import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { DayBucket, ModelTotals } from "./aggregate.js";
import {
	formatCurrency,
	formatTokens,
	OTHER_LABEL,
	shareByModel,
	stackByModel,
} from "./chart-model.js";
import {
	findDayDetail,
	measureToggleState,
	readJson,
	renderDayDetail,
} from "./client-script.js";
import { renderHtml } from "./render.js";

interface SeriesSpec {
	provider?: string;
	model?: string;
	cost?: number;
	tokens?: number;
}

/** One model's totals for a day, as aggregateDaily records them. */
function series(spec: SeriesSpec = {}): ModelTotals {
	return {
		provider: spec.provider ?? "anthropic",
		model: spec.model ?? "claude-sonnet-4-5",
		notionalCost: spec.cost ?? 0,
		tokens: spec.tokens ?? 0,
		unpricedTokens: 0,
	};
}

/** A DayBucket as aggregateDaily builds it (see chart-model.test.ts's identical helper). */
function day(
	label: string,
	models: ModelTotals[],
	responses = models.length,
): DayBucket {
	const byModel: Record<string, ModelTotals> = {};
	let notionalCost = 0;
	let tokens = 0;
	for (const m of models) {
		byModel[`${m.provider}\u0000${m.model}`] = m;
		notionalCost += m.notionalCost;
		tokens += m.tokens;
	}
	return { day: label, byModel, notionalCost, tokens, responses };
}

