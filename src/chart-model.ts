import type { DayBucket, ModelTotals } from "./aggregate.js";

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

/** The `{ kind: "model" }` branch of `StackSeries`, named for readability at call sites. */
type ModelSeries = Extract<StackSeries, { kind: "model" }>;
/** The `{ kind: "other" }` branch of `StackSeries`. */
type OtherSeries = Extract<StackSeries, { kind: "other" }>;

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

/** Opaque grouping key for a (provider, model) pair; never parsed back apart. */
function seriesKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

/** The figure `measure` plots for one model's day total. */
function measureValue(totals: ModelTotals, measure: Measure): number {
	return measure === "cost" ? totals.notionalCost : totals.tokens;
}

/** Window total per (provider, model), read from each day's `byModel` values, never its keys. */
function windowTotalsByModel(
	days: DayBucket[],
	measure: Measure,
): Map<string, { provider: string; model: string; total: number }> {
	const totals = new Map<
		string,
		{ provider: string; model: string; total: number }
	>();
	for (const day of days) {
		for (const model of Object.values(day.byModel)) {
			const key = seriesKey(model.provider, model.model);
			const value = measureValue(model, measure);
			const existing = totals.get(key);
			if (existing) {
				existing.total += value;
			} else {
				totals.set(key, {
					provider: model.provider,
					model: model.model,
					total: value,
				});
			}
		}
	}
	return totals;
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
	days: DayBucket[],
	measure: Measure,
	options: StackOptions = {},
): ModelStacks {
	const topN = Math.max(1, options.topN ?? 8);

	const ranked = [...windowTotalsByModel(days, measure).values()]
		.filter((entry) => entry.total > 0)
		.sort(
			(a, b) =>
				b.total - a.total ||
				a.model.localeCompare(b.model) ||
				a.provider.localeCompare(b.provider),
		);

	// A model id served by more than one provider among the ranked (positive-total) series
	// needs every one of its named entries qualified - see the `label` doc comment above.
	// A Set membership test (rather than reading a `Map<string, Set>`'s size with a fallback)
	// keeps this a plain boolean check with no branch for a "never seen this id" case that
	// can't happen: every ranked entry's model id is added to `providersByModelId` before
	// `labelFor` is ever called.
	const providersByModelId = new Map<string, Set<string>>();
	for (const entry of ranked) {
		let providers = providersByModelId.get(entry.model);
		if (!providers) {
			providers = new Set();
			providersByModelId.set(entry.model, providers);
		}
		providers.add(entry.provider);
	}
	const ambiguousModelIds = new Set<string>();
	for (const [modelId, providers] of providersByModelId) {
		if (providers.size > 1) ambiguousModelIds.add(modelId);
	}
	const labelFor = (provider: string, model: string): string =>
		ambiguousModelIds.has(model) ? `${provider}/${model}` : model;

	const named = ranked.slice(0, topN);
	const folded = ranked.slice(topN);

	const series: StackSeries[] = named.map(
		(entry): ModelSeries => ({
			kind: "model",
			provider: entry.provider,
			model: entry.model,
			label: labelFor(entry.provider, entry.model),
			total: entry.total,
		}),
	);
	if (folded.length > 0) {
		series.push({
			kind: "other",
			label: OTHER_LABEL,
			folded: folded.length,
			total: folded.reduce((sum, entry) => sum + entry.total, 0),
		});
	}

	const foldedKeys = new Set(
		folded.map((entry) => seriesKey(entry.provider, entry.model)),
	);

	const stackedDays: StackedDay[] = days.map((day) => {
		// Unlike windowTotalsByModel's `+=` above, this `.set` overwrites rather than accumulates
		// a second value for the same (provider, model) pair within one day. The real
		// aggregateDaily pipeline never produces that shape (byModel is keyed uniquely per pair),
		// so this is unreachable today - but the "keys are opaque" contract on DayBucket doesn't
		// itself rule out a hand-built one that does.
		const dayValues = new Map<string, number>();
		for (const model of Object.values(day.byModel)) {
			dayValues.set(
				seriesKey(model.provider, model.model),
				measureValue(model, measure),
			);
		}
		const segments = series.map((entry) => {
			if (entry.kind === "model") {
				return dayValues.get(seriesKey(entry.provider, entry.model)) ?? 0;
			}
			let sum = 0;
			for (const key of foldedKeys) {
				sum += dayValues.get(key) ?? 0;
			}
			return sum;
		});
		const total = segments.reduce((sum, value) => sum + value, 0);
		return { day: day.day, segments, total };
	});

	return { measure, series, days: stackedDays };
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

/** Narrows a `ShareEntry` to its `{ kind: "model" }` series branch. */
function isNamedEntry(
	entry: ShareEntry,
): entry is ShareEntry & { series: ModelSeries } {
	return entry.series.kind === "model";
}

/** Narrows a `ShareEntry` to its `{ kind: "other" }` series branch. */
function isOtherEntry(
	entry: ShareEntry,
): entry is ShareEntry & { series: OtherSeries } {
	return entry.series.kind === "other";
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
	series: StackSeries[],
	days: StackedDay[],
	options: ShareOptions = {},
): Shares {
	const namedCap = Math.max(1, (options.maxSlices ?? 6) - 1);

	// Pair each series with its window value in one pass, as tuples rather than two same-length
	// arrays read back by index: `day.segments[i]` is the one read that genuinely can't be
	// proven in range at the type level (a caller could hand `shareByModel` a day whose
	// `segments` don't cover every series), so it alone gets a defensive fallback; everything
	// downstream destructures the tuple instead of indexing a second array.
	const withValues: [StackSeries, number][] = series.map((s, i) => [
		s,
		days.reduce((sum, day) => sum + (day.segments[i] ?? 0), 0),
	]);
	const total = withValues.reduce((sum, [, value]) => sum + value, 0);

	const entries: ShareEntry[] = withValues
		.map(
			([s, value]): ShareEntry => ({
				series: s,
				value,
				pct: total > 0 ? (value / total) * 100 : 0,
			}),
		)
		.filter((entry) => entry.value > 0);

	const namedEntries = entries.filter(isNamedEntry);
	namedEntries.sort(
		(a, b) =>
			b.value - a.value ||
			a.series.model.localeCompare(b.series.model) ||
			a.series.provider.localeCompare(b.series.provider),
	);
	const otherEntry = entries.find(isOtherEntry);

	const ranked: ShareEntry[] = otherEntry
		? [...namedEntries, otherEntry]
		: namedEntries;

	const kept = namedEntries.slice(0, namedCap);
	const overflow = namedEntries.slice(namedCap);

	const overflowTotal = overflow.reduce((sum, entry) => sum + entry.value, 0);
	const otherValue = overflowTotal + (otherEntry?.value ?? 0);
	const otherFolded = overflow.length + (otherEntry?.series.folded ?? 0);

	const slices: ShareEntry[] = [...kept];
	if (otherValue > 0) {
		// total >= otherValue here (otherValue is a subset sum of the same non-negative values
		// total is built from), so total > 0 whenever this branch runs: no zero-guard needed.
		slices.push({
			series: {
				kind: "other",
				label: OTHER_LABEL,
				folded: otherFolded,
				total: otherValue,
			},
			value: otherValue,
			pct: (otherValue / total) * 100,
		});
	}

	return { total, ranked, slices };
}

export interface WindowTotals {
	notionalCost: number;
	tokens: number;
	responses: number;
}

/** The KPI row's figures: each DayBucket total summed over the window. */
export function windowTotals(days: DayBucket[]): WindowTotals {
	let notionalCost = 0;
	let tokens = 0;
	let responses = 0;
	for (const day of days) {
		notionalCost += day.notionalCost;
		tokens += day.tokens;
		responses += day.responses;
	}
	return { notionalCost, tokens, responses };
}

/**
 * Dollars: "$0.00" for zero, four decimals below one cent so a tiny cost still reads as a
 * number, two decimals from a cent up. No thousands separators and no locale data, so the
 * output is the same on every Node build.
 */
export function formatCurrency(usd: number): string {
	if (usd === 0) return "$0.00";
	return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/**
 * Token counts with k / M / B suffixes: below 1,000 a rounded integer; thousands to one decimal;
 * millions and billions to two. Zero is "0".
 */
export function formatTokens(count: number): string {
	if (count < 1_000) return String(Math.round(count));
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	return `${(count / 1_000_000_000).toFixed(2)}B`;
}

/** Whole counts with comma thousands separators, without locale data. */
export function formatCount(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
export function measureFormat(measure: Measure): MeasureFormat {
	if (measure === "cost") {
		return {
			axis: formatCurrency,
			value: formatCurrency,
			unitLabel: "",
			title: (base) => base,
		};
	}
	return {
		axis: formatTokens,
		value: formatTokens,
		unitLabel: "tokens",
		title: (base) => `${base} (Tokens)`,
	};
}
