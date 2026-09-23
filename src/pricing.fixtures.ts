// Shared fixtures for the pricing tests.
//
// LITELLM_FIXTURE holds real entries copied from LiteLLM's model_prices_and_context_window.json
// (BerriAI/litellm @ 38b310b7510ec78059fab6666d87c2fb6a7f76c9; the entries added for the
// model-id fallback tests were copied at b652aaad4a8100e8e0e8b27ce4c9e6bf4aa51465, where the
// older entries carry the same rates). Only the fields the pricing code reads are kept; keys
// and rates are unmodified. Tests that need a doctored entry spread a real one and say so.
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { makeFixtureDir } from "./__tests__/test-fixture-root.js";
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

// Throwaway 10-year self-signed test certificate (regenerated 2026-09-21, myusage-akq, via
// `openssl req -x509 -newkey rsa:2048 -days 3650 -nodes -keyout key.pem -out cert.pem -subj
// "/CN=raw.githubusercontent.com" -addext "subjectAltName=DNS:raw.githubusercontent.com"
// -addext "basicConstraints=critical,CA:FALSE"`), used only to TLS-terminate
// startTunnelingProxy's local fake origin below. A plain end-entity leaf (CA:FALSE, not
// openssl's CA:TRUE default) - verified via `openssl x509 -in cert.pem -noout -text | grep -A2
// "Basic Constraints"` - since this fixture only ever needs to present the right SAN, not CA
// authority: a CA:TRUE key trusted more broadly than this test's own loopback origin (say, via a
// system trust store) would be trusted for any hostname, not just this one. Not a secret: it
// signs nothing but this fixture's own loopback server, and a test process trusts it only by
// pointing NODE_EXTRA_CA_CERTS at it directly (see src/load-price-table-via-proxy.fixtures.ts) -
// it grants no access to anything real. Committed rather than generated at test time so the
// suite never depends on `openssl` being present in CI.
export const TEST_ORIGIN_CERT = `-----BEGIN CERTIFICATE-----
MIIDTDCCAjSgAwIBAgIUA/NC2tGW3LJH5gS/Sav7wHkHatcwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbTAeFw0yNjA5
MjExMDUyMjJaFw0zNjA5MTgxMDUyMjJaMCQxIjAgBgNVBAMMGXJhdy5naXRodWJ1
c2VyY29udGVudC5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCZ
YNwCxVkl0dORvZ1jZ1VDDQOdjK+Rfj52Uqi/hnywCVGUOkbSZuPDennI1PDir5w+
oemzjqXrgEUTSeBC6rlrVF7Wk/oZPX1gU5nHxOLa9O+suTjBBZYmehs9Kxm4eCE9
DPVdOlDsXsF7RrHZcSN6KSqOShvOzIuFyvsIFN9TTOl8n44kwnzo3ZC9oV5up8Dj
ZlokSP2y9/45XzWiNITGoZnUTvvtRSrHnQPp2Hv5lWCf/oUxo4TRnzyHZMrsMyv7
hoZY9c+RgzyKqHo32kKF+q1QgsVxq2i9ARymg7d43iOafyWj8xPnBDLPwnxAyQqy
jFe5pWz0V4kqAkaNPBO9AgMBAAGjdjB0MB0GA1UdDgQWBBQvRZq6DQ63qVVnkm38
Lr5PD5REOzAfBgNVHSMEGDAWgBQvRZq6DQ63qVVnkm38Lr5PD5REOzAkBgNVHREE
HTAbghlyYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tMAwGA1UdEwEB/wQCMAAwDQYJ
KoZIhvcNAQELBQADggEBAFFiZErCZRSNj/XgsWaZomR1ioq7dUFJ8y8qv/WOMpX1
Ys2O9mnZaCfjcEVpmPs9jFbdhRwg2IXjIwFwvJzmIPYyLNdvYtd1fTZ4DNZQD+2m
VHt5ftW9bfqdIZqs1SvsCpB0WNQvf6/Rio8DA/p1KKJ14toawMO8TrZNr6zAH8DO
dlzG5+5TcviqJ4wsmIjfKS1q1T8JqK+EyWyk+r3JQHM0yTsS91rXn+xvps7WcdFk
McxLdxO3u/9JGqNkDhHQ5L4ojK8oZ7Niuqc5flzZczMMLEZNqnb4G6nzHx88NCXe
BHPBOZFP8iCrioyHzTP3Iz6FEDPuLPoj36Q2nORodAA=
-----END CERTIFICATE-----
`;

