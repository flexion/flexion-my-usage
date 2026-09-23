import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	failingFetch,
	fakeFetch,
	forbiddenFetch,
	LITELLM_FIXTURE,
	LITELLM_URL,
	usageRow,
	useTempCacheDirs,
} from "./pricing.fixtures.js";
import { price } from "./pricing.js";
import { DEFAULT_MAX_CACHE_AGE_MS } from "./pricing-table.js";

const newCacheDir = useTempCacheDirs();

const M = 1_000_000;

/** One priceable row: 1M input tokens on Sonnet 4.5 (3 USD with the fixture, 0 when unpriced). */
const sonnetRow = () => usageRow({ tokens: { input: M } });

/** The single file the price cache is stored in. */
async function cacheFile(cacheDir: string): Promise<string> {
	const files = await readdir(cacheDir);
	expect(files).toHaveLength(1);
	return join(cacheDir, files[0] as string);
}

describe("price table: fetch once, then stay offline", () => {
	it("fetches the LiteLLM table when there is no cache, prices from it and caches it", async () => {
		const cacheDir = await newCacheDir();
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], { cacheDir, fetch });

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe(LITELLM_URL);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		// Exactly one file, no temp leftovers from the atomic write.
		expect(await readdir(cacheDir)).toHaveLength(1);
	});

	it("makes ZERO network calls once a valid cache exists", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });

		const offline = forbiddenFetch();
		const [row] = await price([sonnetRow(), sonnetRow()], {
			cacheDir,
			fetch: offline,
		});

		expect(offline).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("a cache within the max age is used immediately, with no fetch attempt", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		// Comfortably inside DEFAULT_MAX_CACHE_AGE_MS (24h), not just "freshly written" - proves
		// the fast path survives real age, not only a brand-new cache.
		const anHourAgo = new Date(Date.now() - 3600 * 1000);
		await utimes(file, anHourAgo, anHourAgo);

		const offline = forbiddenFetch();
		const [row] = await price([sonnetRow()], { cacheDir, fetch: offline });

		expect(offline).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	/** Older than DEFAULT_MAX_CACHE_AGE_MS by a comfortable margin, not just past it. */
	function ageCacheFile(file: string): Promise<void> {
		const wellPastMaxAge = new Date(
			Date.now() - DEFAULT_MAX_CACHE_AGE_MS - 3600 * 1000,
		);
		return utimes(file, wellPastMaxAge, wellPastMaxAge);
	}

	it("fetches fresh data and rewrites the cache when the refresh succeeds", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], { cacheDir, fetch, warn });

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(4, 9);
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
			"claude-sonnet-4-5": { input_cost_per_token: 0.000004 },
		});
		// myusage-4xu.81: a successful refresh must emit zero warnings - a mutation that
		// spuriously warns on success was previously only caught incidentally, by four unrelated
		// pre-existing tests in this file, not this one.
		expect(warn).not.toHaveBeenCalled();
	});

	it("refresh: true against an already-stale cache still makes exactly one fetch, not two (myusage-4xu.81: the manual refresh flag from PR #75 meeting the new auto-refresh-on-stale from PR #76 - both collapse onto the same one-fetch path in loadPriceTable, but nothing in the suite exercised the combination directly. PR #82's own noPriceRefresh: true tests don't reach it either: that flag short-circuits `stale` to false before this combination is ever evaluated)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			refresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("honors a realistic positive LoadOptions.maxCacheAgeMs against a real file mtime, beating a cache that's genuinely still within DEFAULT_MAX_CACHE_AGE_MS (myusage-4xu.80: the doc comment says tests use this override 'to shrink or force the cache-staleness window' - existing coverage elsewhere in this repo only ever passes maxCacheAgeMs: -1, a force-stale sentinel that bypasses isCacheStale's real age comparison entirely; nothing exercised a genuine positive threshold shrinking the window below a cache's real, unforced age. Confirmed by mutation: deleting the `?? DEFAULT_MAX_CACHE_AGE_MS` fallback in loadPriceTable fails this test - and also src/pricing-table.test.ts's existing `-1`-sentinel baseline test, since both now compare against the same hardcoded default - but neither test alone would have caught a narrower bug that only mishandled a real positive override)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		// Well within DEFAULT_MAX_CACHE_AGE_MS (24h) - the default staleness window would not
		// consider this cache stale, so a fetch here can only happen because maxCacheAgeMs
		// shrank the window below this cache's real age.
		const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
		await utimes(file, twoHoursAgo, twoHoursAgo);
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			maxCacheAgeMs: 1000,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("DEFAULT_MAX_CACHE_AGE_MS is exactly 24 hours, matching its own doc comment (myusage-4xu.80: nothing pinned this upward - every age-based test in this file derives its ages FROM this constant, so widening it to, say, 7 days would leave the whole suite green while making the doc comment factually wrong)", () => {
		expect(DEFAULT_MAX_CACHE_AGE_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("attempts one refresh, then falls back to the stale cache with a single warning when it fails", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const before = await readFile(file, "utf8");
		const fetch = failingFetch();
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], { cacheDir, fetch, warn });

		// The refresh was attempted exactly once (this is what distinguishes "never expires" from
		// "expires and retries once") ...
		expect(fetch).toHaveBeenCalledTimes(1);
		// ... it failed, so the stale cache's own data still prices the row ...
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		// ... the cache file itself is untouched (the failed fetch never overwrote it) ...
		expect(await readFile(file, "utf8")).toBe(before);
		// ... and exactly one warning was raised about it - not zero (silent staleness) and not
		// more than one.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toMatch(/refresh failed/i);
	});

	it("noPriceRefresh: true serves a real, well-aged stale cache with zero fetch attempts (myusage-4xu.84)", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);

		const offline = forbiddenFetch();
		const warn = vi.fn();
		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: offline,
			noPriceRefresh: true,
			warn,
		});

		expect(offline).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("noPriceRefresh: true still performs the very first fetch against a completely empty cache (myusage-4xu.87)", async () => {
		// cached === undefined makes the staleness check moot - there is nothing to judge stale
		// yet - so noPriceRefresh's documented scope ("skip the automatic refresh of a stale
		// cache") does not apply on a fresh install; the very first fetch must still happen. A
		// mutation that instead made noPriceRefresh short-circuit straight to an unpriced result
		// whenever there is no cache would survive every other noPriceRefresh test in this file,
		// since all of them seed a cache before setting the flag.
		const cacheDir = await newCacheDir();
		const fetch = fakeFetch(LITELLM_FIXTURE);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			noPriceRefresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("noPriceRefresh: true does not block an explicit refresh: true on the same stale cache", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		await ageCacheFile(file);
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			noPriceRefresh: true,
			refresh: true,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.notionalCost).toBeCloseTo(4, 9);
	});

	it("shows a model missing from the cached table as unpriced until a refresh", async () => {
		const cacheDir = await newCacheDir();
		const { "claude-opus-5": _dropped, ...older } = LITELLM_FIXTURE;
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(older) });

		const opus = usageRow({ model: "claude-opus-5", tokens: { input: M } });
		const offline = forbiddenFetch();
		const [before] = await price([opus], { cacheDir, fetch: offline });
		expect(before).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(offline).not.toHaveBeenCalled();

		const [after] = await price([opus], {
			cacheDir,
			fetch: fakeFetch(LITELLM_FIXTURE),
			refresh: true,
		});
		expect(after?.unpriced).toBe(false);
		expect(after?.notionalCost).toBeCloseTo(5, 9);
	});

	it("refresh: true fetches once even with a valid cache and replaces the cache", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const repriced = {
			...LITELLM_FIXTURE,
			"claude-sonnet-4-5": {
				...LITELLM_FIXTURE["claude-sonnet-4-5"],
				input_cost_per_token: 0.000004,
			},
		};
		const fetch = fakeFetch(repriced);

		const [refreshed] = await price([sonnetRow()], {
			cacheDir,
			fetch,
			refresh: true,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(refreshed?.notionalCost).toBeCloseTo(4, 9);

		// ...and the next plain call is served from the replaced cache, offline.
		const [next] = await price([sonnetRow()], {
			cacheDir,
			fetch: forbiddenFetch(),
		});
		expect(next?.notionalCost).toBeCloseTo(4, 9);
	});

	it("fetches the table for rows from a provider without a rule, since the fallback prices them", async () => {
		const fetch = fakeFetch(LITELLM_FIXTURE);
		const [row] = await price(
			[
				usageRow({
					provider: "github-copilot",
					model: "claude-opus-5",
					tokens: { input: M },
				}),
			],
			{ cacheDir: await newCacheDir(), fetch },
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(row?.notionalCost).toBeCloseTo(5, 9);
	});
});

