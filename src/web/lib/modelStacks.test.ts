import { describe, expect, it } from "vitest";
import type { DayBucket, ModelTotals } from "../../usage-payload";
import {
	buildModelStacks,
	MODEL_TOP_N,
	modelKey,
	modelLabeler,
	OTHER_KEY,
	rankModels,
	type SeriesRow,
	seriesRows,
	totalRows,
	windowTotals,
} from "./modelStacks";

function totals(
	provider: string,
	model: string,
	notionalCost: number,
	tokens: number,
	unpricedTokens = 0,
): ModelTotals {
	return { provider, model, notionalCost, tokens, unpricedTokens };
}

function day(date: string, models: ModelTotals[], responses = 1): DayBucket {
	return {
		day: date,
		byModel: Object.fromEntries(models.map((m) => [modelKey(m), m])),
		notionalCost: models.reduce((sum, m) => sum + m.notionalCost, 0),
		tokens: models.reduce((sum, m) => sum + m.tokens, 0),
		responses,
	};
}

const SONNET = totals("anthropic", "claude-sonnet-4-5", 2, 1_000);
const GPT = totals("openai", "gpt-5", 1, 3_000);

describe("modelKey", () => {
	it("is provider/model", () => {
		expect(modelKey(SONNET)).toBe("anthropic/claude-sonnet-4-5");
	});
});

describe("seriesRows", () => {
	const days = [day("2026-09-01", [SONNET, GPT]), day("2026-09-02", [])];

	it("cost: one column per model, notional cost as the value; quiet days are just the date", () => {
		expect(seriesRows(days, "cost")).toEqual([
			{
				date: "2026-09-01",
				"anthropic/claude-sonnet-4-5": 2,
				"openai/gpt-5": 1,
			},
			{ date: "2026-09-02" },
		]);
	});

	it("tokens: the same columns, tokens as the value", () => {
		expect(seriesRows(days, "tokens")[0]).toEqual({
			date: "2026-09-01",
			"anthropic/claude-sonnet-4-5": 1_000,
			"openai/gpt-5": 3_000,
		});
	});
});

describe("buildModelStacks", () => {
	it("ranks keys by window total, zero-fills absent days, and has no Other when nothing folds", () => {
		const stacks = buildModelStacks([
			{ date: "d1", a: 1, b: 5 },
			{ date: "d2", a: 2 },
		]);
		expect(stacks.keys).toEqual(["b", "a"]);
		expect(stacks.hasOther).toBe(false);
		expect(stacks.rows).toEqual([
			{ date: "d1", b: 5, a: 1 },
			{ date: "d2", b: 0, a: 2 },
		]);
		expect(stacks.totals).toEqual([
			{ key: "b", total: 5 },
			{ key: "a", total: 3 },
		]);
	});

	it("folds everything past topN into Other, per day", () => {
		const stacks = buildModelStacks(
			[
				{ date: "d1", a: 10, b: 5, c: 1, d: 2 },
				{ date: "d2", c: 4 },
			],
			2,
		);
		expect(stacks.keys).toEqual(["a", "b"]);
		expect(stacks.hasOther).toBe(true);
		expect(stacks.rows).toEqual([
			{ date: "d1", a: 10, b: 5, [OTHER_KEY]: 3 },
			{ date: "d2", a: 0, b: 0, [OTHER_KEY]: 4 },
		]);
		expect(stacks.totals.at(-1)).toEqual({ key: OTHER_KEY, total: 7 });
	});

	it("breaks total ties by key, so the order is stable", () => {
		expect(buildModelStacks([{ date: "d1", zeta: 1, alpha: 1 }]).keys).toEqual([
			"alpha",
			"zeta",
		]);
	});

	it("drops zero, negative and non-numeric values instead of ranking them", () => {
		const rows: SeriesRow[] = [{ date: "d1", a: 0, b: -1, c: "x", d: 2 }];
		const stacks = buildModelStacks(rows);
		expect(stacks.keys).toEqual(["d"]);
		expect(stacks.rows).toEqual([{ date: "d1", d: 2 }]);
	});

	it("an all-empty window has no stacks at all", () => {
		const stacks = buildModelStacks([{ date: "d1" }, { date: "d2" }]);
		expect(stacks).toEqual({
			rows: [{ date: "d1" }, { date: "d2" }],
			keys: [],
			hasOther: false,
			totals: [],
		});
	});

	it("keeps at least one named key even when topN is below 1", () => {
		expect(buildModelStacks([{ date: "d1", a: 1, b: 2 }], 0).keys).toEqual([
			"b",
		]);
	});

	it("defaults to the forked dashboard's cap of 8 named stacks", () => {
		expect(MODEL_TOP_N).toBe(8);
		const row: SeriesRow = { date: "d1" };
		for (let i = 1; i <= 9; i++) row[`m${i}`] = i;
		const stacks = buildModelStacks([row]);
		expect(stacks.keys).toHaveLength(8);
		expect(stacks.rows[0]?.[OTHER_KEY]).toBe(1);
	});
});

