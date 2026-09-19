import { PROVIDER_RULES, resolveRates } from "./pricing-match.js";
import {
	describeError,
	type LoadOptions,
	loadPriceTable,
	type ModelRates,
	type PriceTable,
	type Warn,
} from "./pricing-table.js";
import type { NormalizedUsageRow } from "./sources/types.js";

export interface PricedRow extends NormalizedUsageRow {
	/** Notional cost in USD; 0 when the model is unpriced (see `unpriced`). */
	notionalCost: number;
	/** True when no published rate was found for (provider, model). */
	unpriced: boolean;
}

export interface PriceOptions extends LoadOptions {
	/** Receives warnings (one short line each); defaults to writing them to stderr. */
	warn?: Warn;
}

const defaultWarn: Warn = (message) => {
	process.stderr.write(`${message}\n`);
};

/** Token counts are untrusted numbers: anything non-finite or negative counts as zero. */
function count(tokens: number): number {
	return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}

/** Cost of one bucket, or undefined when it has tokens but the table has no rate for it. */
function bucketCost(
	tokens: number,
	rate: number | undefined,
): number | undefined {
	const n = count(tokens);
	if (n === 0) return 0;
	return rate === undefined ? undefined : n * rate;
}

/**
 * Notional cost for one row, or undefined when a bucket that has tokens has no published rate
 * (the row is then flagged unpriced rather than silently under-costed).
 *
 * The buckets are disjoint, as opencode stores them (session.ts getUsage): `input` already
 * excludes cache-read and cache-write tokens, and `output` already excludes reasoning tokens.
 * Each token is therefore billed exactly once. Reasoning uses the entry's dedicated
 * `output_cost_per_reasoning_token` when it has one and the output rate otherwise, which is
 * how both LiteLLM and opencode bill it.
 *
 * Caveat: opencode releases before v1.3.17 (fix landed 2026-04-04) stored `output` INCLUDING
 * reasoning tokens, so their rows overlap the reasoning bucket. Reading those rows correctly
 * is the source adapter's job; this function trusts the disjoint-bucket contract.
 */
function notionalCost(
	tokens: NormalizedUsageRow["tokens"],
	rates: ModelRates,
): number | undefined {
	const parts = [
		bucketCost(tokens.input, rates.input),
		bucketCost(tokens.output, rates.output),
		bucketCost(tokens.reasoning, rates.reasoning ?? rates.output),
		bucketCost(tokens.cacheRead, rates.cacheRead),
		bucketCost(tokens.cacheWrite, rates.cacheWrite),
	];
	let total = 0;
	for (const part of parts) {
		if (part === undefined) return undefined;
		total += part;
	}
	return total;
}

/**
 * Notional cost = token buckets x published per-model rates from the LiteLLM price table,
 * with cache-read and cache-write priced at their own rates. The table is fetched once and
 * cached; with a usable cache this makes no network call. Rows whose model has no published
 * rate keep their tokens, cost 0 and are flagged `unpriced`.
 */
export async function price(
	rows: NormalizedUsageRow[],
	options: PriceOptions = {},
): Promise<PricedRow[]> {
	if (rows.length === 0) return [];
	const warn = options.warn ?? defaultWarn;

	// Skip the table (and any fetch) when no row's provider could be priced anyway.
	let table: PriceTable | undefined;
	if (rows.some((row) => PROVIDER_RULES.has(row.provider))) {
		try {
			table = await loadPriceTable(options, warn);
		} catch (error) {
			// loadPriceTable reports its own failures; this is the never-throw backstop.
			warn(
				`my-usage: price table unavailable (${describeError(error)}); rows will show as unpriced`,
			);
		}
	}

	const ratesByModel = new Map<string, ModelRates | undefined>();
	return rows.map((row) => {
		const id = `${row.provider}\u0000${row.model}`;
		if (!ratesByModel.has(id)) {
			const resolution = table && resolveRates(table, row.provider, row.model);
			ratesByModel.set(id, resolution?.ok ? resolution.rates : undefined);
		}
		const rates = ratesByModel.get(id);
		const cost = rates && notionalCost(row.tokens, rates);
		return cost === undefined
			? { ...row, notionalCost: 0, unpriced: true }
			: { ...row, notionalCost: cost, unpriced: false };
	});
}
