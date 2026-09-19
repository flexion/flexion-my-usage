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
	/** Read normalized per-response usage from a handle. */
	read(handle: SourceHandle): Promise<NormalizedUsageRow[]>;
}
