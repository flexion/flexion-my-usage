import { describe, expect, it } from "vitest";
import type { DayBucket, ModelTotals } from "./aggregate.js";
import {
	formatCount,
	formatCurrency,
	formatTokens,
	measureFormat,
	OTHER_LABEL,
	type StackedDay,
	type StackSeries,
	shareByModel,
	stackByModel,
	windowTotals,
} from "./chart-model.js";

interface SeriesSpec {
	provider?: string;
	model?: string;
	cost?: number;
	tokens?: number;
	unpricedTokens?: number;
}

/** One model's totals for a day, as aggregateDaily records them. */
function series(spec: SeriesSpec = {}): ModelTotals {
	return {
		provider: spec.provider ?? "anthropic",
		model: spec.model ?? "claude-sonnet-4-5",
		notionalCost: spec.cost ?? 0,
		tokens: spec.tokens ?? 0,
		unpricedTokens: spec.unpricedTokens ?? 0,
	};
}

/**
 * A DayBucket as aggregateDaily builds it: `byModel` keyed the way aggregate.ts keys it (an
 * implementation detail the chart model must not parse; see the opaque-keys test), the day's own
 * cost and tokens summed from its series, and `responses` given directly.
 */
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

function model(
	provider: string,
	modelId: string,
	label: string,
	total: number,
): StackSeries {
	return { kind: "model", provider, model: modelId, label, total };
}

function other(folded: number, total: number): StackSeries {
	return { kind: "other", label: OTHER_LABEL, folded, total };
}

describe("stackByModel: series ranking", () => {
	it("ranks series by window total, largest first, ties by model id then provider", () => {
		const days = [
			day("2026-09-17", [
				series({ model: "claude-sonnet-4-5", cost: 2 }),
				series({ provider: "openai", model: "gpt-5.1", cost: 5 }),
			]),
			day("2026-09-18", [
				series({ model: "claude-sonnet-4-5", cost: 4 }),
				series({ provider: "google", model: "gemini-2.5-pro", cost: 6 }),
			]),
		];

		const stacks = stackByModel(days, "cost");

		// sonnet and gemini tie at 6: "claude-sonnet-4-5" sorts before "gemini-2.5-pro".
		expect(stacks.series).toEqual([
			model("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5", 6),
			model("google", "gemini-2.5-pro", "gemini-2.5-pro", 6),
			model("openai", "gpt-5.1", "gpt-5.1", 5),
		]);
	});

	it("keeps eight named series by default and folds the rest into a trailing Other", () => {
		const models = Array.from({ length: 10 }, (_, i) =>
			series({ model: `model-${String(i).padStart(2, "0")}`, cost: 10 - i }),
		);

		const stacks = stackByModel([day("2026-09-19", models)], "cost");

		expect(stacks.series.map((s) => s.label)).toEqual([
			"model-00",
			"model-01",
			"model-02",
			"model-03",
			"model-04",
			"model-05",
			"model-06",
			"model-07",
			OTHER_LABEL,
		]);
		// model-08 (2) and model-09 (1) are the fold.
		expect(stacks.series[8]).toEqual(other(2, 3));
		expect(stacks.days).toEqual([
			{
				day: "2026-09-19",
				segments: [10, 9, 8, 7, 6, 5, 4, 3, 3],
				total: 55,
			},
		]);
	});

	it("honors topN and treats anything below 1 as 1", () => {
		const days = [
			day("2026-09-19", [
				series({ model: "claude-opus-4-6", cost: 8 }),
				series({ model: "claude-sonnet-4-5", cost: 4 }),
				series({ model: "claude-haiku-4-5", cost: 2 }),
				series({ provider: "openai", model: "gpt-5.1", cost: 1 }),
			]),
		];

		expect(stackByModel(days, "cost", { topN: 2 }).series).toEqual([
			model("anthropic", "claude-opus-4-6", "claude-opus-4-6", 8),
			model("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5", 4),
			other(2, 3),
		]);
		expect(stackByModel(days, "cost", { topN: 0 }).series).toEqual([
			model("anthropic", "claude-opus-4-6", "claude-opus-4-6", 8),
			other(3, 7),
		]);
	});

	it("adds no Other when every series fits within topN", () => {
		const days = [
			day("2026-09-19", [
				series({ model: "claude-opus-4-6", cost: 8 }),
				series({ model: "claude-sonnet-4-5", cost: 4 }),
				series({ model: "claude-haiku-4-5", cost: 2 }),
			]),
		];

		const stacks = stackByModel(days, "cost", { topN: 3 });

		expect(stacks.series.map((s) => s.kind)).toEqual([
			"model",
			"model",
			"model",
		]);
		expect(stacks.days).toEqual([
			{ day: "2026-09-19", segments: [8, 4, 2], total: 14 },
		]);
	});

	it("labels a series by model id, qualified by provider only when that id is served by more than one provider", () => {
		const days = [
			day("2026-09-19", [
				series({ provider: "opencode", model: "claude-haiku-4-5", cost: 3 }),
				series({ provider: "anthropic", model: "claude-haiku-4-5", cost: 3 }),
				series({ provider: "openai", model: "gpt-5.1", cost: 1 }),
			]),
		];

		const stacks = stackByModel(days, "cost");

		// The two haiku series tie at 3, so provider breaks the tie.
		expect(stacks.series).toEqual([
			model("anthropic", "claude-haiku-4-5", "anthropic/claude-haiku-4-5", 3),
			model("opencode", "claude-haiku-4-5", "opencode/claude-haiku-4-5", 3),
			model("openai", "gpt-5.1", "gpt-5.1", 1),
		]);
	});

	it("qualifies a named series' label when its same-id twin only survives folded into Other", () => {
		const days = [
			day("2026-09-19", [
				series({ provider: "anthropic", model: "claude-sonnet-4-5", cost: 5 }),
				series({ provider: "opencode", model: "claude-sonnet-4-5", cost: 1 }),
			]),
		];

		const stacks = stackByModel(days, "cost", { topN: 1 });

		// opencode's sonnet folds into Other, but it is still a priced series with the same
		// model id, so anthropic's surviving sonnet must not read as unqualified "claude-sonnet-4-5".
		expect(stacks.series).toEqual([
			model("anthropic", "claude-sonnet-4-5", "anthropic/claude-sonnet-4-5", 5),
			other(1, 1),
		]);
	});

	it("reads provider and model from each ModelTotals, never from byModel's keys", () => {
		const bucket: DayBucket = {
			day: "2026-09-19",
			byModel: {
				first: series({ provider: "openai", model: "gpt-5.1", cost: 1 }),
				second: series({ model: "claude-sonnet-4-5", cost: 2 }),
			},
			notionalCost: 3,
			tokens: 0,
			responses: 2,
		};

		expect(stackByModel([bucket], "cost").series).toEqual([
			model("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5", 2),
			model("openai", "gpt-5.1", "gpt-5.1", 1),
		]);
	});
});

