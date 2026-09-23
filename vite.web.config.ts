// Builds the React page (src/web/, myusage-4xu.118) into dist/web/, which src/index.ts serves at
// runtime (see web-assets.ts). Named vite.web.config.ts, not vite.config.ts, so vitest keeps
// reading vitest.config.ts alone - a root vite.config.ts would be merged into the test config.
//
// react, react-dom and recharts are devDependencies on purpose: this build bundles them into
// dist/web/assets/, so the published package runs without them installed, and
// scripts/check-package.mjs fails the build if any dist/ file still imports one.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL("./src/web", import.meta.url)),
	// Served from the loopback server's root, never a subpath.
	base: "/",
	// No public/ directory: everything the page needs is imported from source.
	publicDir: false,
	build: {
		outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
		// outDir sits outside `root`, so vite won't clear it unless told to - and a stale hashed
		// bundle left behind would ship. scripts/clean-dist.mjs clears dist/ first anyway.
		emptyOutDir: true,
		sourcemap: false,
		reportCompressedSize: false,
		// React + recharts land around 600 kB minified, over vite's 500 kB default. Splitting
		// buys nothing for a page read once over loopback, so the limit moves instead.
		chunkSizeWarningLimit: 1024,
	},
});
