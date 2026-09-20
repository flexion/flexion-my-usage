// Pure decision: which proxy URL, if any, a request to `url` should use, given `env`. No
// network, no real fetch, no process.env read directly - the caller passes both in.
//
// Every rule here mirrors nodejs/undici's EnvHttpProxyAgent (the same logic Node's own global
// fetch relies on once a request is dispatched through an undici ProxyAgent): env-var name
// precedence including the lowercase forms, NO_PROXY's comma/whitespace split, its leading
// "."/"*." forms versus a bare hostname's suffix match, its optional ":port" qualifier, and
// ALL_PROXY's absence. Verified against the undici actually installed in this repo -
// node_modules/undici@8.10.2, lib/dispatcher/env-http-proxy-agent.js
// (EnvHttpProxyAgent#shouldProxy / #parseNoProxy) - cross-checked against the same file at
// github.com/nodejs/undici @ 5e541e0b9df7563e5766bbd469fbfe383d9ae6ca (tag v8.10.2). See
// proxy.test.ts's header comment for the full grounding and the cases this file deliberately
// does not decide (IPv6 entries, ALL_PROXY, a scheme-selecting branch): none of them has a
// behavioral test, because this project's only caller only ever asks about an https target.
//
// This function never validates the returned proxy string as a URL: a malformed HTTPS_PROXY is
// returned unchanged. Parsing it, and failing gracefully on a bad one, is the caller's job
// (pricing-table.ts's ProxyAgent construction; see loadPriceTable's "malformed HTTPS_PROXY" test).

/** An env var read as `env.lower ?? env.UPPER`: lowercase wins, and an explicitly empty
 *  lowercase value still wins that lookup (the caller then treats "" as "not set"). */
function readVar(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): string | undefined {
	return env[name.toLowerCase()] ?? env[name];
}

interface NoProxyEntry {
	/** Normalized (lowercased, leading "*."/"." stripped) host or host suffix to match against. */
	hostname: string;
	/** 0 means "matches any port"; a NO_PROXY entry qualifies its host with `:port` to restrict it. */
	port: number;
}

function parseNoProxyEntries(value: string): NoProxyEntry[] {
	return value
		.split(/[,\s]/)
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			// Both capturing groups are non-optional by construction (`(.+)` and `(\d+)` each
			// require at least one character), so a successful match always fills index 1 and 2;
			// the cast avoids a TS-only "possibly undefined" that no input could ever produce.
			const portMatch = entry.match(/^(.+):(\d+)$/) as
				| [string, string, string]
				| null;
			const hostname = portMatch ? portMatch[1] : entry;
			const port = portMatch ? Number(portMatch[2]) : 0;
			return { hostname: hostname.replace(/^\*?\./, "").toLowerCase(), port };
		});
}

/** True when some NO_PROXY entry suppresses the proxy for this target's host and port. */
function isNoProxyMatch(noProxy: string, url: string): boolean {
	if (noProxy === "*") return true;
	const target = new URL(url);
	const hostname = target.hostname.toLowerCase();
	// This function is only ever called (from resolveProxy) with an https target, so 443 is the
	// only default port that matters here - see the module doc comment.
	const port = target.port ? Number(target.port) : 443;
	for (const entry of parseNoProxyEntries(noProxy)) {
		if (entry.port && entry.port !== port) continue;
		if (hostname === entry.hostname) return true;
		if (hostname.endsWith(`.${entry.hostname}`)) return true;
	}
	return false;
}

/**
 * Which proxy URL, if any, a request to `url` should use: HTTPS_PROXY when set and usable,
 * HTTP_PROXY as its fallback, suppressed entirely when NO_PROXY matches the target host (and,
 * where the entry names one, its port). Returns the configured value unchanged and unvalidated.
 */
export function resolveProxy(
	env: Readonly<Record<string, string | undefined>>,
	url: string,
): string | undefined {
	const proxy = readVar(env, "HTTPS_PROXY") || readVar(env, "HTTP_PROXY");
	if (!proxy) return undefined;

	const noProxy = readVar(env, "NO_PROXY");
	if (!noProxy) return proxy;

	return isNoProxyMatch(noProxy, url) ? undefined : proxy;
}