const OPUS = { provider: "anthropic", model: "claude-opus-4-6" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-4-5" };
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5" };
const GPT = { provider: "openai", model: "gpt-5.1" };
const GEMINI = { provider: "google", model: "gemini-2.5-pro" };
const GROK = { provider: "xai", model: "grok-5" };
const DEEPSEEK = { provider: "deepseek", model: "deepseek-v4" };
const GLM = { provider: "opencode", model: "glm-5.2" };
const MISTRAL = { provider: "mistral", model: "mistral-large-3" };
const LLAMA = { provider: "groq", model: "llama-5-70b" };

/**
 * A realistic 14-day window built straight from aggregate.ts's DayBucket/ModelTotals shape.
 * 2026-09-07 has three models (a multi-segment bar), 2026-09-08 has one (a single-segment
 * bar), 2026-09-09 is quiet (no usage at all), and ten distinct models appear across the
 * window - past stackByModel's default topN of 8, so the tail folds into Other. 14 days also
 * puts the x-axis's "always show the last day" rule to a real test: with the default label
 * spacing, day 13 doesn't fall on the every-other-day tick a shorter window would give it for
 * free.
 */
function buildWindow(): DayBucket[] {
	return [
		day("2026-09-07", [
			series({ ...OPUS, cost: 12, tokens: 12_000 }),
			series({ ...SONNET, cost: 8, tokens: 9_000 }),
			series({ ...HAIKU, cost: 4, tokens: 4_000 }),
		]),
		day("2026-09-08", [series({ ...OPUS, cost: 9, tokens: 9_500 })]),
		day("2026-09-09", []),
		day("2026-09-10", [
			series({ ...GPT, cost: 7, tokens: 7_000 }),
			series({ ...GEMINI, cost: 6, tokens: 6_500 }),
		]),
		day("2026-09-11", [
			series({ ...OPUS, cost: 10, tokens: 10_000 }),
			series({ ...GROK, cost: 5, tokens: 5_200 }),
			series({ ...DEEPSEEK, cost: 3, tokens: 3_100 }),
		]),
		day("2026-09-12", [series({ ...GLM, cost: 2, tokens: 6_000 })]),
		day("2026-09-13", [
			series({ ...SONNET, cost: 6, tokens: 6_100 }),
			series({ ...MISTRAL, cost: 1, tokens: 1_500 }),
		]),
		day("2026-09-14", [series({ ...LLAMA, cost: 0.5, tokens: 900 })]),
		day("2026-09-15", [
			series({ ...OPUS, cost: 11, tokens: 11_200 }),
			series({ ...HAIKU, cost: 3, tokens: 3_300 }),
			series({ ...GPT, cost: 4, tokens: 4_400 }),
		]),
		day("2026-09-16", [series({ ...GEMINI, cost: 5, tokens: 5_500 })]),
		day("2026-09-17", [
			series({ ...SONNET, cost: 7, tokens: 7_300 }),
			series({ ...GROK, cost: 2, tokens: 2_200 }),
		]),
		day("2026-09-18", [series({ ...DEEPSEEK, cost: 2, tokens: 2_600 })]),
		day("2026-09-19", [
			series({ ...OPUS, cost: 8, tokens: 8_800 }),
			series({ ...MISTRAL, cost: 1, tokens: 1_100 }),
			series({ ...LLAMA, cost: 0.5, tokens: 700 }),
		]),
		day("2026-09-20", [series({ ...GLM, cost: 3, tokens: 5_000 })]),
	];
}

/**
 * One double-quoted attribute's value from a single tag's own markup, found by NAME rather than
 * position - so every helper below stays correct however render.ts orders a tag's attributes.
 * `undefined` when the tag doesn't carry that attribute at all.
 */
function attr(tag: string, name: string): string | undefined {
	return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/**
 * The full `<svg ...>...</svg>` markup for the panel whose `aria-label` matches, or "" if not
 * found. Found by NAME, same convention as `attr`/`dayBarMarkup` above, so this stays correct
 * however render.ts orders the `<svg>` tag's own attributes.
 */
function svgMarkup(html: string, ariaLabel: string): string {
	const svgs = html.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/g) ?? [];
	const svg = svgs.find((s) => {
		const openTag = s.match(/^<svg\b[^>]*>/)?.[0] ?? "";
		return attr(openTag, "aria-label") === ariaLabel;
	});
	return svg ?? "";
}

/** The `<g class="day-bar" data-day="...">...</g>` markup for one day, or "" if not found. */
function dayBarMarkup(html: string, dayLabel: string): string {
	const groups = html.match(/<g\b[^>]*>[\s\S]*?<\/g>/g) ?? [];
	const group = groups.find((g) => {
		const openTag = g.match(/^<g\b[^>]*>/)?.[0] ?? "";
		return (
			attr(openTag, "class") === "day-bar" &&
			attr(openTag, "data-day") === dayLabel
		);
	});
	return group ?? "";
}

interface SegmentGeometry {
	topY: number;
	bottomY: number;
	height: number;
}

/** Every floating-point number in `text`, in the order they appear. */
function numbersIn(text: string): number[] {
	return (text.match(/-?\d+\.\d+/g) ?? []).map(Number);
}

/**
 * A day-bar group's filled stack-segment elements (its `<rect>`s and rounded-top `<path>`),
 * bottom to top in the same order `renderChartSvg` emits them. An element counts as a segment by
 * its own `fill` attribute's VALUE starting with "var(--" (a named series or Other's shared
 * color) - read by name via `attr`, not by where `fill` happens to sit in the tag - which also
 * correctly excludes the hit-target rect (`fill="transparent"`) on that value alone, however the
 * tag's attributes are ordered.
 */
function filledSegmentElements(group: string): string[] {
	const elements = group.match(/<(?:rect|path)\b[^>]*\/>/g) ?? [];
	return elements.filter((el) => (attr(el, "fill") ?? "").startsWith("var(--"));
}

/**
 * `filledSegmentElements`, resolved to geometry. Reads real y/height geometry straight out of the
 * markup: a `<rect>`'s own `y`/`height` attributes, or a `<path>`'s `d` attribute, whose numbers
 * alternate x, y throughout `roundedTopRectPath`'s commands - so every odd-indexed number is a y
 * coordinate, and their min/max are the path's top and bottom. Every attribute is read by name via
 * `attr`, so this keeps working however render.ts orders a `<rect>`/`<path>`'s attributes.
 */
function segmentGeometries(group: string): SegmentGeometry[] {
	return filledSegmentElements(group).map((el) => {
		if (el.startsWith("<rect")) {
			const y = Number(attr(el, "y"));
			const height = Number(attr(el, "height"));
			return { topY: y, bottomY: y + height, height };
		}
		const d = attr(el, "d") ?? "";
		const ys = numbersIn(d).filter((_, i) => i % 2 === 1);
		const topY = Math.min(...ys);
		const bottomY = Math.max(...ys);
		return { topY, bottomY, height: bottomY - topY };
	});
}

/** The chart's baseline y, read from a day-bar group's own hit-target rect (its `y` + `height`). */
function baselineYOf(group: string): number {
	const hitTarget = (group.match(/<rect\b[^>]*\/>/g) ?? []).find(
		(el) => attr(el, "class") === "hit-target",
	);
	const y = Number(hitTarget && attr(hitTarget, "y"));
	const height = Number(hitTarget && attr(hitTarget, "height"));
	return y + height;
}

interface DayDetailPayload {
	title: string;
	days: { day: string; total: string; entries: DayDetailEntryPayload[] }[];
}

interface DayDetailEntryPayload {
	label: string;
	color: string;
	value: string;
}

/**
 * `panelDataText`'s raw extracted text (see that function, below, for the extraction logic),
 * `JSON.parse`d into the shape `renderHtml`'s embedded payload has.
 */
function readPanelData(html: string, panelId: string): DayDetailPayload {
	return JSON.parse(panelDataText(html, panelId)) as DayDetailPayload;
}

describe("renderHtml: document shape", () => {
	it("returns a self-contained HTML document for an empty window", () => {
		const html = renderHtml([]);

		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("<title>my-usage</title>");
		expect(html).toMatch(/class="kpi-value">\$0\.00</);
		expect(html).toMatch(/class="kpi-value">0</);
		expect(html).toContain("No usage recorded in this window.");
		expect(html).not.toMatch(/NaN|Infinity/);
	});

	it("never references the network: no http(s) URLs, no external scripts or stylesheets", () => {
		const html = renderHtml(buildWindow());

		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(html).not.toMatch(/<link[^>]+href=/);
	});

	it("never emits NaN or Infinity for a populated window", () => {
		expect(renderHtml(buildWindow())).not.toMatch(/NaN|Infinity/);
	});

	it("labels each chart's SVG aria-label 'Daily cost', matching the visible heading and the JSON payload's title", () => {
		const html = renderHtml(buildWindow());

		expect(html).toContain(
			'<svg viewBox="0 0 840 360" class="chart-svg" role="img" aria-label="Daily cost">',
		);
		expect(html).toContain(
			'<svg viewBox="0 0 840 360" class="chart-svg" role="img" aria-label="Daily cost (Tokens)">',
		);
	});
});

describe("renderHtml: KPI row", () => {
	it("pairs each tile's own label with its own formatter's output, not another tile's, in the documented Notional cost / Tokens / Responses order", () => {
		// Hand-computed literal expectations, not a re-run of windowTotals/the formatters
		// under test (the self-referential shape myusage-4xu.29 flagged: that version
		// stayed green under both a label swap and a formatter swap). notionalCost 12.25,
		// tokens 2,340,000 and responses 1,234 format under their OWN tile's formatter as
		// three visibly different strings ("$12.25", "2.34M", "1,234"), so mispairing any
		// tile's label with another's value, or swapping any tile's formatter for
		// another's, changes what's asserted here - unlike the original fixture, where
		// formatCount and formatTokens happened to agree on the response count.
		//
		// Asserted as one contiguous literal spanning all three tiles in sequence, rather
		// than three independent `toContain`s: three separate checks each pass regardless of
		// which order the tiles render in, so reversing renderKpiRow's tile order used to
		// survive this test untouched (myusage-4xu.43). One literal covering all three, back
		// to back, pins the order too.
		const days = [
			day("2026-09-01", [series({ cost: 5, tokens: 1_000_000 })], 600),
			day("2026-09-02", [series({ cost: 7.25, tokens: 1_340_000 })], 634),
		];

		const html = renderHtml(days);

		expect(html).toContain(
			[
				'<div class="kpi-tile">\n<div class="kpi-label">Notional cost</div>\n<div class="kpi-value">$12.25</div>\n</div>',
				'<div class="kpi-tile">\n<div class="kpi-label">Tokens</div>\n<div class="kpi-value">2.34M</div>\n</div>',
				'<div class="kpi-tile">\n<div class="kpi-label">Responses</div>\n<div class="kpi-value">1,234</div>\n</div>',
			].join("\n"),
		);
	});
});

describe("renderHtml: skipped-database callout (myusage-4xu.98)", () => {
	it("shows no callout when the skipped argument is omitted, the shape every other test in this file exercises", () => {
		const html = renderHtml(buildWindow());

		// Not a bare "skip-note" check: the STYLE block always defines that CSS class, skipped or
		// not, so only the rendered <p> element (or its message text) proves anything about
		// whether the callout itself appears.
		expect(html).not.toContain('<p class="skip-note">');
		expect(html).not.toContain("could not be read");
	});

	it("shows no callout when skipped is explicitly zero, not just when the argument is omitted", () => {
		const html = renderHtml(buildWindow(), { skipped: 0, total: 3 });

		expect(html).not.toContain('<p class="skip-note">');
		expect(html).not.toContain("could not be read");
	});

	it("names how many of how many databases were skipped when one or more failed to read", () => {
		const html = renderHtml(buildWindow(), { skipped: 1, total: 3 });

		expect(html).toContain(
			'<p class="skip-note">1 of 3 databases could not be read - see terminal for details.</p>',
		);
	});

	it("places the callout above the KPI row, not buried after the chart", () => {
		const html = renderHtml(buildWindow(), { skipped: 2, total: 5 });

		const skipIndex = html.indexOf('class="skip-note"');
		const kpiIndex = html.indexOf('class="kpi-row"');
		expect(skipIndex).toBeGreaterThan(-1);
		expect(kpiIndex).toBeGreaterThan(-1);
		expect(skipIndex).toBeLessThan(kpiIndex);
	});
});

describe("renderHtml: legend / breakdown", () => {
	it("lists every ranked cost series, folding the tail into Other", () => {
		const days = buildWindow();
		const stacks = stackByModel(days, "cost");
		const shares = shareByModel(stacks.series, stacks.days);

		const html = renderHtml(days);

		expect(shares.ranked.some((entry) => entry.series.kind === "other")).toBe(
			true,
		);
		for (const entry of shares.ranked) {
			expect(html).toContain(`>${entry.series.label}<`);
			expect(html).toContain(`>${formatCurrency(entry.value)}<`);
			expect(html).toContain(`>${entry.pct.toFixed(1)}%<`);
		}
	});

	it("lists every ranked token series with token-formatted values", () => {
		const days = buildWindow();
		const stacks = stackByModel(days, "tokens");
		const shares = shareByModel(stacks.series, stacks.days);

		const html = renderHtml(days);

		for (const entry of shares.ranked) {
			expect(html).toContain(`>${formatTokens(entry.value)}<`);
		}
	});
});

describe("renderHtml: daily chart", () => {
	it("draws one day-bar group per day, in both the cost and tokens panels", () => {
		const days = buildWindow();
		const html = renderHtml(days);

		for (const bucket of days) {
			const count = (
				html.match(new RegExp(`data-day="${bucket.day}"`, "g")) ?? []
			).length;
			expect(count).toBe(2);
		}
	});

	it("still draws a bar group for a quiet day, with no fill segments", () => {
		const html = renderHtml(buildWindow());

		const group = dayBarMarkup(html, "2026-09-09");

		expect(group).not.toBe("");
		expect(group).not.toMatch(/fill="var\(--(series-\d|other)\)"/);
	});

	it("rounds only the topmost segment of a multi-model day, leaving the rest square", () => {
		const html = renderHtml(buildWindow());

		const group = dayBarMarkup(html, "2026-09-07");
		const elements = filledSegmentElements(group);

		expect(elements.some((el) => el.startsWith("<path"))).toBe(true);
		const squareSegments = elements.filter((el) => el.startsWith("<rect"));
		expect(squareSegments.length).toBeGreaterThan(0);
	});

	it("draws a single-model day as just the one rounded top segment", () => {
		const html = renderHtml(buildWindow());

		const group = dayBarMarkup(html, "2026-09-08");
		const elements = filledSegmentElements(group);

		const fillPaths = elements.filter((el) => el.startsWith("<path"));
		const fillRects = elements.filter((el) => el.startsWith("<rect"));
		expect(fillPaths).toHaveLength(1);
		expect(fillRects).toHaveLength(0);
	});
});

describe("renderHtml: chart geometry", () => {
	it("stacks segments upward from the baseline instead of drawing every one from it", () => {
		const group = dayBarMarkup(renderHtml(buildWindow()), "2026-09-07");
		const baselineY = baselineYOf(group);
		const [bottom, middle, top] = segmentGeometries(group);
		if (!bottom || !middle || !top) throw new Error("fixture has 3 segments");

		// The bottommost segment sits right on the baseline. If every segment did too (as
		// `cumulative += 0` inside the bars fold would cause), the next two would match it as
		// well, and neither would sit above the one before it.
		expect(bottom.bottomY).toBeCloseTo(baselineY, 1);
		expect(middle.bottomY).not.toBeCloseTo(baselineY, 1);
		expect(top.bottomY).not.toBeCloseTo(baselineY, 1);

		// Each segment's top is a smaller y (higher up the chart) than the one below it: real
		// stacking, not three bars independently drawn from the baseline and overlapping.
		expect(middle.topY).toBeLessThan(bottom.topY);
		expect(top.topY).toBeLessThan(middle.topY);

		// The stack's total height (baseline to the topmost segment's top) is close to the sum
		// of the individual segment heights - short by the two inter-segment gaps, never by more.
		const stackedHeight = baselineY - top.topY;
		const summedHeights = bottom.height + middle.height + top.height;
		expect(summedHeights).toBeLessThanOrEqual(stackedHeight);
		expect(summedHeights).toBeGreaterThan(stackedHeight - 20);
	});

	it("leaves a visible gap between adjacent stacked segments", () => {
		const group = dayBarMarkup(renderHtml(buildWindow()), "2026-09-07");
		const [bottom, middle, top] = segmentGeometries(group);
		if (!bottom || !middle || !top) throw new Error("fixture has 3 segments");

		const gapBelowMiddle = bottom.topY - middle.bottomY;
		const gapBelowTop = middle.topY - top.bottomY;

		expect(gapBelowMiddle).toBeGreaterThan(0);
		expect(gapBelowTop).toBeGreaterThan(0);
		// Both seams come from the same SEGMENT_GAP constant.
		expect(gapBelowMiddle).toBeCloseTo(gapBelowTop, 1);
	});

	it("gives a bigger day's total a taller bar (a lower topmost y) than a smaller day's", () => {
		const html = renderHtml(buildWindow());
		const biggerDay = segmentGeometries(dayBarMarkup(html, "2026-09-07")); // $24 total
		const smallerDay = segmentGeometries(dayBarMarkup(html, "2026-09-08")); // $9 total
		const biggerTop = biggerDay.at(-1);
		const smallerTop = smallerDay.at(-1);
		if (!biggerTop || !smallerTop) throw new Error("fixture has both days");

		// An inverted scale would give the bigger day the smaller bar (or none at all); a
		// correct one gives it a topmost y closer to the plot's top margin.
		expect(biggerTop.topY).toBeLessThan(smallerTop.topY);
	});

	it("floors a clamped segment's height at zero instead of going negative", () => {
		// A day whose upper segment's raw scaled height (a sliver of the max-value day) is far
		// smaller than SEGMENT_GAP: Math.max(0, rawHeight - SEGMENT_GAP) must floor it at zero
		// rather than emitting a negative height.
		const days = [
			day("2026-01-01", [series({ model: "big", cost: 100_000 })]),
			day("2026-01-02", [
				series({ model: "base", cost: 5_000 }),
				series({ model: "tiny", cost: 100 }),
			]),
		];

		const group = dayBarMarkup(renderHtml(days), "2026-01-02");
		const clamped = segmentGeometries(group).at(-1);
		if (!clamped) throw new Error("fixture has a tiny top segment");

		expect(clamped.height).toBe(0);
		expect(group).not.toMatch(/height="-/);
	});
});

describe("renderHtml: chart axis", () => {
	it("labels an x-axis tick with MM-DD, not the full date", () => {
		const html = renderHtml(buildWindow());

		expect(html).toMatch(
			/<text[^>]*class="axis-label axis-label-x"[^>]*>09-07<\/text>/,
		);
		expect(html).not.toMatch(
			/<text[^>]*class="axis-label axis-label-x"[^>]*>2026-09-07<\/text>/,
		);
	});

	it("always shows a tick for the last day, even off the every-Nth-day spacing rule", () => {
		// 14 days at the default label spacing (labelEvery = round(14 / 6) = 2) ticks every
		// second day by that rule alone; day 13 (index 13, odd) only gets a tick because of
		// the "always show the last day" exception.
		const html = renderHtml(buildWindow());

		const lastDayTicks =
			html.match(
				/<text[^>]*class="axis-label axis-label-x"[^>]*>09-20<\/text>/g,
			) ?? [];

		// Once per measure panel (cost, tokens).
		expect(lastDayTicks).toHaveLength(2);
	});

	it("draws three y-axis gridlines per panel, at 0%, 50% and 100% of the max value, each labeled", () => {
		// Assertions below are on the meaningful properties (count, relative fraction-based
		// position, and label text computed the same way the source computes it) rather than
		// literal pixel coordinates - a deliberate margin/layout tweak must not break this
		// test even though nothing would actually be wrong (myusage-4xu.43).
		const days = buildWindow();
		const html = renderHtml(days);

		// Two panels, three fractions each - dropping the 0.5 fraction (down to just [0, 1])
		// would halve this to 4.
		const gridlines = html.match(/<line[^>]*class="gridline"[^>]*\/>/g) ?? [];
		expect(gridlines).toHaveLength(6);

		const svg = svgMarkup(html, "Daily cost");
		const lines = svg.match(/<line[^>]*class="gridline"[^>]*\/>/g) ?? [];
		const baseline = svg.match(/<line[^>]*class="baseline"[^>]*\/>/)?.[0] ?? "";
		const labels =
			svg.match(
				/<text[^>]*class="axis-label axis-label-y"[^>]*>[^<]*<\/text>/g,
			) ?? [];
		expect(lines).toHaveLength(3);
		expect(labels).toHaveLength(3);

		// Every gridline spans the exact same horizontal extent as the chart's own baseline -
		// the full plot width - whatever x the margins land on.
		for (const line of lines) {
			expect(attr(line, "x1")).toBe(attr(baseline, "x1"));
			expect(attr(line, "x2")).toBe(attr(baseline, "x2"));
		}

		// The 0% gridline sits exactly on the baseline; the 100% gridline sits above it; the
		// 50% gridline sits exactly halfway between them - the same fraction-of-plot-height
		// math the source uses, verified here as a relationship instead of a pinned pixel
		// value.
		const [zeroY, halfY, fullY] = lines.map((line) => Number(attr(line, "y1")));
		if (zeroY === undefined || halfY === undefined || fullY === undefined) {
			throw new Error("fixture has 3 gridlines");
		}
		expect(zeroY).toBe(Number(attr(baseline, "y1")));
		expect(fullY).toBeLessThan(zeroY);
		expect(halfY).toBeCloseTo((zeroY + fullY) / 2, 5);

		// Each gridline's label sits on the same row as its line (same y) and reads the
		// window's max cost at that line's own fraction, formatted the same way the source
		// formats it - not a hardcoded dollar literal that would go stale the moment the
		// fixture's totals change.
		const stacks = stackByModel(days, "cost");
		const maxValue = Math.max(0, ...stacks.days.map((d) => d.total));
		const labelYs = labels.map((label) => Number(attr(label, "y")));
		const labelTexts = labels.map(
			(label) => label.match(/>([^<]*)<\/text>/)?.[1],
		);
		expect(labelYs).toEqual(lines.map((line) => Number(attr(line, "y1"))));
		expect(labelTexts).toEqual(
			[0, 0.5, 1].map((fraction) => formatCurrency(maxValue * fraction)),
		);

		// The 100% gridline's y must equal the window's tallest bar's own topmost-segment y:
		// both are baselineY minus a plotHeight-scaled fraction of the same maxValue, so a
		// gridline scale that drifts from the bars' scale (for example plotHeight * fraction
		// halved to plotHeight * 0.5 * fraction) would move the gridline while leaving the
		// bar's own top untouched - a real rendering bug the relative checks above can't catch,
		// since they only compare gridlines to each other. "2026-09-07" is this window's
		// biggest cost day at $24 (== maxValue; see "gives a bigger day's total a taller bar"
		// above), and dayBarMarkup resolves it to the cost panel's own bar the same way that
		// test does, so this stays correct however margin/layout constants change.
		const tallestBar = segmentGeometries(dayBarMarkup(html, "2026-09-07"));
		const tallestBarTop = tallestBar.at(-1);
		if (!tallestBarTop)
			throw new Error("fixture's tallest bar has no segments");
		expect(fullY).toBeCloseTo(tallestBarTop.topY, 5);
	});
});

/**
 * One CSS declaration's value out of a `style` attribute's value, found by property NAME rather
 * than assuming it's the only (or first) declaration present - so `styleDeclaration(s,
 * "background")` keeps working whatever else `style` carries, or what order the declarations
 * are in. `""` when `style` doesn't carry that property at all.
 */
function styleDeclaration(style: string, property: string): string {
	const declaration = style
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${property}:`));
	return declaration?.slice(property.length + 1).trim() ?? "";
}

/**
 * Every `<li class="legend-row">...</li>` block in the rendered legend, as `[label, color]`
 * pairs. Finds the row scope, the swatch's `style` attribute, and the label span all by
 * attribute NAME via the shared `attr` reader - the same pattern the day-bar markup helpers
 * above use - rather than a fixed-shape regex or exact-class match, so this stays correct
 * however `renderLegend` orders attributes, whatever unrelated attributes it adds to the row or
 * label tags, and whatever else the swatch's `style` attribute carries besides `background`
 * (myusage-4xu.42, myusage-4xu.44).
 */
function legendPairs(html: string): [label: string, color: string][] {
	const items = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
	const rows = items.filter((li) => {
		const openTag = li.match(/^<li\b[^>]*>/)?.[0] ?? "";
		return attr(openTag, "class") === "legend-row";
	});
	return rows.map((row) => {
		const spans = row.match(/<span\b[^>]*>[^<]*<\/span>/g) ?? [];
		const swatch =
			spans.find((span) => {
				const openTag = span.match(/^<span\b[^>]*>/)?.[0] ?? "";
				return attr(openTag, "class") === "swatch";
			}) ?? "";
		const swatchOpenTag = swatch.match(/^<span\b[^>]*>/)?.[0] ?? "";
		const style = attr(swatchOpenTag, "style") ?? "";
		const color = styleDeclaration(style, "background");

		const labelSpan =
			spans.find((span) => {
				const openTag = span.match(/^<span\b[^>]*>/)?.[0] ?? "";
				return attr(openTag, "class") === "legend-label";
			}) ?? "";
		const label = labelSpan.match(/^<span\b[^>]*>([^<]*)<\/span>$/)?.[1] ?? "";

		return [label, color];
	});
}

describe("renderHtml: chart color assignment", () => {
	it("gives each named series its own distinct, consistent color across the legend and the bar", () => {
		const days = [
			day("2026-01-01", [
				series({ model: "model-a", cost: 10 }),
				series({ model: "model-b", cost: 5 }),
			]),
		];

		const html = renderHtml(days);

		// Ranked by cost: model-a (10) first, model-b (5) second - buildColorLookup assigns
		// palette slots in that rank order, one each, never repeating a slot.
		// Pinned as an exact literal deliberately: unlike the gridline test above, this isn't
		// a layout coordinate a margin/spacing tweak could move - `var(--series-N)` is the
		// rank-to-palette-slot mapping itself, the user-visible behavior this test exists to
		// protect (myusage-4xu.43).
		expect(legendPairs(html)).toEqual([
			["model-a", "var(--series-1)"],
			["model-b", "var(--series-2)"],
		]);

		// The same colors, in the same bottom-to-top stacking order, show up on the bar.
		const group = dayBarMarkup(html, "2026-01-01");
		const segmentFills = filledSegmentElements(group).map((el) =>
			attr(el, "fill"),
		);
		expect(segmentFills).toEqual(["var(--series-1)", "var(--series-2)"]);
	});

	it("gives the Other roll-up its own fixed color, never one of the named-series slots", () => {
		const html = renderHtml(buildWindow());

		const pairs = legendPairs(html);

		const otherPair = pairs.find(([label]) => label === OTHER_LABEL);
		if (!otherPair) throw new Error("fixture folds a tail into Other");
		// Same reasoning as the test above: `var(--other)` is the documented, fixed color for
		// the roll-up, not a coordinate a layout tweak could shift - an intentional exact pin.
		expect(otherPair[1]).toBe("var(--other)");

		const namedColors = pairs
			.filter(([label]) => label !== OTHER_LABEL)
			.map(([, color]) => color);
		expect(namedColors).not.toContain("var(--other)");
	});
});

describe("renderHtml: bar width", () => {
	it("caps the bar width at a maximum of 24px when few days give a wide natural slot", () => {
		const days = [
			day("day-0", [
				series({ model: "model-a", cost: 5 }),
				series({ model: "model-b", cost: 3 }),
			]),
			day("day-1", []),
		];

		const group = dayBarMarkup(renderHtml(days), "day-0");
		const rect = filledSegmentElements(group).find((el) =>
			el.startsWith("<rect"),
		);
		if (!rect) throw new Error("fixture's first day has a square segment");

		expect(attr(rect, "width")).toBe("24.00");
	});

	it("floors the bar width at a minimum of 2px when enough days make the natural slot tiny", () => {
		const manyQuietDays: DayBucket[] = Array.from({ length: 300 }, (_, i) =>
			i === 0
				? day("day-0", [
						series({ model: "model-a", cost: 5 }),
						series({ model: "model-b", cost: 3 }),
					])
				: day(`day-${i}`, []),
		);

		const group = dayBarMarkup(renderHtml(manyQuietDays), "day-0");
		const rect = filledSegmentElements(group).find((el) =>
			el.startsWith("<rect"),
		);
		if (!rect) throw new Error("fixture's first day has a square segment");

		expect(attr(rect, "width")).toBe("2.00");
	});
});

describe("renderHtml: cost/token toggle", () => {
	it("starts on cost, with the tokens panel hidden", () => {
		const html = renderHtml(buildWindow());

		expect(html).toMatch(
			/<button type="button" id="measure-cost" class="toggle-btn active" aria-pressed="true">Cost<\/button>/,
		);
		expect(html).toMatch(
			/<button type="button" id="measure-tokens" class="toggle-btn" aria-pressed="false">Tokens<\/button>/,
		);
		expect(html).toContain('id="panel-tokens" class="measure-panel" hidden');
		expect(html).not.toContain('id="panel-cost" class="measure-panel" hidden');
	});
});

describe("renderHtml: day drill-down payload", () => {
	it("embeds a per-day cost breakdown that matches stackByModel, pre-formatted", () => {
		const days = buildWindow();
		const stacks = stackByModel(days, "cost");

		const payload = readPanelData(renderHtml(days), "panel-cost");

		expect(payload.title).toBe("Daily cost");
		expect(payload.days).toHaveLength(days.length);

		const busyDay = payload.days.find((d) => d.day === "2026-09-07");
		const stackedDay = stacks.days.find((d) => d.day === "2026-09-07");
		if (!busyDay || !stackedDay) throw new Error("fixture has 2026-09-07");

		const expectedEntries = stacks.series
			.map((s, i) => ({ series: s, value: stackedDay.segments[i] ?? 0 }))
			.filter((e) => e.value > 0);

		expect(busyDay.entries.map((e) => e.label)).toEqual(
			expectedEntries.map((e) => e.series.label),
		);
		expect(busyDay.entries.map((e) => e.value)).toEqual(
			expectedEntries.map((e) => formatCurrency(e.value)),
		);
		expect(busyDay.total).toBe(formatCurrency(stackedDay.total));
	});

	it("titles the tokens panel through measureFormat, not a hand-written string", () => {
		const payload = readPanelData(renderHtml(buildWindow()), "panel-tokens");

		expect(payload.title).toBe("Daily cost (Tokens)");
	});

	it("leaves a quiet day's entries empty", () => {
		const payload = readPanelData(renderHtml(buildWindow()), "panel-cost");

		const quietDay = payload.days.find((d) => d.day === "2026-09-09");

		expect(quietDay?.entries).toEqual([]);
		expect(quietDay?.total).toBe(formatCurrency(0));
	});

	it("appends the measure's unit label after the formatted value, for tokens", () => {
		// A no-op withUnit (dropping the unitLabel suffix) would leave this reading "25.0k"
		// instead of "25.0k tokens" - still a valid-looking number, so nothing else in the
		// suite would catch it.
		const payload = readPanelData(renderHtml(buildWindow()), "panel-tokens");

		const busyDay = payload.days.find((d) => d.day === "2026-09-07");
		if (!busyDay) throw new Error("fixture has 2026-09-07");

		// 2026-09-07's token total: 12,000 + 9,000 + 4,000 = 25,000.
		expect(busyDay.total).toBe("25.0k tokens");
	});
});

describe("renderHtml: escaping untrusted local labels", () => {
	it("HTML-escapes a model id that looks like a tag", () => {
		const hazardous = [
			day("2026-09-07", [
				series({
					provider: "custom",
					model: "<img src=x onerror=alert(1)>",
					cost: 5,
					tokens: 500,
				}),
			]),
		];

		const html = renderHtml(hazardous);

		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("keeps a label containing a closing script tag from breaking the embedded JSON", () => {
		const hazardous = [
			day("2026-09-07", [
				series({
					provider: "custom",
					model: "weird</script><script>evil()</script>",
					cost: 5,
					tokens: 500,
				}),
			]),
		];

		const html = renderHtml(hazardous);

		expect(html).not.toContain("</script><script>evil()");
		const payload = readPanelData(html, "panel-cost");
		expect(payload.days[0]?.entries[0]?.label).toBe(
			"weird</script><script>evil()</script>",
		);
	});
});

describe("renderHtml: client script embedding", () => {
	// myusage-4xu.34's whole premise is that CLIENT_SCRIPT runs exactly what client-script.ts's
	// own tests exercise, not a hand-copied second implementation that could drift - render.ts
	// embeds each function's own compiled source via `.toString()`. Nothing pinned that claim:
	// deleting an interpolation, or swapping in a hand-copied drifted implementation (e.g. one
	// that uses innerHTML instead of textContent, the exact regression myusage-4xu.34 closed),
	// left the full gate green (myusage-4xu.41). Asserting the literal compiled source is
	// present is a direct, precise pin - no vm execution needed here, since client-script.test.ts
	// already proves what these functions do; this test only proves the shipped page still
	// contains them. readJson (myusage-3ef) joined the other three the same way, after living
	// untested inside CLIENT_SCRIPT's own string literal, invisible to v8 coverage.
	//
	// What this test does NOT prove: that CLIENT_SCRIPT's own call sites invoke these functions
	// correctly. It pins the embedded TEXT against each function's own source, nothing about the
	// arguments the surrounding glue passes them - an arity bug (e.g. readJson(document), missing
	// the id) or a typo'd element id at a call site (e.g. readJson(document, "panel-Cost-data"))
	// leaves this assertion just as green, since the compiled source is still byte-for-byte
	// embedded either way (myusage-cq8). See "renderHtml: client script execution (vm)" below for
	// a test that runs the real call sites.
	it("embeds each toggle/drill-down function's own compiled source, not a hand-copied duplicate", () => {
		const html = renderHtml(buildWindow());

		expect(html).toContain(measureToggleState.toString());
		expect(html).toContain(findDayDetail.toString());
		expect(html).toContain(renderDayDetail.toString());
		expect(html).toContain(readJson.toString());
	});
});

/** CLIENT_SCRIPT's own source, extracted from real `renderHtml()` output - the plain `<script>` tag (no `type` attribute). The match below takes the FIRST bare `<script>` in the document; that's correct today only because there's exactly one. The load-bearing property is "carries no type attribute," not position - this would need a more specific match if a second bare `<script>` tag were ever added. */
function clientScriptSource(html: string): string {
	const match = html.match(/<script>([\s\S]*?)<\/script>/);
	if (!match?.[1])
		throw new Error("plain <script> (CLIENT_SCRIPT) tag not found");
	return match[1];
}

/**
 * The `<script type="application/json" id="{panelId}-data">` payload's raw text (not
 * `JSON.parse`d) - exactly the string a real browser exposes as that element's `textContent`,
 * which is what gets fed to the fake DOM below so `readJson`'s real call site parses genuine
 * embedded data, not a hand-built stand-in for it. Finds every application/json script tag
 * first, then filters by id read via `attr` - so this stays correct however embedJson orders
 * `type` and `id` on the opening tag, the same order-independence the day-bar markup helpers
 * above already have (myusage-4xu.31, myusage-4xu.42). `readPanelData` (above) is this same
 * lookup with a `JSON.parse` on top - see that function for the parsed-object form.
 */
function panelDataText(html: string, panelId: string): string {
	const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
	const target = scripts.find((tag) => {
		const openTag = tag.match(/^<script\b[^>]*>/)?.[0] ?? "";
		return (
			attr(openTag, "type") === "application/json" &&
			attr(openTag, "id") === `${panelId}-data`
		);
	});
	const match = target?.match(/^<script\b[^>]*>([\s\S]*?)<\/script>$/);
	if (!match?.[1]) throw new Error(`${panelId}-data script not found`);
	return match[1];
}

interface FakeButton {
	classList: { active: boolean; toggle(cls: string, force: boolean): void };
	ariaPressed: string;
	setAttribute(name: string, value: string): void;
	addEventListener(type: string, cb: () => void): void;
	dispatchClick(): void;
}

/** A fake `<button>`: tracks the "active" class, the `aria-pressed` attribute, and its own click listener - just enough surface for CLIENT_SCRIPT's `setMeasure` wiring. */
function fakeButton(): FakeButton {
	let onClick: (() => void) | undefined;
	return {
		classList: {
			active: false,
			toggle(cls, force) {
				if (cls === "active") this.active = force;
			},
		},
		ariaPressed: "",
		setAttribute(name, value) {
			if (name === "aria-pressed") this.ariaPressed = value;
		},
		addEventListener(type, cb) {
			if (type === "click") onClick = cb;
		},
		dispatchClick() {
			onClick?.();
		},
	};
}

interface FakeDetailChild {
	className: string;
	textContent: string;
	style: { background: string };
	children: FakeDetailChild[];
	appendChild(child: FakeDetailChild): void;
}

/** What `document.createElement` returns in the fake DOM below: satisfies `renderDayDetail`'s `DomElementLike`. */
function fakeDetailChild(): FakeDetailChild {
	return {
		className: "",
		textContent: "",
		style: { background: "" },
		children: [],
		appendChild(child) {
			this.children.push(child);
		},
	};
}

interface FakeDetail {
	hidden: boolean;
	children: FakeDetailChild[];
	readonly firstChild: FakeDetailChild | null;
	appendChild(child: FakeDetailChild): void;
	removeChild(child: FakeDetailChild): void;
}

/** The fake `#day-detail` container: satisfies `renderDayDetail`'s `DomContainerLike`. */
function fakeDetail(): FakeDetail {
	return {
		hidden: true,
		children: [],
		get firstChild() {
			return this.children[0] ?? null;
		},
		appendChild(child) {
			this.children.push(child);
		},
		removeChild(child) {
			const i = this.children.indexOf(child);
			if (i >= 0) this.children.splice(i, 1);
		},
	};
}

/** A fake keyboard event: just enough surface for CLIENT_SCRIPT's day-bar keydown handler (`evt.key`, `evt.preventDefault()`), with the call to `preventDefault` observable afterward. */
interface FakeKeydownEvent {
	key: string;
	preventDefaultCalled: boolean;
	preventDefault(): void;
}

interface FakeDayBar {
	getAttribute(name: string): string | null;
	addEventListener(type: string, cb: (evt?: FakeKeydownEvent) => void): void;
	dispatchClick(): void;
	dispatchKeydown(key: string): FakeKeydownEvent;
}

/** A fake `.day-bar` element for one `day`, whose only real datum is its own `data-day` attribute. Tracks the "click" and "keydown" listeners CLIENT_SCRIPT registers as two independent slots, the way a real `EventTarget` would. */
function fakeDayBar(day: string): FakeDayBar {
	let onClick: ((evt?: FakeKeydownEvent) => void) | undefined;
	let onKeydown: ((evt?: FakeKeydownEvent) => void) | undefined;
	return {
		getAttribute(name) {
			return name === "data-day" ? day : null;
		},
		addEventListener(type, cb) {
			if (type === "click") onClick = cb;
			if (type === "keydown") onKeydown = cb;
		},
		dispatchClick() {
			onClick?.();
		},
		dispatchKeydown(key) {
			const evt: FakeKeydownEvent = {
				key,
				preventDefaultCalled: false,
				preventDefault() {
					this.preventDefaultCalled = true;
				},
			};
			onKeydown?.(evt);
			return evt;
		},
	};
}

/** Every `id="..."` attribute value present anywhere in `html`, regardless of which tag carries it. */
function idsInHtml(html: string): Set<string> {
	const ids = new Set<string>();
	for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
		const id = match[1];
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * The static-markup ids CLIENT_SCRIPT's real `document.getElementById` call sites look up
 * (`elementsById` below). Checked against `idsInHtml(html)` in `runClientScript` so a renamed id
 * in `renderHtml` (e.g. `chart-title` or `day-detail`) fails this harness loudly - myusage-4xu.50:
 * before this check, `elementsById` handed back the same fixed fake objects no matter what ids
 * `renderHtml` actually emitted, so a rename left the vm harness (and the whole suite) green even
 * though a real browser's `document.getElementById` would return null and the very next line
 * (`titleEl.textContent = ...`) would throw.
 */
const REQUIRED_ELEMENT_IDS = [
	"panel-cost",
	"panel-tokens",
	"measure-cost",
	"measure-tokens",
	"chart-title",
	"day-detail",
] as const;

/**
 * Runs the ACTUAL `<script>` block extracted from real `renderHtml(html)` output in a `node:vm`
 * context, against a fake DOM built from plain objects (never jsdom, per this repo's
 * zero-dependency convention). The two data elements (`panel-cost-data`/`panel-tokens-data`) hand
 * back the page's own real embedded JSON text, so `readJson`'s real call site - untyped and
 * unexercised before myusage-cq8 - parses genuine data, not a test-authored stand-in for it. The
 * day bar is fixed to "2026-09-07", the fixture's busiest day (see `buildWindow`).
 */
function runClientScript(html: string) {
	const renderedIds = idsInHtml(html);
	for (const id of REQUIRED_ELEMENT_IDS) {
		if (!renderedIds.has(id)) {
			throw new Error(
				`renderHtml no longer emits id="${id}" - CLIENT_SCRIPT's document.getElementById("${id}") call site would return null in a real browser`,
			);
		}
	}

	const panels = { cost: { hidden: false }, tokens: { hidden: true } };
	const buttons = { cost: fakeButton(), tokens: fakeButton() };
	const titleEl = { textContent: "Daily cost" };
	const detailEl = fakeDetail();
	const dayBar = fakeDayBar("2026-09-07");

	const elementsById: Record<string, unknown> = {
		"panel-cost": panels.cost,
		"panel-tokens": panels.tokens,
		"measure-cost": buttons.cost,
		"measure-tokens": buttons.tokens,
		"chart-title": titleEl,
		"day-detail": detailEl,
		"panel-cost-data": { textContent: panelDataText(html, "panel-cost") },
		"panel-tokens-data": { textContent: panelDataText(html, "panel-tokens") },
	};

	const document = {
		getElementById(id: string) {
			return elementsById[id] ?? null;
		},
		querySelectorAll(selector: string) {
			return selector === ".day-bar" ? [dayBar] : [];
		},
		createElement(_tag: string) {
			return fakeDetailChild();
		},
	};

	runInContext(clientScriptSource(html), createContext({ document }));

	return { panels, buttons, titleEl, detailEl, dayBar };
}

describe("renderHtml: client script execution (vm)", () => {
	// myusage-cq8: CLIENT_SCRIPT's readJson(document, "panel-cost-data") call site sits inside a
	// string literal - untyped, and (until this test) never executed by anything. Reverting it to
	// the pre-extraction one-argument form, readJson("panel-cost-data"), left typecheck, lint, and
	// 100% coverage on all four metrics green: the arity mismatch only throws once a real
	// `document`-shaped object hits `doc.getElementById(id)` with `doc` bound to the string
	// "panel-cost-data" and `id` to `undefined`. These tests run the real <script> block extracted
	// from real renderHtml() output - not a re-typed copy of it - in a node:vm context against a
	// fake DOM, then drive the same interactions a browser would (clicking the Tokens toggle,
	// clicking a day bar) and assert the rendered result traces back to the page's own embedded
	// JSON. That exercises readJson's real call site, not just readJson in isolation (already
	// covered by client-script.test.ts) - and also catches a typo'd element id at the call site,
	// which an arity check alone would miss: a wrong id makes readJson return null without
	// throwing, so the toggle/drill-down below would silently stop reflecting real data.

	it("switches to tokens and updates the chart title from the real embedded tokens payload", () => {
		const html = renderHtml(buildWindow());
		const tokensPayload = readPanelData(html, "panel-tokens");

		const { panels, buttons, titleEl } = runClientScript(html);
		buttons.tokens.dispatchClick();

		expect(titleEl.textContent).toBe(tokensPayload.title);
		expect(panels.cost.hidden).toBe(true);
		expect(panels.tokens.hidden).toBe(false);
		expect(buttons.tokens.classList.active).toBe(true);
		expect(buttons.tokens.ariaPressed).toBe("true");
	});

	// myusage-4xu.50: the Cost button's own click handler registration
	// (`buttons.cost.addEventListener("click", ...)`) was, until this test, only ever exercised by
	// a guard-only test myusage-jom deleted along with the guard it existed to test. Mutating that
	// handler's `setMeasure("cost")` call to `setMeasure("tokens")` left the whole suite green: the
	// line still runs (it's registered whenever runClientScript's setup runs), so line/branch
	// coverage stayed 100% - a mutation-coverage gap, not a coverage-number gap. Starting from
	// tokens (so cost isn't already active-by-default) and clicking Cost proves the click actually
	// reaches `setMeasure("cost")`, not just that the listener is registered.
	it("switches back to cost from tokens and restores the chart title from the real embedded cost payload", () => {
		const html = renderHtml(buildWindow());
		const costPayload = readPanelData(html, "panel-cost");

		const { panels, buttons, titleEl } = runClientScript(html);
		buttons.tokens.dispatchClick();
		buttons.cost.dispatchClick();

		expect(titleEl.textContent).toBe(costPayload.title);
		expect(panels.cost.hidden).toBe(false);
		expect(panels.tokens.hidden).toBe(true);
		expect(buttons.cost.classList.active).toBe(true);
		expect(buttons.cost.ariaPressed).toBe("true");
		expect(buttons.tokens.classList.active).toBe(false);
		expect(buttons.tokens.ariaPressed).toBe("false");
	});

	it("renders the real per-day drill-down from the embedded payload when a day bar is clicked", () => {
		const html = renderHtml(buildWindow());
		const costPayload = readPanelData(html, "panel-cost");
		const busyDay = costPayload.days.find((d) => d.day === "2026-09-07");
		if (!busyDay) throw new Error("fixture has 2026-09-07");

		const { detailEl, dayBar } = runClientScript(html);
		dayBar.dispatchClick();

		expect(detailEl.hidden).toBe(false);
		expect(detailEl.children).toHaveLength(1 + busyDay.entries.length);
		expect(detailEl.children[0]?.textContent).toBe(
			`2026-09-07 - ${busyDay.total}`,
		);

		const rows = detailEl.children.slice(1);
		rows.forEach((row, i) => {
			const entry = busyDay.entries[i];
			const [, label, value] = row.children;
			expect(label?.textContent).toBe(entry?.label);
			expect(value?.textContent).toBe(entry?.value);
		});
	});

	// myusage-9en: the day bar's keydown handler and hideDetail()'s hide-and-clear behavior are
	// two more real CLIENT_SCRIPT call sites the tests above never reach - the click tests only
	// ever dispatch "click", and no existing test opens a detail panel and then closes it. Both
	// ran (statements inside them execute whenever setMeasure/the keydown listener registration
	// runs) without ever being proven: breaking the Enter/Space check, dropping preventDefault, or
	// making hideDetail a no-op all left the full suite green before these tests existed.

	it("drills down on Enter keydown the same way a click does, and calls preventDefault", () => {
		const html = renderHtml(buildWindow());
		const costPayload = readPanelData(html, "panel-cost");
		const busyDay = costPayload.days.find((d) => d.day === "2026-09-07");
		if (!busyDay) throw new Error("fixture has 2026-09-07");

		const { detailEl, dayBar } = runClientScript(html);
		const evt = dayBar.dispatchKeydown("Enter");

		expect(evt.preventDefaultCalled).toBe(true);
		expect(detailEl.hidden).toBe(false);
		expect(detailEl.children).toHaveLength(1 + busyDay.entries.length);
		expect(detailEl.children[0]?.textContent).toBe(
			`2026-09-07 - ${busyDay.total}`,
		);
	});

	it("drills down on Space keydown the same way a click does, and calls preventDefault", () => {
		const html = renderHtml(buildWindow());
		const costPayload = readPanelData(html, "panel-cost");
		const busyDay = costPayload.days.find((d) => d.day === "2026-09-07");
		if (!busyDay) throw new Error("fixture has 2026-09-07");

		const { detailEl, dayBar } = runClientScript(html);
		const evt = dayBar.dispatchKeydown(" ");

		expect(evt.preventDefaultCalled).toBe(true);
		expect(detailEl.hidden).toBe(false);
		expect(detailEl.children).toHaveLength(1 + busyDay.entries.length);
	});

	it("ignores an unrelated keydown: no drill-down, no preventDefault", () => {
		const html = renderHtml(buildWindow());

		const { detailEl, dayBar } = runClientScript(html);
		const evt = dayBar.dispatchKeydown("Tab");

		expect(evt.preventDefaultCalled).toBe(false);
		expect(detailEl.hidden).toBe(true);
		expect(detailEl.children).toHaveLength(0);
	});

	it("hides the day detail panel and clears its rendered rows when the measure toggle changes (hideDetail)", () => {
		const html = renderHtml(buildWindow());
		const { buttons, detailEl, dayBar } = runClientScript(html);

		dayBar.dispatchClick();
		expect(detailEl.hidden).toBe(false);
		expect(detailEl.children.length).toBeGreaterThan(0);

		buttons.tokens.dispatchClick();

		expect(detailEl.hidden).toBe(true);
		expect(detailEl.children).toHaveLength(0);
	});
});
