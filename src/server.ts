// The local HTTP server that serves the rendered dashboard (myusage-4xu.7). renderHtml() already
// returns one complete document with every style and script inline, so this is a single-route
// server, not a static-file one: GET / returns that string, and nothing else is served.
//
// Two halves, like browser.ts: `reply` is the pure routing decision (method, path and Host header
// in; status, headers and body out), specified with plain strings, and `startServer` is the
// node:http adapter around it, proven by starting a real server on an ephemeral port and making
// real requests against it - never by mocking createServer.
//
// Design calls (see the PR that landed this for the fuller rationale):
// - Bind 127.0.0.1 only (LOOPBACK_HOST), never 0.0.0.0 and never the name "localhost": the name
//   can resolve to ::1 on one side and 127.0.0.1 on the other, and the URL printed and opened is
//   the exact literal that was bound.
// - Port 0 by default (the OS picks a free ephemeral port), so the default path can never hit
//   EADDRINUSE and needs no retry loop; an explicit --port is honored as given and a conflict on
//   it is an error with the remedy in the message, not a silent move to a different port.
// - The server keeps running until it is told to stop: this is a one-shot CLI, but the page is
//   served from this process, and there is no way to know when the browser is "done" with it
//   (a reload, a second tab, or a bookmark all need it up). SIGINT/SIGTERM close it cleanly and
//   let the process exit through the event loop draining, with whatever exit code the CLI set.
// - A Host-header check (see `isLoopbackHost`) so a page on another origin can't read this one
//   through DNS rebinding: a browser always sends the Host it dialed, and only the loopback names
//   this server can legitimately be reached by are accepted.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const LOOPBACK_HOST = "127.0.0.1";

export interface Reply {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/**
 * Whether a request's Host header names this machine's loopback interface. The port is ignored:
 * it's whatever the OS handed out, and a bracketed IPv6 literal carries its own colons, so only
 * the part before the last ":" (or the whole bracketed literal) is compared. A missing header
 * (HTTP/1.0 allows one) is refused: every browser sends the Host it dialed, and a request
 * without one has nothing to prove it was aimed at this server.
 */
export function isLoopbackHost(host: string | undefined): boolean {
	if (host === undefined) return false;
	const name = host.startsWith("[")
		? host.slice(0, host.indexOf("]") + 1)
		: host.replace(/:\d*$/, "");
	return name === LOOPBACK_HOST || name === "localhost" || name === "[::1]";
}

const NOT_FOUND = "Not found\n";
const FORBIDDEN =
	"Forbidden: this server only answers requests addressed to localhost\n";
const METHOD_NOT_ALLOWED = "Method not allowed\n";

function textReply(
	status: number,
	body: string,
	extra: Record<string, string>,
): Reply {
	return {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"content-length": String(Buffer.byteLength(body)),
			"cache-control": "no-store",
			...extra,
		},
		body,
	};
}

/**
 * The response for one request. Checks run in the order a client would want to hear about
 * them: an off-origin Host is refused outright (403) before anything else is looked at, then
 * the method (405, with the allowed ones named), then the path (404 for anything but "/",
 * query string ignored). A HEAD for "/" carries the same headers as the GET - including the
 * full content-length - and an empty body.
 */
export function reply(
	method: string,
	url: string,
	host: string | undefined,
	html: string,
): Reply {
	if (!isLoopbackHost(host)) return textReply(403, FORBIDDEN, {});
	if (method !== "GET" && method !== "HEAD") {
		return textReply(405, METHOD_NOT_ALLOWED, { allow: "GET, HEAD" });
	}
	// The request target must be exactly "/" once any query string is dropped. Deliberately not
	// `new URL(url, base).pathname`: Node's parser hands over targets the URL parser refuses
	// ("//", "///", "http://", "/\\" - all reachable from any web page via an <img src> aimed at
	// this loopback address, since that sends the loopback Host the check above accepts), and a
	// throw here would escape the request handler as an uncaught exception and kill the whole
	// process. Every browser normalizes "/./" and friends before sending, so exact-match loses
	// nothing a real client relies on.
	if (url.replace(/\?.*$/s, "") !== "/") return textReply(404, NOT_FOUND, {});
	return {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-length": String(Buffer.byteLength(html)),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
		body: method === "HEAD" ? "" : html,
	};
}

