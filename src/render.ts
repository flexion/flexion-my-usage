import type { DayBucket } from "./aggregate.js";
import {
	formatCount,
	formatCurrency,
	formatTokens,
	type Measure,
	type MeasureFormat,
	type ModelStacks,
	measureFormat,
	type Shares,
	type StackedDay,
	type StackSeries,
	shareByModel,
	stackByModel,
	type WindowTotals,
	windowTotals,
} from "./chart-model.js";

// Render a single self-contained index.html: KPI row + a daily cost-over-time chart, model-
// stacked, as inline SVG, with a cost/token toggle and a per-day drill-down. Tracked:
// myusage-4xu.6 (this file), myusage-4xu.7 (writing it out and opening a browser).
//
// Zero-dependency by design (see docs/design/slice-1.md's "Done when"): no React, no chart
// library, no bundler, no external assets. Markup is plain template strings; the only script is
// a small hand-written vanilla one, inlined, that never calls out over the network. Every number
// shown is formatted once, in this file or in chart-model.ts, and carried into the page as
// already-formatted text - the inline `<script>` never reimplements formatCurrency/formatTokens,
// it only displays strings this module already produced.

/** Escapes text for both HTML text nodes and quoted attribute values. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Serializes `value` for a `<script type="application/json">` body. Model ids come from local
 * session data this file doesn't control, so a label containing the literal text "</script>"
 * must not be able to close the tag early; escaping "<" to its Unicode escape (valid inside a
 * JSON string, invisible to `JSON.parse`) rules that out without touching any other character.
 */
function embedJson(id: string, value: unknown): string {
	const json = JSON.stringify(value).replace(/</g, "\\u003c");
	return `<script type="application/json" id="${id}">${json}</script>`;
}

/** `value` formatted, with the measure's unit spelled out when it has one ("1.50M tokens"). */
function withUnit(fmt: MeasureFormat, n: number): string {
	const value = fmt.value(n);
	return fmt.unitLabel ? `${value} ${fmt.unitLabel}` : value;
}

/** Rounds a coordinate to a tidy, deterministic precision for the emitted SVG markup. */
function num(n: number): string {
	return n.toFixed(2);
}

/**
 * One `series`/color pair per named slot (palette slots 1-8, matching stackByModel's default
 * `topN` of 8) plus one shared color for Other. Keyed by object reference: every `StackSeries`
 * a renderer ever looks a color up for is one of `series`'s own elements, carried through
 * unchanged by `stackByModel`/`shareByModel` (`shareByModel`'s `ranked` never clones a "model"
 * entry, and its own fresh Other only appears in `slices`, which this file doesn't use) - so the
 * lookup below always hits and the assertion documents that instead of a defensive branch
 * nothing in this file can ever exercise.
 */
function buildColorLookup(series: StackSeries[]): Map<StackSeries, string> {
	const colors = new Map<StackSeries, string>();
	// `slot` is unbounded past `--series-8`: safe only because this file always calls
	// stackByModel with its default topN of 8, so `series` never carries more than 8 named
	// entries. A caller passing a larger topN would need this guarded.
	let slot = 0;
	for (const s of series) {
		if (s.kind === "other") {
			colors.set(s, "var(--other)");
		} else {
			slot += 1;
			colors.set(s, `var(--series-${slot})`);
		}
	}
	return colors;
}

function colorFor(colors: Map<StackSeries, string>, s: StackSeries): string {
	// See buildColorLookup's doc comment: this lookup is always populated for every series this
	// file passes through it.
	// biome-ignore lint/style/noNonNullAssertion: proven by construction, see buildColorLookup.
	return colors.get(s)!;
}

/**
 * Pairs each of `stacks.series` with its value on `day`. `day` always comes from the same
 * `ModelStacks` as `stacks` in this file (renderMeasurePanel builds both from one
 * `stackByModel` call), so `day.segments` and `stacks.series` are always the same length; the
 * assertion documents that invariant instead of a defensive fallback this file can never
 * actually exercise (see the `StackedDay.segments` contract in chart-model.ts).
 */
