// Stacked-series chart helpers (top-N + Other bars), ported from the forked dashboard: the
// palette, the color-by-rank rule, the hover tooltip and the legend row. Its tooltip's
// billed/subscription grouping, pattern swatches and header tag served charts this page doesn't
// have (a single notional measure, no subscription split), so they didn't come across.
import { OTHER_KEY } from "./modelStacks";

// A colorblind-friendly palette for stacked bars - 8 distinct hues + Other.
export const STACK_COLORS = [
	"#8b5cf6",
	"#06b6d4",
	"#f59e0b",
	"#ec4899",
	"#10b981",
	"#3b82f6",
	"#ef4444",
	"#eab308",
];
export const OTHER_COLOR = "#64748b";

/** OTHER_COLOR for the Other stack, else a hue keyed by rank among the named keys. */
export function stackColorFor(key: string, namedKeys: string[]): string {
	if (key === OTHER_KEY) return OTHER_COLOR;
	const idx = namedKeys.indexOf(key);
	return STACK_COLORS[idx % STACK_COLORS.length] as string;
}

/** One entry of recharts' tooltip payload - only the fields read here. */
export interface TooltipEntry {
	dataKey?: unknown;
	value?: unknown;
	color?: string;
}

export interface StackedTooltipProps {
	/** Set by recharts, which clones this element with the hover state. */
	active?: boolean;
	payload?: TooltipEntry[];
	label?: unknown;
	displayKey: (key: string) => string;
	/** The segment under the cursor, tracked via Bar.onMouseEnter (see below). */
	hoveredKey: string | null;
	formatValue: (value: number) => string;
}

/**
 * Tooltip for a stacked daily chart. Recharts' shared={false} misattributes segments on stacked
 * bars, so the hovered segment's dataKey is tracked manually via Bar.onMouseEnter and passed in
 * as `hoveredKey`.
 *
 * Always returns a container (even with no segment to show) so recharts keeps the tooltip
 * wrapper mounted and positioned: returning null until hoveredKey was set would mount the
 * wrapper at the chart's origin on the first hover and only reposition it on the next move.
 */
export function StackedTooltip({
	active,
	payload,
	label,
	displayKey,
	hoveredKey,
	formatValue,
}: StackedTooltipProps) {
	if (!active) return null;
	const segment = payload?.find(
		(p) =>
			p.dataKey === hoveredKey && typeof p.value === "number" && p.value > 0,
	);
	return (
		<div
			className="stacked-tooltip"
			style={{
				background: "var(--color-surface-2)",
				border: "1px solid var(--color-accent-light)",
				borderRadius: 6,
				padding: "0.625rem 0.75rem",
				fontSize: "0.75rem",
				color: "var(--color-text)",
				minWidth: 220,
				boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
				opacity: segment ? 1 : 0,
				pointerEvents: "none",
				transition: "opacity 80ms ease-out",
			}}
		>
			<div
				style={{
					marginBottom: "0.4rem",
					paddingBottom: "0.4rem",
					borderBottom: "1px solid rgba(148,163,184,0.15)",
					color: "var(--color-text-muted)",
					fontFamily: "var(--font-mono)",
				}}
			>
				{String(label)}
			</div>
			{segment && (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "0.5rem",
						padding: "0.15rem 0",
					}}
				>
					<span
						style={{
							display: "inline-block",
							width: 8,
							height: 8,
							borderRadius: 2,
							background: segment.color,
							flexShrink: 0,
						}}
					/>
					<span
						style={{
							flex: 1,
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							fontFamily:
								segment.dataKey === OTHER_KEY
									? "var(--font-sans)"
									: "var(--font-mono)",
							color: "var(--color-text-muted)",
						}}
					>
						{displayKey(String(segment.dataKey))}
					</span>
					<span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
						{formatValue(segment.value as number)}
					</span>
				</div>
			)}
		</div>
	);
}

/** Legend row for a stacked chart: one swatch + label per key, colored to match the bars. */
export function StackedSeriesLegend({
	stackKeys,
	displayKey,
}: {
	stackKeys: string[];
	displayKey: (key: string) => string;
}) {
	const namedKeys = stackKeys.filter((k) => k !== OTHER_KEY);
	return (
		<ul
			aria-label="Legend"
			style={{
				display: "flex",
				flexWrap: "wrap",
				gap: "0.75rem",
				listStyle: "none",
				margin: 0,
				padding: "0.5rem 0 0",
				fontSize: "0.7rem",
				color: "var(--color-text-muted)",
			}}
		>
			{stackKeys.map((k) => (
				<li
					key={k}
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: "0.3rem",
					}}
				>
					<span
						data-swatch={stackColorFor(k, namedKeys)}
						style={{
							display: "inline-block",
							width: 10,
							height: 10,
							borderRadius: 2,
							background: stackColorFor(k, namedKeys),
						}}
					/>
					<span
						style={{
							fontFamily:
								k === OTHER_KEY ? "var(--font-sans)" : "var(--font-mono)",
						}}
					>
						{displayKey(k)}
					</span>
				</li>
			))}
		</ul>
	);
}
