// LiteLLM price table: fetch once, cache locally, validate everything.
//
// Source of truth: BerriAI/litellm, model_prices_and_context_window.json (the same URL LiteLLM
// itself uses as its default price-map URL). Its published JSON Schema
// (model_prices_and_context_window.schema.json) says every top-level key except `sample_spec`
// and `fallback_generalizations` is a model entry, all costs are USD per unit, and consumers
// should ignore unknown fields. The body is treated as untrusted data: it is only ever parsed
// with JSON.parse and read field by field, never evaluated.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveProxy } from "./proxy.js";

export const PRICE_TABLE_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** The published table is ~3 MB; this leaves headroom without letting a bad response fill memory. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Maximum age before a cached price table is stale enough to trigger one refresh attempt on
 * the next run, instead of being served forever (see `isCacheStale`). LiteLLM's table moves on
 * the order of days to weeks - new models land, rates get corrected - so 24 hours bounds how
 * long a newly-added or repriced model can stay unpriced to about a day, while keeping the
 * common case (rerunning within the same day) on the fast, no-fetch path this module is built
 * around. Overridable via `LoadOptions.maxCacheAgeMs` for callers - and tests - that need a
 * different bound.
 */
export const DEFAULT_MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

const CACHE_DIR_NAME = "my-usage";
const CACHE_FILE_NAME = "litellm-model-prices.json";

/** Top-level keys in the table that are not model entries (per LiteLLM's schema). */
const NON_MODEL_KEYS: ReadonlySet<string> = new Set([
	"sample_spec",
	"fallback_generalizations",
]);

/** Published per-token rates for one table entry, in USD per token. */
export interface ModelRates {
	/** LiteLLM's `litellm_provider` slug for this entry. */
	provider: string;
	/** `input_cost_per_token` */
	input: number;
	/** `output_cost_per_token` */
	output: number;
	/** `cache_read_input_token_cost`, when published. */
	cacheRead?: number;
	/** `cache_creation_input_token_cost`, when published. */
	cacheWrite?: number;
	/** `output_cost_per_reasoning_token`, when billed separately. */
	reasoning?: number;
}

/** Table key (LiteLLM model id, optionally provider-prefixed) to its rates. */
export type PriceTable = ReadonlyMap<string, ModelRates>;

export type Warn = (message: string) => void;

export interface LoadOptions {
	/** Fetch implementation; defaults to the global `fetch`. */
	fetch?: typeof globalThis.fetch;
	/** Directory holding the cached table; defaults to `<XDG cache dir>/my-usage`. */
	cacheDir?: string;
	/** Fetch even when a usable cache exists. Off by default: with a cache, nothing is sent. */
	refresh?: boolean;
	/**
	 * Maximum cache age, in milliseconds, before a stale cache triggers one refresh attempt on
	 * the next run; defaults to `DEFAULT_MAX_CACHE_AGE_MS`. A cache within this age is returned
	 * immediately, with no fetch, exactly like a cache hit today - unless `refresh` is also set.
	 */
	maxCacheAgeMs?: number;
	/** Fetch timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum accepted response size in bytes. */
	maxBytes?: number;
	/** Environment used to locate the cache dir; defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Home directory used when XDG_CACHE_HOME is unusable; defaults to `os.homedir()`. */
	homeDir?: string;
	/**
	 * Filesystem remove implementation, used only to delete a failed cache write's stray temp
	 * file; defaults to `node:fs/promises`' `rm`. The same injected-seam shape as `fetch`,
	 * so the cleanup-failure path can be proven with a real, rejecting fake instead of a mock
	 * of `node:fs/promises` itself.
	 */
	rm?: typeof rm;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real published rates are USD per token, always far below 1 (the priciest entries in the
 * table run a few times 1e-5). A rate above this ceiling is corrupted data, not a legitimate
 * price - the common failure mode is a per-million rate copied in as-is - so the whole entry
 * is rejected rather than pricing rows at an absurd notional cost.
 */
const MAX_RATE_PER_TOKEN = 1;

function isRate(value: unknown): value is number {
	// No separate Number.isFinite check: NaN fails >= 0, +Infinity fails <= MAX_RATE_PER_TOKEN,
	// and -Infinity fails >= 0, so the range check below already excludes every non-finite value.
	return typeof value === "number" && value >= 0 && value <= MAX_RATE_PER_TOKEN;
}

/** Reads an optional rate: absent is fine, present-but-invalid rejects the whole entry. */
function optionalRate(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return isRate(value) ? value : null;
}

function parseEntry(value: unknown): ModelRates | undefined {
	if (!isRecord(value)) return undefined;
	const provider = value.litellm_provider;
	const input = value.input_cost_per_token;
	const output = value.output_cost_per_token;
	if (typeof provider !== "string" || !isRate(input) || !isRate(output)) {
		return undefined;
	}
	const cacheRead = optionalRate(value.cache_read_input_token_cost);
	const cacheWrite = optionalRate(value.cache_creation_input_token_cost);
	const reasoning = optionalRate(value.output_cost_per_reasoning_token);
	if (cacheRead === null || cacheWrite === null || reasoning === null) {
		return undefined;
	}
	const rates: ModelRates = { provider, input, output };
	if (cacheRead !== undefined) rates.cacheRead = cacheRead;
	if (cacheWrite !== undefined) rates.cacheWrite = cacheWrite;
	if (reasoning !== undefined) rates.reasoning = reasoning;
	return rates;
}

/**
 * Keeps the entries that carry usable token rates and ignores everything else: non-model
 * entries, entries without numeric input/output rates, and entries with an invalid optional
 * rate. Never throws.
 */
export function parsePriceTable(raw: unknown): PriceTable {
	const table = new Map<string, ModelRates>();
	if (!isRecord(raw)) return table;
	for (const [key, value] of Object.entries(raw)) {
		if (NON_MODEL_KEYS.has(key)) continue;
		const rates = parseEntry(value);
		if (rates) table.set(key, rates);
	}
	return table;
}

/** A table is usable when the body is JSON and at least one entry survives validation. */
function parseBody(text: string): PriceTable | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const table = parsePriceTable(raw);
	return table.size > 0 ? table : undefined;
}

