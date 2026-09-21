// Usage-source adapter seam. See docs/design/slice-1.md.
// Tracked: myusage-4xu.3 (opencode reader), myusage-ocq (pluggable sources).

/** One assistant response's usage, normalized across sources. */
export interface NormalizedUsageRow {
	/** Which source produced this row, e.g. "opencode". */
	source: string;
	/** Provider as stored by the source, e.g. "amazon-bedrock", "openai". */
	provider: string;
	/** Model id in the source's own form (normalized to canonical at pricing time). */
	model: string;
	/** Response completion time. */
	timestamp: Date;
	sessionId: string;
	/** Stable per-response id, used as the idempotency key. */
	messageId: string;
	/**
	 * Every bucket must be finite and non-negative before `UsageSource.read()` returns the row.
	 * Nothing downstream re-validates or clamps: `pricing.ts`'s `price()` copies these values
	 * unchanged onto `PricedRow.tokens`, and `aggregate.ts`'s `tokenTotal` sums them as given.
	 * The opencode adapter holds this via its own `bucket()` clamp (see opencode.ts); any future
	 * adapter must do the same, or its NaN/negative values will silently corrupt aggregated
	 * totals.
	 */
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/** A located local session store for a given source. */
export interface SourceHandle {
	source: string;
	path: string;
}

/** A pluggable usage source (one per agent/tool). */
export interface UsageSource {
	readonly name: string;
	/** Locate this source's local store(s); empty when the source is not present. */
	discover(): Promise<SourceHandle[]>;
	/**
	 * Read normalized per-response usage from a handle. Token buckets must already be finite,
	 * non-negative numbers on return; see `NormalizedUsageRow.tokens`.
	 */
	read(handle: SourceHandle): Promise<NormalizedUsageRow[]>;
}
