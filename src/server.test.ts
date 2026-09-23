// Proves the dashboard server two ways: `reply` and `isLoopbackHost` as pure routing decisions
// over plain values, and `startServer` as a real node:http server on a real ephemeral port,
// driven by real clients (global fetch, and node:http's own client where a test needs to forge
// or omit the Host header, which fetch won't let it do). Nothing mocks createServer.
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONTENT_SECURITY_POLICY,
	DATA_PATH,
	INDEX_PATH,
	isLoopbackHost,
	LOOPBACK_HOST,
	portInUseMessage,
	type RunningServer,
	reply,
	type Site,
	startServer,
} from "./server.js";

// Non-ASCII on purpose: content-length must be the byte length, not the character count.
const HTML =
	"<!doctype html><html><body><h1>my-usage</h1><p>café</p></body></html>";
const HTML_BYTES = String(Buffer.byteLength(HTML));
const SCRIPT = "console.log('é');";
const DATA = '{"days":[],"skipped":{"skipped":0,"total":0}}';
const SITE: Site = {
	files: new Map([
		[
			INDEX_PATH,
			{ contentType: "text/html; charset=utf-8", body: Buffer.from(HTML) },
		],
		[
			"/assets/index-abc123.js",
			{
				contentType: "text/javascript; charset=utf-8",
				body: Buffer.from(SCRIPT),
			},
		],
	]),
	data: DATA,
};
const OK_HOST = "127.0.0.1:1";

/** A reply's body as text, for readable assertions. */
function text(r: { body: Buffer }): string {
	return r.body.toString("utf8");
}

describe("isLoopbackHost", () => {
	it.each([
		["127.0.0.1", true],
		["127.0.0.1:54321", true],
		["localhost", true],
		["localhost:80", true],
		["localhost:", true],
		["[::1]", true],
		["[::1]:8080", true],
		["evil.example", false],
		["evil.example:54321", false],
		["127.0.0.1.evil.example", false],
		["localhost.evil.example", false],
		["evil.example:127.0.0.1", false],
		["127.0.0.1:abc", false],
		["::1", false],
		["[::1", false],
		["", false],
		[undefined, false],
	])("%s -> %s", (host, expected) => {
		expect(isLoopbackHost(host)).toBe(expected);
	});
});

