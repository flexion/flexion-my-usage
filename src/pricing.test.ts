import { describe, expect, it } from "vitest";
import {
	fakeFetch,
	forbiddenFetch,
	LITELLM_FIXTURE,
	usageRow,
	useTempCacheDirs,
} from "./pricing.fixtures.js";
import { price } from "./pricing.js";

const newCacheDir = useTempCacheDirs();

/** Prices rows against a table served by a fake fetch into a fresh cache dir. */
async function priceWith(
	rows: ReturnType<typeof usageRow>[],
	table: Record<string, Record<string, unknown>> = LITELLM_FIXTURE,
) {
	return price(rows, {
		cacheDir: await newCacheDir(),
		fetch: fakeFetch(table),
		warn: () => {},
	});
}

const M = 1_000_000;

describe("price: cost model", () => {
	it("returns no rows for no rows, without touching the network", async () => {
		const fetch = forbiddenFetch();
		const out = await price([], { cacheDir: await newCacheDir(), fetch });
		expect(out).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("prices every bucket at its own published rate", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokens: {
					input: 1 * M,
					output: 0.1 * M,
					cacheRead: 2 * M,
					cacheWrite: 0.5 * M,
				},
			}),
		]);
		// input 1M x 3e-6 + output 100k x 1.5e-5 + cache-read 2M x 3e-7 + cache-write 500k x 3.75e-6
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(3 + 1.5 + 0.6 + 1.875, 9);
	});

	it("keeps the source row's fields and order", async () => {
		const a = usageRow({ messageId: "a", tokens: { input: 10 } });
		const b = usageRow({ messageId: "b", model: "no-such-model" });
		const out = await priceWith([a, b]);
		expect(out.map((r) => r.messageId)).toEqual(["a", "b"]);
		expect(out[0]).toMatchObject({ ...a, unpriced: false });
		expect(out[1]).toMatchObject({ ...b, unpriced: true });
	});

	it("bills reasoning at the dedicated reasoning rate when the table has one", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "google",
				model: "gemini-robotics-er-2-preview",
				// opencode stores output WITHOUT reasoning, so these buckets are disjoint.
				tokens: { input: 1000, output: 2000, reasoning: 500 },
			}),
		]);
		// 1000 x 1e-6 + 2000 x 5e-6 + 500 x 1e-5
		expect(row?.notionalCost).toBeCloseTo(0.016, 12);
	});

	it("bills reasoning at the output rate when the table has no reasoning rate, never twice", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokens: { output: 1000, reasoning: 500 },
			}),
		]);
		// (1000 + 500) x 1.5e-5, each token counted once
		expect(row?.notionalCost).toBeCloseTo(0.0225, 12);
	});

	it("treats input as already excluding cached tokens (no double charge)", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "openai",
				model: "gpt-5",
				tokens: { input: 1000, cacheRead: 9000 },
			}),
		]);
		// 1000 x 1.25e-6 + 9000 x 1.25e-7, not 10000 x 1.25e-6
		expect(row?.notionalCost).toBeCloseTo(0.00125 + 0.001125, 12);
	});

	it("never yields NaN or negative cost from bad token counts", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokens: {
					input: Number.NaN,
					output: 1 * M,
					reasoning: -50,
					cacheRead: Number.POSITIVE_INFINITY,
					cacheWrite: -1,
				},
			}),
		]);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(15, 9);
	});
});

describe("price: unknown models", () => {
	it("still counts tokens, costs 0 and flags the row", async () => {
		const tokens = {
			input: 5,
			output: 6,
			reasoning: 7,
			cacheRead: 8,
			cacheWrite: 9,
		};
		const [row] = await priceWith([
			usageRow({ provider: "anthropic", model: "claude-not-a-model", tokens }),
		]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true, tokens });
	});
});

