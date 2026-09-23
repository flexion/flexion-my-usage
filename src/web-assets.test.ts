// Loads real directories written to disk per test - the loader's whole job is filesystem I/O, so
// nothing here fakes node:fs.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFixtureDir } from "./__tests__/test-fixture-root.js";
import {
	contentTypeFor,
	loadStaticFiles,
	missingAssetsMessage,
	urlPathFor,
} from "./web-assets.js";

const FIXTURE_PARENT = fileURLToPath(
	new URL("../node_modules/.cache/my-usage-tests/web-assets/", import.meta.url),
);

const fixtureDir = makeFixtureDir(FIXTURE_PARENT);

describe("contentTypeFor", () => {
	it.each([
		["index.html", "text/html; charset=utf-8"],
		["assets/index-abc.js", "text/javascript; charset=utf-8"],
		["assets/index-abc.css", "text/css; charset=utf-8"],
		["data.json", "application/json; charset=utf-8"],
		["logo.svg", "image/svg+xml"],
		["logo.png", "image/png"],
		["favicon.ico", "image/x-icon"],
		["font.woff2", "font/woff2"],
		["robots.txt", "text/plain; charset=utf-8"],
		["INDEX.HTML", "text/html; charset=utf-8"],
		["assets/index-abc.js.map", "application/octet-stream"],
		["LICENSE", "application/octet-stream"],
	])("%s -> %s", (path, expected) => {
		expect(contentTypeFor(path)).toBe(expected);
	});
});

describe("urlPathFor", () => {
	it("is the path relative to the root, with a leading slash", () => {
		expect(urlPathFor("/pkg/dist/web", "/pkg/dist/web/index.html")).toBe(
			"/index.html",
		);
		expect(
			urlPathFor("/pkg/dist/web", join("/pkg/dist/web", "assets", "a.js")),
		).toBe("/assets/a.js");
	});
});

describe("loadStaticFiles", () => {
	it("loads every file, nested ones included, keyed by URL path with its content type", async () => {
		const dir = await fixtureDir();
		await mkdir(join(dir, "assets"));
		await writeFile(join(dir, "index.html"), "<!doctype html>");
		await writeFile(join(dir, "assets", "index-abc.js"), "export {};");
		await writeFile(join(dir, "assets", "index-abc.css"), "body{}");

		const files = await loadStaticFiles(dir);

		expect([...files.keys()]).toEqual([
			"/assets/index-abc.css",
			"/assets/index-abc.js",
			"/index.html",
		]);
		expect(files.get("/index.html")).toEqual({
			contentType: "text/html; charset=utf-8",
			body: Buffer.from("<!doctype html>"),
		});
		expect(files.get("/assets/index-abc.js")?.contentType).toBe(
			"text/javascript; charset=utf-8",
		);
	});

	it("rejects a directory with no top-level index.html, naming the remedy", async () => {
		const dir = await fixtureDir();
		await mkdir(join(dir, "nested"));
		await writeFile(join(dir, "nested", "index.html"), "<!doctype html>");
		await expect(loadStaticFiles(dir)).rejects.toThrow(
			missingAssetsMessage(dir),
		);
	});

	it("rejects a directory that doesn't exist with the same message, keeping the cause", async () => {
		const dir = join(await fixtureDir(), "never-built");
		await expect(loadStaticFiles(dir)).rejects.toMatchObject({
			message: missingAssetsMessage(dir),
			cause: { code: "ENOENT" },
		});
	});
});

describe("missingAssetsMessage", () => {
	it("names the directory and the command that fixes it", () => {
		expect(missingAssetsMessage("/pkg/dist/web")).toBe(
			"the dashboard's frontend build is missing (no index.html in /pkg/dist/web) - " +
				"run `yarn build` first",
		);
	});
});
