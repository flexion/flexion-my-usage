import type { DayBucket } from "./aggregate.js";

// Pure chart model for the usage page: the per-model stack fold, the part-to-whole share fold,
// the KPI window totals and the number formatters the KPI row and chart labels use.
// Framework-free on purpose (no React, no chart library) so render.ts can draw it as SVG text
// and every rule here is testable with plain data. Tracked: myusage-4xu.6.
//
// Scope for this slice: one notional cost measure (no billed-vs-subscription split), no
// previous-period comparison, no month-to-date projection, no URL or query state, and no
// model-family detection. A series here is the (provider, model) pair exactly as aggregate.ts
// records it; model ids are never rewritten or grouped.

/** Which per-model figure a chart plots: `ModelTotals.notionalCost` or `ModelTotals.tokens`. */
export type Measure = "cost" | "tokens";

/** Display label of the roll-up series that absorbs every model ranked past the named cap. */
export const OTHER_LABEL = "Other";

export type StackSeries =
	| {
			kind: "model";
			provider: string;
			model: string;
			/**
			 * The model id on its own, or `provider/model` when the same id appears under more
			 * than one provider among every ranked series for the window - named ones and any
			 * folded into Other alike - so two legend entries never read the same and a folded
			 * twin never leaves its named sibling's label looking unambiguous when it isn't.
			 */
			label: string;
			/** The measure summed over every day in the window. */
			total: number;
	  }
	| {
			kind: "other";
			label: typeof OTHER_LABEL;
			/** How many model series this roll-up stands for. */
			folded: number;
			/** The measure summed over every day in the window. */
			total: number;
	  };

export interface StackedDay {
	/** The source DayBucket's `day`, YYYY-MM-DD. */
	day: string;
	/** One value per `ModelStacks.series` entry, in that order; 0 where a series has nothing that day. */
	segments: number[];
	/** Sum of `segments`. */
	total: number;
}

export interface ModelStacks {
	measure: Measure;
	/**
	 * Rank order: named model series by window total, largest first, then the Other roll-up last
	 * when there is one. Empty when no series has a positive total. Other sorting last here lets
	 * a renderer draw it at the base of each bar straight from this list's order, with no
	 * separate layout pass.
	 */
	series: StackSeries[];
	/** One entry per input DayBucket, in input order. */
	days: StackedDay[];
}

export interface StackOptions {
	/** Named series kept before the rest fold into Other. Default 8; anything below 1 counts as 1. */
	topN?: number;
}

/**
 * Fold daily per-model totals into stacked-bar series for one measure.
 *
 * - A series is the (provider, model) pair read from each ModelTotals; the `byModel` record's
 *   keys are opaque and never parsed.
 * - Only positive values count. Under "cost" an unpriced model (notionalCost 0) contributes no
 *   series, is not counted in Other's `folded`, and does not force a provider-qualified label on
 *   a priced series with the same model id.
 * - Series rank by window total, largest first; ties by model id, then provider (the order
 *   aggregate.ts's `unpricedModels` uses).
 * - A model id shared by more than one priced series forces every named series with that id to
 *   carry a provider-qualified label, even when only one of them stays individually named and
 *   the rest fold into Other - folding a series out of the legend must never make its surviving
 *   sibling's label look unambiguous when it isn't.
 * - The first `topN` ranked series stay named; every series past that folds into one trailing
 *   Other, whose value on a day is the sum of the folded series' values that day.
 * - Each day's `segments` holds one value per series in `series` order, 0 where a series is
 *   absent that day, and `total` is their sum.
 */
export function stackByModel(
	_days: DayBucket[],
	measure: Measure,
	_options: StackOptions = {},
): ModelStacks {
	// TODO(myusage-4xu.6): rank (provider, model) series by window total, cap at topN, fold the
	// rest into Other, and lay out one segment per series per day.
	return { measure, series: [], days: [] };
}