describe("totalRows", () => {
	const days = [day("2026-09-01", [SONNET, GPT])];

	it("carries the day's total cost or tokens under the given key", () => {
		expect(totalRows(days, "cost", "Total")).toEqual([
			{ date: "2026-09-01", Total: 3 },
		]);
		expect(totalRows(days, "tokens", "Total")).toEqual([
			{ date: "2026-09-01", Total: 4_000 },
		]);
	});
});

describe("windowTotals", () => {
	it("sums cost, tokens and responses over every day", () => {
		expect(windowTotals([day("d1", [SONNET], 3), day("d2", [GPT], 4)])).toEqual(
			{ notionalCost: 3, tokens: 4_000, responses: 7 },
		);
	});

	it("is all zeros for an empty window", () => {
		expect(windowTotals([])).toEqual({
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		});
	});
});

describe("rankModels", () => {
	it("sums each model across days, largest cost first", () => {
		const rows = rankModels([
			day("d1", [SONNET, GPT]),
			day("d2", [totals("openai", "gpt-5", 4, 10, 10)]),
		]);
		expect(rows).toEqual([
			{
				key: "openai/gpt-5",
				provider: "openai",
				model: "gpt-5",
				notionalCost: 5,
				tokens: 3_010,
				unpricedTokens: 10,
			},
			{
				key: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 2,
				tokens: 1_000,
				unpricedTokens: 0,
			},
		]);
	});

	it("ranks equal-cost (e.g. unpriced) models by tokens, then by key", () => {
		const rows = rankModels([
			day("d1", [
				totals("p", "b", 0, 5, 5),
				totals("p", "c", 0, 9, 9),
				totals("p", "a", 0, 5, 5),
			]),
		]);
		expect(rows.map((row) => row.key)).toEqual(["p/c", "p/a", "p/b"]);
	});

	it("does not mutate the input buckets", () => {
		const input = day("d1", [SONNET]);
		rankModels([input, input]);
		expect(input.byModel["anthropic/claude-sonnet-4-5"]).toEqual(SONNET);
	});
});

describe("modelLabeler", () => {
	it("labels a model by its bare id when only one provider serves it", () => {
		const labelFor = modelLabeler([day("d1", [SONNET, GPT])]);
		expect(labelFor("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(labelFor("openai/gpt-5")).toBe("gpt-5");
	});

	it("qualifies every entry of an id that appears under two providers", () => {
		const labelFor = modelLabeler([
			day("d1", [SONNET]),
			day("d2", [totals("vertex", "claude-sonnet-4-5", 1, 1)]),
		]);
		expect(labelFor("anthropic/claude-sonnet-4-5")).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(labelFor("vertex/claude-sonnet-4-5")).toBe(
			"vertex/claude-sonnet-4-5",
		);
	});

	it("reads Other for the Other key, and passes an unknown key through", () => {
		const labelFor = modelLabeler([]);
		expect(labelFor(OTHER_KEY)).toBe("Other");
		expect(labelFor("Total")).toBe("Total");
	});
});
