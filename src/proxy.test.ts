// Specifies resolveProxy(env, url): the pure decision "which proxy URL, if any, applies to this
// request", exhaustively, with plain data. No network, no real fetch, no process.env.
//
// Why this file exists (myusage-4xu.15, FIX round 2): the sibling describe block in
// pricing-table.test.ts drives the real, unmocked global fetch through a local recording-proxy
// fixture, which is the right tool for proving the real network stack is actually wired to a
// proxy - but it cannot decide (and must not be asked to decide) every NO_PROXY form, case rule
// and precedence rule, because outcomes there depend on whatever transport mechanism the
// eventual implementation uses. Node's built-in env-proxy support (NODE_USE_ENV_PROXY) is
// startup-only and unavailable at this repo's Node floor (engines.node ">=22.13.0" in
// package.json; added in Node 22.21.0 per the prior review round), so the only viable
// implementation is a hand-rolled CONNECT tunnel in pricing-table.ts - a file the coverage gate
// never excludes. Every NO_PROXY/HTTP(S)_PROXY form below is therefore specified here, against
// plain inputs, so whichever transport the implementer builds only has to satisfy a fixed,
// deterministic table - not reproduce it by trial and error against a live proxy.
//
// Grounding: the exact matching rules below (env-var name precedence including the lowercase
// forms, NO_PROXY's comma/whitespace split, its leading "." and "*" suffix forms vs. a bare
// hostname's exact-only match, its optional ":port" qualifier, and ALL_PROXY's absence) mirror
// nodejs/undici @ 7392d6f9f565e550e9047458c275ae77aeaefbb9 (tag v7.16.0),
// lib/dispatcher/env-http-proxy-agent.js (EnvHttpProxyAgent#shouldProxy/#parseNoProxy) - the
// same convention Node's own fetch would use once NODE_USE_ENV_PROXY is set, so a proxy admin
// configuring this tool sees the behavior every other Node-based client on their machine
// already has. Read there, not invented here.
//
// Decisions made explicit by a test, not left implicit:
// - Every proxy/no-proxy env var is read as `env.lower ?? env.UPPER`: an env object with only
//   the uppercase key set falls through to it, but an explicitly-empty lowercase key (`??` does
//   not skip "") wins the precedence check and is then treated as "not set" - it does NOT fall
//   through to the uppercase key. See "an explicitly empty lowercase env var wins precedence
//   and still counts as unset" below.
// - HTTPS_PROXY is preferred; HTTP_PROXY is used only as its fallback when HTTPS_PROXY is
//   unset. There is no scheme-selecting branch here: the price-table URL this function is
//   actually called with is always https, so a generic "http vs https target" decision would be
//   dead code on this call path (round-2 review, F8) and is deliberately not built.
// - ALL_PROXY is not read at all: neither undici nor Node's fetch honors it, and the bead names
//   only HTTP(S)_PROXY. A variable set to the empty string is treated the same as unset, which
//   is the conventional meaning of an empty proxy variable.
// - A malformed or credentialed proxy URL is returned unchanged and unvalidated: this function
//   only decides *which* configured string applies, never whether that string is a usable URL.
//   Parsing (and failing gracefully on a bad one) is the adapter's job once it exists - out of
//   scope for this test-only round, and deliberately not decided here so no untested branch it
//   would require gets written.
import { describe, expect, it } from "vitest";
import { PRICE_TABLE_URL } from "./pricing-table.js";
import { resolveProxy } from "./proxy.js";

const REAL_HOST = new URL(PRICE_TABLE_URL).hostname; // raw.githubusercontent.com

/** A neutral target for the generic NO_PROXY matching-rule tests (RFC 2606 documentation domain). */
const GENERIC_URL = "https://api.example.com/v1";

describe("resolveProxy: no proxy configured", () => {
	it.each([
		["no proxy-related variable is set", {}],
		[
			"only ALL_PROXY is set (not a variable this function reads)",
			{ ALL_PROXY: "http://proxy.example:8080" },
		],
		["HTTPS_PROXY is set to the empty string", { HTTPS_PROXY: "" }],
		[
			"HTTP_PROXY is set to the empty string and HTTPS_PROXY is unset",
			{ HTTP_PROXY: "" },
		],
	])("%s -> undefined", (_name, env) => {
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBeUndefined();
	});
});