/** `$XDG_CACHE_HOME/my-usage` when that is set and absolute (per the XDG spec), else `~/.cache/my-usage`. */
export function resolveCacheDir(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const xdg = env.XDG_CACHE_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".cache");
	return join(base, CACHE_DIR_NAME);
}

/**
 * Whether a cache this old should trigger a refresh attempt on the next run. A pure decision
 * over plain numbers - exercised directly in tests, so nothing about its truth table depends
 * on real time passing or a real file's mtime. The boundary is inclusive of `maxAgeMs` itself
 * (an age exactly at the limit still counts as fresh), matching this module's other ceiling
 * check (`isRate`'s `<= MAX_RATE_PER_TOKEN`).
 */
export function isCacheStale(ageMs: number, maxAgeMs: number): boolean {
	return ageMs > maxAgeMs;
}

/** One short, single-line reason suitable for a warning. */
export function describeError(error: unknown): string {
	if (error instanceof Error && error.name === "TimeoutError")
		return "timed out";
	let message = error instanceof Error ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	if (isRecord(cause) && typeof cause.code === "string") {
		message = `${message}: ${cause.code}`;
	}
	return message.replace(/\s+/g, " ").slice(0, 100);
}

async function readCache(
	path: string,
	maxBytes: number,
): Promise<{ table: PriceTable; ageMs: number } | undefined> {
	let text: string;
	let mtimeMs: number;
	try {
		const [content, info] = await Promise.all([
			readFile(path, "utf8"),
			stat(path),
		]);
		text = content;
		mtimeMs = info.mtimeMs;
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(text, "utf8") > maxBytes) return undefined;
	const table = parseBody(text);
	if (!table) return undefined;
	return { table, ageMs: Date.now() - mtimeMs };
}