export const TEST_ORIGIN_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCZYNwCxVkl0dOR
vZ1jZ1VDDQOdjK+Rfj52Uqi/hnywCVGUOkbSZuPDennI1PDir5w+oemzjqXrgEUT
SeBC6rlrVF7Wk/oZPX1gU5nHxOLa9O+suTjBBZYmehs9Kxm4eCE9DPVdOlDsXsF7
RrHZcSN6KSqOShvOzIuFyvsIFN9TTOl8n44kwnzo3ZC9oV5up8DjZlokSP2y9/45
XzWiNITGoZnUTvvtRSrHnQPp2Hv5lWCf/oUxo4TRnzyHZMrsMyv7hoZY9c+RgzyK
qHo32kKF+q1QgsVxq2i9ARymg7d43iOafyWj8xPnBDLPwnxAyQqyjFe5pWz0V4kq
AkaNPBO9AgMBAAECggEAFRBs1sKUpjGFbWANo++2kXFRnEsMd55PZL+gZkFJkYGO
Hx3LySyRPjDtVcwM0w0MF7vz1RGTrt6cXfRI5NfIpDlflveWou3DcL26gmmDQE/g
NKfxZ+zk/J7La+Cl9SQmaHSFpAqUv4mZ59zDIxo7JZVOv2DlJccIqFTCmg8HxrA0
dA0UzlBQMryHSDZLoOzmQ6Ao661BPqJY06tXKUnUrMxeO23vGO0vYbTnBEn3qiNP
8/r/RTtKnmwCh05AyZbUAHFLPIDMKItGqqF7goMtzB+vfdoutddstqMJe218aVlQ
NC+gEOQHikBJtFBkya+nAZS1pK0lXEMfvCZxioV6oQKBgQDLrdAFtYTCmGSyg/BO
CMfKm/DN3Jp+CWlLR8QJROZAtMWA+Tv2PioKoaYZiCCsWz7W9SKk5joA8sOZo3Ly
YtZ2bKZlAVJkwLajri4bIayK07i0S4uRiupHw4KP3V+ZQOyWYdf5+vOamedltO7u
tkWkgvu3ndpKlTtjrK3UNCVFDQKBgQDAxzcnhLnv/A++Io0aQudPIklYsHXM0Rcj
+ao5ccyNojEcqJyoDddSwFDcGRNMfnClTjjOWtc1k1MDLLx4XIwQYfhUfQaJOb2z
h3GfCmI22xLeOaMJ3LXSOpCCGz4IuG2Es+L26ZMjDfIfunkv4F6o5FPSin/GGwED
FINJYIa9cQKBgQCt3+yk4we5w7S6/I1JYI+GdEdGxluQ2uHrZRGCRDI37NpqNtos
ZXcoakTMqPwThzWG9e+kS/IaWyQF5ZW8PAoPQMNvmIhJAIcqBgjQGpgcT4/vQkqc
bbWAm/O6cuYog1c1LcPdYJFTWq1Ckwoh+LJNNZBDeNsgLnNrrL8cV4O1hQKBgQCJ
xZYYSxXrefPySZUYIJpZBsLufGYj84abMlHCbh7nVfPNbH9Q51tsi37+XXlaYL62
lRmp+Gf3pQtdqHoldtau2qV0FEo4hiiaBoFgTTZ1x8lLQlvPr4nN7gbaxQdnig7T
GRBqr/F0ywGwRT9YxPxBrbRuMocwmJn3jpBpP2/sMQKBgQDBhTeE+JzH56iZNMov
jwhTdW2zQm99ct2eF4Js/CM53edQfsqovF5Rd/joG/8R7YlM1VNEHp0ugwGySXyR
L9eCXVkDvTdWTWzuQxC7W7LOQ4Ks6CdgQNAgB5Fj1luaZemG6TnXZF7Dg49DwSpK
4deEJ5unU7yU61i57/iCzva3wg==
-----END PRIVATE KEY-----
`;

export interface TunnelingProxy {
	/** `http://127.0.0.1:<port>`: pass this as HTTPS_PROXY. */
	url: string;
	close(): Promise<void>;
}

/**
 * A real local HTTP CONNECT proxy that, unlike startRecordingProxy above, actually tunnels:
 * on CONNECT it opens a real TCP connection to `originPort` (ignoring the CONNECT target the
 * client asked for - always redirected to this fixture's own local origin, never the real
 * internet) and pipes bytes in both directions, so a client's TLS handshake and full response
 * genuinely flow through this proxy process rather than being answered locally. Forwards the
 * CONNECT handler's `head` buffer (any bytes the client already sent past the CONNECT request
 * line, e.g. the start of a TLS ClientHello racing ahead of the "200 Connection Established"
 * reply) - dropping it silently loses those bytes and hangs the handshake, caught by hand
 * while building this fixture.
 */
export function startTunnelingProxy(
	originPort: number,
): Promise<TunnelingProxy> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("connect", (_req, clientSocket, head) => {
			const upstream = netConnect(originPort, "127.0.0.1", () => {
				clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			upstream.on("error", () => clientSocket.destroy());
			clientSocket.on("error", () => upstream.destroy());
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("tunneling proxy fixture failed to bind a port"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close() {
					return new Promise((res) => server.close(() => res()));
				},
			});
		});
	});
}

export interface FakeOrigin {
	port: number;
	close(): Promise<void>;
}

/**
 * A real local HTTPS server, TLS-terminated with TEST_ORIGIN_CERT/TEST_ORIGIN_KEY (whose SAN
 * is raw.githubusercontent.com), answering every request with `body` and a
 * `content-type: application/json` header. Meant to sit behind startTunnelingProxy: a client
 * that trusts TEST_ORIGIN_CERT (via NODE_EXTRA_CA_CERTS) and requests the real
 * PRICE_TABLE_URL through a proxy pointed at this origin genuinely can't tell it apart from
 * the real host at the TLS layer.
 */
export function startFakeOrigin(body: string): Promise<FakeOrigin> {
	return new Promise((resolve, reject) => {
		const server = createHttpsServer(
			{ cert: TEST_ORIGIN_CERT, key: TEST_ORIGIN_KEY },
			(_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
			},
		);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("fake origin fixture failed to bind a port"));
				return;
			}
			resolve({
				port: address.port,
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
 * Each caller gets its own root (see src/__tests__/test-fixture-root.ts), so test files running in
 * parallel never share a directory - including the other test files (the opencode reader
 * tests) that call this same function against this same shared CACHE_BASE. Call once at
 * describe/module scope.
 */
export function useTempCacheDirs(): () => Promise<string> {
	return makeFixtureDir(CACHE_BASE);
}
