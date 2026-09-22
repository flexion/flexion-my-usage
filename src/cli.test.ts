// Specifies runCli end to end with plain fakes behind CliDeps: what gets called, in what order,
// with what, and what lands on stdout/stderr and in the exit code. The pure stages in the middle
// (aggregateDaily, renderHtml) run for real - they're deterministic and already specified by
// their own tests - so the html handed to `serve` is the real page. No process.argv, no
// process.exit, no real server, no real browser, no real opencode database.
import { describe, expect, it } from "vitest";
import {
	type CliDeps,
	EXIT_FAILURE,
	EXIT_OK,
	EXIT_USAGE,
	errorMessage,
	NO_DATA_HINT,
	PRE_1_3_16_NOTE,
	runCli,
} from "./cli.js";
import { USAGE } from "./cli-args.js";
import { NODE_FLOOR } from "./node-version.js";
import type { PricedRow } from "./pricing.js";
import type { RunningServer } from "./server.js";
import type { NormalizedUsageRow, SourceHandle } from "./sources/types.js";

const HANDLE_A: SourceHandle = {
	source: "opencode",
	path: "/data/opencode.db",
};
const HANDLE_B: SourceHandle = {
	source: "opencode",
	path: "/data/opencode-beta.db",
};

function row(messageId: string, input: number): NormalizedUsageRow {
	return {
		source: "opencode",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: new Date(),
		sessionId: "ses_test",
		messageId,
		tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

interface Recorded {
	deps: CliDeps;
	calls: string[];
	stdout: string;
	stderr: string;
	served: { html: string; port: number } | undefined;
	priceOptions: { refresh: boolean; noPriceRefresh: boolean } | undefined;
	opened: string | undefined;
}

const SERVER_URL = "http://127.0.0.1:43210/";

function fakeServer(): RunningServer {
	return {
		url: SERVER_URL,
		port: 43210,
		close: () => Promise.resolve(),
		closed: new Promise(() => {}),
	};
}

/** A CliDeps whose every member records itself; each can be replaced per test. */
function record(overrides: Partial<CliDeps> = {}): Recorded {
	const r: Recorded = {
		calls: [],
		stdout: "",
		stderr: "",
		served: undefined,
		priceOptions: undefined,
		opened: undefined,
		deps: {
			nodeVersion: NODE_FLOOR.join("."),
			discover: async () => {
				r.calls.push("discover");
				return [HANDLE_A, HANDLE_B];
			},
			read: async (handle) => {
				r.calls.push(`read ${handle.path}`);
				return handle === HANDLE_A
					? [row("a1", 10), row("a2", 20)]
					: [row("b1", 30)];
			},
			price: async (rows, options) => {
				r.calls.push(`price ${rows.length}`);
				r.priceOptions = options;
				return rows.map(
					(x): PricedRow => ({ ...x, notionalCost: 0.5, unpriced: false }),
				);
			},
			serve: async (html, port) => {
				r.calls.push(`serve ${port}`);
				r.served = { html, port };
				return fakeServer();
			},
			openBrowser: async (url) => {
				r.calls.push(`open ${url}`);
				r.opened = url;
			},
			stdout: (text) => {
				r.stdout += text;
			},
			stderr: (text) => {
				r.stderr += text;
			},
			...overrides,
		},
	};
	return r;
}

describe("runCli: the happy path", () => {
	it("scans, prices, serves the rendered page on an OS-chosen port, opens the browser, exits 0", async () => {
		const r = record();
		const code = await runCli([], r.deps);

		expect(code).toBe(EXIT_OK);
		expect(r.calls).toEqual([
			"discover",
			`read ${HANDLE_A.path}`,
			`read ${HANDLE_B.path}`,
			"price 3",
			"serve 0",
			`open ${SERVER_URL}`,
		]);
		expect(r.priceOptions).toEqual({ refresh: false, noPriceRefresh: false });
		expect(r.served?.port).toBe(0);
		expect(r.served?.html.startsWith("<!doctype html>")).toBe(true);
		expect(r.served?.html).toContain("<title>my-usage</title>");
		expect(r.opened).toBe(SERVER_URL);
		expect(r.stdout).toBe(
			`my-usage: 3 responses in the last 30 days (3 scanned in total)\n${PRE_1_3_16_NOTE}` +
				`Serving at ${SERVER_URL} - press Ctrl+C to stop.\n`,
		);
		expect(r.stderr).toBe("");
	});

	it("counts only the window's responses in the summary, with the scanned total beside it", async () => {
		const old = row("old", 5);
		old.timestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		const r = record({
			discover: async () => [HANDLE_A],
			read: async () => [row("a1", 10), old],
		});
		expect(await runCli([], r.deps)).toBe(EXIT_OK);
		expect(r.stdout).toContain(
			"my-usage: 1 responses in the last 30 days (2 scanned in total)",
		);
	});

	it("prints the URL before trying to open the browser, so it's visible even if opening hangs", async () => {
		const r = record({
			openBrowser: async () => {
				expect(r.stdout).toContain(`Serving at ${SERVER_URL}`);
				r.calls.push("open (after url printed)");
			},
		});
		await runCli([], r.deps);
		expect(r.calls.at(-1)).toBe("open (after url printed)");
	});
});

describe("runCli: flags", () => {
	it("--refresh-prices reaches price() as refresh: true", async () => {
		const r = record();
		expect(await runCli(["--refresh-prices"], r.deps)).toBe(EXIT_OK);
		expect(r.priceOptions).toEqual({ refresh: true, noPriceRefresh: false });
	});

	it("--no-price-refresh reaches price() as noPriceRefresh: true", async () => {
		const r = record();
		expect(await runCli(["--no-price-refresh"], r.deps)).toBe(EXIT_OK);
		expect(r.priceOptions).toEqual({ refresh: false, noPriceRefresh: true });
	});

	it("--refresh-prices and --no-price-refresh combine: both reach price() set, since they answer different questions", async () => {
		const r = record();
		expect(
			await runCli(["--refresh-prices", "--no-price-refresh"], r.deps),
		).toBe(EXIT_OK);
		expect(r.priceOptions).toEqual({ refresh: true, noPriceRefresh: true });
	});

	it("--no-open serves but never touches the browser", async () => {
		const r = record();
		expect(await runCli(["--no-open"], r.deps)).toBe(EXIT_OK);
		expect(r.opened).toBeUndefined();
		expect(r.calls.some((c) => c.startsWith("open"))).toBe(false);
		expect(r.stdout).toContain(`Serving at ${SERVER_URL}`);
	});

	it("--port <n> is passed through to serve()", async () => {
		const r = record();
		expect(await runCli(["--port", "8123"], r.deps)).toBe(EXIT_OK);
		expect(r.served?.port).toBe(8123);
	});

	it("--help prints USAGE to stdout, exits 0, and does nothing else", async () => {
		const r = record();
		expect(await runCli(["--help"], r.deps)).toBe(EXIT_OK);
		expect(r.stdout).toBe(USAGE);
		expect(r.stderr).toBe("");
		expect(r.calls).toEqual([]);
	});

	it("a bad flag prints the usage error to stderr, exits 2, and does nothing else", async () => {
		const r = record();
		expect(await runCli(["--bogus"], r.deps)).toBe(EXIT_USAGE);
		expect(r.stderr).toContain("--bogus");
		expect(r.stderr).toContain("Run my-usage --help for usage.");
		expect(r.stderr.endsWith("\n")).toBe(true);
		expect(r.stdout).toBe("");
		expect(r.calls).toEqual([]);
	});
});

describe("runCli: Node preflight", () => {
	it("an older Node prints the upgrade message, exits 1, and never touches the reader", async () => {
		const r = record({ nodeVersion: "20.11.1" });
		expect(await runCli([], r.deps)).toBe(EXIT_FAILURE);
		expect(r.stderr).toContain("my-usage needs Node 22.13.0 or newer");
		expect(r.stderr).toContain("This is Node 20.11.1");
		expect(r.calls).toEqual([]);
	});

	it("--help still works on an older Node (it needs nothing the floor provides)", async () => {
		const r = record({ nodeVersion: "18.0.0" });
		expect(await runCli(["--help"], r.deps)).toBe(EXIT_OK);
		expect(r.stdout).toBe(USAGE);
	});

	it("a usage error is reported before the Node preflight", async () => {
		const r = record({ nodeVersion: "18.0.0" });
		expect(await runCli(["--bogus"], r.deps)).toBe(EXIT_USAGE);
		expect(r.stderr).not.toContain("needs Node");
	});
});

describe("runCli: no data", () => {
	it("no database found -> a hint on stderr, an empty page still served, exit 0", async () => {
		const r = record({ discover: async () => [] });
		expect(await runCli([], r.deps)).toBe(EXIT_OK);
		expect(r.stderr).toBe(NO_DATA_HINT);
		expect(r.calls).toEqual(["price 0", "serve 0", `open ${SERVER_URL}`]);
		expect(r.stdout).toContain(
			"my-usage: 0 responses in the last 30 days (0 scanned in total)",
		);
		expect(r.served?.html).toContain("No usage recorded in this window.");
	});
});

describe("runCli: failures", () => {
	it("a failing discover() -> its message on stderr, exit 1, nothing served", async () => {
		const r = record({
			discover: () =>
				Promise.reject(
					new Error(
						"OPENCODE_DB is set to /nope/opencode.db but that file does not exist",
					),
				),
		});
		expect(await runCli([], r.deps)).toBe(EXIT_FAILURE);
		expect(r.stderr).toBe(
			"my-usage: OPENCODE_DB is set to /nope/opencode.db but that file does not exist\n",
		);
		expect(r.served).toBeUndefined();
		expect(r.stdout).toBe("");
	});

	it("every database's read() rejecting -> a named warning per database, exit 0 with an empty page (myusage-4xu.95)", async () => {
		const r = record({
			read: (handle) => {
				r.calls.push(`read ${handle.path}`);
				return Promise.reject(new Error(`Cannot read ${handle.path}: boom`));
			},
		});
		expect(await runCli([], r.deps)).toBe(EXIT_OK);
		expect(r.stderr).toBe(
			`my-usage: couldn't read ${HANDLE_A.path} (Cannot read ${HANDLE_A.path}: boom) - skipping it, continuing with what's left.\n` +
				`my-usage: couldn't read ${HANDLE_B.path} (Cannot read ${HANDLE_B.path}: boom) - skipping it, continuing with what's left.\n`,
		);
		expect(r.calls).toEqual([
			"discover",
			`read ${HANDLE_A.path}`,
			`read ${HANDLE_B.path}`,
			"price 0",
			"serve 0",
			`open ${SERVER_URL}`,
		]);
		expect(r.stdout).toContain(
			"my-usage: 0 responses in the last 30 days (0 scanned in total)",
		);
		expect(r.served?.html).toContain("No usage recorded in this window.");
	});

	it("one of several databases' read() rejecting (matching PR #87's V2-only shape) -> a named warning for it, the rest still render and aggregate", async () => {
		const v2OnlyMessage =
			`Cannot read ${HANDLE_B.path}: found 3 assistant usage row(s) in ` +
			'"session_message" but none in "message" - this database looks like it was ' +
			"written by opencode's V2 (2.0-preview) schema, which this reader does not read yet.";
		const r = record({
			read: async (handle) => {
				if (handle === HANDLE_B) {
					return Promise.reject(new Error(v2OnlyMessage));
				}
				return [row("a1", 10), row("a2", 20)];
			},
		});
		expect(await runCli([], r.deps)).toBe(EXIT_OK);
		expect(r.stderr).toBe(
			`my-usage: couldn't read ${HANDLE_B.path} (${v2OnlyMessage}) - skipping it, continuing with what's left.\n`,
		);
		// The good database's rows still reached price() and, from there, the rendered page -
		// the whole point of catching the bad database's rejection per-handle instead of letting
		// it abort the shared Promise.all.
		expect(r.calls).toContain("price 2");
		expect(r.stdout).toContain(
			"my-usage: 2 responses in the last 30 days (2 scanned in total)",
		);
	});

	it("a port already in use -> the server's remedy message, exit 1, no browser", async () => {
		const r = record({
			serve: () =>
				Promise.reject(
					new Error("port 8123 is already in use on 127.0.0.1 - pick another"),
				),
		});
		expect(await runCli(["--port", "8123"], r.deps)).toBe(EXIT_FAILURE);
		expect(r.stderr).toBe(
			"my-usage: port 8123 is already in use on 127.0.0.1 - pick another\n",
		);
		expect(r.opened).toBeUndefined();
		expect(r.stdout).toBe("");
	});

	it("a non-Error rejection is still reported as text", async () => {
		const r = record({ discover: () => Promise.reject("plain string") });
		expect(await runCli([], r.deps)).toBe(EXIT_FAILURE);
		expect(r.stderr).toBe("my-usage: plain string\n");
	});

	it("a browser that won't open is a warning naming the URL, and still exit 0 - the server is up", async () => {
		const r = record({
			openBrowser: () =>
				Promise.reject(
					Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
				),
		});
		expect(await runCli([], r.deps)).toBe(EXIT_OK);
		expect(r.stdout).toContain(`Serving at ${SERVER_URL}`);
		expect(r.stderr).toBe(
			`my-usage: couldn't open a browser (spawn xdg-open ENOENT) - open ${SERVER_URL} yourself.\n`,
		);
	});
});

describe("errorMessage", () => {
	it("an Error -> its message", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	it("anything else -> String() of it", () => {
		expect(errorMessage("text")).toBe("text");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});
