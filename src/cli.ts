// The CLI's whole run, as one covered function (myusage-4xu.7): parse the arguments, preflight
// the Node version, scan -> price -> aggregate -> render, start the server, open the browser,
// and turn every outcome into an exit code and some text. Every side effect - reading local
// data, fetching prices, listening on a port, spawning a browser, writing to the terminal -
// arrives through `CliDeps`, so cli.test.ts drives this with plain fakes and asserts on what was
// called and what was written. src/index.ts is the only place the real dependencies are wired
// in, and it does nothing else; that split is what keeps index.ts a logic-free composition root
// (see vitest.config.ts's coverage.exclude and scripts/branch-guard.ts).
import { aggregateDaily } from "./aggregate.js";
import { parseCliArgs, USAGE } from "./cli-args.js";
import { NODE_FLOOR, nodeUpgradeMessage } from "./node-version.js";
import type { PricedRow } from "./pricing.js";
import { renderHtml } from "./render.js";
import type { RunningServer } from "./server.js";
import type { NormalizedUsageRow, SourceHandle } from "./sources/types.js";

export interface CliDeps {
	/** `process.versions.node` for real; any "X.Y.Z" string in tests. */
	nodeVersion: string;
	discover(): Promise<SourceHandle[]>;
	read(handle: SourceHandle): Promise<NormalizedUsageRow[]>;
	price(
		rows: NormalizedUsageRow[],
		options: { refresh: boolean },
	): Promise<PricedRow[]>;
	/** Starts serving `html` on `port` (0 = any free port) and resolves once it's listening. */
	serve(html: string, port: number): Promise<RunningServer>;
	openBrowser(url: string): Promise<void>;
	stdout(text: string): void;
	stderr(text: string): void;
}

/** Exit codes: the conventional 0 / 1 / 2 split (ok / failed / called wrong). */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const PRE_1_3_16_NOTE =
	"Note: usage from before opencode v1.3.16 may be over-billed on reasoning-heavy models " +
	"(OpenAI, Gemini) - an old bug double-counted reasoning tokens, and there's no way to spot " +
	"or correct affected rows after the fact.\n";

export const NO_DATA_HINT =
	"my-usage: no opencode database found - looked under $XDG_DATA_HOME/opencode (or " +
	"~/.local/share/opencode when XDG_DATA_HOME is unset). If opencode keeps its data " +
	"somewhere else, point OPENCODE_DB at the file.\n";

/** The one line printed for a failure: an Error's own message, or anything else as text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the CLI end to end and resolves with the process exit code. Never rejects: every failure
 * is written to `deps.stderr` and reported as EXIT_FAILURE (or EXIT_USAGE for a bad command
 * line). On success the server is left running - this process stays alive until a stop signal
 * closes it (see server.ts) - and the browser is opened as a courtesy: if that fails, the URL
 * is already on the terminal, so it's a warning, not a failure.
 */
export async function runCli(
	argv: readonly string[],
	deps: CliDeps,
): Promise<number> {
	const parsed = parseCliArgs(argv);
	if (!parsed.ok) {
		deps.stderr(`${parsed.message}\n`);
		return EXIT_USAGE;
	}
	const { options } = parsed;
	if (options.help) {
		deps.stdout(USAGE);
		return EXIT_OK;
	}

	// Before anything touches the reader: node:sqlite is loaded lazily on the first read (see
	// sources/opencode.ts), so this is early enough to replace Node's own "No such built-in
	// module" with a message that says what to do.
	const upgrade = nodeUpgradeMessage(deps.nodeVersion, NODE_FLOOR);
	if (upgrade !== undefined) {
		deps.stderr(`${upgrade}\n`);
		return EXIT_FAILURE;
	}

	try {
		const handles = await deps.discover();
		if (handles.length === 0) deps.stderr(NO_DATA_HINT);
		const rows = (
			await Promise.all(handles.map((handle) => deps.read(handle)))
		).flat();
		const priced = await deps.price(rows, { refresh: options.refreshPrices });
		const days = aggregateDaily(priced);
		const html = renderHtml(days);

		const server = await deps.serve(html, options.port);
		// Report what the page shows (the window's responses), and separately how many rows were
		// scanned: aggregateDaily always returns one bucket per window day and drops rows outside
		// it, so `rows.length` alone would overcount and `days.length` alone is just the window.
		const inWindow = days.reduce((n, day) => n + day.responses, 0);
		deps.stdout(
			`my-usage: ${inWindow} responses in the last ${days.length} days ` +
				`(${rows.length} scanned in total)\n${PRE_1_3_16_NOTE}`,
		);
		deps.stdout(`Serving at ${server.url} - press Ctrl+C to stop.\n`);

		if (options.open) {
			try {
				await deps.openBrowser(server.url);
			} catch (error) {
				deps.stderr(
					`my-usage: couldn't open a browser (${errorMessage(error)}) - open ${server.url} yourself.\n`,
				);
			}
		}
		return EXIT_OK;
	} catch (error) {
		deps.stderr(`my-usage: ${errorMessage(error)}\n`);
		return EXIT_FAILURE;
	}
}