describe("stackByModel: per-day segments", () => {
	it("lays out one day per bucket in input order, one segment per series, zero where a series is absent", () => {
		const days = [
			day("2026-09-17", [
				series({ model: "claude-sonnet-4-5", cost: 1.5 }),
				series({ provider: "openai", model: "gpt-5.1", cost: 0.5 }),
			]),
			day("2026-09-18", [], 0),
			day("2026-09-19", [series({ model: "claude-sonnet-4-5", cost: 2 })]),
		];

		const stacks = stackByModel(days, "cost");

		expect(stacks.measure).toBe("cost");
		expect(stacks.series.map((s) => s.label)).toEqual([
			"claude-sonnet-4-5",
			"gpt-5.1",
		]);
		expect(stacks.days).toEqual([
			{ day: "2026-09-17", segments: [1.5, 0.5], total: 2 },
			{ day: "2026-09-18", segments: [0, 0], total: 0 },
			{ day: "2026-09-19", segments: [2, 0], total: 2 },
		]);
	});

	it("plots tokens under the tokens measure, ranking by token total", () => {
		const days = [
			day("2026-09-18", [
				series({ model: "claude-sonnet-4-5", cost: 9, tokens: 1_000 }),
				series({
					provider: "openai",
					model: "gpt-5.1",
					cost: 1,
					tokens: 4_000,
				}),
			]),
			day("2026-09-19", [
				series({ model: "claude-sonnet-4-5", cost: 9, tokens: 2_000 }),
			]),
		];

		const stacks = stackByModel(days, "tokens");

		expect(stacks.measure).toBe("tokens");
		expect(stacks.series).toEqual([
			model("openai", "gpt-5.1", "gpt-5.1", 4_000),
			model("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5", 3_000),
		]);
		expect(stacks.days).toEqual([
			{ day: "2026-09-18", segments: [4_000, 1_000], total: 5_000 },
			{ day: "2026-09-19", segments: [0, 2_000], total: 2_000 },
		]);
	});

	it("gives an unpriced model no cost series: not ranked, not folded, and no provider qualifier forced on its priced twin", () => {
		const days = [
			day("2026-09-19", [
				series({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					cost: 3,
					tokens: 100,
				}),
				series({
					provider: "opencode",
					model: "claude-sonnet-4-5",
					cost: 0,
					tokens: 500,
					unpricedTokens: 500,
				}),
				series({ provider: "openai", model: "gpt-5.1", cost: 1, tokens: 50 }),
			]),
		];

		const cost = stackByModel(days, "cost", { topN: 1 });
		expect(cost.series).toEqual([
			model("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5", 3),
			other(1, 1),
		]);
		expect(cost.days).toEqual([
			{ day: "2026-09-19", segments: [3, 1], total: 4 },
		]);

		// Under tokens the same model counts, and now the id needs qualifying.
		expect(stackByModel(days, "tokens").series).toEqual([
			model("opencode", "claude-sonnet-4-5", "opencode/claude-sonnet-4-5", 500),
			model(
				"anthropic",
				"claude-sonnet-4-5",
				"anthropic/claude-sonnet-4-5",
				100,
			),
			model("openai", "gpt-5.1", "gpt-5.1", 50),
		]);
	});

	it("returns no series and no days for an empty window", () => {
		expect(stackByModel([], "cost")).toEqual({
			measure: "cost",
			series: [],
			days: [],
		});
	});

	it("returns no series but keeps every day, empty, when nothing has a positive value", () => {
		const days = [
			day("2026-09-18", [
				series({
					provider: "opencode",
					model: "glm-5.2",
					cost: 0,
					tokens: 700,
					unpricedTokens: 700,
				}),
			]),
			day("2026-09-19", [], 0),
		];

		expect(stackByModel(days, "cost")).toEqual({
			measure: "cost",
			series: [],
			days: [
				{ day: "2026-09-18", segments: [], total: 0 },
				{ day: "2026-09-19", segments: [], total: 0 },
			],
		});
	});
});