function pairSeriesWithDay(
	stacks: ModelStacks,
	day: StackedDay,
): { series: StackSeries; value: number }[] {
	return stacks.series.map((series, i) => ({
		series,
		// biome-ignore lint/style/noNonNullAssertion: proven by construction, see above.
		value: day.segments[i]!,
	}));
}

/** A rounded-top, square-bottom rectangle path: the stacked bar's "data end" mark spec. */
function roundedTopRectPath(
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): string {
	const r = Math.max(0, Math.min(radius, height, width / 2));
	const left = x;
	const right = x + width;
	const top = y;
	const bottom = y + height;
	return [
		`M ${num(left)} ${num(bottom)}`,
		`L ${num(left)} ${num(top + r)}`,
		`Q ${num(left)} ${num(top)} ${num(left + r)} ${num(top)}`,
		`L ${num(right - r)} ${num(top)}`,
		`Q ${num(right)} ${num(top)} ${num(right)} ${num(top + r)}`,
		`L ${num(right)} ${num(bottom)}`,
		"Z",
	].join(" ");
}

const CHART_WIDTH = 840;
const CHART_HEIGHT = 360;
const MARGIN_TOP = 16;
const MARGIN_RIGHT = 16;
const MARGIN_BOTTOM = 32;
const MARGIN_LEFT = 64;
/** Stacked-bar segment gap (a visible seam between segments) and rounded-top-corner radius. */
const SEGMENT_GAP = 2;
const CORNER_RADIUS = 4;

/** "YYYY-MM-DD" -> "MM-DD", for the x-axis tick text where full dates would crowd the axis. */
function shortDayLabel(day: string): string {
	return day.slice(5);
}

