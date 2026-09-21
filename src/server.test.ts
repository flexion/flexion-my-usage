// Proves the dashboard server two ways: `reply` and `isLoopbackHost` as pure routing decisions
// over plain strings, and `startServer` as a real node:http server on a real ephemeral port,
// driven by real clients (global fetch, and node:http's own client where a test needs to forge
// or omit the Host header, which fetch won't let it do). Nothing mocks createServer.
import { EventEmitter } from "node:events";
import { Agent, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	isLoopbackHost,
	LOOPBACK_HOST,
	portInUseMessage,
	type RunningServer,
	reply,
	startServer,
} from "./server.js";

// Non-ASCII on purpose: content-length must be the byte length, not the character count.
const HTML =
	"<!doctype html><html><body><h1>my-usage</h1><p>café</p></body></html>";
const HTML_BYTES = String(Buffer.byteLength(HTML));
const OK_HOST = "127.0.0.1:1";

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
	it("GET / from a loopback Host -> 200, the html, with no-store and nosniff", () => {
		expect(reply("GET", "/", OK_HOST, HTML)).toEqual({
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-length": HTML_BYTES,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			},
			body: HTML,
		});
	});

	it("HEAD / -> the GET's headers (full content-length) and an empty body", () => {
		const head = reply("HEAD", "/", OK_HOST, HTML);
		expect(head.status).toBe(200);
		expect(head.headers).toEqual(reply("GET", "/", OK_HOST, HTML).headers);
		expect(head.body).toBe("");
	});

	it("a query string on / is ignored", () => {
		expect(reply("GET", "/?measure=tokens", OK_HOST, HTML).status).toBe(200);
	});

	it.each([
		"/index.html",
		"/favicon.ico",
		"/x",
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
		expect(reply("GET", url, OK_HOST, HTML)).toEqual({
			status: 404,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"content-length": String(Buffer.byteLength("Not found\n")),
				"cache-control": "no-store",
			},
			body: "Not found\n",
		});
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS", "PATCH"])(
		"%s / -> 405 with the allowed methods named",
		(method) => {
			const r = reply(method, "/", OK_HOST, HTML);
			expect(r.status).toBe(405);
			expect(r.headers.allow).toBe("GET, HEAD");
			expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
			expect(r.body).toBe("Method not allowed\n");
		},
	);

	it("an off-origin Host -> 403, before the method or path is even looked at", () => {
		const r = reply("POST", "/nowhere", "evil.example:54321", HTML);
		expect(r.status).toBe(403);
		expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
		expect(r.headers.allow).toBeUndefined();
		expect(r.body).toContain("localhost");
	});

	it("a missing Host -> 403", () => {
		expect(reply("GET", "/", undefined, HTML).status).toBe(403);
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

	async function start(
		port = 0,
		signals: EventEmitter = new EventEmitter(),
	): Promise<RunningServer> {
		const server = await startServer(HTML, {
			host: LOOPBACK_HOST,
			port,
			signals,
		});
		running.push(server);
		return server;
	}

	afterEach(async () => {
		await Promise.all(running.splice(0).map((s) => s.close()));
	});

	it("listens on 127.0.0.1 at an OS-chosen port and reports the exact URL", async () => {
		const server = await start();
		expect(server.port).toBeGreaterThan(0);
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
	});

	it("serves the html to a real fetch of the reported URL", async () => {
		const server = await start();
		const res = await fetch(server.url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("content-length")).toBe(HTML_BYTES);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toBe(HTML);
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
		const raw = await new Promise<string>((resolve, reject) => {
			const socket = netConnect(server.port, LOOPBACK_HOST, () => {
				socket.write("GET / HTTP/1.0\r\n\r\n");
			});
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
			startServer(HTML, {
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

	it("close() drops an idle keep-alive connection instead of waiting on it", async () => {
		const server = await start();
		const agent = new Agent({ keepAlive: true });
		try {
			const res = await new Promise<number>((resolve, reject) => {
				httpRequest({ host: LOOPBACK_HOST, port: server.port, agent }, (r) => {
					r.resume();
					r.on("end", () => resolve(r.statusCode as number));
				})
					.once("error", reject)
					.end();
			});
			expect(res).toBe(200);
			// Without closeAllConnections, server.close() would wait out the socket's
			// keep-alive idle timeout (5s by default) - well past this test's own limit.
			await server.close();
		} finally {
			agent.destroy();
		}
	}, 3000);

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
