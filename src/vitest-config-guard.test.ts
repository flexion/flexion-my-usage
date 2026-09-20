// myusage-c2a: the independent reviewer of PR #9 (myusage-2xv) found that `satisfies
// CoverageGate` in vitest.config.ts type-checks the four threshold VALUES by name, but says
// nothing about the shape of coverage.exclude/coverage.include. Confirmed by hand before
// writing these tests: planting a throwaway wildcard in `exclude` (e.g. "src/**/*.ts") or
// narrowing `include` to a single file both compile clean today under `tsc -p
// tsconfig.config.json` (the exact command `yarn typecheck` runs for this file) and both
// genuinely hollow the 100%-per-file coverage gate at runtime - `yarn test` would exit 0
// having checked almost nothing.
//
// These tests run that real command against a real, on-disk variant of vitest.config.ts,
// so they prove the actual `yarn typecheck` behavior rather than assuming how the eventual
// guard gets implemented (a named type, a typed helper, or a lint rule are all fair game -
// the acceptance criteria is "fails yarn typecheck or yarn lint", not a particular
// mechanism). Each variant is a copy of the repo's real tsconfig.json + tsconfig.config.json
// (unmodified) plus a text-mutated copy of the real vitest.config.ts, written into its own
// throwaway directory under node_modules/.cache so module resolution for "vitest/config" and
// "@types/node" still finds this checkout's node_modules by walking up parent directories -
// the same fixture convention src/sources/opencode.test.ts already uses.
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_ROOT = join(
	REPO_ROOT,
	"node_modules",
	".cache",
	"my-usage-tests",
);
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

let sandboxes: string[] = [];

afterEach(async () => {
	for (const dir of sandboxes) {
		await rm(dir, { recursive: true, force: true });
	}
	sandboxes = [];
});

async function sandbox(): Promise<string> {
	await mkdir(FIXTURE_ROOT, { recursive: true });
	const dir = await mkdtemp(join(FIXTURE_ROOT, "vitest-config-guard-"));
	sandboxes.push(dir);
	return dir;
}

/** A throwaway tsc project: the real tsconfigs, unmodified, plus the given config source. */
async function typecheckProjectWith(
	vitestConfigSource: string,
): Promise<string> {
	const dir = await sandbox();
	copyFileSync(join(REPO_ROOT, "tsconfig.json"), join(dir, "tsconfig.json"));
	copyFileSync(
		join(REPO_ROOT, "tsconfig.config.json"),
		join(dir, "tsconfig.config.json"),
	);
	await writeFile(join(dir, "vitest.config.ts"), vitestConfigSource);
	return dir;
}

/** Runs the exact command `yarn typecheck` runs for vitest.config.ts. */
function runTypecheck(dir: string) {
	return spawnSync(process.execPath, [TSC_BIN, "-p", "tsconfig.config.json"], {
		cwd: dir,
		encoding: "utf8",
	});
}

async function realConfigSource(): Promise<string> {
	return readFile(join(REPO_ROOT, "vitest.config.ts"), "utf8");
}

/** Replaces the one occurrence of `marker`; fails loudly if the real file no longer has it,
 * or now has it more than once, instead of silently mutating the wrong spot or nothing. */
function replaceOnce(
	source: string,
	marker: string,
	replacement: string,
): string {
	expect(source.split(marker)).toHaveLength(2);
	return source.replace(marker, replacement);
}

describe("vitest.config.ts: coverage.exclude/coverage.include stay explicit", () => {
	it("lets the real, unmodified config through cleanly", async () => {
		const dir = await typecheckProjectWith(await realConfigSource());

		const result = runTypecheck(dir);

		expect(result.status).toBe(0);
	});

	it("fails typecheck when a wildcard is grafted into coverage.exclude", async () => {
		const mutated = replaceOnce(
			await realConfigSource(),
			'"src/sources/types.ts", // type-only: compiles to no runtime code',
			'"src/sources/types.ts", // type-only: compiles to no runtime code\n' +
				'\t\t\t\t"src/**/*.ts", // THROWAWAY WILDCARD planted by this test, never a real entry',
		);
		const dir = await typecheckProjectWith(mutated);

		const result = runTypecheck(dir);

		expect(result.status).not.toBe(0);
		expect(result.stdout + result.stderr).not.toBe("");
	});

	it("fails typecheck when coverage.include is narrowed to a single file", async () => {
		const mutated = replaceOnce(
			await realConfigSource(),
			'include: ["src/**/*.ts"],',
			'include: ["src/index.ts"],',
		);
		const dir = await typecheckProjectWith(mutated);

		const result = runTypecheck(dir);

		expect(result.status).not.toBe(0);
		expect(result.stdout + result.stderr).not.toBe("");
	});
});
