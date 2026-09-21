// Specifies the browser opener without ever opening a browser: the command-building decision
// with plain (platform, url) inputs, `openBrowser`'s wiring through an injected launcher, and
// the real `spawnDetached` against a harmless real child (this test's own Node binary), plus a
// command that cannot exist. No vi.mock on node:child_process.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserOpenCommand, openBrowser, spawnDetached } from "./browser.js";

const URL_UNDER_TEST = "http://127.0.0.1:54321/";

describe("browserOpenCommand", () => {
	it("darwin -> open <url>", () => {
		expect(browserOpenCommand("darwin", URL_UNDER_TEST)).toEqual({
			command: "open",
			args: [URL_UNDER_TEST],
		});
	});

	it('win32 -> cmd /c start "" <url> (the empty argument is start\'s window title)', () => {
		expect(browserOpenCommand("win32", URL_UNDER_TEST)).toEqual({
			command: "cmd",
			args: ["/c", "start", "", URL_UNDER_TEST],
		});
	});

	it.each(["linux", "freebsd", "openbsd", "sunos", "aix", "android", "haiku"])(
		"%s -> xdg-open <url>",
		(platform) => {
			expect(browserOpenCommand(platform, URL_UNDER_TEST)).toEqual({
				command: "xdg-open",
				args: [URL_UNDER_TEST],
			});
		},
	);

	it("passes the url through untouched", () => {
		const url = "http://127.0.0.1:1/?a=1";
		expect(browserOpenCommand("darwin", url).args).toEqual([url]);
	});
});

describe("openBrowser", () => {
	it("hands the platform's command to the injected launcher and resolves with it", async () => {
		const calls: [string, string[]][] = [];
		await openBrowser(URL_UNDER_TEST, "linux", async (command, args) => {
			calls.push([command, args]);
		});
		expect(calls).toEqual([["xdg-open", [URL_UNDER_TEST]]]);
	});

	it("rejects with the launcher's own error, unchanged", async () => {
		const failure = new Error("no opener here");
		await expect(
			openBrowser(URL_UNDER_TEST, "darwin", () => Promise.reject(failure)),
		).rejects.toBe(failure);
	});
});

describe("spawnDetached", () => {
	let sandbox: string | undefined;

	afterEach(async () => {
		if (sandbox) await rm(sandbox, { recursive: true, force: true });
		sandbox = undefined;
	});

	it("resolves once a real child has started, and the child runs on its own", async () => {
		sandbox = await mkdtemp(join(tmpdir(), "my-usage-browser-"));
		const marker = join(sandbox, "marker.txt");
		await spawnDetached(process.execPath, [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], 'spawned')",
			marker,
		]);
		// spawnDetached resolves on the spawn event, before the child has done anything; the
		// detached, unref'd child then finishes on its own. Poll for its side effect.
		const deadline = Date.now() + 10_000;
		let content: string | undefined;
		while (content === undefined && Date.now() < deadline) {
			content = await readFile(marker, "utf8").catch(() => undefined);
			if (content === undefined) await new Promise((r) => setTimeout(r, 20));
		}
		expect(content).toBe("spawned");
	});

	it("rejects with ENOENT when the command does not exist, instead of crashing the process", async () => {
		const missing = `my-usage-no-such-opener-${randomBytes(6).toString("hex")}`;
		await expect(
			spawnDetached(missing, ["http://127.0.0.1:1/"]),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