describe("reply", () => {
	it("GET / from a loopback Host -> 200, index.html, no-store, nosniff and the CSP", () => {
		const r = reply("GET", "/", OK_HOST, SITE);
		expect(r.status).toBe(200);
		expect(r.headers).toEqual({
			"content-type": "text/html; charset=utf-8",
			"content-length": HTML_BYTES,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": CONTENT_SECURITY_POLICY,
		});
		expect(text(r)).toBe(HTML);
	});

	it("the CSP only allows this origin, and never allows inline or remote script", () => {
		expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
		expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src/);
		expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
	});

	it("GET /index.html is the same file as /", () => {
		expect(reply("GET", INDEX_PATH, OK_HOST, SITE)).toEqual(
			reply("GET", "/", OK_HOST, SITE),
		);
	});

	it("a built asset -> 200 with its own content type, byte length, and no CSP", () => {
		const r = reply("GET", "/assets/index-abc123.js", OK_HOST, SITE);
		expect(r.status).toBe(200);
		expect(r.headers).toEqual({
			"content-type": "text/javascript; charset=utf-8",
			"content-length": String(Buffer.byteLength(SCRIPT)),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		expect(text(r)).toBe(SCRIPT);
	});

	it("the data route -> 200 JSON, the payload verbatim", () => {
		const r = reply("GET", DATA_PATH, OK_HOST, SITE);
		expect(DATA_PATH).toBe("/api/usage.json");
		expect(r.status).toBe(200);
		expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
		expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(DATA)));
		expect(r.headers["cache-control"]).toBe("no-store");
		expect(r.headers["content-security-policy"]).toBeUndefined();
		expect(text(r)).toBe(DATA);
	});

	it("HEAD -> the GET's headers (full content-length) and an empty body, on every route", () => {
		for (const path of ["/", "/assets/index-abc123.js", DATA_PATH]) {
			const head = reply("HEAD", path, OK_HOST, SITE);
			expect(head.status, path).toBe(200);
			expect(head.headers, path).toEqual(
				reply("GET", path, OK_HOST, SITE).headers,
			);
			expect(head.body.length, path).toBe(0);
		}
	});

	it("a query string is ignored on every route", () => {
		expect(text(reply("GET", "/?measure=tokens", OK_HOST, SITE))).toBe(HTML);
		expect(text(reply("GET", `${DATA_PATH}?t=1`, OK_HOST, SITE))).toBe(DATA);
		expect(
			reply("GET", "/assets/index-abc123.js?v=2", OK_HOST, SITE).status,
		).toBe(200);
	});

	it.each([
		"/favicon.ico",
		"/x",
		"/assets/",
		"/assets/missing.js",
		"/assets/../index.html",
		"/assets/index-abc123.js/",
		"/api/usage",
		"/api/usage.json/",
		"/INDEX.HTML",
		"//",
		"///",
		"//:",
		"http://",
		"http://@",
		"/\\",
		"http://anything/",
		"//anything/",
		"/./",
		"/x/../",
		"",
	])("GET %s -> 404 text, never a throw", (url) => {
		const notFound = Buffer.from("Not found\n");
		expect(reply("GET", url, OK_HOST, SITE)).toEqual({
			status: 404,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"content-length": String(notFound.length),
				"cache-control": "no-store",
			},
			body: notFound,
		});
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS", "PATCH"])(
		"%s / -> 405 with the allowed methods named",
		(method) => {
			const r = reply(method, "/", OK_HOST, SITE);
			expect(r.status).toBe(405);
			expect(r.headers.allow).toBe("GET, HEAD");
			expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
			expect(text(r)).toBe("Method not allowed\n");
		},
	);

	it("an off-origin Host -> 403, before the method or path is even looked at", () => {
		const r = reply("POST", "/nowhere", "evil.example:54321", SITE);
		expect(r.status).toBe(403);
		expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
		expect(r.headers.allow).toBeUndefined();
		expect(text(r)).toContain("localhost");
	});

	it("an off-origin Host can't read the data route either", () => {
		expect(reply("GET", DATA_PATH, "evil.example", SITE).status).toBe(403);
	});

	it("a missing Host -> 403", () => {
		expect(reply("GET", "/", undefined, SITE).status).toBe(403);
	});
});

describe("portInUseMessage", () => {
	it("names the port, the host, and both remedies", () => {
		const message = portInUseMessage("127.0.0.1", 8123);
		expect(message).toContain("port 8123 is already in use on 127.0.0.1");
		expect(message).toContain("--port <n>");
		expect(message).toContain("leave --port off");
	});
});

interface RawResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

/** node:http's client, for the cases fetch can't express: a forged or absent Host header. */
function rawRequest(
	server: RunningServer,
	options: { method?: string; path?: string; host?: string; setHost?: boolean },
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: LOOPBACK_HOST,
				port: server.port,
				method: options.method ?? "GET",
				path: options.path ?? "/",
				setHost: options.setHost ?? true,
				headers: options.host === undefined ? {} : { host: options.host },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode as number,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.once("error", reject);
		req.end();
	});
}

