// Shared fixtures for the pricing tests.
//
// LITELLM_FIXTURE holds real entries copied from LiteLLM's model_prices_and_context_window.json
// (BerriAI/litellm @ 38b310b7510ec78059fab6666d87c2fb6a7f76c9; the entries added for the
// model-id fallback tests were copied at b652aaad4a8100e8e0e8b27ce4c9e6bf4aa51465, where the
// older entries carry the same rates). Only the fields the pricing code reads are kept; keys
// and rates are unmodified. Tests that need a doctored entry spread a real one and say so.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, vi } from "vitest";
import type { NormalizedUsageRow } from "./sources/types.js";

export const LITELLM_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const LITELLM_FIXTURE: Record<string, Record<string, unknown>> = {
	// Non-model entries the real file carries (trimmed).
	sample_spec: {
		litellm_provider: "one of https://docs.litellm.ai/docs/providers",
		mode: "one of: chat, embedding, completion, image_generation",
		input_cost_per_token: 0,
		output_cost_per_token: 0,
		output_cost_per_reasoning_token: 0,
	},
	fallback_generalizations: {
		rules: [
			{
				name: "bedrock-claude-ids",
				pattern: "^(?:[a-z-]+\\.)?anthropic\\.claude-",
				model_info: { litellm_provider: "bedrock" },
			},
		],
	},

	// anthropic / openai (bare keys)
	"claude-sonnet-4-5": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"claude-opus-5": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 0.00000625,
	},
	// The dashed first-party keys that github-copilot's dotted Claude ids (claude-opus-4.7 and
	// friends) stand for; models.dev names each one as the gateway id's `base_model`.
	"claude-haiku-4-5": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000001,
		output_cost_per_token: 0.000005,
		cache_read_input_token_cost: 1e-7,
		cache_creation_input_token_cost: 0.00000125,
	},
	"claude-opus-4-5": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 0.00000625,
	},
	"claude-opus-4-6": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 0.00000625,
	},
	"claude-opus-4-7": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 0.00000625,
	},
	"claude-opus-4-8": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000025,
		cache_read_input_token_cost: 5e-7,
		cache_creation_input_token_cost: 0.00000625,
	},
	"claude-sonnet-4-6": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"claude-fable-5-1": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.00001,
		output_cost_per_token: 0.00005,
		cache_read_input_token_cost: 2.5e-7,
		cache_creation_input_token_cost: 0.0000125,
	},
	// Has a dashed key, but github-copilot's dotted spelling of it is not in the alias table:
	// used to show that ids are never rewritten.
	"claude-opus-4-1": {
		litellm_provider: "anthropic",
		mode: "chat",
		input_cost_per_token: 0.000015,
		output_cost_per_token: 0.000075,
		cache_read_input_token_cost: 0.0000015,
		cache_creation_input_token_cost: 0.00001875,
	},
	// A bare key that belongs to Bedrock, not Anthropic.
	"claude-sonnet-4-5-20250929-v1:0": {
		litellm_provider: "bedrock",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"gpt-5": {
		litellm_provider: "openai",
		mode: "chat",
		input_cost_per_token: 0.00000125,
		output_cost_per_token: 0.00001,
		cache_read_input_token_cost: 1.25e-7,
	},
	"gpt-5.1": {
		litellm_provider: "openai",
		mode: "chat",
		input_cost_per_token: 0.00000125,
		output_cost_per_token: 0.00001,
		cache_read_input_token_cost: 1.25e-7,
	},
	"gpt-4o-mini": {
		litellm_provider: "openai",
		mode: "chat",
		input_cost_per_token: 1.5e-7,
		output_cost_per_token: 6e-7,
		cache_read_input_token_cost: 7.5e-8,
	},

	// azure
	"azure/gpt-4o-mini": {
		litellm_provider: "azure",
		mode: "chat",
		input_cost_per_token: 1.65e-7,
		output_cost_per_token: 6.6e-7,
		cache_read_input_token_cost: 7.5e-8,
	},

	// bedrock: the regional keys carry their own (premium) rates.
	"us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 0.0000033,
		output_cost_per_token: 0.0000165,
		cache_read_input_token_cost: 3.3e-7,
		cache_creation_input_token_cost: 0.000004125,
	},
	"global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"anthropic.claude-sonnet-4-5-20250929-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"apac.anthropic.claude-sonnet-4-20250514-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	// Cache-read rate but no cache-write rate.
	"amazon.nova-pro-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 8e-7,
		output_cost_per_token: 0.0000032,
		cache_read_input_token_cost: 2e-7,
	},
	// The real table has this bare key but no jp.-prefixed one.
	"amazon.nova-2-lite-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 3e-7,
		output_cost_per_token: 0.0000025,
		cache_read_input_token_cost: 7.5e-8,
	},
	// No cache rates at all.
	"us.deepseek.r1-v1:0": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 0.00000135,
		output_cost_per_token: 0.0000054,
	},
	"bedrock_mantle/openai.gpt-5.5": {
		litellm_provider: "bedrock_mantle",
		mode: "responses",
		input_cost_per_token: 0.0000055,
		output_cost_per_token: 0.000033,
		cache_read_input_token_cost: 5.5e-7,
	},
	// Present under both the bare and the bedrock_mantle/ key, with identical rates.
	"openai.gpt-oss-safeguard-20b": {
		litellm_provider: "bedrock_converse",
		mode: "chat",
		input_cost_per_token: 7e-8,
		output_cost_per_token: 2e-7,
	},
	"bedrock_mantle/openai.gpt-oss-safeguard-20b": {
		litellm_provider: "bedrock_mantle",
		mode: "chat",
		input_cost_per_token: 7e-8,
		output_cost_per_token: 2e-7,
	},

	// vertex: Claude lives under vertex_ai/, Gemini under bare keys (and sometimes both).
	"vertex_ai/claude-sonnet-4-5@20250929": {
		litellm_provider: "vertex_ai-anthropic_models",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"gemini-2.5-flash": {
		litellm_provider: "vertex_ai-language-models",
		mode: "chat",
		input_cost_per_token: 3e-7,
		output_cost_per_token: 0.0000025,
		cache_read_input_token_cost: 3e-8,
		output_cost_per_reasoning_token: 0.0000025,
	},
	// Same effective rates under both keys (one lists the reasoning rate, the other omits it).
	"gemini-3-flash-preview": {
		litellm_provider: "vertex_ai-language-models",
		mode: "chat",
		input_cost_per_token: 5e-7,
		output_cost_per_token: 0.000003,
		cache_read_input_token_cost: 5e-8,
		output_cost_per_reasoning_token: 0.000003,
	},
	"vertex_ai/gemini-3-flash-preview": {
		litellm_provider: "vertex_ai",
		mode: "chat",
		input_cost_per_token: 5e-7,
		output_cost_per_token: 0.000003,
		cache_read_input_token_cost: 5e-8,
	},
	// A bare key that belongs to the Gemini API (not Vertex).
	"gemini-flash-latest": {
		litellm_provider: "gemini",
		mode: "chat",
		input_cost_per_token: 7.5e-7,
		output_cost_per_token: 0.00000375,
		cache_read_input_token_cost: 7.5e-8,
		output_cost_per_reasoning_token: 0.00000375,
	},

	// google (Gemini API)
	"gemini/gemini-flash-latest": {
		litellm_provider: "gemini",
		mode: "chat",
		input_cost_per_token: 7.5e-7,
		output_cost_per_token: 0.00000375,
		cache_read_input_token_cost: 7.5e-8,
		output_cost_per_reasoning_token: 0.00000375,
	},
	// The Gemini API key behind github-copilot's (and other gateways') gemini-3.6-flash.
	"gemini/gemini-3.6-flash": {
		litellm_provider: "gemini",
		mode: "chat",
		input_cost_per_token: 7.5e-7,
		output_cost_per_token: 0.00000375,
		cache_read_input_token_cost: 7.5e-8,
		output_cost_per_reasoning_token: 0.00000375,
	},
	// A real entry whose dedicated reasoning rate differs from its output rate.
	"gemini/gemini-robotics-er-2-preview": {
		litellm_provider: "gemini",
		mode: "chat",
		input_cost_per_token: 0.000001,
		output_cost_per_token: 0.000005,
		cache_read_input_token_cost: 1e-7,
		output_cost_per_reasoning_token: 0.00001,
	},

	// openrouter and the smaller first-party providers
	"openrouter/anthropic/claude-sonnet-4.5": {
		litellm_provider: "openrouter",
		mode: "chat",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 0.00000375,
	},
	"xai/grok-4": {
		litellm_provider: "xai",
		mode: "chat",
		input_cost_per_token: 0.00000125,
		output_cost_per_token: 0.0000025,
		cache_read_input_token_cost: 2e-7,
	},
	// An explicit zero cache-write rate.
	"deepseek/deepseek-chat": {
		litellm_provider: "deepseek",
		mode: "chat",
		input_cost_per_token: 2.8e-7,
		output_cost_per_token: 4.2e-7,
		cache_read_input_token_cost: 2.8e-8,
		cache_creation_input_token_cost: 0,
	},
	"mistral/mistral-large-latest": {
		litellm_provider: "mistral",
		mode: "chat",
		input_cost_per_token: 5e-7,
		output_cost_per_token: 0.0000015,
		cache_read_input_token_cost: 5e-8,
	},
	"groq/llama-3.3-70b-versatile": {
		litellm_provider: "groq",
		mode: "chat",
		input_cost_per_token: 5.9e-7,
		output_cost_per_token: 7.9e-7,
	},
};

