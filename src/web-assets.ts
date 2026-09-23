// Loads the frontend build (vite's output, dist/web/ in the published package - see
// vite.web.config.ts) into memory once at startup, keyed by the URL path server.ts looks each
// file up under (myusage-4xu.118). Reading everything up front keeps the request path free of
// filesystem access entirely, and the whole build is a few hundred kilobytes.
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { INDEX_PATH, type StaticFile } from "./server.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

/** The content type for a file by extension (case-insensitive); unknown ones are opaque bytes. */
export function contentTypeFor(path: string): string {
	return (
		CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
	);
}

/** The URL path a file under `root` is served at: "/" plus its relative path, "/"-separated. */
export function urlPathFor(root: string, file: string): string {
	return `/${relative(root, file).split(sep).join("/")}`;
}

/** Printed when `dir` holds no index.html: almost always a source checkout that skipped the build. */
export function missingAssetsMessage(dir: string): string {
	return (
		`the dashboard's frontend build is missing (no index.html in ${dir}) - ` +
		"run `yarn build` first"
	);
}

/**
 * Every file under `dir`, recursively, keyed by URL path. Rejects when `dir` doesn't exist or
 * has no top-level index.html, with missingAssetsMessage either way: a page with no entry
 * point can't render anything, so failing at startup beats serving a server that 404s "/".
 */
export async function loadStaticFiles(
	dir: string,
): Promise<Map<string, StaticFile>> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { recursive: true, withFileTypes: true });
	} catch (error) {
		throw new Error(missingAssetsMessage(dir), { cause: error });
	}
	const paths = entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	const files = new Map<string, StaticFile>();
	for (const path of paths) {
		files.set(urlPathFor(dir, path), {
			contentType: contentTypeFor(path),
			body: await readFile(path),
		});
	}
	if (!files.has(INDEX_PATH)) throw new Error(missingAssetsMessage(dir));
	return files;
}
