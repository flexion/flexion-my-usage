// End-to-end tests for scripts/clean-dist.mjs (bead myusage-4xu.20): `yarn build` runs this
// first so a stale dist/ from a previous build - e.g. a dist/aggregate.test.js left over from
// before tsconfig.build.json excluded test files - never survives into the next build. tsc only
// ever adds or overwrites what the current source produces; it never deletes what a prior build
// left behind and the current source no longer does, so without this step a developer keeps
// seeing doubled test counts (or a published package that still ships a file the source no
// longer has) until they manually `rm -rf dist`.
//
// Run as a real subprocess against a real fixture directory, the same reason
// src/check-package.integration.test.ts does: the point is to prove the script's actual I/O
// behavior, not just a mocked call to `rm`. Plain `node`, not tsx: clean-dist.mjs is plain JS
// with no TypeScript import to resolve, so there is nothing tsx's transform buys here and no
// reason to pay its startup cost.
//
// Deliberately does NOT shell out to a real `yarn build` (slow, and couples this test to tsc's
// own behavior, which is orthogonal to whether the clean step ran) - see
// scripts/package-rules.ts's tests for the same call on the build-vs-guard split.
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../scripts/clean-dist.mjs", import.meta.url),
);

const FIXTURE_BASE = fileURLToPath(
	new URL("../node_modules/.cache/my-usage-tests/clean-dist/", import.meta.url),
);

afterAll(async () => {
	await rm(FIXTURE_BASE, { recursive: true, force: true });
});

/** A fresh, isolated fixture directory under node_modules/.cache/, removed after the run. */
async function fixtureDir(): Promise<string> {
	await mkdir(FIXTURE_BASE, { recursive: true });
	return mkdtemp(`${FIXTURE_BASE}t-`);
}

function runCleanDist(cwd: string) {
	return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("scripts/clean-dist.mjs against a real dist/ on disk", () => {
	it("removes a stale dist/ left over from a previous build", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/old.test.js`, "console.log('stale');\n");
		// Two siblings of dist/, untouched by a correct clean - a file AND a directory - this
		// is what proves the script's blast radius stays scoped to dist/ instead of the whole
		// cwd. A file-only sibling would not catch a broken clean that over-broadly deletes
		// every top-level directory (not just dist/) while leaving files alone. The directory
		// sibling holds a real file, not just an empty directory: an empty directory can't
		// distinguish "sibling survives" from "sibling's subtree got recursively wiped", so a
		// mutation that empties a sibling's contents instead of leaving it alone would still
		// pass here otherwise. No { recursive: true } on this mkdir (unlike dist/'s, above) -
		// mkdtemp already created dir itself, so there's no missing parent to create.
		await writeFile(`${dir}/package.json`, "{}\n");
		await mkdir(`${dir}/src`);
		await writeFile(`${dir}/src/index.ts`, "export {};\n");

		const result = runCleanDist(dir);

		expect(result.status).toBe(0);
		expect(await exists(`${dir}/dist`)).toBe(false);
		expect(await exists(`${dir}/package.json`)).toBe(true);
		expect(await exists(`${dir}/src`)).toBe(true);
		expect(await exists(`${dir}/src/index.ts`)).toBe(true);
	});

	it("succeeds when dist/ does not exist yet (a first build)", async () => {
		const dir = await fixtureDir();

		const result = runCleanDist(dir);

		expect(result.status).toBe(0);
		expect(await exists(`${dir}/dist`)).toBe(false);
	});
});
