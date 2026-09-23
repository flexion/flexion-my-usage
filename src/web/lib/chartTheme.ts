// Shared recharts theme, ported from the forked dashboard. Spread these onto chart components
// so every axis, grid and tooltip on the page reads the same.

export const CHART_COLORS = {
	accent: "#8b5cf6", // violet-500 - primary bar color
	selected: "#a78bfa", // violet-400 - the day whose detail is open
	grid: "rgba(148,163,184,0.08)",
	axis: "#475569", // slate-600
	tickText: "#64748b", // slate-500
};

export const AXIS_STYLE = {
	tick: {
		fill: CHART_COLORS.tickText,
		fontSize: 11,
		fontFamily: "var(--font-sans)",
	},
	axisLine: { stroke: CHART_COLORS.axis },
	tickLine: { stroke: CHART_COLORS.axis },
};

export const GRID_STYLE = {
	stroke: CHART_COLORS.grid,
	strokeDasharray: "3 3",
};

/** The hover band behind the day under the cursor. */
export const TOOLTIP_CURSOR = { fill: "rgba(255,255,255,0.04)" };
