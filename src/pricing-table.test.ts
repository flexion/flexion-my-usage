import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	failingFetch,
	fakeFetch,
	forbiddenFetch,
	LITELLM_FIXTURE,
	startRecordingProxy,
	useTempCacheDirs,
} from "./pricing.fixtures.js";
import {
	describeError,
	loadPriceTable,
	PRICE_TABLE_URL,
	parsePriceTable,
} from "./pricing-table.js";

const newCacheDir = useTempCacheDirs();

/**
 * A parseable JSON price-table body whose UTF-16 code-unit length equals exactly
 * `charBudget`, but whose real UTF-8 byte length is larger: each padding character is
 * U+3042 ("あ"), one UTF-16 code unit but three UTF-8 bytes. Lets a test set maxBytes to
 * charBudget and show that a byte-accurate cap rejects the body while a code-unit cap
 * (`text.length`) would not, distinguishing the two on a single real string.
 */
function multibyteBodyAtCharBudget(charBudget: number): string {
	const MULTIBYTE_CHAR = "あ";
	const withoutPadding = JSON.stringify({
		"multibyte/model": {
			litellm_provider: "multibyte",
			input_cost_per_token: 0,
			output_cost_per_token: 0,
			pad: "",
		},
	});
	const overhead = withoutPadding.length;
	const paddingLength = charBudget - overhead;
	const padding = MULTIBYTE_CHAR.repeat(paddingLength);
	return withoutPadding.replace('"pad":""', `"pad":${JSON.stringify(padding)}`);
}

describe("describeError", () => {
	it("appends the underlying cause code, as fetch failures carry it", () => {
		const error = new Error("fetch failed", { cause: { code: "ENOTFOUND" } });
		expect(describeError(error)).toBe("fetch failed: ENOTFOUND");
	});

	it("describes a thrown value that is not an Error", () => {
		expect(describeError("plain failure")).toBe("plain failure");
	});
});

describe("parsePriceTable: the rate ceiling", () => {
	// The 1e300 input-rate case that used to live here was dropped: for any ceiling c, it
	// fails only when c >= 1e300, which implies the 3-USD/token case below also fails, so it
	// pinned nothing the realistic-corruption case doesn't already pin.
	it.each([
		[
			"excludes an entry whose output rate is a realistic corruption, not just an extreme like 1e300 (a per-million-vs-per-token unit slip: 3 USD/token, still comfortably above the bead's 1 USD/token ceiling)",
			{ output_cost_per_token: 3 },
			false,
		],
		[
			"excludes an entry whose input rate is a realistic corruption, not just an extreme like 1e300 (a per-million-vs-per-token unit slip: 3 USD/token, still comfortably above the bead's 1 USD/token ceiling)",
			{ input_cost_per_token: 3 },
			false,
		],
		[
			"accepts an entry whose input rate sits exactly at the ceiling (1 USD/token)",
			{ input_cost_per_token: 1 },
			true,
		],
	])("%s", (_name, overrides, accepted) => {
		const table = parsePriceTable({
			"ceiling/entry": {
				litellm_provider: "ceiling",
				input_cost_per_token: 0.000003,
				output_cost_per_token: 0.000015,
				...overrides,
			},
		});
		expect(table.has("ceiling/entry")).toBe(accepted);
	});

	it.each([
		["cache_read_input_token_cost"],
		["cache_creation_input_token_cost"],
		["output_cost_per_reasoning_token"],
	])(
		"excludes an entry whose realistic-corruption rate (3 USD/token), not just an extreme like 1e300, sits on the optional field %s, not just input or output",
		(field) => {
			const table = parsePriceTable({
				"ceiling/optional": {
					litellm_provider: "ceiling",
					input_cost_per_token: 0.000003,
					output_cost_per_token: 0.000015,
					[field]: 3,
				},
			});
			expect(table.has("ceiling/optional")).toBe(false);
		},
	);
});

