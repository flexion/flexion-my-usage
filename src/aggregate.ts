import type { PricedRow } from "./pricing.js";

export interface ModelTotals {
	notionalCost: number;
	tokens: number;
}

export interface DayBucket {
	/** Local calendar day, YYYY-MM-DD. */
	day: string;
	byModel: Record<string, ModelTotals>;
	notionalCost: number;
	tokens: number;
}

// Roll priced rows into daily buckets over a window, split by model. Tracked: myusage-4xu.5.
export function aggregateDaily(
	_rows: PricedRow[],
	_windowDays = 30,
): DayBucket[] {
	// TODO(myusage-4xu.5): bucket by local day within the window; sum cost + tokens per model.
	return [];
}
