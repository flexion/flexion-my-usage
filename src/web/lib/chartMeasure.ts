// The Cost | Tokens measure concept, ported from the forked dashboard: one formatter set per
// measure, so a chart swaps its whole vocabulary in one call instead of branching on the
// measure at every label. The forked dashboard's URL-backed state hook and its API-parameter
// mapping have no counterpart here (one page, no query state, no API measures), so only the
// formatter half came across.
import { formatCurrency, formatTokens } from "./formatters";

export type Metric = "cost" | "tokens";

export interface MetricFormatters {
	/** Axis ticks. */
	axis: (n: number) => string;
	/** Tooltip, legend and table values. */
	value: (n: number) => string;
	/** Appended after value() where the unit must be spelled out ("1.50M tokens"); empty for cost. */
	unitLabel: string;
	/** Decorates a card title with the measure: "Daily Cost" vs "Daily Tokens". */
	title: (base: string) => string;
}

export function metricFormatters(metric: Metric): MetricFormatters {
	if (metric === "tokens") {
		return {
			axis: formatTokens,
			value: formatTokens,
			unitLabel: "tokens",
			title: (base) => `${base} Tokens`,
		};
	}
	return {
		axis: formatCurrency,
		value: formatCurrency,
		unitLabel: "",
		title: (base) => `${base} Cost`,
	};
}
