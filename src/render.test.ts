import { describe, expect, it } from "vitest";
import type { DayBucket, ModelTotals } from "./aggregate.js";
import {
	formatCount,
	formatCurrency,
	formatTokens,
	shareByModel,
	stackByModel,
	windowTotals,
} from "./chart-model.js";
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

/** The `<g class="day-bar" data-day="...">...</g>` markup for one day, or "" if not found. */
function dayBarMarkup(html: string, dayLabel: string): string {
	const escaped = dayLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = html.match(
		new RegExp(`<g class="day-bar" data-day="${escaped}"[\\s\\S]*?</g>`),
	);
	return match?.[0] ?? "";
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

function readPanelData(html: string, panelId: string): DayDetailPayload {
	const match = html.match(
		new RegExp(
			`<script type="application/json" id="${panelId}-data">([\\s\\S]*?)</script>`,
		),
	);
	if (!match?.[1]) throw new Error(`${panelId}-data script not found`);
	return JSON.parse(match[1]) as DayDetailPayload;
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
});

describe("renderHtml: KPI row", () => {
	it("sums the window through windowTotals and formats with the real formatters", () => {
		const days = buildWindow();
		const totals = windowTotals(days);

		const html = renderHtml(days);

		expect(html).toContain(`>${formatCurrency(totals.notionalCost)}<`);
		expect(html).toContain(`>${formatTokens(totals.tokens)}<`);
		expect(html).toContain(`>${formatCount(totals.responses)}<`);
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

		expect(group).toMatch(/<path d="[^"]+" fill="var\(--/);
		const squareSegments =
			group.match(/<rect x="[^"]*" y="[^"]*"[^>]*fill="var\(--/g) ?? [];
		expect(squareSegments.length).toBeGreaterThan(0);
	});

	it("draws a single-model day as just the one rounded top segment", () => {
		const html = renderHtml(buildWindow());

		const group = dayBarMarkup(html, "2026-09-08");

		const fillPaths = group.match(/<path d="[^"]+" fill="var\(--/g) ?? [];
		const fillRects =
			group.match(/<rect x="[^"]*" y="[^"]*"[^>]*fill="var\(--/g) ?? [];
		expect(fillPaths).toHaveLength(1);
		expect(fillRects).toHaveLength(0);
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
