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
		options: { refresh: boolean; noPriceRefresh: boolean },
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
 * One `deps.read(handle)` outcome, kept per-handle so a rejection from one database never
 * propagates past its own entry (myusage-4xu.95). Before this, all reads shared one
 * `Promise.all`/`try` with the rest of `runCli`, so a single V2-only channel database (PR #87's
 * own reject-loudly behavior) took the entire run down - no chart at all, even with perfectly
 * good data in the primary database. `ok: true` carries that database's rows; `ok: false` carries
 * the handle and the error so the caller can name exactly which database failed and why. When
 * every result is `ok: false` and at least one was discovered, `runCli` treats that as
 * EXIT_FAILURE (myusage-4xu.97) - distinct from `discover()` finding no handles at all, which
 * stays the soft "nothing to show" case.
 */
type ReadResult =
	| { ok: true; rows: NormalizedUsageRow[] }
	| { ok: false; handle: SourceHandle; error: unknown };

/**
 * Runs the CLI end to end and resolves with the process exit code. Never rejects: every failure
 * is written to `deps.stderr` and reported as EXIT_FAILURE (or EXIT_USAGE for a bad command
 * line). On success the server is left running - this process stays alive until a stop signal
 * closes it (see server.ts) - and the browser is opened as a courtesy: if that fails, the URL
 * is already on the terminal, so it's a warning, not a failure.
 *
 * Exit-code contract for discovered-but-unreadable databases (myusage-4xu.97): a database that
 * fails to read is always a per-database warning on stderr, never fatal by itself. It only
 * becomes EXIT_FAILURE for the whole run when EVERY discovered database failed to read - a
 * caller scripting on the exit code (`my-usage || alert`) can then tell "something failed to
 * read" apart from "nothing to show, nothing wrong." Both softer cases still exit EXIT_OK: no
 * database discovered at all (unchanged - see NO_DATA_HINT), and a partial failure where at
 * least one discovered database read successfully (unchanged since myusage-4xu.95 - one bad
 * channel among several good ones shouldn't kill the run).
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
		// Each handle's read is caught right here, not left to reject out of this Promise.all: a
		// promise that always resolves (to an ok/error result) can never abort the run its sibling
		// reads are part of. If every handle fails, that's the EXIT_FAILURE case checked for below
		// (myusage-4xu.97) - distinct from handles.length === 0 above, which means no database was
		// ever found. The per-handle warnings already say why each one failed, so nothing further
		// is needed here.
		const reads = await Promise.all(
			handles.map(async (handle): Promise<ReadResult> => {
				try {
					return { ok: true, rows: await deps.read(handle) };
				} catch (error) {
					return { ok: false, handle, error };
				}
			}),
		);
		const rows = reads.flatMap((result) => {
			if (result.ok) return result.rows;
			deps.stderr(
				`my-usage: couldn't read ${result.handle.path} (${errorMessage(result.error)}) - ` +
					"skipping it, continuing with what's left.\n",
			);
			return [];
		});
		// A genuine failure, not "nothing to show": at least one database was discovered and every
		// single one of them failed to read. Distinct from handles.length === 0 (no database
		// configured at all), which stays EXIT_OK with NO_DATA_HINT above. A partial failure - some
		// handles ok, some not - still falls through to render what did come back (myusage-4xu.95).
		if (handles.length > 0 && reads.every((result) => !result.ok)) {
			return EXIT_FAILURE;
		}
		const priced = await deps.price(rows, {
			refresh: options.refreshPrices,
			noPriceRefresh: options.noPriceRefresh,
		});
		const days = aggregateDaily(priced);
		// Names the skip count on the rendered page itself (myusage-4xu.98): the per-database
		// warnings above already went to stderr, but once the browser opens, stderr is out of
		// sight - without this, a partial dashboard renders with zero on-page sign anything was
		// skipped. `handles.length` (not `rows.length` or `reads.length`) is the right
		// denominator: it's every database this run discovered, the same population `reads` -
		// and its failures - was built from.
		const skippedCount = reads.filter((result) => !result.ok).length;
		const html = renderHtml(days, {
			skipped: skippedCount,
			total: handles.length,
		});

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
