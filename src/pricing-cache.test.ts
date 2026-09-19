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
import { price } from "./pricing.js";
import {
	fakeFetch,
	forbiddenFetch,
	LITELLM_FIXTURE,
	LITELLM_URL,
	usageRow,
	useTempCacheDirs,
} from "./pricing.fixtures.js";

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

	it("does not expire the cache: an old cache is used without any fetch", async () => {
		const cacheDir = await newCacheDir();
		await price([sonnetRow()], { cacheDir, fetch: fakeFetch(LITELLM_FIXTURE) });
		const file = await cacheFile(cacheDir);
		const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
		await utimes(file, twoYearsAgo, twoYearsAgo);

		const offline = forbiddenFetch();
		const [row] = await price([sonnetRow()], { cacheDir, fetch: offline });

		expect(offline).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(false);
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

	it("does not fetch when no row's provider can be priced", async () => {
		const fetch = forbiddenFetch();
		const [row] = await price(
			[usageRow({ provider: "github-copilot", model: "claude-opus-5" })],
			{ cacheDir: await newCacheDir(), fetch },
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(row?.unpriced).toBe(true);
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

	it("rejects a response over the size cap, declared or streamed, and does not cache it", async () => {
		const declared = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify(LITELLM_FIXTURE), {
					headers: { "content-length": "999999" },
				}),
		);
		const streamed = vi.fn<typeof fetch>(async () => {
			const chunk = new TextEncoder().encode(
				JSON.stringify(LITELLM_FIXTURE).slice(0, 600),
			);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(chunk);
						controller.enqueue(chunk);
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
				maxBytes: 1000,
				warn,
			});
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(await readdir(cacheDir)).toEqual([]);
		}
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