/** A usage row with zero tokens unless overridden. */
export function usageRow(
	overrides: Partial<Omit<NormalizedUsageRow, "tokens">> & {
		tokens?: Partial<NormalizedUsageRow["tokens"]>;
	} = {},
): NormalizedUsageRow {
	const { tokens, ...rest } = overrides;
	return {
		source: "opencode",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: new Date("2026-09-01T12:00:00Z"),
		sessionId: "ses_test",
		messageId: "msg_test",
		...rest,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			...tokens,
		},
	};
}

/** A fake fetch that answers every call with the given JSON body. Never touches the network. */
export function fakeFetch(body: unknown, init?: ResponseInit) {
	return vi.fn<typeof fetch>(
		async () =>
			new Response(
				typeof body === "string" ? body : JSON.stringify(body),
				init,
			),
	);
}

/** A fake fetch that fails the test if it is ever called. */
export function forbiddenFetch() {
	return vi.fn<typeof fetch>(async () => {
		throw new Error("network access is not allowed here");
	});
}

/** A fake fetch that answers every call with a 503, for tests that must reach the network. */
export function failingFetch() {
	return vi.fn<typeof fetch>(
		async () => new Response("unavailable", { status: 503 }),
	);
}

export interface RecordingProxy {
	/** `http://127.0.0.1:<port>`: pass this as HTTPS_PROXY. */
	url: string;
	/** Every CONNECT target seen so far, as `host:port`, in arrival order. */
	connects: string[];
	/**
	 * Resolves with the next CONNECT target the proxy receives (or, if one has already
	 * arrived, the most recent one immediately). Resolves `undefined` if none arrives
	 * within `timeoutMs`, so a caller never hangs waiting for a proxy that (correctly, or
	 * because the feature is not wired up yet) is never contacted.
	 */
	waitForConnect(timeoutMs: number): Promise<string | undefined>;
	/** Stops the fixture. Always call this, in a `finally`, even on a failed assertion. */
	close(): Promise<void>;
}

