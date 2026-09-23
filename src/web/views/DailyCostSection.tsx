// The daily chart card, ported from the forked dashboard's per-person Daily Cost section: the
// Total | By model and Cost | Tokens toggles, the stacked-by-model bars with their hover
// tooltip and legend, the rounded single-series bars, and the click-a-day drill-down (plus the
// keyboard-operable date input that mirrors it).
//
// Left behind, because this page has nothing for them to show: the billed-vs-subscription split
// and its hatched bars (every figure here is one notional measure), the previous-period
// reference line and month-to-date projection (one fixed window, no comparison period), the
// pie/share view, and the per-bucket token stack (the data route carries token totals only).
//
// One deliberate change: bars don't animate in. Recharts' grow-from-zero animation made the
// drawn chart depend on frame timing, which is also what made it untestable deterministically
// in jsdom, and a page read once over loopback gains nothing from the motion.
import { useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { DayBucket } from "../../usage-payload";
import { Card, CardHeader } from "../components/Card";
import {
	MEASURE_OPTIONS,
	MeasureToggle,
	type ToggleOption,
} from "../components/MeasureToggle";
import { SectionHeader } from "../components/SectionHeader";
import { type Metric, metricFormatters } from "../lib/chartMeasure";
import {
	AXIS_STYLE,
	CHART_COLORS,
	GRID_STYLE,
	TOOLTIP_CURSOR,
} from "../lib/chartTheme";
import {
	buildModelStacks,
	OTHER_KEY,
	type SeriesRow,
	seriesRows,
	totalRows,
} from "../lib/modelStacks";
import {
	StackedSeriesLegend,
	StackedTooltip,
	stackColorFor,
} from "../lib/stackedSeries";
import { DayDetail } from "./DayDetail";

type StackBy = "none" | "model";

const STACK_OPTIONS: ToggleOption<StackBy>[] = [
	{ value: "none", label: "Total" },
	{ value: "model", label: "By model" },
];

/**
 * The Total chart's one series. Doubles as its tooltip label: labelFor passes a key it has never
 * seen through unchanged, so the tooltip reads "Total" with no second label function to wire.
 */
const TOTAL_KEY = "Total";

const CHART_HEIGHT = 240;

/** Rendered size before the browser reports the real one - and the size under test. */
const INITIAL_DIMENSION = { width: 720, height: CHART_HEIGHT };

const CHART_MARGIN = { top: 4, right: 4, left: 0, bottom: 4 };

/** Recharts' shape props for one bar - only the fields RoundedBar draws from. */
interface BarShapeProps {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	fill?: string;
}

/** A bar with rounded top corners and a square base; nothing at all for an empty day. */
export function RoundedBar({
	x = 0,
	y = 0,
	width = 0,
	height = 0,
	fill,
}: BarShapeProps) {
	if (height <= 0) return null;
	const r = Math.min(3, height);
	return (
		<path
			d={`M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`}
			fill={fill}
		/>
	);
}

/**
 * Keyboard-operable counterpart to clicking a bar: the bars are SVG shapes with no tab stop, so
 * this native date input, bounded to the window, is how a day's detail opens without a mouse.
 */
function DayJumpInput({
	selectedDay,
	onDaySelect,
	first,
	last,
}: {
	selectedDay: string | null;
	onDaySelect: (day: string | null) => void;
	first: string;
	last: string;
}) {
	return (
		<label
			style={{
				display: "flex",
				alignItems: "center",
				gap: "0.35rem",
				fontSize: "0.72rem",
				color: "var(--color-text-subtle)",
			}}
		>
			Jump to day
			<input
				type="date"
				value={selectedDay ?? ""}
				min={first}
				max={last}
				onChange={(e) => onDaySelect(e.target.value || null)}
				style={{
					padding: "0.25rem 0.4rem",
					fontSize: "0.72rem",
					fontFamily: "var(--font-mono)",
					background: "var(--color-surface-2)",
					color: "var(--color-text)",
					border: "1px solid var(--color-border)",
					borderRadius: "var(--radius-sm)",
					lineHeight: 1,
					colorScheme: "dark",
				}}
			/>
		</label>
	);
}

function DrillDownHint({ selectedDay }: { selectedDay: string | null }) {
	return (
		<p
			style={{
				margin: "0 0 0.5rem",
				fontSize: "0.75rem",
				color: "var(--color-text-subtle)",
			}}
		>
			Click a bar to see that day's models.
			{selectedDay && (
				<>
					{" "}
					Showing{" "}
					<strong style={{ color: "var(--color-text)" }}>{selectedDay}</strong>{" "}
					- click it again to close.
				</>
			)}
		</p>
	);
}

export function DailyCostSection({
	days,
	labelFor,
}: {
	/** The window, oldest first - never empty (aggregateDaily always returns the full window). */
	days: DayBucket[];
	labelFor: (key: string) => string;
}) {
	const [stackBy, setStackBy] = useState<StackBy>("model");
	const [metric, setMetric] = useState<Metric>("cost");
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	const [selectedDay, setSelectedDay] = useState<string | null>(null);

	const fmt = metricFormatters(metric);
	const first = (days[0] as DayBucket).day;
	const last = (days[days.length - 1] as DayBucket).day;
	const detail = days.find((day) => day.day === selectedDay);

	// A bar click toggles that day's detail: clicking the open day again closes it.
	const onBarClick = (item: { payload?: unknown }) => {
		const day = (item.payload as SeriesRow).date;
		setSelectedDay((current) => (current === day ? null : day));
	};

	const stacks = buildModelStacks(seriesRows(days, metric));
	const hasAny = stacks.totals.length > 0;
	const legendKeys = stacks.hasOther
		? [...stacks.keys, OTHER_KEY]
		: stacks.keys;
	// Other renders first so it stacks at the bottom of each bar.
	const renderKeys = stacks.hasOther
		? [OTHER_KEY, ...stacks.keys]
		: stacks.keys;

	return (
		<Card label={fmt.title("Daily")}>
			<CardHeader>
				<SectionHeader
					title={fmt.title("Daily")}
					caption={
						<span
							style={{
								fontSize: "0.7rem",
								fontWeight: 500,
								color: "var(--color-text-subtle)",
							}}
						>
							{metric === "tokens"
								? "Tokens are counted, not billed."
								: "Notional: tokens x published rates."}
						</span>
					}
				/>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "0.75rem",
						flexWrap: "wrap",
					}}
				>
					<MeasureToggle
						label="Stack"
						value={stackBy}
						onChange={setStackBy}
						options={STACK_OPTIONS}
					/>
					<MeasureToggle
						label="Measure"
						value={metric}
						onChange={setMetric}
						options={MEASURE_OPTIONS}
					/>
					<DayJumpInput
						selectedDay={selectedDay}
						onDaySelect={setSelectedDay}
						first={first}
						last={last}
					/>
					<span
						style={{ fontSize: "0.75rem", color: "var(--color-text-subtle)" }}
					>
						Last {days.length} days
					</span>
				</div>
			</CardHeader>
			{!hasAny ? (
				<p
					style={{
						color: "var(--color-text-subtle)",
						fontSize: "0.8125rem",
						margin: 0,
					}}
				>
					No usage recorded in this window.
				</p>
			) : (
				<>
					<DrillDownHint selectedDay={selectedDay} />
					<ResponsiveContainer
						width="100%"
						height={CHART_HEIGHT}
						initialDimension={INITIAL_DIMENSION}
					>
						{stackBy === "model" ? (
							<BarChart
								data={stacks.rows}
								margin={CHART_MARGIN}
								onMouseLeave={() => setHoveredKey(null)}
								style={{ cursor: "pointer" }}
							>
								<CartesianGrid {...GRID_STYLE} vertical={false} />
								<XAxis dataKey="date" {...AXIS_STYLE} />
								<YAxis tickFormatter={fmt.axis} {...AXIS_STYLE} width={62} />
								<Tooltip
									cursor={TOOLTIP_CURSOR}
									content={
										<StackedTooltip
											displayKey={labelFor}
											hoveredKey={hoveredKey}
											formatValue={fmt.value}
										/>
									}
								/>
								{renderKeys.map((key) => (
									<Bar
										key={key}
										dataKey={key}
										stackId="a"
										fill={stackColorFor(key, stacks.keys)}
										name={labelFor(key)}
										onMouseEnter={() => setHoveredKey(key)}
										onClick={onBarClick}
										isAnimationActive={false}
									/>
								))}
							</BarChart>
						) : (
							<BarChart
								data={totalRows(days, metric, TOTAL_KEY)}
								margin={CHART_MARGIN}
								style={{ cursor: "pointer" }}
							>
								<CartesianGrid {...GRID_STYLE} vertical={false} />
								<XAxis dataKey="date" {...AXIS_STYLE} />
								<YAxis tickFormatter={fmt.axis} {...AXIS_STYLE} width={62} />
								<Tooltip
									cursor={TOOLTIP_CURSOR}
									content={
										<StackedTooltip
											displayKey={labelFor}
											hoveredKey={TOTAL_KEY}
											formatValue={fmt.value}
										/>
									}
								/>
								<Bar
									dataKey={TOTAL_KEY}
									shape={<RoundedBar />}
									onClick={onBarClick}
									isAnimationActive={false}
								>
									{days.map((day) => (
										<Cell
											key={day.day}
											fill={
												day.day === selectedDay
													? CHART_COLORS.selected
													: CHART_COLORS.accent
											}
										/>
									))}
								</Bar>
							</BarChart>
						)}
					</ResponsiveContainer>
					{stackBy === "model" && (
						<StackedSeriesLegend stackKeys={legendKeys} displayKey={labelFor} />
					)}
				</>
			)}
			{detail && (
				<DayDetail
					day={detail}
					labelFor={labelFor}
					onClose={() => setSelectedDay(null)}
				/>
			)}
		</Card>
	);
}