describe("shareByModel", () => {
	// Window total 16 (a power of two) so every percentage below is exact in floating point.
	// Ranked: opus 8, haiku 3, sonnet 2, gpt 2 (tie broken by model id), gemini 1.
	const fiveModels = [
		day("2026-09-18", [
			series({ model: "claude-opus-4-6", cost: 8 }),
			series({ model: "claude-sonnet-4-5", cost: 2 }),
			series({ model: "claude-haiku-4-5", cost: 3 }),
		]),
		day("2026-09-19", [
			series({ provider: "openai", model: "gpt-5.1", cost: 2 }),
			series({ provider: "google", model: "gemini-2.5-pro", cost: 1 }),
		]),
	];

	it("shares the window total across every series, Other last however large", () => {
		const stacks = stackByModel(fiveModels, "cost", { topN: 2 });
		const opus = model("anthropic", "claude-opus-4-6", "claude-opus-4-6", 8);
		const haiku = model("anthropic", "claude-haiku-4-5", "claude-haiku-4-5", 3);

		const shares = shareByModel(stacks.series, stacks.days);

		// Other (sonnet 2 + gpt 2 + gemini 1 = 5) outweighs haiku's 3 and still sits last.
		expect(shares.total).toBe(16);
		expect(shares.ranked).toEqual([
			{ series: opus, value: 8, pct: 50 },
			{ series: haiku, value: 3, pct: 18.75 },
			{ series: other(3, 5), value: 5, pct: 31.25 },
		]);
	});

	it("breaks a tie in ranked share value by model id, independent of input order", () => {
		// Fed in reverse-alphabetical order on purpose: a stable sort that just preserved input
		// order would still pass every other test here, so this pins the id comparison itself.
		const zebra = model("anthropic", "model-zebra", "model-zebra", 5);
		const alpha = model("anthropic", "model-alpha", "model-alpha", 5);
		const tiedDay: StackedDay = {
			day: "2026-09-19",
			segments: [5, 5],
			total: 10,
		};

		const shares = shareByModel([zebra, alpha], [tiedDay]);

		expect(shares.ranked.map((e) => e.series.label)).toEqual([
			"model-alpha",
			"model-zebra",
		]);
	});

	it("breaks a tie in ranked share value by provider when the model id is the same", () => {
		const opencodeTwin = model(
			"opencode",
			"claude-sonnet-4-5",
			"opencode/claude-sonnet-4-5",
			5,
		);
		const anthropicTwin = model(
			"anthropic",
			"claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			5,
		);
		const tiedDay: StackedDay = {
			day: "2026-09-19",
			segments: [5, 5],
			total: 10,
		};

		// Fed opencode first so a stable sort on input order alone would keep it first too.
		const shares = shareByModel([opencodeTwin, anthropicTwin], [tiedDay]);

		expect(shares.ranked.map((e) => e.series.label)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"opencode/claude-sonnet-4-5",
		]);
	});

	it("shares a single day's entry over that day alone, dropping series with nothing that day", () => {
		const stacks = stackByModel(fiveModels, "cost", { topN: 2 });
		const [firstDay] = stacks.days;
		if (!firstDay) throw new Error("fixture has two days");

		const shares = shareByModel(stacks.series, [firstDay]);

		// 2026-09-18: opus 8, haiku 3, Other holds sonnet 2 (gpt and gemini land on the 19th).
		expect(shares.total).toBe(13);
		expect(shares.ranked.map((e) => [e.series.label, e.value])).toEqual([
			["claude-opus-4-6", 8],
			["claude-haiku-4-5", 3],
			[OTHER_LABEL, 2],
		]);
		// And a day with none of a series' usage leaves that series out entirely.
		const [, secondDay] = stacks.days;
		if (!secondDay) throw new Error("fixture has two days");
		expect(
			shareByModel(stacks.series, [secondDay]).ranked.map(
				(e) => e.series.label,
			),
		).toEqual([OTHER_LABEL]);
	});

	it("caps slices at six by default: five named plus one Other that folds the rest and the stack's own Other", () => {
		// Nine models: 64, 32, ..., 1, 0.5, 0.5. topN 7 names the first seven and folds two.
		const values = [64, 32, 16, 8, 4, 2, 1, 0.5, 0.5];
		const stacks = stackByModel(
			[
				day(
					"2026-09-19",
					values.map((cost, i) =>
						series({ model: `model-${String(i).padStart(2, "0")}`, cost }),
					),
				),
			],
			"cost",
			{ topN: 7 },
		);

		const shares = shareByModel(stacks.series, stacks.days);

		expect(shares.total).toBe(128);
		expect(shares.ranked).toHaveLength(8);
		expect(shares.slices.map((e) => [e.series.label, e.value, e.pct])).toEqual([
			["model-00", 64, 50],
			["model-01", 32, 25],
			["model-02", 16, 12.5],
			["model-03", 8, 6.25],
			["model-04", 4, 3.125],
			[OTHER_LABEL, 4, 3.125],
		]);
		// model-05, model-06 and the two already folded: four models behind one slice.
		expect(shares.slices[5]?.series).toEqual(other(4, 4));
	});

	it("keeps every named series as its own slice when they fit, with the stack's Other as the last slice", () => {
		const stacks = stackByModel(fiveModels, "cost", { topN: 2 });

		const shares = shareByModel(stacks.series, stacks.days);

		// Two named slices under the cap, then the stack's Other (three models) as its own slice.
		expect(shares.slices).toEqual([
			{
				series: model("anthropic", "claude-opus-4-6", "claude-opus-4-6", 8),
				value: 8,
				pct: 50,
			},
			{
				series: model("anthropic", "claude-haiku-4-5", "claude-haiku-4-5", 3),
				value: 3,
				pct: 18.75,
			},
			{ series: other(3, 5), value: 5, pct: 31.25 },
		]);
	});

	it("has no Other slice when nothing folds", () => {
		const stacks = stackByModel(fiveModels, "cost");

		const { slices } = shareByModel(stacks.series, stacks.days);

		expect(slices.map((e) => e.series.kind)).toEqual([
			"model",
			"model",
			"model",
			"model",
			"model",
		]);
	});

	it("keeps at least one named slice however small maxSlices is", () => {
		const stacks = stackByModel(fiveModels, "cost");

		const { slices } = shareByModel(stacks.series, stacks.days, {
			maxSlices: 1,
		});

		expect(slices.map((e) => [e.series.label, e.value])).toEqual([
			["claude-opus-4-6", 8],
			[OTHER_LABEL, 8],
		]);
		expect(slices[1]?.series).toEqual(other(4, 8));
	});

	it("is empty when the days given carry no value", () => {
		const stacks = stackByModel(fiveModels, "cost");

		expect(shareByModel(stacks.series, [])).toEqual({
			total: 0,
			ranked: [],
			slices: [],
		});
	});
});