describe("price: (provider, model) -> LiteLLM key", () => {
	// Each case uses a real (providerID, modelID) from models.dev and a real LiteLLM key.
	// Cost for 1M input tokens equals the input rate in $/M, so the rate identifies the key.
	const priced: [string, string, number][] = [
		["anthropic", "claude-sonnet-4-5", 3],
		["openai", "gpt-4o-mini", 0.15],
		// Azure has its own azure/ key with its own rate; the bare key is OpenAI's.
		["azure", "gpt-4o-mini", 0.165],
		// Bedrock regional keys are matched exactly and keep their own (premium) rate.
		["amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", 3.3],
		["amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0", 3],
		["amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0", 3],
		["amazon-bedrock", "apac.anthropic.claude-sonnet-4-20250514-v1:0", 3],
		// Bedrock "mantle" models live under a bedrock_mantle/ key.
		["amazon-bedrock", "openai.gpt-5.5", 5.5],
		// Under both keys with identical rates: not ambiguous.
		["amazon-bedrock", "openai.gpt-oss-safeguard-20b", 0.07],
		["google-vertex-anthropic", "claude-sonnet-4-5@20250929", 3],
		["google-vertex", "claude-sonnet-4-5@20250929", 3],
		["google-vertex", "gemini-2.5-flash", 0.3],
		// Under both keys, identical effective rates (one lists a reasoning rate equal to output).
		["google-vertex", "gemini-3-flash-preview", 0.5],
		["google", "gemini-flash-latest", 0.75],
		["openrouter", "anthropic/claude-sonnet-4.5", 3],
		["xai", "grok-4", 1.25],
		["deepseek", "deepseek-chat", 0.28],
		["mistral", "mistral-large-latest", 0.5],
		["groq", "llama-3.3-70b-versatile", 0.59],
	];

	it.each(priced)(
		"%s / %s is priced at %d USD per M input tokens",
		async (provider, model, perM) => {
			const [row] = await priceWith([
				usageRow({ provider, model, tokens: { input: M } }),
			]);
			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(perM, 9);
			// Only fallback-priced rows carry a label.
			expect(row).not.toHaveProperty("priceLabel");
		},
	);

	const unpriced: [string, string, string][] = [
		// No prefix stripping: the bare amazon.nova-2-lite key exists, but a jp. request is not
		// guaranteed to carry the bare rate (regional keys are priced differently elsewhere).
		[
			"amazon-bedrock",
			"jp.amazon.nova-2-lite-v1:0",
			"no key; regional prefix is not stripped",
		],
		["amazon-bedrock", "us.anthropic.claude-sonnet-9-99-v1:0", "no such key"],
		// The bare key exists but belongs to Bedrock, not Anthropic.
		[
			"anthropic",
			"claude-sonnet-4-5-20250929-v1:0",
			"bare key owned by another provider",
		],
		// The bare key belongs to the Gemini API, not Vertex. gemini/gemini-flash-latest is a
		// first-party key too, but a provider that has a rule never falls back to one.
		[
			"google-vertex",
			"gemini-flash-latest",
			"bare key owned by another provider, and no fallback for a provider with a rule",
		],
		// Alias spellings are part of that fallback: they do not apply to a provider with a rule.
		["anthropic", "claude-opus-4.7", "a dotted id is not aliased here"],
		["anthropic", "", "empty model id"],
		["constructor", "__proto__", "prototype-ish ids are just unknown"],
	];

	it.each(unpriced)("%s / %s is unpriced (%s)", async (provider, model) => {
		const tokens = { input: 123, output: 45 };
		const [row] = await priceWith([usageRow({ provider, model, tokens })]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(row?.tokens).toMatchObject(tokens);
		expect(row).not.toHaveProperty("priceLabel");
	});

	it("skips the table's non-model entries even when they look priceable", async () => {
		const [row] = await priceWith(
			[
				usageRow({
					provider: "anthropic",
					model: "sample_spec",
					tokens: { input: M },
				}),
			],
			{
				sample_spec: {
					litellm_provider: "anthropic",
					input_cost_per_token: 0,
					output_cost_per_token: 0,
				},
			},
		);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
	});

	it("leaves the row unpriced when two candidate keys disagree on price", async () => {
		// Doctored: a real entry with its rate changed so the bare and bedrock_mantle/ keys conflict.
		const conflicting = {
			...LITELLM_FIXTURE,
			"bedrock_mantle/openai.gpt-oss-safeguard-20b": {
				...LITELLM_FIXTURE["bedrock_mantle/openai.gpt-oss-safeguard-20b"],
				input_cost_per_token: 9e-8,
			},
		};
		const [row] = await priceWith(
			[
				usageRow({
					provider: "amazon-bedrock",
					model: "openai.gpt-oss-safeguard-20b",
					tokens: { input: M },
				}),
			],
			conflicting,
		);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
	});
});

describe("price: first-party fallback for providers without a rule", () => {
	// A row from a gateway, subscription or custom provider is priced by its bare model id
	// against first-party keys only, and says so.
	const LABEL = "notional at first-party list price";

	// Real (providerID, modelID) pairs; the rate in USD per M input tokens identifies the key.
	const priced: [string, string, number][] = [
		["github-copilot", "claude-opus-5", 5],
		// opencode Zen lists this id at 1.07 USD per M; the first-party list price is 1.25.
		["opencode", "gpt-5.1", 1.25],
		// The Gemini API's key lives under gemini/.
		["github-copilot", "gemini-3.6-flash", 0.75],
		["some-custom-provider", "grok-4", 1.25],
		["some-custom-provider", "deepseek-chat", 0.28],
		// Resellers are not first party: Azure also lists this id (azure/gpt-4o-mini at 0.165), and
		// if it counted, the two rate sets would disagree and the row would go unpriced.
		["some-custom-provider", "gpt-4o-mini", 0.15],
	];

	it.each(priced)(
		"%s / %s is priced at the first-party %d USD per M input tokens and labeled",
		async (provider, model, perM) => {
			const [row] = await priceWith([
				usageRow({ provider, model, tokens: { input: M } }),
			]);
			expect(row?.unpriced).toBe(false);
			expect(row?.notionalCost).toBeCloseTo(perM, 9);
			expect(row?.priceLabel).toBe(LABEL);
		},
	);

	// A model id the table has no first-party key for stays unpriced, exactly like a provider
	// the code has never heard of did before the fallback existed.
	const unmatched: [string, string, string][] = [
		["github-copilot", "kimi-k3", "no first-party key in the table"],
		[
			"some-custom-provider",
			"claude-sonnet-4-5-20250929-v1:0",
			"the bare key belongs to Bedrock, which is not first party",
		],
		[
			"some-custom-provider",
			"llama-3.3-70b-versatile",
			"only a host (Groq) lists it",
		],
		[
			"some-custom-provider",
			"mistral-large-latest",
			"Mistral's namespace also lists other vendors' models, so it is not consulted",
		],
		[
			"some-custom-provider",
			"anthropic/claude-sonnet-4.5",
			"only a gateway (OpenRouter) lists it",
		],
		[
			"some-custom-provider",
			"claude-sonnet-4-5@20250929",
			"only a cloud (Vertex) lists it",
		],
	];

	it.each(unmatched)("%s / %s stays unpriced (%s)", async (provider, model) => {
		const tokens = { input: 123, output: 45 };
		const [row] = await priceWith([usageRow({ provider, model, tokens })]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true, tokens });
		expect(row).not.toHaveProperty("priceLabel");
	});

	it("leaves the row unpriced and unlabeled when a bucket with tokens has no first-party rate", async () => {
		// The id matches a first-party key, but xAI publishes no cache-write rate for it.
		const [row] = await priceWith([
			usageRow({
				provider: "some-custom-provider",
				model: "grok-4",
				tokens: { input: 1000, cacheWrite: 500 },
			}),
		]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(row).not.toHaveProperty("priceLabel");
	});

	it("labels each row by its own provider when a rule provider and a ruleless one share a model id", async () => {
		const row = (provider: string) =>
			usageRow({ provider, model: "claude-opus-5", tokens: { input: M } });
		const [own, gateway, ownAgain] = await priceWith([
			row("anthropic"),
			row("github-copilot"),
			row("anthropic"),
		]);
		expect(own).not.toHaveProperty("priceLabel");
		expect(gateway?.priceLabel).toBe(LABEL);
		expect(ownAgain).not.toHaveProperty("priceLabel");
	});

	// Two first-party vendors listing the same bare id count as one answer only when every
	// rate the cost calculation uses agrees.
	// Doctored: xAI also lists `gpt-5` (the real OpenAI entry), changed one rate at a time.
	const twoVendors = (change: Record<string, unknown>) => ({
		...LITELLM_FIXTURE,
		"xai/gpt-5": {
			...LITELLM_FIXTURE["gpt-5"],
			litellm_provider: "xai",
			...change,
		},
	});
	const gpt5Row = () =>
		usageRow({
			provider: "github-copilot",
			model: "gpt-5",
			tokens: { input: M },
		});

	it("prices the row when every first-party key for the id lists the same rates", async () => {
		const [row] = await priceWith([gpt5Row()], twoVendors({}));
		expect(row?.notionalCost).toBeCloseTo(1.25, 9);
		expect(row?.priceLabel).toBe(LABEL);
	});

	it.each<[string, Record<string, unknown>]>([
		["input", { input_cost_per_token: 2e-6 }],
		// The reasoning rate is held equal to the other key's, so only output differs.
		[
			"output",
			{
				output_cost_per_token: 2e-5,
				output_cost_per_reasoning_token: 1e-5,
			},
		],
		["cache read", { cache_read_input_token_cost: 2e-7 }],
		["cache write", { cache_creation_input_token_cost: 1.5e-6 }],
		["reasoning", { output_cost_per_reasoning_token: 2e-5 }],
	])(
		"leaves the row unpriced when first-party keys differ in the %s rate",
		async (_rate, change) => {
			const [row] = await priceWith([gpt5Row()], twoVendors(change));
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(row).not.toHaveProperty("priceLabel");
		},
	);

	// github-copilot spells Claude versions with a dot; Anthropic and LiteLLM's `anthropic` keys
	// use a dash. Each pair is a github-copilot model id and the first-party key that models.dev
	// gives as its base_model. The table holds only the target key, so a row prices only if the
	// alias points at exactly that key. Two pairs stand for the mechanism; the full list, with
	// its models.dev and LiteLLM evidence, is documented on the alias table in pricing-match.ts.
	const aliased: [string, string, number][] = [
		["claude-opus-4.7", "claude-opus-4-7", 5],
		["claude-fable-5.1", "claude-fable-5-1", 10],
	];

	it.each(aliased)(
		"github-copilot / %s resolves to the LiteLLM key %s",
		async (spelling, key, perM) => {
			const [row] = await priceWith(
				[
					usageRow({
						provider: "github-copilot",
						model: spelling,
						tokens: { input: M },
					}),
				],
				{ [key]: LITELLM_FIXTURE[key] as Record<string, unknown> },
			);
			expect(row?.notionalCost).toBeCloseTo(perM, 9);
			expect(row?.priceLabel).toBe(LABEL);
		},
	);

	// Ids are never rewritten: a spelling resolves only if the table has it or the alias table
	// lists it. Both ids below are real gateway ids whose twin key exists in the table.
	const notRewritten: [string, string, string][] = [
		[
			"github-copilot",
			"claude-opus-4.1",
			"dotted, but claude-opus-4-1 is not aliased",
		],
		["neon", "gpt-5-1", "dashed, but the first-party key is gpt-5.1"],
	];

	it.each(notRewritten)(
		"%s / %s stays unpriced (%s)",
		async (provider, model) => {
			const [row] = await priceWith([
				usageRow({ provider, model, tokens: { input: M } }),
			]);
			expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
			expect(row).not.toHaveProperty("priceLabel");
		},
	);
});

describe("price: buckets without a published rate", () => {
	it("flags the row when a bucket with tokens has no rate (no cache-write rate)", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "amazon-bedrock",
				model: "amazon.nova-pro-v1:0",
				tokens: { input: 1000, cacheWrite: 500 },
			}),
		]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
		expect(row?.tokens.cacheWrite).toBe(500);
	});

	it("flags the row when a bucket with tokens has no rate (no cache rates at all)", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "amazon-bedrock",
				model: "us.deepseek.r1-v1:0",
				tokens: { input: 1000, cacheRead: 500 },
			}),
		]);
		expect(row).toMatchObject({ notionalCost: 0, unpriced: true });
	});

	it("does not need a rate for a bucket with zero tokens", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "amazon-bedrock",
				model: "amazon.nova-pro-v1:0",
				tokens: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0 },
			}),
		]);
		expect(row?.unpriced).toBe(false);
		// 1000 x 8e-7 + 1000 x 3.2e-6 + 1000 x 2e-7
		expect(row?.notionalCost).toBeCloseTo(0.0042, 12);
	});

	it("accepts an explicit zero rate as a published rate", async () => {
		const [row] = await priceWith([
			usageRow({
				provider: "deepseek",
				model: "deepseek-chat",
				tokens: { input: 1000, cacheWrite: 1000 },
			}),
		]);
		expect(row?.unpriced).toBe(false);
		expect(row?.notionalCost).toBeCloseTo(1000 * 2.8e-7, 12);
	});
});