describe("resolveProxy: which proxy value applies", () => {
	it("returns HTTPS_PROXY when only the uppercase form is set", () => {
		const env = { HTTPS_PROXY: "http://proxy.example:8080" };
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.HTTPS_PROXY);
	});

	it("prefers lowercase https_proxy over uppercase HTTPS_PROXY when both are set", () => {
		const env = {
			https_proxy: "http://lower.example:8080",
			HTTPS_PROXY: "http://upper.example:8080",
		};
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.https_proxy);
	});

	it("an explicitly empty lowercase env var wins precedence and still counts as unset", () => {
		// The precedence chain is `??`, which does not skip an explicitly empty string: the
		// lowercase key "wins" the lookup, and only then is the winning value checked for
		// usability. So this must NOT fall through to the uppercase HTTPS_PROXY value below.
		const env = { https_proxy: "", HTTPS_PROXY: "http://upper.example:8080" };
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBeUndefined();
	});

	it("falls back to HTTP_PROXY when HTTPS_PROXY is unset, for this always-https target", () => {
		const env = { HTTP_PROXY: "http://proxy.example:3128" };
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.HTTP_PROXY);
	});

	it("prefers lowercase http_proxy over uppercase HTTP_PROXY when both are set", () => {
		const env = {
			http_proxy: "http://lower.example:3128",
			HTTP_PROXY: "http://upper.example:3128",
		};
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.http_proxy);
	});

	it("prefers HTTPS_PROXY over HTTP_PROXY when both are set", () => {
		const env = {
			HTTPS_PROXY: "http://https.example:1",
			HTTP_PROXY: "http://http.example:2",
		};
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.HTTPS_PROXY);
	});

	it("returns a proxy URL carrying Basic credentials unchanged", () => {
		const env = { HTTPS_PROXY: "http://user:pass@proxy.example:8080" };
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.HTTPS_PROXY);
	});

	it("returns a malformed proxy value unchanged, without validating or rejecting it", () => {
		const env = { HTTPS_PROXY: "notaurl" };
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe("notaurl");
	});
});

describe("resolveProxy: NO_PROXY against the real price-table host", () => {
	// These two decisively replace the pre-implementation "does not use the proxy when
	// NO_PROXY matches the target host" case in pricing-table.test.ts, which could only ever
	// assert against the real, hardcoded PRICE_TABLE_URL host over the real network stack (see
	// that file's block comment). As plain-data cases here, both are fully decisive.
	it("suppresses the proxy when NO_PROXY exactly matches the real target host", () => {
		const env = {
			HTTPS_PROXY: "http://proxy.example:8080",
			NO_PROXY: REAL_HOST,
		};
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBeUndefined();
	});

	it("still returns the proxy when NO_PROXY does not match the real target host", () => {
		const env = {
			HTTPS_PROXY: "http://proxy.example:8080",
			NO_PROXY: "example.com",
		};
		expect(resolveProxy(env, PRICE_TABLE_URL)).toBe(env.HTTPS_PROXY);
	});
});

describe("resolveProxy: NO_PROXY matching rules", () => {
	const HTTPS_PROXY = "http://proxy.example:8080";

	it.each<[string, string, string, boolean]>([
		[
			"a bare hostname is an exact match only, and does NOT suffix-match a subdomain",
			"example.com",
			"https://api.example.com/v1",
			false,
		],
		[
			"a bare hostname matches when it equals the target host exactly",
			"api.example.com",
			GENERIC_URL,
			true,
		],
		[
			"a leading-dot entry suffix-matches a subdomain",
			".example.com",
			"https://api.example.com/v1",
			true,
		],
		[
			"a leading-dot entry does NOT match the bare parent domain itself",
			".example.com",
			"https://example.com/",
			false,
		],
		[
			"a leading-star entry behaves the same as a leading dot",
			"*.example.com",
			"https://api.example.com/v1",
			true,
		],
		[
			"host matching is case-insensitive on the NO_PROXY entry",
			"API.EXAMPLE.COM",
			GENERIC_URL,
			true,
		],
		[
			"a port-qualified entry suppresses the proxy when the port matches (default 443)",
			"api.example.com:443",
			GENERIC_URL,
			true,
		],
		[
			"a port-qualified entry does NOT suppress the proxy when the port does not match",
			"api.example.com:8443",
			GENERIC_URL,
			false,
		],
		[
			"comma- and space-separated entries, including empty entries from doubled separators, are all honored",
			"foo.example, ,api.example.com,,bar.example",
			GENERIC_URL,
			true,
		],
	])("%s", (_name, noProxy, url, suppressed) => {
		const env = { HTTPS_PROXY, NO_PROXY: noProxy };
		const result = resolveProxy(env, url);
		expect(result).toBe(suppressed ? undefined : HTTPS_PROXY);
	});

	it("a bare '*' entry bypasses the proxy for every host", () => {
		const env = { HTTPS_PROXY, NO_PROXY: "*" };
		expect(resolveProxy(env, GENERIC_URL)).toBeUndefined();
	});

	it("an explicitly empty NO_PROXY behaves the same as NO_PROXY being unset", () => {
		const env = { HTTPS_PROXY, NO_PROXY: "" };
		expect(resolveProxy(env, GENERIC_URL)).toBe(HTTPS_PROXY);
	});

	it("prefers lowercase no_proxy over uppercase NO_PROXY when they disagree", () => {
		// no_proxy (lowercase, wins) matches the target; NO_PROXY (uppercase, loses) does not.
		// If precedence were reversed, or both were consulted, this would return the proxy.
		const env = {
			HTTPS_PROXY,
			no_proxy: "api.example.com",
			NO_PROXY: "example.org",
		};
		expect(resolveProxy(env, GENERIC_URL)).toBeUndefined();
	});
});
