// Turns the data route's daily buckets into the row shapes the ported recharts components draw.
// The fold itself - top-N models by window total as named stacks, everything else into one
// Other stack - is the forked dashboard's per-family stack fold, ported with its "family" step
// dropped: that dashboard collapsed vendor-prefixed and bare ids of one model into a family,
// while here every (provider, model) pair opencode recorded is already its own series.
import type { DayBucket, ModelTotals } from "../../usage-payload";
import type { Metric } from "./chartMeasure";

/** The Other stack's key, shared with stackedSeries.tsx's colors and labels. */
export const OTHER_KEY = "__other";

/** Named stacks before the rest fold into Other: the forked dashboard's own cap. */
export const MODEL_TOP_N = 8;

/** One chart row: the day, plus one numeric column per stack key. */
export type SeriesRow = { date: string } & Record<string, number | string>;

/** A series' key. A gateway's model id may itself contain a slash, but the pair stays unique. */
export function modelKey(totals: Pick<ModelTotals, "provider" | "model">) {
	return `${totals.provider}/${totals.model}`;
}

function metricOf(totals: ModelTotals, metric: Metric): number {
	return metric === "tokens" ? totals.tokens : totals.notionalCost;
}

/** Per day, each model's value under `metric` - the fold's input, one column per model key. */
export function seriesRows(days: DayBucket[], metric: Metric): SeriesRow[] {
	return days.map((day) => {
		const row: SeriesRow = { date: day.day };
		for (const totals of Object.values(day.byModel)) {
			row[modelKey(totals)] = metricOf(totals, metric);
		}
		return row;
	});
}

export interface ModelStacks {
	rows: SeriesRow[];
	/** Named stacks, largest window total first. Other, when present, is not in this list. */
	keys: string[];
	hasOther: boolean;
	/** Window total per rendered stack, named ones first, then Other. */
	totals: { key: string; total: number }[];
}

/**
 * Folds per-model rows into top-N named stacks plus Other. Ranks by window total, largest first,
 * ties by key; drops non-positive and non-finite values; zero-fills a named key on a day it's
 * absent. Other appears only when something actually folds into it.
 */
export function buildModelStacks(
	rows: SeriesRow[],
	topN: number = MODEL_TOP_N,
): ModelStacks {
	const byDate = new Map<string, Map<string, number>>();
	const grandTotals = new Map<string, number>();

	for (const row of rows) {
		const dayMap = new Map<string, number>();
		byDate.set(row.date, dayMap);
		for (const [key, raw] of Object.entries(row)) {
			if (key === "date") continue;
			const value = Number(raw);
			if (!Number.isFinite(value) || value <= 0) continue;
			dayMap.set(key, value);
			grandTotals.set(key, (grandTotals.get(key) ?? 0) + value);
		}
	}

	const ranked = [...grandTotals.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key]) => key);
	const keys = ranked.slice(0, Math.max(1, topN));
	const hasOther = ranked.length > keys.length;
	const named = new Set(keys);

	const stackRows = rows.map((row) => {
		// Always set: the loop above registered every row's date before this one runs.
		const dayMap = byDate.get(row.date) as Map<string, number>;
		const out: SeriesRow = { date: row.date };
		for (const key of keys) out[key] = dayMap.get(key) ?? 0;
		if (hasOther) {
			let other = 0;
			for (const [key, value] of dayMap) if (!named.has(key)) other += value;
			out[OTHER_KEY] = other;
		}
		return out;
	});

	const renderKeys = hasOther ? [...keys, OTHER_KEY] : keys;
	const totals = renderKeys.map((key) => ({
		key,
		total: stackRows.reduce((sum, row) => sum + Number(row[key]), 0),
	}));

	return { rows: stackRows, keys, hasOther, totals };
}

/** Per day, the day's own total under `metric`, in column `key` - the Total chart's rows. */
export function totalRows(
	days: DayBucket[],
	metric: Metric,
	key: string,
): SeriesRow[] {
	return days.map((day) => ({
		date: day.day,
		[key]: metric === "tokens" ? day.tokens : day.notionalCost,
	}));
}

export interface WindowTotals {
	notionalCost: number;
	tokens: number;
	responses: number;
}

/** The KPI row's figures: each day's totals summed over the window. */
export function windowTotals(days: DayBucket[]): WindowTotals {
	return days.reduce(
		(sum, day) => ({
			notionalCost: sum.notionalCost + day.notionalCost,
			tokens: sum.tokens + day.tokens,
			responses: sum.responses + day.responses,
		}),
		{ notionalCost: 0, tokens: 0, responses: 0 },
	);
}

export interface ModelRow extends ModelTotals {
	key: string;
}

/**
 * Every model with usage in `days`, summed across them: the By Model table's rows, and (given a
 * single day) the day detail's. Largest cost first, then most tokens, then key - so unpriced
 * models (cost 0) still rank among themselves by volume instead of arbitrarily.
 */
export function rankModels(days: DayBucket[]): ModelRow[] {
	const rows = new Map<string, ModelRow>();
	for (const day of days) {
		for (const totals of Object.values(day.byModel)) {
			const key = modelKey(totals);
			const row = rows.get(key) ?? {
				...totals,
				key,
				notionalCost: 0,
				tokens: 0,
				unpricedTokens: 0,
			};
			row.notionalCost += totals.notionalCost;
			row.tokens += totals.tokens;
			row.unpricedTokens += totals.unpricedTokens;
			rows.set(key, row);
		}
	}
	return [...rows.values()].sort(
		(a, b) =>
			b.notionalCost - a.notionalCost ||
			b.tokens - a.tokens ||
			a.key.localeCompare(b.key),
	);
}

/**
 * Display names for series keys: the bare model id, unless the same id appears under more than
 * one provider in the window - then "provider/model" for every one of them, so two legend
 * entries never read the same. The Other key reads "Other"; a key not seen in `days` shows as-is.
 */
export function modelLabeler(days: DayBucket[]): (key: string) => string {
	const models = rankModels(days);
	const providers = new Map<string, Set<string>>();
	for (const row of models) {
		const set = providers.get(row.model) ?? new Set<string>();
		set.add(row.provider);
		providers.set(row.model, set);
	}
	const labels = new Map(
		models.map((row) => [
			row.key,
			(providers.get(row.model) as Set<string>).size > 1 ? row.key : row.model,
		]),
	);
	return (key) => (key === OTHER_KEY ? "Other" : (labels.get(key) ?? key));
}