describe("parsePriceTable: untrusted top-level shape", () => {
	it("never throws on a JSON top level of null, per its documented contract", () => {
		expect(parsePriceTable(null).size).toBe(0);
	});

	it("rejects a JSON array instead of keying entries by numeric index", () => {
		const table = parsePriceTable([
			{
				litellm_provider: "array-index",
				input_cost_per_token: 0,
				output_cost_per_token: 0,
			},
		]);
		expect(table.size).toBe(0);
	});

	it.each([
		["missing", { input_cost_per_token: 0, output_cost_per_token: 0 }],
		[
			"not a string",
			{
				litellm_provider: 42,
				input_cost_per_token: 0,
				output_cost_per_token: 0,
			},
		],
	])("excludes an entry whose litellm_provider is %s", (_case, entry) => {
		const table = parsePriceTable({ "provider/entry": entry });
		expect(table.size).toBe(0);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("loadPriceTable: defaults for what the caller does not inject", () => {
	it("uses the global fetch when no proxy is configured, the default path for nearly every user", async () => {
		const globalFetch = fakeFetch(LITELLM_FIXTURE);
		vi.stubGlobal("fetch", globalFetch);

		// Every other test in this file injects `options.fetch`, which bypasses the proxy
		// question entirely; this is the one that stands in for the real, unproxied default
		// path once HTTPS_PROXY/NO_PROXY handling exists. `env: {}` (rather than omitting the
		// option, which would fall through to the real ambient process.env) keeps it decisive
		// regardless of the host machine's own proxy configuration.
		const table = await loadPriceTable(
			{ cacheDir: await newCacheDir(), env: {} },
			vi.fn(),
		);

		expect(globalFetch).toHaveBeenCalledTimes(1);
		expect(table?.size).toBeGreaterThan(0);
	});

	it("locates the cache from process.env and the home directory", async () => {
		// A sandbox stands in for the home directory, so the real one is never touched.
		const home = await newCacheDir();
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("XDG_CACHE_HOME", "");

		await loadPriceTable({ fetch: fakeFetch(LITELLM_FIXTURE) }, vi.fn());

		expect(await readdir(join(home, ".cache", "my-usage"))).toHaveLength(1);
	});
});

// These tests exercise the real, unmocked global fetch (no `fetch` override) against a real
// local proxy server, per myusage-4xu.15: the point is to prove the actual network stack
// engages HTTPS_PROXY end to end - including the resulting graceful failure, since this fixture
// never forwards a tunnel - which a fake `fetch` cannot show. Proxy configuration goes through
// `options.env` - the same seam `loadPriceTable` already uses to resolve the cache directory -
// rather than `vi.stubEnv`/`process.env`, so a machine's own ambient HTTPS_PROXY can never leak
// into a test and these tests never share mutable global state (this suite runs `pool:
// "forks"`, so all of them share one process).
//
// round-2 review (F8, F2, F3): every NO_PROXY form, case rule and env-var-name precedence rule
// used to live only here, asserted against real network timing - but outcomes here depend on
// whatever transport mechanism the eventual implementation uses (Node's built-in env-proxy
// support is startup-only and unavailable at this repo's Node floor, so the implementation is
// necessarily a hand-rolled tunnel), which is a property of the Node build and the
// implementation, not of NO_PROXY handling itself. That entire decision table now lives in
// proxy.test.ts, against a pure `resolveProxy(env, url)`, with no network and no timing
// dependency. What stays here is kept to what plain-data tests structurally cannot prove: that
// the real transport actually opens a tunnel through a real HTTPS_PROXY, that a refused tunnel
// still produces this module's normal "price table unavailable" warning rather than an
// unhandled rejection, and that an injected `options.fetch` - the seam all 23 other tests in
// this file use - is left alone rather than wrapped or replaced.
//
// "does not use the proxy when NO_PROXY matches the target host" used to live here too, but
// PRICE_TABLE_URL is a module constant with no injection seam (LoadOptions carries `fetch`,
// `cacheDir`, `env`, `homeDir`, but no `url`), so that case could only ever be pinned negatively
// against the real host, for a reason unrelated to NO_PROXY handling (see the deleted test's
// history). Adding a `url` seam is a source change, out of scope for this test-only round; the
// case is now pinned decisively, with plain data, in proxy.test.ts's "NO_PROXY against the real
// price-table host" block instead.
//
// round-3 review (TENSION-1): its mirror, "still routes through the proxy when NO_PROXY is set
// but does not match the target host", is deleted for the same reason. Its assertions were
// byte-for-byte identical to "routes the request through HTTPS_PROXY when it is set" above (same
// `connectSeen` check, same env shape with a non-matching NO_PROXY added), so it exercised no
// code path the test above it does not already cover: an adapter that reads
// `options.env?.HTTPS_PROXY` and never consults NO_PROXY at all would pass both. Which NO_PROXY
// forms suppress the proxy is proxy.test.ts's job (`resolveProxy`, pure and exhaustive). What
// would make a real-transport test decisive for NO_PROXY specifically is its mirror case -
// NO_PROXY that *does* match the real target host, so the proxy must NOT be dialed - and that
// hits the same wall the deleted "matches the target host" case above did: proving "does not
// dial the proxy" here would mean either reaching the real public host directly (an
// external-network dependency this suite does not take) or adding the same `url` seam, both out
// of scope for a test-only round. Until that seam exists, end-to-end NO_PROXY suppression is
// guaranteed only by construction: the adapter has exactly one call site that can resolve a
// proxy at all, so wiring NO_PROXY into that single `resolveProxy(env, url)` call is what GREEN
// must do to pass proxy.test.ts's table - it is not separately pinned by an executed test here.
describe("loadPriceTable: HTTPS_PROXY (real fetch, local proxy fixture)", () => {
	// Loopback CONNECT + 502 + socket close is sub-25ms in practice (confirmed directly on
	// Node 22.13.0/Linux, this repo's actual floor), so 2000ms leaves ample margin for a
	// correctly-proxied request while bounding how long an unrouted request spends reaching
	// the real host before its own AbortSignal cancels it. This number is not standing in for
	// a real prior incident: this test once failed deterministically on CI regardless of the
	// timeout value, because of a real bug (now fixed - see fetchTable's doc comment on the
	// undiciFetch branch), so a large timeout here is not evidence CI itself runs slow.
	const REAL_FETCH_TIMEOUT_MS = 2000;

	it("routes the request through HTTPS_PROXY when it is set, and warns gracefully when the proxy refuses the tunnel", async () => {
		const proxy = await startRecordingProxy();
		const connectSeen = proxy.waitForConnect(REAL_FETCH_TIMEOUT_MS);
		const warn = vi.fn();
		const load = loadPriceTable(
			{
				cacheDir: await newCacheDir(),
				timeoutMs: REAL_FETCH_TIMEOUT_MS,
				env: { HTTPS_PROXY: proxy.url },
			},
			warn,
		);
		try {
			const { hostname } = new URL(PRICE_TABLE_URL);
			await expect(connectSeen).resolves.toBe(`${hostname}:443`);
			// This fixture answers every CONNECT with 502 and forwards nothing (see
			// startRecordingProxy's doc comment), so a correctly-proxied request must fail the
			// same way an ordinary fetch failure does: resolve to undefined via the module's
			// existing, already-covered warn-and-continue path, never throw.
			await expect(load).resolves.toBeUndefined();
			expect(warn.mock.calls[0]?.[0]).toContain("price table unavailable");
		} finally {
			await proxy.close();
		}
	});

	it("uses the injected fetch as-is when a proxy is configured, never consulting the proxy", async () => {
		// All 23 other tests in this file inject `options.fetch`; a proxy implementation that
		// wraps or replaces it (instead of only applying to the real global-fetch fallback)
		// would silently change what every one of those tests actually exercises.
		const proxy = await startRecordingProxy();
		const injectedFetch = fakeFetch(LITELLM_FIXTURE);
		try {
			const table = await loadPriceTable(
				{
					cacheDir: await newCacheDir(),
					fetch: injectedFetch,
					env: { HTTPS_PROXY: proxy.url },
				},
				vi.fn(),
			);
			expect(injectedFetch).toHaveBeenCalledTimes(1);
			expect(table?.size).toBeGreaterThan(0);
			expect(proxy.connects).toEqual([]);
		} finally {
			await proxy.close();
		}
	});
});

// round-3 review (F4): no test in either file exercised a malformed HTTPS_PROXY through
// loadPriceTable itself, so nothing forced the URL-parsing failure to land inside the module's
// existing never-throw contract, and nothing stopped a silent fall-back to a direct request
// either. This test does not use startRecordingProxy - there is no tunnel to record, since a
// correct implementation never attempts one - so a stub on the *global* fetch stands in for
// "the real network" here.
describe("loadPriceTable: malformed HTTPS_PROXY", () => {
	it("fails gracefully without ever dialing out, neither through the bad proxy nor direct", async () => {
		// No injected `options.fetch`: that seam bypasses proxy resolution entirely (see "uses
		// the injected fetch as-is" above), so injecting it here would prove nothing about
		// malformed-proxy handling. Stubbing the global instead forces execution through the
		// same `options.fetch ?? globalThis.fetch` resolution every unproxied test in this file
		// relies on, while keeping the test fully offline: the stub is called if and only if the
		// implementation ever attempts an actual request, proxied or not. A correct
		// implementation rejects an unusable HTTPS_PROXY value before it gets anywhere near that
		// call, so the stub must stay untouched. The current, pre-implementation source ignores
		// the env option entirely and falls straight through to it - exactly the "silently goes
		// direct" failure this test exists to catch.
		const directFetch = forbiddenFetch();
		vi.stubGlobal("fetch", directFetch);
		const warn = vi.fn();

		const table = await loadPriceTable(
			{
				cacheDir: await newCacheDir(),
				timeoutMs: 500,
				env: { HTTPS_PROXY: "notaurl" },
			},
			warn,
		);

		expect(table).toBeUndefined();
		expect(directFetch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("price table unavailable");
	});
});

describe("loadPriceTable: a cache hit makes no network calls, even with a proxy configured", () => {
	it("returns the cached table without calling fetch", async () => {
		const cacheDir = await newCacheDir();
		await loadPriceTable(
			{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
			vi.fn(),
		);

		// round 3 (F1): the size-only assertion below holds whether or not fetch runs, since a
		// failed refresh falls back to the cache too. These two calls are what actually pin
		// "makes no network calls": the injected fetch must never fire, and no warning (from a
		// refresh attempt failing) may fire either.
		const offline = forbiddenFetch();
		const warn = vi.fn();
		const table = await loadPriceTable(
			{
				cacheDir,
				fetch: offline,
				env: { HTTPS_PROXY: "http://proxy.example:8080" },
			},
			warn,
		);

		expect(table?.size).toBeGreaterThan(0);
		expect(offline).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});

/** A response that exposes no body stream, only text(): the shape some fetch polyfills return. */
function bodylessFetch(text: string) {
	return vi.fn<typeof fetch>(
		async () =>
			({
				ok: true,
				status: 200,
				headers: new Headers(),
				body: null,
				text: async () => text,
			}) as unknown as Response,
	);
}

describe("loadPriceTable: response without a body stream", () => {
	it("reads the table from text() and caches it", async () => {
		const cacheDir = await newCacheDir();
		const warn = vi.fn();

		const table = await loadPriceTable(
			{ cacheDir, fetch: bodylessFetch(JSON.stringify(LITELLM_FIXTURE)) },
			warn,
		);

		expect(table?.size).toBeGreaterThan(0);
		expect(warn).not.toHaveBeenCalled();
		expect(await readdir(cacheDir)).toHaveLength(1);
	});

	it("still enforces the size cap", async () => {
		const cacheDir = await newCacheDir();
		const warn = vi.fn();

		const table = await loadPriceTable(
			{
				cacheDir,
				fetch: bodylessFetch(JSON.stringify(LITELLM_FIXTURE)),
				maxBytes: 10,
			},
			warn,
		);

		expect(table).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("response too large");
		expect(await readdir(cacheDir)).toEqual([]);
	});

	it("rejects a multibyte body whose UTF-16 code-unit length is within the cap but whose real UTF-8 byte length is not", async () => {
		const text = multibyteBodyAtCharBudget(600);
		const maxBytes = text.length;
		// Sanity check on the fixture itself, so a future edit that breaks the property fails
		// loudly here rather than producing a confusing failure below.
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(maxBytes);
		const warn = vi.fn();

		const table = await loadPriceTable(
			{ cacheDir: await newCacheDir(), fetch: bodylessFetch(text), maxBytes },
			warn,
		);

		expect(table).toBeUndefined();
		expect(warn.mock.calls[0]?.[0]).toContain("response too large");
	});
});

describe("loadPriceTable: cached file size cap is byte-accurate", () => {
	it("rejects a cached body whose UTF-16 code-unit length is within the cap but whose real UTF-8 byte length is not", async () => {
		const cacheDir = await newCacheDir();
		// Seed a normal cache file first, so its exact (undocumented) file name can be
		// discovered, the same way the "cache write failure" test below does.
		await loadPriceTable(
			{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
			() => {},
		);
		const [cacheFile] = await readdir(cacheDir);

		const text = multibyteBodyAtCharBudget(600);
		const maxBytes = text.length;
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(maxBytes);
		await writeFile(join(cacheDir, cacheFile as string), text, "utf8");

		// If the oversized cache is (wrongly) accepted, this fetch is never reached and its
		// failure never surfaces; if the cache is correctly rejected, loadPriceTable falls
		// through to this fetch, which fails, leaving no usable table.
		const table = await loadPriceTable(
			{ cacheDir, maxBytes, fetch: failingFetch() },
			vi.fn(),
		);

		expect(table).toBeUndefined();
	});
});

describe("loadPriceTable: cache directory permissions", () => {
	// POSIX-only, and an accepted contract: both CI jobs in .github/workflows/ci.yml
	// (`verify` and `verify-node-floor`) pin `runs-on: ubuntu-latest`, so the resulting inode
	// mode is decisive there. Windows ignores POSIX mode bits on mkdir, so if a Windows
	// checkout ever needs to run this suite, assert the mode argument handed to the
	// directory-creation seam instead of the resulting `stat().mode`.
	it("creates a brand-new cache directory as 0700 (owner-only), not the default umask", async () => {
		const parent = await newCacheDir();
		const cacheDir = join(parent, "brand-new-cache-dir");
		// The umask is pinned so this assertion is decisive regardless of the ambient umask.
		const previousUmask = process.umask(0o022);
		try {
			await loadPriceTable(
				{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
				() => {},
			);

			const info = await stat(cacheDir);
			expect(info.mode & 0o777).toBe(0o700);
		} finally {
			process.umask(previousUmask);
		}
	});
});

/** A body whose cancel() rejects, to show a failed cleanup never hides the real failure. */
function stubbornBody(start?: (c: ReadableStreamDefaultController) => void) {
	return new ReadableStream({
		start,
		cancel: () => Promise.reject(new Error("cancel failed")),
	});
}

describe("loadPriceTable: cleanup failures do not mask the real failure", () => {
	it.each([
		[
			"a declared size over the cap",
			() =>
				new Response(stubbornBody(), {
					headers: { "content-length": "999999" },
				}),
			"response too large",
		],
		[
			"a streamed size over the cap",
			() =>
				new Response(
					stubbornBody((controller) => controller.enqueue(new Uint8Array(600))),
				),
			"response too large",
		],
		[
			"an HTTP error status",
			() => new Response(stubbornBody(), { status: 500 }),
			"HTTP 500",
		],
	])("%s", async (_name, response, reason) => {
		const warn = vi.fn();

		const table = await loadPriceTable(
			{
				cacheDir: await newCacheDir(),
				fetch: async () => response(),
				maxBytes: 500,
			},
			warn,
		);

		expect(table).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain(reason);
		expect(warn.mock.calls[0]?.[0]).not.toContain("cancel failed");
	});
});

describe("loadPriceTable: cache write failure after a good fetch", () => {
	it("removes its temp file, warns once, and still returns the fetched table", async () => {
		const cacheDir = await newCacheDir();
		await loadPriceTable(
			{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
			() => {},
		);
		const [cacheFile] = await readdir(cacheDir);
		// A directory where the cache file belongs makes the final rename fail.
		await rm(join(cacheDir, cacheFile as string));
		await mkdir(join(cacheDir, cacheFile as string));
		const warn = vi.fn();

		const table = await loadPriceTable(
			{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
			warn,
		);

		expect(table?.size).toBeGreaterThan(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain(
			"could not cache the price table",
		);
		// Only the blocking directory remains: no leftover .tmp file.
		expect(await readdir(cacheDir)).toEqual([cacheFile]);
	});
});