describe("price table: fetch failures", () => {
	const failures: [string, () => typeof fetch][] = [
		[
			"network error",
			() =>
				vi.fn<typeof fetch>(async () =>
					Promise.reject(new TypeError("fetch failed")),
				),
		],
		["HTTP 503", () => fakeFetch("service unavailable", { status: 503 })],
		["not JSON", () => fakeFetch("<html>nope</html>")],
		["JSON array", () => fakeFetch([1, 2, 3])],
		["JSON null", () => fakeFetch("null")],
		["no usable entries", () => fakeFetch({ nothing: { here: true } })],
	];

	it.each(failures)(
		"%s with a cache: falls back to the cached table and keeps it",
		async (_name, makeFetch) => {
			const cacheDir = await newCacheDir();
			await price([sonnetRow()], {
				cacheDir,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});
			const file = await cacheFile(cacheDir);
			const before = await readFile(file, "utf8");
			const warn = vi.fn();

			const [row] = await price([sonnetRow()], {
				cacheDir,
				fetch: makeFetch(),
				refresh: true,
				warn,
			});

			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(3, 9);
			expect(await readFile(file, "utf8")).toBe(before);
			expect(await readdir(cacheDir)).toHaveLength(1);
			// One short line saying the refresh failed.
			expect(warn).toHaveBeenCalledTimes(1);
		},
	);

	it.each(failures)(
		"%s with no cache: every row is unpriced, one warning, no throw, nothing cached",
		async (_name, makeFetch) => {
			const cacheDir = await newCacheDir();
			const warn = vi.fn();
			const rows = [
				sonnetRow(),
				usageRow({ provider: "openai", model: "gpt-5", tokens: { output: 5 } }),
			];

			const out = await price(rows, { cacheDir, fetch: makeFetch(), warn });

			expect(out).toHaveLength(2);
			for (const row of out)
				expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(out[0]?.tokens.input).toBe(M);
			expect(warn).toHaveBeenCalledTimes(1);
			const message = String(warn.mock.calls[0]?.[0]);
			expect(message).not.toContain("\n");
			expect(message.length).toBeLessThan(200);
			expect(message).toMatch(/price table/i);
			expect(await readdir(cacheDir)).toEqual([]);
		},
	);

	it("writes the default warning as one line on stderr", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await price([sonnetRow()], {
				cacheDir: await newCacheDir(),
				fetch: vi.fn<typeof fetch>(async () =>
					Promise.reject(new TypeError("fetch failed")),
				),
			});
			const lines = write.mock.calls.map((call) => String(call[0]));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^[^\n]+\n$/);
		} finally {
			write.mockRestore();
		}
	});

	it("never throws, even when an option itself blows up", async () => {
		const warn = vi.fn();
		const options = {
			get cacheDir(): string {
				throw new Error("boom");
			},
			fetch: forbiddenFetch(),
			warn,
		};

		const [row] = await price([sonnetRow()], options);

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("gives up on a hung fetch after the timeout instead of hanging", async () => {
		const hung = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch: hung,
			timeoutMs: 25,
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("rejects a valid table over the size cap, whether the size is declared or streamed", async () => {
		const body = JSON.stringify(LITELLM_FIXTURE);
		const cap = 1000;
		expect(body.length).toBeGreaterThan(cap * 4);
		const declared = vi.fn<typeof fetch>(
			async () =>
				new Response(body, {
					headers: { "content-length": String(body.length) },
				}),
		);
		// A stream carries no content-length, so only counting bytes can catch it.
		const streamed = vi.fn<typeof fetch>(async () => {
			const bytes = new TextEncoder().encode(body);
			return new Response(
				new ReadableStream({
					start(controller) {
						for (let i = 0; i < bytes.length; i += 300) {
							controller.enqueue(bytes.slice(i, i + 300));
						}
						controller.close();
					},
				}),
			);
		});

		for (const fetch of [declared, streamed]) {
			const cacheDir = await newCacheDir();
			const warn = vi.fn();
			const [row] = await price([sonnetRow()], {
				cacheDir,
				fetch,
				maxBytes: cap,
				warn,
			});
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(await readdir(cacheDir)).toEqual([]);
		}
	});

	it("does not download a body whose declared size is over the cap", async () => {
		let pulled = 0;
		let cancelled = false;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							pulled++;
							controller.enqueue(new Uint8Array(300));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-length": "999999" } },
				),
		);

		await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch,
			maxBytes: 1000,
			warn: () => {},
		});

		// The stream primes itself once on construction; any further pull means we read it.
		expect(pulled).toBeLessThanOrEqual(1);
		expect(cancelled).toBe(true);
	});

	it("accepts the same table when it fits under the size cap", async () => {
		const [row] = await price([sonnetRow()], {
			cacheDir: await newCacheDir(),
			fetch: fakeFetch(LITELLM_FIXTURE),
			maxBytes: JSON.stringify(LITELLM_FIXTURE).length,
		});
		expect(row?.notionalCost).toBeCloseTo(3, 9);
	});

	it("treats a cache file over the size cap as absent", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: vi.fn<typeof fetch>(async () =>
				Promise.reject(new TypeError("fetch failed")),
			),
			maxBytes: 1000,
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("still prices from the network table when the cache cannot be written, with one warning", async () => {
		const cacheDir = await newCacheDir();
		// A file where the cache directory should be makes mkdir fail.
		const blocker = join(cacheDir, "blocker");
		await writeFile(blocker, "not a directory");
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir: join(blocker, "nested"),
			fetch: fakeFetch(LITELLM_FIXTURE),
			warn,
		});

		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3, 9);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("price table: untrusted cache and body", () => {
	const corrupt: [string, string][] = [
		["garbage text", "this is not json {{{"],
		["truncated JSON", '{"claude-sonnet-4-5": {"litellm_provider": "anth'],
		["empty file", ""],
		["JSON array", "[]"],
		["object with no usable entries", '{"a": 1, "b": {"c": 2}}'],
	];

	it.each(corrupt)(
		"a corrupt cache (%s) is treated as absent: refetched and repaired",
		async (_name, contents) => {
			const cacheDir = await newCacheDir();
			await price([sonnetRow()], {
				cacheDir,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});
			const file = await cacheFile(cacheDir);
			await writeFile(file, contents);
			const fetch = fakeFetch(LITELLM_FIXTURE);

			const [row] = await price([sonnetRow()], { cacheDir, fetch });

			expect(fetch).toHaveBeenCalledTimes(1);
			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(3, 9);
			expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty(
				"claude-sonnet-4-5",
			);
		},
	);

	it("a corrupt cache and a failed fetch means unpriced, not a throw", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		await writeFile(await cacheFile(cacheDir), "garbage");
		const warn = vi.fn();

		const [row] = await price([sonnetRow()], {
			cacheDir,
			fetch: vi.fn<typeof fetch>(async () =>
				Promise.reject(new TypeError("fetch failed")),
			),
			warn,
		});

		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("ignores malformed entries one by one and still prices the good ones", async () => {
		// Real ids and rates, deliberately corrupted one field at a time.
		const good = LITELLM_FIXTURE["claude-sonnet-4-5"];
		const table = {
			"claude-sonnet-4-5": good,
			// rate as a string (JS would silently coerce it in arithmetic)
			"claude-opus-5": {
				...LITELLM_FIXTURE["claude-opus-5"],
				input_cost_per_token: "0.000005",
			},
			// negative rate
			"gpt-5": { ...LITELLM_FIXTURE["gpt-5"], output_cost_per_token: -0.00001 },
			// null cache-read rate present but invalid
			"gpt-4o-mini": {
				...LITELLM_FIXTURE["gpt-4o-mini"],
				cache_read_input_token_cost: null,
			},
			// cache-write rate as a string, present but invalid (mirrors the cache-read case above)
			"claude-haiku-4-5": {
				...LITELLM_FIXTURE["claude-haiku-4-5"],
				cache_creation_input_token_cost: "0.00000125",
			},
			// missing output rate
			"gpt-5.1": {
				litellm_provider: "openai",
				input_cost_per_token: 0.00000125,
			},
			// invalid reasoning rate
			"gemini/gemini-robotics-er-2-preview": {
				...LITELLM_FIXTURE["gemini/gemini-robotics-er-2-preview"],
				output_cost_per_reasoning_token: "free",
			},
			// not an object at all
			"xai/grok-4": 7,
			"deepseek/deepseek-chat": ["not", "an", "object"],
		};
		const rows = [
			sonnetRow(),
			usageRow({ model: "claude-opus-5", tokens: { input: M } }),
			usageRow({ provider: "openai", model: "gpt-5", tokens: { input: M } }),
			usageRow({
				provider: "openai",
				model: "gpt-4o-mini",
				tokens: { input: M },
			}),
			usageRow({ model: "claude-haiku-4-5", tokens: { input: M } }),
			usageRow({ provider: "openai", model: "gpt-5.1", tokens: { input: M } }),
			usageRow({ provider: "xai", model: "grok-4", tokens: { input: M } }),
			usageRow({
				provider: "deepseek",
				model: "deepseek-chat",
				tokens: { input: M },
			}),
		];

		const out = await price(rows, {
			cacheDir: await newCacheDir(),
			fetch: fakeFetch(table),
			warn: () => {},
		});

		expect(out[0]?.unpriced).toBe(false);
		expect(out[0]?.notionalCost).toBeCloseTo(3, 9);
		for (const row of out.slice(1))
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
	});

	it("treats a table whose keys look like prototype properties as plain data", async () => {
		// Built by hand: JSON.stringify would not emit a real "__proto__" key.
		const entry =
			'{"litellm_provider":"anthropic","input_cost_per_token":1,"output_cost_per_token":1}';
		const rest = JSON.stringify(LITELLM_FIXTURE).slice(1, -1);
		const body = `{"__proto__":${entry},"constructor":${entry},${rest}}`;

		const out = await price(
			[
				sonnetRow(),
				usageRow({ model: "constructor", tokens: { input: 1 } }),
				usageRow({ model: "__proto__", tokens: { input: 1 } }),
			],
			{ cacheDir: await newCacheDir(), fetch: fakeFetch(body), warn: () => {} },
		);

		expect(out[0]?.notionalCost).toBeCloseTo(3, 9);
		// Priced only because the table really carries those keys.
		expect(out[1]?.notionalCost).toBeCloseTo(1, 9);
		expect(out[2]?.notionalCost).toBeCloseTo(1, 9);
		// ...and nothing leaked onto Object.prototype.
		expect(({} as Record<string, unknown>).litellm_provider).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("input_cost_per_token");
	});
});

describe("price table: cache location", () => {
	const strayRelative = "relative-xdg-cache-test";
	afterEach(async () => {
		await rm(strayRelative, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME/my-usage when set", async () => {
		const root = await newCacheDir();
		const home = join(root, "home");

		await price([sonnetRow()], {
			env: { XDG_CACHE_HOME: join(root, "xdg") },
			homeDir: home,
			fetch: fakeFetch(LITELLM_FIXTURE),
		});

		expect(await readdir(join(root, "xdg", "my-usage"))).toHaveLength(1);
		expect(existsSync(home)).toBe(false);
	});

	it.each([
		["unset", {}],
		["empty", { XDG_CACHE_HOME: "" }],
		["relative", { XDG_CACHE_HOME: "relative-xdg-cache-test" }],
	])(
		"falls back to ~/.cache/my-usage when XDG_CACHE_HOME is %s",
		async (_name, env) => {
			const root = await newCacheDir();
			const home = join(root, "home");
			await mkdir(home);

			await price([sonnetRow()], {
				env,
				homeDir: home,
				fetch: fakeFetch(LITELLM_FIXTURE),
			});

			expect(await readdir(join(home, ".cache", "my-usage"))).toHaveLength(1);
			expect(existsSync(strayRelative)).toBe(false);
		},
	);
});
