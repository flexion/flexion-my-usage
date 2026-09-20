// (provider, model) -> LiteLLM price-table key.
//
// Conservative by design: a wrong silent price is worse than a flagged unpriced row, so a row
// resolves only when a candidate key exists in the table and that entry's `litellm_provider` is
// one the matching rule accepts. Model ids are never rewritten: no prefix or suffix stripping.
// In particular the Bedrock geo prefixes (global. us. eu. jp. apac. au.) are NOT stripped,
// because the table carries separate regional entries with their own rates (for example
// us.anthropic.claude-sonnet-4-5-20250929-v1:0 lists $3.30 per M input tokens while the bare
// and global. keys list $3.00).
//
// A provider with an explicit rule is priced through that rule and nothing else. A provider
// without one (gateways, subscription plans, custom endpoints) falls back to the model
// maker's own list price by model id; see `resolveRates` for what that promises.
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

// The model makers' own APIs. They are also the "first party" the fallback consults.
const ANTHROPIC: ProviderRule = {
	prefixes: [""],
	litellmProviders: ["anthropic"],
};
const OPENAI: ProviderRule = { prefixes: [""], litellmProviders: ["openai"] };
const GOOGLE: ProviderRule = {
	prefixes: ["gemini/"],
	litellmProviders: ["gemini"],
};
const XAI: ProviderRule = { prefixes: ["xai/"], litellmProviders: ["xai"] };
const DEEPSEEK: ProviderRule = {
	prefixes: ["deepseek/"],
	litellmProviders: ["deepseek"],
};

/** Keyed by opencode's `providerID` (the models.dev provider id). */
const PROVIDER_RULES: ReadonlyMap<string, ProviderRule> = new Map([
	["anthropic", ANTHROPIC],
	["openai", OPENAI],
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
	["google", GOOGLE],
	[
		"openrouter",
		{ prefixes: ["openrouter/"], litellmProviders: ["openrouter"] },
	],
	["xai", XAI],
	["deepseek", DEEPSEEK],
	["mistral", { prefixes: ["mistral/"], litellmProviders: ["mistral"] }],
	["groq", { prefixes: ["groq/"], litellmProviders: ["groq"] }],
]);

/**
 * Whose list price counts as "first party" for the fallback: the model maker's own API, that
 * is Anthropic, OpenAI, the Gemini API, xAI and DeepSeek. These are the makers whose ids the
 * gateways in models.dev (github-copilot, opencode Zen and others) actually carry and that
 * LiteLLM keys exactly (at BerriAI/litellm b652aaad4a81 no id is listed under two of them).
 *
 * Left out on purpose:
 * - Clouds, hosts and gateways (Bedrock, Azure, Vertex, OpenRouter, Groq): they resell other
 *   vendors' models at their own rates, which is what the label warns about.
 * - Mistral: its namespace also lists other vendors' models, and a gateway's exact id can hit
 *   one (glm-5-2 is Z.ai's GLM, listed as mistral/glm-5-2), so a hit there is not
 *   necessarily the maker's price. The cost: Mistral's own models stay unpriced on gateways
 *   (22 of the 23 ids in models.dev that match a Mistral key exactly).
 */
const FIRST_PARTY_RULES: readonly ProviderRule[] = [
	ANTHROPIC,
	OPENAI,
	GOOGLE,
	XAI,
	DEEPSEEK,
];

/**
 * Spellings a gateway uses for a first-party model, mapped to the model's LiteLLM key. This is
 * the ONLY way a spelling other than the exact key resolves; there is no dot/dash rewriting,
 * because a generic rewrite matches the wrong model (opencode Zen's glm-5.2 would become
 * mistral/glm-5-2, another vendor's price list). Add an entry only with a real id pair.
 *
 * Every entry below is a github-copilot Claude id, which spells versions with a dot where
 * Anthropic and LiteLLM use a dash. models.dev names the dashed id as the entry's `base_model`
 * (anomalyco/models.dev, providers/github-copilot/models/<id>.toml: at 198dec37e53f for
 * claude-fable-5.1, claude-haiku-4.5, claude-opus-4.7, claude-opus-4.8 and claude-sonnet-4.6,
 * at f476b2d34eec for claude-opus-4.5, claude-opus-4.6 and claude-sonnet-4.5), and each key
 * exists in BerriAI/litellm b652aaad4a81 (model_prices_and_context_window.json) with
 * `litellm_provider` "anthropic". Anthropic keys are bare, so the key is also the id the
 * fallback looks up.
 */
const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
	["claude-fable-5.1", "claude-fable-5-1"],
	["claude-haiku-4.5", "claude-haiku-4-5"],
	["claude-opus-4.5", "claude-opus-4-5"],
	["claude-opus-4.6", "claude-opus-4-6"],
	["claude-opus-4.7", "claude-opus-4-7"],
	["claude-opus-4.8", "claude-opus-4-8"],
	["claude-sonnet-4.5", "claude-sonnet-4-5"],
	["claude-sonnet-4.6", "claude-sonnet-4-6"],
]);

export type Resolution =
	| {
			ok: true;
			rates: ModelRates;
			/** True when the row's provider has no rule and a first-party price was used. */
			fallback: boolean;
	  }
	| { ok: false };

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

/** The rates of the table entries a rule accepts for `model`. */
function ruleHits(
	table: PriceTable,
	rule: ProviderRule,
	model: string,
): ModelRates[] {
	const hits: ModelRates[] = [];
	for (const prefix of rule.prefixes) {
		const rates = table.get(prefix + model);
		if (rates && rule.litellmProviders.includes(rates.provider)) {
			hits.push(rates);
		}
	}
	return hits;
}

/**
 * One answer from the candidate entries: none, or several that disagree on an effective rate,
 * leave the row unpriced rather than guessed; otherwise there is a single distinct rate set.
 */
function settle(hits: ModelRates[], fallback: boolean): Resolution {
	const [first] = hits;
	if (!first || !hits.every((hit) => sameEffectiveRates(first, hit))) {
		return { ok: false };
	}
	return { ok: true, rates: first, fallback };
}

/**
 * Finds the rates for a row, or reports that it has none.
 *
 * A provider with a rule uses that rule alone. A provider without one gets the first-party
 * fallback: the bare model id (or its alias, see MODEL_ALIASES) is looked up under every
 * first-party rule, and the row is priced only if exactly one distinct rate set matches.
 * No match, or matches that disagree, leave the row unpriced.
 *
 * Accuracy limit: a fallback figure is what the model maker charges, not what the row's
 * gateway billed, and it can be off by 10 percent or more where a gateway adds markup or
 * uses regional or discounted price lists. Two real cases: LiteLLM lists the us. Bedrock
 * Sonnet 4.5 at $3.30 per M input tokens against $3.00 for the bare id, and opencode Zen lists
 * gpt-5.1 at $1.07 per M against $1.25 first party (models.dev, providers opencode and
 * openai). That is why every fallback-priced row is labeled.
 */
export function resolveRates(
	table: PriceTable,
	provider: string,
	model: string,
): Resolution {
	const rule = PROVIDER_RULES.get(provider);
	if (rule) return settle(ruleHits(table, rule, model), false);

	const id = MODEL_ALIASES.get(model) ?? model;
	const hits = FIRST_PARTY_RULES.flatMap((first) => ruleHits(table, first, id));
	return settle(hits, true);
}
