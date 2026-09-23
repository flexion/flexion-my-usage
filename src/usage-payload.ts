// The data route's wire contract (myusage-4xu.118): what GET /api/usage.json returns and the
// frontend under src/web/ reads. Kept free of imports on purpose - src/web/ type-checks against
// this file under its own DOM-only tsconfig, so anything this file pulled in (node:* modules,
// the pricing pipeline) would drag Node's types into the browser build's program too.
// aggregate.ts re-exports DayBucket/ModelTotals from here, so the aggregation code and the page
// share one definition instead of two that could drift.

/** Where the server serves the payload and the page fetches it from. */
export const DATA_PATH = "/api/usage.json";

export interface ModelTotals {
	provider: string;
	model: string;
	notionalCost: number;
	tokens: number;
	/** Tokens billed at cost 0 because no published rate covered them. */
	unpricedTokens: number;
}

export interface DayBucket {
	/** Local calendar day, YYYY-MM-DD. */
	day: string;
	byModel: Record<string, ModelTotals>;
	notionalCost: number;
	tokens: number;
	responses: number;
}

/**
 * How many of the discovered databases failed to read, and how many were discovered in total
 * (myusage-4xu.98). A per-database read failure is non-fatal - the run continues on what's left,
 * with a warning on stderr - so the page names the count itself; otherwise a browser showing a
 * subset of the user's data reads as the whole picture. `skipped === total` never reaches the
 * page: that all-failed case is runCli's own EXIT_FAILURE branch, which returns before serving.
 */
export interface SkippedDatabases {
	skipped: number;
	total: number;
}

export interface UsagePayload {
	/** One bucket per day in the window, oldest first, zero-filled (see aggregateDaily). */
	days: DayBucket[];
	skipped: SkippedDatabases;
}

/** The data route's response body. */
export function usagePayloadJson(payload: UsagePayload): string {
	return JSON.stringify(payload);
}
