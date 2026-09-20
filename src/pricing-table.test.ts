import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fakeFetch,
	LITELLM_FIXTURE,
	useTempCacheDirs,
} from "./pricing.fixtures.js";
import {
	describeError,
	loadPriceTable,
	parsePriceTable,
} from "./pricing-table.js";

const newCacheDir = useTempCacheDirs();

/** A fetch that fails every call with a server error, for tests that must reach the network. */
function failingFetch() {
	return vi.fn<typeof fetch>(
		async () => new Response("unavailable", { status: 503 }),
	);
}

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
	if (paddingLength <= 0) {
		throw new Error(
			`charBudget must exceed the fixture's fixed overhead (${overhead})`,
		);
	}
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

describe("parsePriceTable: rejects absurd rates", () => {
	it("excludes an entry whose input rate is absurdly large (bead example: 1e300)", () => {
		const table = parsePriceTable({
			"absurd/input": {
				litellm_provider: "absurd",
				input_cost_per_token: 1e300,
				output_cost_per_token: 0.000015,
			},
		});
		expect(table.has("absurd/input")).toBe(false);
	});

	it("excludes an entry whose output rate is absurdly large", () => {
		const table = parsePriceTable({
			"absurd/output": {
				litellm_provider: "absurd",
				input_cost_per_token: 0.000003,
				output_cost_per_token: 1e300,
			},
		});
		expect(table.has("absurd/output")).toBe(false);
	});

	it("still accepts real, published rates (no false rejection)", () => {
		const table = parsePriceTable({
			"claude-sonnet-4-5": LITELLM_FIXTURE["claude-sonnet-4-5"],
		});
		expect(table.has("claude-sonnet-4-5")).toBe(true);
		expect(table.get("claude-sonnet-4-5")?.input).toBe(0.000003);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("loadPriceTable: defaults for what the caller does not inject", () => {
	it("uses the global fetch", async () => {
		const globalFetch = fakeFetch(LITELLM_FIXTURE);
		vi.stubGlobal("fetch", globalFetch);

		const table = await loadPriceTable(
			{ cacheDir: await newCacheDir() },
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
	it("creates a brand-new cache directory as 0700 (owner-only), not the default umask", async () => {
		const parent = await newCacheDir();
		const cacheDir = join(parent, "brand-new-cache-dir");

		await loadPriceTable(
			{ cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) },
			() => {},
		);

		const info = await stat(cacheDir);
		expect(info.mode & 0o777).toBe(0o700);
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