describe("windowTotals", () => {
	it("sums cost, tokens and responses across the window", () => {
		const days = [
			day(
				"2026-09-18",
				[
					series({ cost: 1.25, tokens: 1_000 }),
					series({
						provider: "openai",
						model: "gpt-5.1",
						cost: 0.75,
						tokens: 500,
					}),
				],
				7,
			),
			day("2026-09-19", [], 0),
			day("2026-09-20", [series({ cost: 2, tokens: 2_500 })], 3),
		];

		expect(windowTotals(days)).toEqual({
			notionalCost: 4,
			tokens: 4_000,
			responses: 10,
		});
	});

	it("is all zeros for an empty window", () => {
		expect(windowTotals([])).toEqual({
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		});
	});

	it("sums each DayBucket's own notionalCost and tokens fields, not a re-sum of byModel", () => {
		// byModel deliberately disagrees with the bucket's own totals, the way a caller that
		// already trusts aggregateDaily's totals would never construct one; this only exists to
		// prove windowTotals reads the bucket fields directly instead of recomputing them.
		const bucket: DayBucket = {
			day: "2026-09-19",
			byModel: {
				only: series({ cost: 1, tokens: 100 }),
			},
			notionalCost: 999,
			tokens: 555,
			responses: 4,
		};

		expect(windowTotals([bucket])).toEqual({
			notionalCost: 999,
			tokens: 555,
			responses: 4,
		});
	});
});

