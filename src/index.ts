#!/usr/bin/env node
import { openBrowser, spawnDetached } from "./browser.js";
import { runCli } from "./cli.js";
import { price } from "./pricing.js";
import { LOOPBACK_HOST, startServer } from "./server.js";
import { opencodeSource } from "./sources/opencode.js";

// Composition root, and nothing else: hands the real world - process, the opencode reader, the
// price table, a node:http server, a browser launcher - to runCli (src/cli.ts), which holds
// every decision and is covered at 100%. This file is excluded from the coverage gate as a
// humble object (vitest.config.ts) and scanned by scripts/branch-guard.ts to stay branch-free,
// so no if/&&/??/ternary belongs here: a new decision goes into cli.ts or a module it calls.
//
// runCli never rejects, and resolves once the server is listening (and the browser has been
// asked to open). The process then stays alive on the server's open handle until SIGINT or
// SIGTERM closes it (see server.ts), and exits with the code set here.
process.exitCode = await runCli(process.argv.slice(2), {
	nodeVersion: process.versions.node,
	discover: () => opencodeSource.discover(),
	read: (handle) => opencodeSource.read(handle),
	price: (rows, options) => price(rows, options),
	serve: (html, port) =>
		startServer(html, { host: LOOPBACK_HOST, port, signals: process }),
	openBrowser: (url) => openBrowser(url, process.platform, spawnDetached),
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
});
