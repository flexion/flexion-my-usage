#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { openBrowser, spawnDetached } from "./browser.js";
import { runCli } from "./cli.js";
import { price } from "./pricing.js";
import { LOOPBACK_HOST, startServer } from "./server.js";
import { opencodeSource } from "./sources/opencode.js";
import { loadStaticFiles } from "./web-assets.js";

// Composition root, and nothing else: hands the real world - process, the opencode reader, the
// price table, the frontend build, a node:http server, a browser launcher - to runCli
// (src/cli.ts), which holds every decision and is covered at 100%. This file is excluded from
// the coverage gate as a humble object (vitest.config.ts) and scanned by scripts/branch-guard.ts
// to stay branch-free, so no if/&&/??/ternary belongs here: a new decision goes into cli.ts or a module it calls.
//
// runCli never rejects, and resolves once the server is listening (and the browser has been
// asked to open). The process then stays alive on the server's open handle until SIGINT or
// SIGTERM closes it (see server.ts), and exits with the code set here.
process.exitCode = await runCli(process.argv.slice(2), {
	nodeVersion: process.versions.node,
	discover: () => opencodeSource.discover(),
	read: (handle) => opencodeSource.read(handle),
	price: (rows, options) => price(rows, options),
	// dist/web/, next to this file once built (see vite.web.config.ts). Run from source (tsx on
	// src/index.ts) this would point at src/web/ - the frontend's unbuilt source, which a browser
	// can't run - so `yarn dev` builds and runs dist/ instead.
	loadAssets: () =>
		loadStaticFiles(fileURLToPath(new URL("web", import.meta.url))),
	serve: (site, port) =>
		startServer(site, { host: LOOPBACK_HOST, port, signals: process }),
	openBrowser: (url) => openBrowser(url, process.platform, spawnDetached),
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
});