describe("formatCurrency", () => {
	it("shows zero as $0.00", () => {
		expect(formatCurrency(0)).toBe("$0.00");
	});

	it("keeps four decimals below one cent", () => {
		expect(formatCurrency(0.0045)).toBe("$0.0045");
		expect(formatCurrency(0.005)).toBe("$0.0050");
		expect(formatCurrency(0.0099)).toBe("$0.0099");
	});

	it("rounds to cents from one cent up, with no thousands separator", () => {
		expect(formatCurrency(0.01)).toBe("$0.01");
		expect(formatCurrency(12.34)).toBe("$12.34");
		expect(formatCurrency(1234.5)).toBe("$1234.50");
	});
});

describe("formatTokens", () => {
	it("shows zero as 0 and counts below a thousand as rounded integers", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(42.4)).toBe("42");
	});

	it("uses k with one decimal from a thousand", () => {
		expect(formatTokens(1_000)).toBe("1.0k");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(42_500)).toBe("42.5k");
	});

	it("uses M and B with two decimals from a million and a billion", () => {
		expect(formatTokens(1_200_000)).toBe("1.20M");
		expect(formatTokens(7_060_000_000)).toBe("7.06B");
	});
});

describe("formatCount", () => {
	it("groups digits in threes with commas", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(999)).toBe("999");
		expect(formatCount(1_000)).toBe("1,000");
		expect(formatCount(1_234_567)).toBe("1,234,567");
	});
});

describe("measureFormat", () => {
	it("speaks dollars for cost, with the unit carried by the $ sign", () => {
		const fmt = measureFormat("cost");

		expect(fmt.axis(1.5)).toBe("$1.50");
		expect(fmt.value(0.004)).toBe("$0.0040");
		expect(fmt.unitLabel).toBe("");
		expect(fmt.title("Daily Cost")).toBe("Daily Cost");
	});

	it("speaks token counts for tokens, and says so in the title", () => {
		const fmt = measureFormat("tokens");

		expect(fmt.axis(1_500)).toBe("1.5k");
		expect(fmt.value(2_000_000)).toBe("2.00M");
		expect(fmt.unitLabel).toBe("tokens");
		expect(fmt.title("Daily Cost")).toBe("Daily Cost (Tokens)");
	});
});
