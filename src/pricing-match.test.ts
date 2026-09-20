import { describe, expect, it } from "vitest";
import { resolveRates } from "./pricing-match.js";
import type { ModelRates, PriceTable } from "./pricing-table.js";

const rates = (overrides: Partial<ModelRates> = {}): ModelRates => ({
	provider: "anthropic",
	input: 3,
	output: 15,
	...overrides,
});

const tableOf = (entries: [string, ModelRates][]): PriceTable =>
	new Map(entries);

describe("resolveRates", () => {
	it("resolves a bare key whose litellm_provider the rule accepts", () => {
		const entry = rates();
		expect(resolveRates(tableOf([["m", entry]]), "anthropic", "m")).toEqual({
			ok: true,
			key: "m",
			rates: entry,
		});
	});

	it("says unknown-provider for a provider with no rule", () => {
		const table = tableOf([["m", rates()]]);
		expect(resolveRates(table, "some-gateway", "m")).toEqual({
			ok: false,
			reason: "unknown-provider",
		});
	});

	it("says no-match when the key is absent", () => {
		expect(resolveRates(tableOf([]), "anthropic", "m")).toEqual({
			ok: false,
			reason: "no-match",
		});
	});

	it("says no-match when the key belongs to another litellm_provider", () => {
		const table = tableOf([["m", rates({ provider: "openai" })]]);
		expect(resolveRates(table, "anthropic", "m")).toEqual({
			ok: false,
			reason: "no-match",
		});
	});

	it("says ambiguous when candidate keys disagree on an effective rate", () => {
		const table = tableOf([
			["m", rates({ provider: "bedrock", input: 3 })],
			["bedrock_mantle/m", rates({ provider: "bedrock_mantle", input: 4 })],
		]);
		expect(resolveRates(table, "amazon-bedrock", "m")).toEqual({
			ok: false,
			reason: "ambiguous",
		});
	});

	it("accepts several candidate keys that agree on every effective rate", () => {
		// Reasoning falls back to the output rate when not published, so 15 and undefined agree.
		const table = tableOf([
			["m", rates({ provider: "bedrock", reasoning: 15 })],
			["bedrock_mantle/m", rates({ provider: "bedrock_mantle" })],
		]);
		const result = resolveRates(table, "amazon-bedrock", "m");
		expect(result).toMatchObject({ ok: true, key: "m" });
	});
});
