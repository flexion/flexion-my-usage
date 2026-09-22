// Command-line parsing for the npx entrypoint (myusage-4xu.7): argv in, a plain options object
// (or a usage error) out. Nothing here touches process.argv, stdout or the pipeline, so every
// flag and every malformed input is specified with plain string arrays in cli-args.test.ts.
//
// Node's own `util.parseArgs` does the tokenizing (it has been stable since Node 20, well under
// this repo's 22.13.0 floor); this module owns the option table, the port validation, the usage
// text, and the shape of a usage error. Its thrown errors are caught right here and turned into
// a `{ ok: false }` result, so the CLI never has to know how Node phrases a bad flag.
import { parseArgs as nodeParseArgs } from "node:util";

export interface CliOptions {
	/** Print USAGE and exit without doing anything else. */
	help: boolean;
	/** Force a refetch of the LiteLLM price table instead of using the cached copy. */
	refreshPrices: boolean;
	/**
	 * Treat the price cache as always fresh, skipping the automatic refresh attempt a stale
	 * (24h+) cache would otherwise trigger on every run. Independent of `refreshPrices`: one
	 * answers "never auto-refresh on age," the other "refetch right now regardless of age," and
	 * an explicit `refreshPrices` still fetches even when this is set. For a permanently
	 * offline machine with a hand-seeded cache (see README's "Proxies and offline machines").
	 */
	noPriceRefresh: boolean;
	/** Open the served page in the default browser (off with --no-open). */
	open: boolean;
	/**
	 * The port to listen on. 0 (the default) asks the OS for a free ephemeral port, which can
	 * never collide with anything; an explicit port is used as given, and a conflict on it is an
	 * error, never a silent fallback - the user named that port on purpose.
	 */
	port: number;
}

export type ParsedArgs =
	| { ok: true; options: CliOptions }
	| { ok: false; message: string };

export const USAGE = `Usage: my-usage [options]

Scans your local opencode usage, works out a notional cost, and serves a dashboard from a
local server (bound to 127.0.0.1 only), opened in your default browser. Press Ctrl+C to stop.

Options:
  --port <n>          Listen on this port (default: a free port chosen by the OS)
  --no-open           Don't open a browser; just print the URL
  --refresh-prices    Refetch the LiteLLM price table instead of using the cached copy
  --no-price-refresh  Skip the automatic refresh of a stale price cache (--refresh-prices still forces one)
  -h, --help          Show this help
`;

const MAX_PORT = 65535;

/** A TCP port: a whole number from 0 (let the OS choose) to 65535. */
export function parsePort(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const port = Number(raw);
	return port <= MAX_PORT ? port : undefined;
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
	let values: {
		help?: boolean;
		"refresh-prices"?: boolean;
		"no-price-refresh"?: boolean;
		"no-open"?: boolean;
		port?: string;
	};
	try {
		values = nodeParseArgs({
			args: [...argv],
			options: {
				help: { type: "boolean", short: "h" },
				"refresh-prices": { type: "boolean" },
				"no-price-refresh": { type: "boolean" },
				"no-open": { type: "boolean" },
				port: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (error) {
		// parseArgs only ever throws an Error subclass (ERR_PARSE_ARGS_*), whose message already
		// names the offending token; wrapping it with the tool's name and a pointer at --help is
		// all that's missing.
		return { ok: false, message: usageError((error as Error).message) };
	}

	let port = 0;
	if (values.port !== undefined) {
		const parsed = parsePort(values.port);
		if (parsed === undefined) {
			return {
				ok: false,
				message: usageError(
					`--port must be a whole number from 0 to ${MAX_PORT}, not "${values.port}"`,
				),
			};
		}
		port = parsed;
	}

	return {
		ok: true,
		options: {
			help: values.help === true,
			refreshPrices: values["refresh-prices"] === true,
			noPriceRefresh: values["no-price-refresh"] === true,
			open: values["no-open"] !== true,
			port,
		},
	};
}

function usageError(detail: string): string {
	return `my-usage: ${detail}\nRun my-usage --help for usage.`;
}
