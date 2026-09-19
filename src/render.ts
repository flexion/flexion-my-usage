import type { DayBucket } from "./aggregate.js";

// Render a single self-contained index.html. Tracked: myusage-4xu.6 (UI), myusage-4xu.7 (delivery).
export function renderHtml(_days: DayBucket[]): string {
	// TODO(myusage-4xu.6): KPI row + daily cost-over-time chart (model-stacked, cost/token toggle,
	// day drill-down), all assets inlined so the file is self-contained.
	return "<!doctype html><meta charset=utf-8><title>my-usage</title><p>Not built yet.</p>";
}