/** Reads the body as text, refusing more than `maxBytes` whether or not the size was declared. */
async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	// No separate Number.isFinite check: a missing header parses to 0 and a non-numeric one to
	// NaN, and both already fail the comparison below. A header that resolves to Infinity now
	// fails it too - a reasonable outcome, and the byte-counted read below enforces the real
	// cap regardless of what any header claims.
	if (declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new Error("response too large");
	}
	if (!response.body) {
		throw new Error("response has no body");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error("response too large");
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchTable(
	options: LoadOptions,
	env: Readonly<Record<string, string | undefined>>,
): Promise<{ table: PriceTable; text: string }> {
	const fetchOptions: RequestInit = {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	};

	// Scoped out here, not inside the proxied branch below, because closing it has to wait
	// until this function's whole body - including reading the response - is done (see the
	// finally block at the bottom for why).
	let agent: ProxyAgent | undefined;
	try {
		let response: Response;
		if (options.fetch) {
			// An injected fetch is used exactly as given: it is the seam every other test in
			// this file relies on, and it bypasses the proxy question entirely (see
			// LoadOptions.fetch).
			response = await options.fetch(PRICE_TABLE_URL, fetchOptions);
		} else {
			// Node's global fetch does not honor HTTPS_PROXY/HTTP_PROXY on its own (undici only
			// reads them when NODE_USE_ENV_PROXY is set, which this repo's Node floor cannot
			// rely on - see resolveProxy's doc comment). Routing through a proxy when one is
			// configured means dispatching through an explicit undici ProxyAgent instead.
			const proxyUrl = resolveProxy(env, PRICE_TABLE_URL);
			// New URL(...) inside ProxyAgent throws synchronously on an unusable value, before
			// any request - proxied or direct - is ever attempted; the caller's catch turns
			// that into the module's normal "price table unavailable" warning.
			agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
			if (agent) {
				// Node's global fetch (globalThis.fetch) is backed by an internal undici fork
				// bundled with Node itself, a different build from the "undici" package this
				// ProxyAgent comes from. On this repo's Node floor (22.13.0) the two are not
				// dispatcher-interface-compatible: passing this ProxyAgent as globalThis.fetch's
				// `dispatcher` throws synchronously, "invalid onRequestStart method" - confirmed
				// directly against node:22.13.0-bookworm and node:22-bookworm (both fail), while
				// node:26-bookworm passes, so this is a Node-version skew, not a platform one.
				// The npm "undici" package's own fetch() always matches its own ProxyAgent
				// because they ship from the same install - reproduced directly: swapping only
				// this call from globalThis.fetch to undici's fetch on 22.13.0 makes the CONNECT
				// arrive at a real local proxy exactly as expected. Scoped to only the proxied
				// path so the far more common no-proxy path keeps using globalThis.fetch
				// unchanged.
				response = await undiciFetch(PRICE_TABLE_URL, {
					...fetchOptions,
					dispatcher: agent,
				});
			} else {
				response = await globalThis.fetch(PRICE_TABLE_URL, fetchOptions);
			}
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new Error(`HTTP ${response.status}`);
		}
		const text = await readCapped(
			response,
			options.maxBytes ?? DEFAULT_MAX_BYTES,
		);
		const table = parseBody(text);
		if (!table) throw new Error("response is not a usable price table");
		return { table, text };
	} finally {
		// ProxyAgent#close() waits for every in-flight request on its pool to finish; a
		// fetch() call resolves as soon as headers arrive, well before the body is read, so
		// the request is still "in flight" by the agent's own accounting until readCapped
		// above has fully consumed (or cancelled) the body. Closing first leaves the body
		// stream paused with backpressure and close() itself never resolves until the
		// AbortSignal above fires - reproduced directly against a real local proxy tunneling a
		// real ~620KB body: closing before reading hung for the full timeout every time,
		// closing after took under 100ms. This finally wraps the whole fetch-and-read sequence
		// specifically so close() only ever runs once the body is already spoken for, on every
		// path (success, a cancelled oversized body, an HTTP error's own cancel() above).
		await agent?.close();
	}
}

/** Temp file + rename, so a reader never sees a half-written cache. */
async function writeCache(
	dir: string,
	path: string,
	text: string,
	removeFn: typeof rm,
): Promise<void> {
	// 0700 (owner-only): the file itself is already written 0600, so the directory should not
	// be world- or group-readable under the default umask either.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, text, { mode: 0o600 });
		await rename(temp, path);
	} catch (error) {
		// Best effort: a failed cleanup must not mask the write error. See "Failed cleanup"
		// in AGENTS.md - the swallow is proven by a real test that injects a rejecting `rm`.
		await removeFn(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Returns the price table, or undefined when none is available.
 *
 * - A usable cached copy no older than `maxCacheAgeMs` (see `DEFAULT_MAX_CACHE_AGE_MS`) is
 *   returned as-is, with no network call.
 * - A cache older than that, or `refresh: true`, triggers exactly one fetch attempt.
 * - If that fetch succeeds, the fresh table is validated, cached for next time, and used.
 * - If it fails and a cache exists (however old), the cache is used, with one warning line.
 *   If there is no cache, the caller gets undefined. Failures never throw.
 * - A corrupt or empty cache file counts as no cache.
 */
export async function loadPriceTable(
	options: LoadOptions,
	warn: Warn,
): Promise<PriceTable | undefined> {
	const env = options.env ?? process.env;
	const cacheDir =
		options.cacheDir ?? resolveCacheDir(env, options.homeDir ?? homedir());
	const cachePath = join(cacheDir, CACHE_FILE_NAME);

	const cached = await readCache(
		cachePath,
		options.maxBytes ?? DEFAULT_MAX_BYTES,
	);
	const stale =
		cached !== undefined &&
		isCacheStale(
			cached.ageMs,
			options.maxCacheAgeMs ?? DEFAULT_MAX_CACHE_AGE_MS,
		);
	if (cached && !options.refresh && !stale) return cached.table;

	let fetched: { table: PriceTable; text: string };
	try {
		fetched = await fetchTable(options, env);
	} catch (error) {
		const reason = describeError(error);
		if (cached) {
			warn(
				`my-usage: price table refresh failed (${reason}); using the cached copy`,
			);
			return cached.table;
		}
		warn(
			`my-usage: price table unavailable (${reason}); rows will show as unpriced`,
		);
		return undefined;
	}

	try {
		await writeCache(cacheDir, cachePath, fetched.text, options.rm ?? rm);
	} catch (error) {
		warn(`my-usage: could not cache the price table (${describeError(error)})`);
	}
	return fetched.table;
}