describe("startServer", () => {
	const running: RunningServer[] = [];
	const rawSockets: Socket[] = [];

	async function start(
		port = 0,
		signals: EventEmitter = new EventEmitter(),
	): Promise<RunningServer> {
		const server = await startServer(SITE, {
			host: LOOPBACK_HOST,
			port,
			signals,
		});
		running.push(server);
		return server;
	}

	afterEach(async () => {
		// Raw sockets first: any test below that opens one over `netConnect` registers it here
		// rather than relying on its own try/finally, because a test that times out mid-request
		// (see "close() drops an active (half-sent-request) connection") leaves both a socket
		// the server is still waiting on and a `RunningServer.close()` waiting on that same
		// socket - and a plain try/finally never gets a turn to run in that case (the timeout
		// abandons the suspended async function instead of unwinding it). This hook runs
		// regardless, so dropping the socket here unblocks that close() instead of this hook
		// also hanging out to its own timeout.
		for (const socket of rawSockets.splice(0)) socket.destroy();
		await Promise.all(running.splice(0).map((s) => s.close()));
	});

	it("listens on 127.0.0.1 at an OS-chosen port and reports the exact URL", async () => {
		const server = await start();
		expect(server.port).toBeGreaterThan(0);
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
	});

	it("serves the page, an asset and the data to a real fetch of the reported URL", async () => {
		const server = await start();
		const res = await fetch(server.url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("content-length")).toBe(HTML_BYTES);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toBe(
			CONTENT_SECURITY_POLICY,
		);
		expect(await res.text()).toBe(HTML);
		const asset = await fetch(new URL("/assets/index-abc123.js", server.url));
		expect(asset.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(await asset.text()).toBe(SCRIPT);
		const data = await fetch(new URL(DATA_PATH, server.url));
		expect(await data.json()).toEqual(JSON.parse(DATA));
	});

	it("answers HEAD with the headers and no body", async () => {
		const server = await start();
		const res = await fetch(server.url, { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe(HTML_BYTES);
		expect(await res.text()).toBe("");
	});

	it("404s any other path and 405s any other method, over the wire", async () => {
		const server = await start();
		const notFound = await fetch(new URL("/favicon.ico", server.url));
		expect(notFound.status).toBe(404);
		expect(await notFound.text()).toBe("Not found\n");
		const notAllowed = await fetch(server.url, { method: "POST", body: "x" });
		expect(notAllowed.status).toBe(405);
		expect(notAllowed.headers.get("allow")).toBe("GET, HEAD");
	});

	it("accepts every loopback spelling of Host, with or without a port", async () => {
		const server = await start();
		for (const host of [
			`127.0.0.1:${server.port}`,
			"127.0.0.1",
			`localhost:${server.port}`,
			"localhost",
			`[::1]:${server.port}`,
		]) {
			const res = await rawRequest(server, { host });
			expect(res.status, host).toBe(200);
			expect(res.body, host).toBe(HTML);
		}
	});

	it("refuses a forged off-origin Host (DNS rebinding) with 403", async () => {
		const server = await start();
		const res = await rawRequest(server, {
			host: `evil.example:${server.port}`,
		});
		expect(res.status).toBe(403);
		expect(res.body).toContain("only answers requests addressed to localhost");
	});

	it("refuses a request that sends no Host header at all", async () => {
		// Node's own parser already 400s an HTTP/1.1 request with no Host before any handler
		// runs, so the only way a real request reaches `reply` with host undefined is HTTP/1.0,
		// where the header is optional - sent here as raw bytes over a plain socket.
		const server = await start();
		const socket = netConnect(server.port, LOOPBACK_HOST, () => {
			socket.write("GET / HTTP/1.0\r\n\r\n");
		});
		rawSockets.push(socket);
		const raw = await new Promise<string>((resolve, reject) => {
			let data = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				data += chunk;
			});
			socket.once("end", () => resolve(data));
			socket.once("error", reject);
		});
		expect(raw.startsWith("HTTP/1.1 403 ")).toBe(true);
		expect(raw).toContain("only answers requests addressed to localhost");
	});

	it("refuses an HTTP/1.1 request with no Host too (Node's parser, with a 400)", async () => {
		const server = await start();
		const res = await rawRequest(server, { setHost: false });
		expect(res.status).toBe(400);
	});

	it("survives a target the URL parser would refuse (a double slash), and keeps serving", async () => {
		// `new URL("//", base)` throws; an unguarded parse in the handler would escape as an
		// uncaught exception and kill the process. Reachable from any web page via an <img src>
		// aimed at this address, so this is a real client sending it over a real socket.
		const server = await start();
		const res = await fetch(`${server.url}/`);
		expect(res.status).toBe(404);
		const again = await fetch(server.url);
		expect(again.status).toBe(200);
	});

	// No "honors an explicit port" test on purpose: binding port 0, closing, and rebinding that
	// port is racy (anything can take it in between). The conflict test below already pins the
	// pass-through - it only rejects if the second server tried to bind exactly `first.port`.
	it("rejects an explicit port that is already in use, naming the remedy", async () => {
		const first = await start();
		await expect(start(first.port)).rejects.toMatchObject({
			message: portInUseMessage(LOOPBACK_HOST, first.port),
			cause: { code: "EADDRINUSE" },
		});
	});

	it("surfaces any other listen failure unchanged", async () => {
		// 192.0.2.1 is RFC 5737 documentation space - never assigned to a local interface.
		await expect(
			startServer(SITE, {
				host: "192.0.2.1",
				port: 0,
				signals: new EventEmitter(),
			}),
		).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
	});

	it("close() stops the listener, resolves `closed`, and is idempotent", async () => {
		const server = await start();
		let closedResolved = false;
		void server.closed.then(() => {
			closedResolved = true;
		});
		await server.close();
		expect(closedResolved).toBe(true);
		await expect(fetch(server.url)).rejects.toThrow();
		await server.close();
	});

	it("close() drops an active (half-sent-request) connection instead of waiting on it", async () => {
		const server = await start();
		const socket = netConnect(server.port, LOOPBACK_HOST);
		// Registered with the shared afterEach above instead of a try/finally: if
		// closeAllConnections regresses and close() hangs, this test times out with the socket
		// still open mid-request, and a finally block never gets a turn to run (the timeout
		// abandons the suspended async function - it doesn't unwind it). The afterEach hook
		// still runs on a timeout, so the raw socket - and the server's own pending close() that
		// depends on it - still get torn down instead of also hanging the afterEach itself.
		rawSockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", reject);
		});
		// Deliberately missing the blank line that ends the headers, so the server has
		// accepted the connection but is still mid-request. The 10ms tick lets the server
		// actually read and start parsing those bytes before close() runs - without it, close()
		// races the parser and sees the same still-blank socket an idle one would look like,
		// which defeats the point of this test (measured: 2ms already suffices on every
		// supported Node version, but on the 26 line a 0-1ms tick is unreliable - close() can
		// still beat the parser and drop the socket as untouched - so 10ms is a margin, not the
		// floor). Once the server has genuinely started a request, the connection is active, not
		// idle: an idle keep-alive connection (a finished request/response) already closes on
		// its own in 0-3ms; only an in-flight one like this depends on closeAllConnections -
		// without it, close() waits on a request that never finishes instead of dropping the
		// socket.
		socket.write(`GET / HTTP/1.1\r\nHost: ${LOOPBACK_HOST}:${server.port}\r\n`);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		const started = Date.now();
		await server.close();
		// Measured close() here is ~1ms; 300ms is two orders of magnitude of headroom, not a
		// tight bound. The real failure mode without closeAllConnections is a hang well past
		// this test's own 2000ms timeout below, not a slow-but-finished close.
		expect(Date.now() - started).toBeLessThan(300);
	}, 2000);

	it("stops on SIGINT from the injected signal source and unregisters its listeners", async () => {
		const signals = new EventEmitter();
		const server = await start(0, signals);
		expect(signals.listenerCount("SIGINT")).toBe(1);
		expect(signals.listenerCount("SIGTERM")).toBe(1);
		signals.emit("SIGINT");
		await server.closed;
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGTERM")).toBe(0);
		await expect(fetch(server.url)).rejects.toThrow();
	});

	it("stops on SIGTERM too", async () => {
		const signals = new EventEmitter();
		const server = await start(0, signals);
		signals.emit("SIGTERM");
		await server.closed;
		expect(signals.listenerCount("SIGINT")).toBe(0);
		await expect(fetch(server.url)).rejects.toThrow();
	});

	it("close() after a signal is a no-op that still resolves", async () => {
		const signals = new EventEmitter();
		const server = await start(0, signals);
		signals.emit("SIGINT");
		await server.close();
		await server.closed;
	});
});
