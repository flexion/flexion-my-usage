// Opening the served page in the user's default browser (myusage-4xu.7), split into two halves
// on purpose: `browserOpenCommand` is the pure decision - which program, with which arguments,
// on which platform - and `spawnDetached` is the one place that actually starts a process.
// Tests specify the decision with plain (platform, url) inputs, and prove the launcher against a
// real, harmless child (the running Node binary itself), never by launching a browser and never
// by mocking node:child_process.
import { spawn } from "node:child_process";

export interface Command {
	command: string;
	args: string[];
}

/**
 * The platform's own "open this URL with whatever handles it" helper. macOS ships `open`, Windows
 * reaches its handler through `cmd /c start`, and every other platform is assumed to follow the
 * freedesktop convention (`xdg-open`) - the same three-way split most CLI tools use.
 *
 * On Windows, `start`'s first quoted argument is the window title, so an empty one is passed
 * ahead of the URL - otherwise a URL in quotes would be taken as the title and nothing would
 * open. `start` runs through cmd, where `&` is a command separator; the URLs this program opens
 * are its own `http://127.0.0.1:<port>/`, which carries no such character, so no escaping is
 * done here (see server.ts for where that URL is built).
 */
export function browserOpenCommand(platform: string, url: string): Command {
	switch (platform) {
		case "darwin":
			return { command: "open", args: [url] };
		case "win32":
			return { command: "cmd", args: ["/c", "start", "", url] };
		default:
			return { command: "xdg-open", args: [url] };
	}
}

/** Starts `command` and resolves once it has spawned, or rejects when it can't be started. */
export type Launch = (command: string, args: string[]) => Promise<void>;

/**
 * The real launcher. Detached and with stdio ignored, so the helper runs in its own process
 * group: a Ctrl+C aimed at this server never reaches it (some `xdg-open` implementations block
 * until the browser exits), and its output never lands in this terminal. On Windows, `detached`
 * also means DETACHED_PROCESS, so `cmd` gets no console window of its own (`windowsHide` would
 * be ignored alongside that flag, per CreateProcess's documentation, so it isn't set). `unref()`
 * keeps the child from holding this process open - the HTTP server is what keeps it alive, not
 * the browser.
 *
 * Resolves on the child's `spawn` event and rejects on `error` (typically ENOENT: the helper
 * isn't installed, e.g. `xdg-open` on a headless Linux box). Without that `error` listener, a
 * missing helper would be an uncaught exception that crashes the whole process - and the server
 * with it - instead of a warning the caller can print alongside the URL.
 */
export function spawnDetached(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** Opens `url` in the default browser for `platform`, through `launch` (spawnDetached for real). */
export function openBrowser(
	url: string,
	platform: string,
	launch: Launch,
): Promise<void> {
	const { command, args } = browserOpenCommand(platform, url);
	return launch(command, args);
}
