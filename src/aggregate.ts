import type { PricedRow } from "./pricing.js";
import type { DayBucket } from "./usage-payload.js";

// The bucket shapes live in usage-payload.ts, the data route's wire contract, so the page and
// this aggregation share one definition. Re-exported so existing importers keep one entry point.
export type { DayBucket, ModelTotals } from "./usage-payload.js";

export interface UnpricedModel {
	provider: string;
	model: string;
	tokens: number;
}

/**
 * All five token buckets, disjoint per pricing.ts, summed into one response total.
 *
 * Trusts every bucket is already finite and non-negative (see `NormalizedUsageRow.tokens` in
 * sources/types.ts) and does no validation or clamping of its own. That trust holds today only
 * because opencode.ts's `bucket()` is the sole adapter's clamp; a second `UsageSource` that
 * skips the same clamp would have its NaN/negative values summed here without complaint.
 */
function tokenTotal(tokens: PricedRow["tokens"]): number {
	return (
		tokens.input +
		tokens.output +
		tokens.reasoning +
		tokens.cacheRead +
		tokens.cacheWrite
	);
}

/**
 * The local calendar day a timestamp falls on, as a day-count from the epoch. Built from local
 * Y/M/D read through `Date.UTC`, so comparing two of these is calendar-day arithmetic: never off
 * by an hour across a daylight-saving change, unlike diffing raw epoch milliseconds.
 */
function dayNumber(date: Date): number {
	return Math.floor(
		Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000,
	);
}

/** The YYYY-MM-DD label for a day-count produced by `dayNumber`. */
function dayLabel(day: number): string {
	const asUtc = new Date(day * 86_400_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${asUtc.getUTCFullYear()}-${pad(asUtc.getUTCMonth() + 1)}-${pad(asUtc.getUTCDate())}`;
}

/** Group key for a (provider, model) pair; a gateway's model id may itself contain a slash. */
function seriesKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

/**
 * Roll priced rows into daily buckets over a rolling window of local calendar days ending today,
 * split by model. One bucket per day in the window, oldest first, zero-filled for quiet days.
 * Tracked: myusage-4xu.5.
 */
export function aggregateDaily(
	rows: PricedRow[],
	windowDays = 30,
	now: Date = new Date(),
): DayBucket[] {
	const lastDay = dayNumber(now);
	const firstDay = lastDay - (windowDays - 1);

	const days = new Map<number, DayBucket>();
	for (let day = firstDay; day <= lastDay; day++) {
		days.set(day, {
			day: dayLabel(day),
			byModel: {},
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		});
	}

	for (const row of rows) {
		const bucket = days.get(dayNumber(row.timestamp));
		if (!bucket) continue;

		const tokens = tokenTotal(row.tokens);
		bucket.responses += 1;
		bucket.tokens += tokens;
		bucket.notionalCost += row.notionalCost;

		const key = seriesKey(row.provider, row.model);
		let series = bucket.byModel[key];
		if (!series) {
			series = {
				provider: row.provider,
				model: row.model,
				notionalCost: 0,
				tokens: 0,
				unpricedTokens: 0,
			};
			bucket.byModel[key] = series;
		}
		series.notionalCost += row.notionalCost;
		series.tokens += tokens;
		if (row.unpriced) series.unpricedTokens += tokens;
	}

	return [...days.values()];
}

/**
 * Every model with unpriced usage anywhere in `days`, tokens summed across days, largest first
 * (ties broken by model id, then provider).
 */
export function unpricedModels(days: DayBucket[]): UnpricedModel[] {
	const totals = new Map<string, UnpricedModel>();
	for (const day of days) {
		for (const series of Object.values(day.byModel)) {
			if (series.unpricedTokens === 0) continue;
			const key = seriesKey(series.provider, series.model);
			const existing = totals.get(key);
			if (existing) {
				existing.tokens += series.unpricedTokens;
			} else {
				totals.set(key, {
					provider: series.provider,
					model: series.model,
					tokens: series.unpricedTokens,
				});
			}
		}
	}
	return [...totals.values()].sort(
		(a, b) =>
			b.tokens - a.tokens ||
			a.model.localeCompare(b.model) ||
			a.provider.localeCompare(b.provider),
	);
}