export interface ShareEntry {
	series: StackSeries;
	/** The series' segments summed over the days given. */
	value: number;
	/** `(value / total) * 100`. */
	pct: number;
}

export interface Shares {
	/** Sum of every series' value over the days given. */
	total: number;
	/** Every series with a positive value, largest first, Other last however large. Lossless. */
	ranked: ShareEntry[];
	/** At most `maxSlices` entries for a share (pie) view; see `shareByModel`. */
	slices: ShareEntry[];
}

export interface ShareOptions {
	/** Slice cap. Default 6; the named slices number `max(1, maxSlices - 1)`. */
	maxSlices?: number;
}

/**
 * Collapse stacked days into part-to-whole shares of one total: the question a share view
 * answers ("which model is my usage") that stacked segments only let you eyeball. Pass every
 * day of a `ModelStacks` for window shares, or a single day's entry for that day's.
 *
 * - Each series' value is its segment summed over `days`; `total` is the sum of those values.
 * - `ranked` lists every series with a positive value, largest first, with Other always last
 *   however large it is; ties among model series by model id, then provider. Nothing is hidden,
 *   so a ranked list under the share view can show every entry.
 * - `slices` keeps the top `max(1, maxSlices - 1)` named series, then, when anything is left
 *   over, one trailing Other absorbing the remaining named series and the stack's own Other.
 *   That entry's `series` is a fresh Other whose `folded` counts every model it stands for and
 *   whose `total` is the entry's value.
 * - No positive value at all yields `{ total: 0, ranked: [], slices: [] }`.
 */
export function shareByModel(
	_series: StackSeries[],
	_days: StackedDay[],
	_options: ShareOptions = {},
): Shares {
	// TODO(myusage-4xu.6): sum each series over the days given, rank with Other last, and cap
	// the slices with a single folded Other.
	return { total: 0, ranked: [], slices: [] };
}

export interface WindowTotals {
	notionalCost: number;
	tokens: number;
	responses: number;
}

/** The KPI row's figures: each DayBucket total summed over the window. */
export function windowTotals(_days: DayBucket[]): WindowTotals {
	// TODO(myusage-4xu.6): sum notionalCost, tokens and responses across the days.
	return { notionalCost: 0, tokens: 0, responses: 0 };
}

/**
 * Dollars: "$0.00" for zero, four decimals below one cent so a tiny cost still reads as a
 * number, two decimals from a cent up. No thousands separators and no locale data, so the
 * output is the same on every Node build.
 */
export function formatCurrency(_usd: number): string {
	// TODO(myusage-4xu.6): "$" + fixed decimals per the rule above.
	return "";
}

/**
 * Token counts with k / M / B suffixes: below 1,000 a rounded integer; thousands to one decimal;
 * millions and billions to two. Zero is "0".
 */
export function formatTokens(_count: number): string {
	// TODO(myusage-4xu.6): pick the suffix by magnitude and fix the decimals.
	return "";
}

/** Whole counts with comma thousands separators, without locale data. */
export function formatCount(_n: number): string {
	// TODO(myusage-4xu.6): group digits in threes from the right.
	return "";
}

export interface MeasureFormat {
	/** Axis ticks. */
	axis: (n: number) => string;
	/** Tooltip and legend values. */
	value: (n: number) => string;
	/**
	 * Appended after `value()` where the unit must be spelled out ("1.50M tokens"); empty for
	 * cost, whose "$" already carries the unit.
	 */
	unitLabel: string;
	/** Decorates a card title with the measure: unchanged for cost, " (Tokens)" appended for tokens. */
	title: (base: string) => string;
}

/**
 * The whole cost/token vocabulary for one measure in one object, so a chart swaps its
 * formatters with the measure instead of branching on it at every label.
 */
export function measureFormat(_measure: Measure): MeasureFormat {
	// TODO(myusage-4xu.6): formatCurrency for cost, formatTokens for tokens.
	return { axis: () => "", value: () => "", unitLabel: "", title: () => "" };
}
