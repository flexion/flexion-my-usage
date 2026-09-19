// (provider, model) -> LiteLLM price-table key.
//
// Conservative by design: a wrong silent price is worse than a flagged unpriced row, so a row
// resolves only when its provider has an explicit rule, a candidate key exists in the table,
// and that entry's `litellm_provider` is one the rule accepts. Model ids are never rewritten:
// no prefix or suffix stripping. In particular the Bedrock geo prefixes (global. us. eu. jp.
// apac. au.) are NOT stripped, because the table carries separate regional entries with their
// own rates (for example us.anthropic.claude-sonnet-4-5-20250929-v1:0 lists $3.30 per M input
// tokens while the bare and global. keys list $3.00).
//
// Providers without a rule (gateways, subscription plans, custom endpoints) stay unpriced: a
// same-named first-party key would be a different vendor's price list.
//
// Every rule below was checked against the real table and models.dev's model ids for the
// provider: each candidate key exists, and `litellm_provider` has the listed value.
import type { ModelRates, PriceTable } from "./pricing-table.js";

export interface ProviderRule {
	/** Candidate keys are `prefix + model`; "" is the bare key. */
	prefixes: readonly string[];
	/** Accepted `litellm_provider` values for an entry to count as this provider's price. */
	litellmProviders: readonly string[];
}

/** Keyed by opencode's `providerID` (the models.dev provider id). */
export const PROVIDER_RULES: ReadonlyMap<string, ProviderRule> = new Map([
	["anthropic", { prefixes: [""], litellmProviders: ["anthropic"] }],
	["openai", { prefixes: [""], litellmProviders: ["openai"] }],
	[
		"amazon-bedrock",
		{
			prefixes: ["", "bedrock_mantle/"],
			litellmProviders: ["bedrock", "bedrock_converse", "bedrock_mantle"],
		},
	],
	["azure", { prefixes: ["azure/"], litellmProviders: ["azure"] }],
	[
		"google-vertex-anthropic",
		{
			prefixes: ["vertex_ai/"],
			litellmProviders: ["vertex_ai-anthropic_models"],
		},
	],
	[
		"google-vertex",
		{
			prefixes: ["", "vertex_ai/"],
			litellmProviders: [
				"vertex_ai-language-models",
				"vertex_ai-anthropic_models",
				"vertex_ai",
			],
		},
	],
	["google", { prefixes: ["gemini/"], litellmProviders: ["gemini"] }],
	[
		"openrouter",
		{ prefixes: ["openrouter/"], litellmProviders: ["openrouter"] },
	],
	["xai", { prefixes: ["xai/"], litellmProviders: ["xai"] }],
	["deepseek", { prefixes: ["deepseek/"], litellmProviders: ["deepseek"] }],
	["mistral", { prefixes: ["mistral/"], litellmProviders: ["mistral"] }],
	["groq", { prefixes: ["groq/"], litellmProviders: ["groq"] }],
]);

export type Resolution =
	| { ok: true; key: string; rates: ModelRates }
	| { ok: false; reason: "unknown-provider" | "no-match" | "ambiguous" };

/** Two entries agree when every rate a cost calculation would use is identical. */
function sameEffectiveRates(a: ModelRates, b: ModelRates): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		(a.reasoning ?? a.output) === (b.reasoning ?? b.output)
	);
}

/**
 * Finds the table entry for a row, or says why it could not.
 *
 * If more than one candidate key exists, they must agree on every effective rate; otherwise
 * the answer is "ambiguous" rather than a guess.
 */
export function resolveRates(
	table: PriceTable,
	provider: string,
	model: string,
): Resolution {
	const rule = PROVIDER_RULES.get(provider);
	if (!rule) return { ok: false, reason: "unknown-provider" };

	const hits: { key: string; rates: ModelRates }[] = [];
	for (const prefix of rule.prefixes) {
		const key = prefix + model;
		const rates = table.get(key);
		if (rates && rule.litellmProviders.includes(rates.provider)) {
			hits.push({ key, rates });
		}
	}

	const [first] = hits;
	if (!first) return { ok: false, reason: "no-match" };
	if (!hits.every((hit) => sameEffectiveRates(first.rates, hit.rates))) {
		return { ok: false, reason: "ambiguous" };
	}
	return { ok: true, key: first.key, rates: first.rates };
}
