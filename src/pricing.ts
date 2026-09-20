import { type Resolution, resolveRates } from "./pricing-match.js";
import {
	describeError,
	type LoadOptions,
	loadPriceTable,
	type ModelRates,
	type PriceTable,
	type Warn,
} from "./pricing-table.js";
import type { NormalizedUsageRow } from "./sources/types.js";

/**
 * The exact text to show beside a cost that came from the first-party fallback (see
 * `PricedRow.priceLabel`). A string literal type on purpose: consumers compare against this
 * constant instead of matching on prose.
 */
export const FIRST_PARTY_FALLBACK_LABEL = "notional at first-party list price";

export interface PricedRow extends NormalizedUsageRow {
	/** Notional cost in USD; 0 when the model is unpriced (see `unpriced`). */
	notionalCost: number;
	/** True when no published rate was found for (provider, model). */
	unpriced: boolean;
	/**
	 * Set only when the row's provider has no explicit pricing rule and the cost is the model
	 * maker's list price found by model id. That figure is approximate: it can be off by 10
	 * percent or more where a gateway adds markup or uses regional or discounted price lists.
	 * Absent on rows priced through their own provider's rule and on unpriced rows.
	 */
	priceLabel?: typeof FIRST_PARTY_FALLBACK_LABEL;
}

export interface PriceOptions extends LoadOptions {
	/** Receives warnings (one short line each); defaults to writing them to stderr. */
	warn?: Warn;
}

const defaultWarn: Warn = (message) => {
	process.stderr.write(`${message}\n`);
};

/**
 * Wraps a warn function so it can never make `price()` reject: a caller-injected warn can
 * throw, and the default warn can raise EPIPE when stderr is a closed pipe. Warning delivery
 * is best-effort and must never take priority over returning priced rows.
 */
function safeWarn(warn: Warn): Warn {
	return (message) => {
		try {
			warn(message);
		} catch {
			// Best-effort: a broken warning channel must not crash pricing.
		}
	};
}

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
 *
 * A row from a provider with no explicit rule (a gateway, subscription plan or custom
 * endpoint) is priced at the model maker's list price when its bare model id matches exactly
 * one first-party rate set, and carries `priceLabel`; see `resolveRates` for the rules and the
 * accuracy limit. Every provider can therefore be priced, so any row needs the table.
 */
export async function price(
	rows: NormalizedUsageRow[],
	options: PriceOptions = {},
): Promise<PricedRow[]> {
	if (rows.length === 0) return [];
	const warn = safeWarn(options.warn ?? defaultWarn);

	let table: PriceTable | undefined;
	try {
		table = await loadPriceTable(options, warn);
	} catch (error) {
		// loadPriceTable reports its own failures; this is the never-throw backstop.
		warn(
			`my-usage: price table unavailable (${describeError(error)}); rows will show as unpriced`,
		);
	}

	const resolutionByModel = new Map<string, Resolution | undefined>();
	return rows.map((row) => {
		const id = `${row.provider}\u0000${row.model}`;
		if (!resolutionByModel.has(id)) {
			resolutionByModel.set(
				id,
				table && resolveRates(table, row.provider, row.model),
			);
		}
		const unpriced = { ...row, notionalCost: 0, unpriced: true };
		const resolution = resolutionByModel.get(id);
		if (!resolution?.ok) return unpriced;
		const cost = notionalCost(row.tokens, resolution.rates);
		if (cost === undefined) return unpriced;
		const priced = { ...row, notionalCost: cost, unpriced: false };
		return resolution.fallback
			? { ...priced, priceLabel: FIRST_PARTY_FALLBACK_LABEL }
			: priced;
	});
}