/**
 * A real local HTTP server that plays the part of a forwarding proxy, for tests that must
 * observe whether a real, unmocked fetch actually routes through HTTPS_PROXY - not just
 * that some code reads the environment variable. It only handles the CONNECT method (how
 * an HTTP proxy tunnels HTTPS, per every real proxy client including undici): Node's own
 * `http.Server` surfaces a CONNECT request through the `connect` event rather than
 * `request`, with `req.url` set to the tunnel target as `host:port` (verified directly
 * against Node 26.8.2 here: a manual `CONNECT raw.githubusercontent.com:443` produced
 * `req.url === "raw.githubusercontent.com:443"`).
 *
 * It never forwards the tunnel to the real target: on every CONNECT it records the target,
 * answers 502, and closes the socket. So a client that correctly honors the proxy never
 * reaches the public network through this fixture; only a client that ignores the proxy
 * and goes direct does, which the tests that use this account for explicitly.
 */
export function startRecordingProxy(): Promise<RecordingProxy> {
	return new Promise((resolve, reject) => {
		const connects: string[] = [];
		let waiter: ((target: string) => void) | undefined;
		const server = createServer();
		server.on("connect", (req, socket) => {
			// Node's http.Server always sets req.url to the CONNECT target (see the class doc
			// comment above); an undefined value here would mean Node's own contract changed
			// under us, so this blows up loudly rather than silently recording an empty string
			// that would turn into a confusing assertion failure downstream.
			if (req.url === undefined) {
				throw new Error(
					"recording proxy fixture: CONNECT request carried no url",
				);
			}
			const target = req.url;
			connects.push(target);
			waiter?.(target);
			waiter = undefined;
			socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			socket.end();
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("recording proxy fixture failed to bind a port"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				connects,
				waitForConnect(timeoutMs) {
					const [seen] = connects.slice(-1);
					if (seen !== undefined) return Promise.resolve(seen);
					return new Promise((res) => {
						const timer = setTimeout(() => {
							waiter = undefined;
							res(undefined);
						}, timeoutMs);
						waiter = (target) => {
							clearTimeout(timer);
							res(target);
						};
					});
				},
				close() {
					return new Promise((res) => server.close(() => res()));
				},
			});
		});
	});
}

// Test cache directories live under node_modules/.cache/, never the user's real cache.
const CACHE_BASE = fileURLToPath(
	new URL("../node_modules/.cache/my-usage-tests/", import.meta.url),
);

/**
 * Registers cleanup and returns a factory for fresh, isolated cache directories.
 * Each caller gets its own root, so test files running in parallel never share a directory.
 * Call once at describe/module scope.
 */
export function useTempCacheDirs(): () => Promise<string> {
	let root: string | undefined;
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
		// The shared parent is left in place, empty. Other test files (the opencode reader
		// tests use the same directory) may still be creating sandboxes under it, and
		// removing it from here races with them.
	});
	return async () => {
		if (!root) {
			await mkdir(CACHE_BASE, { recursive: true });
			root = await mkdtemp(`${CACHE_BASE}run-`);
		}
		return mkdtemp(`${root}/t-`);
	};
}