/** The inline SVG for one measure's daily stacked-bar chart. */
function renderChartSvg(
	stacks: ModelStacks,
	colors: Map<StackSeries, string>,
	fmt: MeasureFormat,
): string {
	const plotWidth = CHART_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
	const plotHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
	const baselineY = CHART_HEIGHT - MARGIN_BOTTOM;

	const dayCount = stacks.days.length;
	const maxValue = Math.max(0, ...stacks.days.map((d) => d.total));
	// A quiet window (maxValue 0) degrades to an axis with no bars, rather than a special empty
	// state. No guard needed here: scaleHeight is only ever called below for a segment whose
	// value is positive, and that segment's day total - one of the values maxValue is the max
	// of - is at least that value, so maxValue is provably positive whenever this runs.
	const scaleHeight = (value: number): number =>
		(value / maxValue) * plotHeight;

	const gridLines = [0, 0.5, 1]
		.map((fraction) => {
			const y = baselineY - plotHeight * fraction;
			const label = escapeHtml(fmt.axis(maxValue * fraction));
			return `<line x1="${num(MARGIN_LEFT)}" y1="${num(y)}" x2="${num(CHART_WIDTH - MARGIN_RIGHT)}" y2="${num(y)}" class="gridline" />
<text x="${num(MARGIN_LEFT - 8)}" y="${num(y)}" class="axis-label axis-label-y" text-anchor="end" dominant-baseline="middle">${label}</text>`;
		})
		.join("\n");

	const slotWidth = dayCount > 0 ? plotWidth / dayCount : 0;
	const barWidth = Math.min(24, Math.max(2, slotWidth * 0.6));
	const labelEvery = Math.max(1, Math.round(dayCount / 6));

	const bars = stacks.days
		.map((day, dayIndex) => {
			const slotX = MARGIN_LEFT + slotWidth * dayIndex;
			const barX = slotX + (slotWidth - barWidth) / 2;
			const pairs = pairSeriesWithDay(stacks, day).filter((p) => p.value > 0);

			let cumulative = 0;
			const segments = pairs
				.map((pair, order) => {
					const yTop = baselineY - scaleHeight(cumulative + pair.value);
					const yBottom = baselineY - scaleHeight(cumulative);
					cumulative += pair.value;
					const rawHeight = yBottom - yTop;
					const height =
						order > 0 ? Math.max(0, rawHeight - SEGMENT_GAP) : rawHeight;
					const isTop = order === pairs.length - 1;
					const fill = colorFor(colors, pair.series);
					return isTop
						? `<path d="${roundedTopRectPath(barX, yTop, barWidth, height, CORNER_RADIUS)}" fill="${fill}" />`
						: `<rect x="${num(barX)}" y="${num(yTop)}" width="${num(barWidth)}" height="${num(height)}" fill="${fill}" />`;
				})
				.join("\n");

			const showLabel =
				dayIndex % labelEvery === 0 || dayIndex === dayCount - 1;
			const tick = showLabel
				? `<text x="${num(barX + barWidth / 2)}" y="${num(baselineY + 16)}" class="axis-label axis-label-x" text-anchor="middle">${escapeHtml(shortDayLabel(day.day))}</text>`
				: "";

			const ariaValue = withUnit(fmt, day.total);
			return `<g class="day-bar" data-day="${escapeHtml(day.day)}" tabindex="0" role="button" aria-label="${escapeHtml(day.day)}: ${escapeHtml(ariaValue)}">
<rect class="hit-target" x="${num(slotX)}" y="${num(MARGIN_TOP)}" width="${num(slotWidth)}" height="${num(plotHeight)}" fill="transparent" />
${segments}
</g>
${tick}`;
		})
		.join("\n");

	return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" class="chart-svg" role="img" aria-label="${escapeHtml(fmt.title("Daily usage"))}">
<line x1="${num(MARGIN_LEFT)}" y1="${num(baselineY)}" x2="${num(CHART_WIDTH - MARGIN_RIGHT)}" y2="${num(baselineY)}" class="baseline" />
${gridLines}
${bars}
</svg>`;
}

/** The legend / per-model breakdown list below a chart: swatch, label, value, share of window. */
function renderLegend(
	shares: Shares,
	colors: Map<StackSeries, string>,
	fmt: MeasureFormat,
): string {
	if (shares.ranked.length === 0) {
		return '<p class="empty-note">No usage recorded in this window.</p>';
	}
	const rows = shares.ranked
		.map((entry) => {
			const fill = colorFor(colors, entry.series);
			return `<li class="legend-row">
<span class="swatch" style="background:${fill}"></span>
<span class="legend-label">${escapeHtml(entry.series.label)}</span>
<span class="legend-value">${escapeHtml(fmt.value(entry.value))}</span>
<span class="legend-pct">${entry.pct.toFixed(1)}%</span>
</li>`;
		})
		.join("\n");
	return `<ul class="legend">\n${rows}\n</ul>`;
}

interface DayDetailEntry {
	label: string;
	color: string;
	value: string;
}

interface DayDetail {
	day: string;
	total: string;
	entries: DayDetailEntry[];
}

/**
 * The drill-down payload for one measure: every day's per-model breakdown, pre-formatted with
 * this measure's formatter so the client-side script never reimplements formatCurrency or
 * formatTokens - it only displays the strings built here.
 */
function buildDayDetails(
	stacks: ModelStacks,
	colors: Map<StackSeries, string>,
	fmt: MeasureFormat,
): DayDetail[] {
	return stacks.days.map((day) => ({
		day: day.day,
		total: withUnit(fmt, day.total),
		entries: pairSeriesWithDay(stacks, day)
			.filter((p) => p.value > 0)
			.map((p) => ({
				label: p.series.label,
				color: colorFor(colors, p.series),
				value: withUnit(fmt, p.value),
			})),
	}));
}

interface MeasurePanel {
	/** The chart card's markup for this measure: chart SVG + legend. */
	html: string;
	/** The `<script type="application/json">` tag carrying this measure's drill-down payload. */
	dataScript: string;
}

/** Builds one measure's full panel: stack the days, share the window, render, and pre-format. */
function renderMeasurePanel(
	days: DayBucket[],
	measure: Measure,
	panelId: string,
	hidden: boolean,
): MeasurePanel {
	const stacks = stackByModel(days, measure);
	const shares = shareByModel(stacks.series, stacks.days);
	const fmt = measureFormat(measure);
	const colors = buildColorLookup(stacks.series);

	const chart = renderChartSvg(stacks, colors, fmt);
	const legend = renderLegend(shares, colors, fmt);
	const details = buildDayDetails(stacks, colors, fmt);

	const html = `<div id="${panelId}" class="measure-panel"${hidden ? " hidden" : ""}>
${chart}
${legend}
</div>`;
	const dataScript = embedJson(`${panelId}-data`, {
		title: fmt.title("Daily cost"),
		days: details,
	});
	return { html, dataScript };
}

/** The KPI row: notional cost, tokens and responses, summed over the window. */
function renderKpiRow(totals: WindowTotals): string {
	const tiles: { label: string; value: string }[] = [
		{ label: "Notional cost", value: formatCurrency(totals.notionalCost) },
		{ label: "Tokens", value: formatTokens(totals.tokens) },
		{ label: "Responses", value: formatCount(totals.responses) },
	];
	const cards = tiles
		.map(
			(tile) => `<div class="kpi-tile">
<div class="kpi-label">${escapeHtml(tile.label)}</div>
<div class="kpi-value">${escapeHtml(tile.value)}</div>
</div>`,
		)
		.join("\n");
	return `<div class="kpi-row">\n${cards}\n</div>`;
}

// A categorical palette in a fixed, CVD-checked order: eight named-series hues, never cycled or
// reassigned by rank, plus a shared muted gray for the Other roll-up so it never impersonates a
// named series.
const STYLE = `:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --baseline: #c3c2b7;
  --border: rgba(11, 11, 11, 0.1);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;
  --other: #898781;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255, 255, 255, 0.1);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;
    --other: #898781;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}
h1 { font-size: 20px; margin: 0 0 20px; }
h2 { font-size: 16px; margin: 0; font-weight: 600; }
.kpi-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
.kpi-tile {
  flex: 1 1 160px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.kpi-label { color: var(--text-secondary); font-size: 12px; margin-bottom: 6px; }
.kpi-value { font-size: 24px; font-weight: 600; }
.chart-card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.toggle-btn {
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  background: var(--surface-1);
  color: var(--text-secondary);
  border: none;
  cursor: pointer;
}
.toggle-btn.active { background: var(--series-1); color: #fff; }
.chart-svg { width: 100%; height: auto; display: block; }
.gridline { stroke: var(--grid); stroke-width: 1; }
.baseline { stroke: var(--baseline); stroke-width: 1; }
.axis-label { fill: var(--muted); font-size: 11px; }
.day-bar { cursor: pointer; }
.day-bar:hover rect:not(.hit-target),
.day-bar:focus rect:not(.hit-target),
.day-bar:hover path,
.day-bar:focus path { opacity: 0.85; }
.day-bar:focus { outline: none; }
.day-bar:focus .hit-target { stroke: var(--series-1); stroke-width: 2; }
.legend { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.legend-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.legend-label { flex: 1 1 auto; color: var(--text-primary); }
.legend-value { color: var(--text-primary); font-weight: 600; }
.legend-pct { color: var(--text-secondary); width: 52px; text-align: right; }
.empty-note { color: var(--text-secondary); font-size: 13px; }
.day-detail { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; }
.day-detail-title { font-weight: 600; margin-bottom: 8px; }
.day-detail-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.day-detail-value { margin-left: auto; font-weight: 600; }
[hidden] { display: none !important; }`;

// The cost/token toggle and day drill-down, as one small vanilla script. It only ever reads the
// two `<script type="application/json">` payloads this module already formatted (see
// buildDayDetails) and writes them back with textContent, never innerHTML, for label text that
// ultimately comes from local session data this file doesn't control.
const CLIENT_SCRIPT = `(function () {
  "use strict";
  var state = { measure: "cost" };

  function readJson(id) {
    var el = document.getElementById(id);
    if (!el || !el.textContent) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      return null;
    }
  }

  var payload = { cost: readJson("panel-cost-data"), tokens: readJson("panel-tokens-data") };
  var panels = {
    cost: document.getElementById("panel-cost"),
    tokens: document.getElementById("panel-tokens")
  };
  var buttons = {
    cost: document.getElementById("measure-cost"),
    tokens: document.getElementById("measure-tokens")
  };
  var titleEl = document.getElementById("chart-title");
  var detailEl = document.getElementById("day-detail");

  function hideDetail() {
    if (!detailEl) return;
    detailEl.hidden = true;
    while (detailEl.firstChild) detailEl.removeChild(detailEl.firstChild);
  }

  function setMeasure(measure) {
    state.measure = measure;
    var keys = ["cost", "tokens"];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var active = key === measure;
      if (panels[key]) panels[key].hidden = !active;
      if (buttons[key]) {
        buttons[key].classList.toggle("active", active);
        buttons[key].setAttribute("aria-pressed", String(active));
      }
    }
    var data = payload[measure];
    if (titleEl && data && data.title) titleEl.textContent = data.title;
    hideDetail();
  }

  function showDay(day) {
    var data = payload[state.measure];
    if (!data || !detailEl) return;
    var found = null;
    for (var i = 0; i < data.days.length; i++) {
      if (data.days[i].day === day) {
        found = data.days[i];
        break;
      }
    }
    if (!found) return;

    while (detailEl.firstChild) detailEl.removeChild(detailEl.firstChild);

    var title = document.createElement("div");
    title.className = "day-detail-title";
    title.textContent = day + " - " + found.total;
    detailEl.appendChild(title);

    for (var j = 0; j < found.entries.length; j++) {
      var entry = found.entries[j];
      var row = document.createElement("div");
      row.className = "day-detail-row";

      var swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = entry.color;
      row.appendChild(swatch);

      var label = document.createElement("span");
      label.textContent = entry.label;
      row.appendChild(label);

      var value = document.createElement("span");
      value.className = "day-detail-value";
      value.textContent = entry.value;
      row.appendChild(value);

      detailEl.appendChild(row);
    }

    detailEl.hidden = false;
  }

  var dayBars = document.querySelectorAll(".day-bar");
  for (var k = 0; k < dayBars.length; k++) {
    (function (el) {
      el.addEventListener("click", function () {
        showDay(el.getAttribute("data-day"));
      });
      el.addEventListener("keydown", function (evt) {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          showDay(el.getAttribute("data-day"));
        }
      });
    })(dayBars[k]);
  }

  if (buttons.cost) buttons.cost.addEventListener("click", function () { setMeasure("cost"); });
  if (buttons.tokens) buttons.tokens.addEventListener("click", function () { setMeasure("tokens"); });
})();`;

export function renderHtml(days: DayBucket[]): string {
	const totals = windowTotals(days);
	const costPanel = renderMeasurePanel(days, "cost", "panel-cost", false);
	const tokensPanel = renderMeasurePanel(days, "tokens", "panel-tokens", true);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>my-usage</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>my-usage</h1>
${renderKpiRow(totals)}
<section class="chart-card">
<div class="chart-toolbar">
<h2 id="chart-title">Daily cost</h2>
<div class="toggle" role="group" aria-label="Measure">
<button type="button" id="measure-cost" class="toggle-btn active" aria-pressed="true">Cost</button>
<button type="button" id="measure-tokens" class="toggle-btn" aria-pressed="false">Tokens</button>
</div>
</div>
${costPanel.html}
${tokensPanel.html}
<div id="day-detail" class="day-detail" hidden></div>
</section>
</main>
${costPanel.dataScript}
${tokensPanel.dataScript}
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}
