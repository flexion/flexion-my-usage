import type { NormalizedUsageRow } from "./sources/types.js";

export interface PricedRow extends NormalizedUsageRow {
	/** Notional cost in USD; 0 when the model is unpriced (see `unpriced`). */
	notionalCost: number;
	/** True when no published rate was found for (provider, model). */
	unpriced: boolean;
}

// Notional cost = token buckets x published per-model rates (cache-read and cache-write
// priced separately), from the LiteLLM public price table. Tracked: myusage-4xu.4.
export async function price(rows: NormalizedUsageRow[]): Promise<PricedRow[]> {
	// TODO(myusage-4xu.4): fetch+cache the LiteLLM table, normalize (provider, model) to a
	// canonical id, and price each token bucket. Unknown model -> notionalCost 0, unpriced true.
	return rows.map((row) => ({ ...row, notionalCost: 0, unpriced: true }));
}