export type StopSignal = "SIGINT" | "SIGTERM";

/**
 * Where SIGINT/SIGTERM arrive: `process` in the real wiring, a fresh EventEmitter in tests (so
 * a test can "press Ctrl+C" by emitting the event, without signalling its own process). Only
 * the two methods the server uses, so both satisfy it structurally.
 */
export interface StopSignals {
	once(event: StopSignal, listener: () => void): unknown;
	off(event: StopSignal, listener: () => void): unknown;
}

export interface ServerOptions {
	host: string;
	/** 0 lets the OS pick a free port. */
	port: number;
	signals: StopSignals;
}

export interface RunningServer {
	/** The exact URL to open: the literal host that was bound, the port the OS or user gave. */
	url: string;
	port: number;
	/**
	 * Stops accepting connections and drops the open ones, then resolves once the listener is
	 * closed. An idle keep-alive connection - one that already finished a request - closes on
	 * its own on every Node version this supports (>=22.13.0). What this actually forces shut is
	 * a connection the client is still holding open without a finished response: a request
	 * received but not yet finished on any version, or - on Node versions before 26, measured
	 * directly on the 22.13.0 floor - even one that was accepted but never sent anything at all
	 * (a browser's speculative preconnect, say). Without this call, close() would wait on that
	 * connection instead of ending it. Idempotent: a second call just returns the same `closed`
	 * promise.
	 */
	close(): Promise<void>;
	/** Resolves once the server has stopped, whether through close() or a stop signal. */
	closed: Promise<void>;
}

/** The message for a port the user asked for that something else already holds. */
export function portInUseMessage(host: string, port: number): string {
	return (
		`port ${port} is already in use on ${host} - pick another with --port <n>, ` +
		"or leave --port off to let the OS choose a free one"
	);
}

/**
 * Starts serving `html` at `http://<host>:<port>/`. Resolves once the server is listening,
 * with the real port; rejects when it can't listen (an explicit port already in use is rewritten
 * to name the remedy, every other listen error surfaces as-is).
 */
export function startServer(
	html: string,
	options: ServerOptions,
): Promise<RunningServer> {
	const { host, port, signals } = options;
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			// method and url are always set on a server-side request; IncomingMessage types them
			// optional only because the same class is the client-side response object, where
			// neither exists. The casts state that instead of adding a fallback no request can
			// ever take.
			const r = reply(
				req.method as string,
				req.url as string,
				req.headers.host,
				html,
			);
			res.writeHead(r.status, r.headers);
			res.end(r.body);
		});

		// `on`, not `once`: before listen succeeds this rejects; after it, `reject` is a no-op,
		// and the listener stays registered so a later server-level error (an accept() failure
		// such as EMFILE - rare, and not something this process can act on) can never surface as
		// an unhandled "error" event that throws and takes the dashboard down.
		server.on("error", (error: Error) => {
			const code = (error as NodeJS.ErrnoException).code;
			reject(
				code === "EADDRINUSE"
					? new Error(portInUseMessage(host, port), { cause: error })
					: error,
			);
		});

		// Resolved by the server's own "close" event, so close() below and a stop signal share
		// one source of truth for "stopped" instead of each tracking it separately.
		const closed = new Promise<void>((done) => {
			server.once("close", () => done());
		});

		let closing = false;
		const close = (): Promise<void> => {
			if (!closing) {
				closing = true;
				signals.off("SIGINT", stop);
				signals.off("SIGTERM", stop);
				server.closeAllConnections();
				server.close();
			}
			return closed;
		};
		const stop = (): void => {
			void close();
		};

		server.listen(port, host, () => {
			// A listening TCP server's address() is always an AddressInfo; the string form is
			// for pipe/UNIX-socket servers, and null only before listen or after close.
			const { port: boundPort } = server.address() as AddressInfo;
			signals.once("SIGINT", stop);
			signals.once("SIGTERM", stop);
			resolve({
				url: `http://${host}:${boundPort}/`,
				port: boundPort,
				close,
				closed,
			});
		});
	});
}
