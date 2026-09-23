// End-to-end tests for scripts/check-branch-guard.mjs itself, run as a real subprocess against a
// real, on-disk scratch vitest.config.ts and scratch source tree (bead myusage-qx9).
//
// src/branch-guard.test.ts pins the pure decision logic with plain data, but nothing there
// proves check-branch-guard.mjs actually reads vitest.config.ts's real coverage.exclude, reads
// real files off disk, or exits with the right code. These tests close that gap: they run the
// unmodified script exactly as `yarn lint` does - via tsx - against a real scratch directory,
// the same split src/check-fixtures-guard.integration.test.ts already uses for check-fixtures-
// guard.mjs/fixtures-guard.ts.
//
// Each fixture supplies its OWN scratch vitest.config.ts: the driver resolves it against
// process.cwd() (see scripts/check-branch-guard.mjs's header for why), so spawning it with a
// scratch cwd is what lets these tests control which coverage.exclude entries - and so which
// files - it scans, without touching this repo's real vitest.config.ts. A scratch config only
// ever needs to be an object shaped like `{ test: { coverage: { exclude: [...] } } }`; nothing
// here calls vitest's own `defineConfig`, since the driver only ever reads that one property
// path.
//
// Spawned via tsx, not a bare `node`: check-branch-guard.mjs imports scripts/branch-guard.ts
// directly, and dynamically imports a scratch vitest.config.ts, both of which need TS/ESM
// handling plain node lacks by default.
//
// Fixtures live under node_modules/.cache/ (never the real home or the system temp dir) and are
// removed afterward, the same convention every other integration test in this repo uses.
//
// The fixture root is allocated per-run via `mkdtemp` (bead myusage-5vf), mirroring the fix for
// the identical race in src/check-package.integration.test.ts (bead myusage-4xu.114 - see that
// file's header comment for the full writeup, including why `mkdtemp` beats a process.pid
// namespace). A single fixed FIXTURE_BASE, shared by every process that runs this file against
// the same checkout, let one process's afterAll `rm` of that shared directory delete another
// concurrent process's still-in-flight fixtures mid-test - reproduced directly under concurrent
// `yarn vitest run` load before this fix.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-branch-guard.mjs", import.meta.url),
);

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

// Fixed parent directory, shared by every process that runs this file against this checkout.
// Never removed directly - only the per-run directory allocated inside it (see fixtureDir
// below) is ever passed to `rm`.
const FIXTURE_PARENT = fileURLToPath(
	new URL(
		"../node_modules/.cache/my-usage-tests/check-branch-guard/",
		import.meta.url,
	),
);

let fixtureRoot: string | undefined;

afterAll(async () => {
	if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

/** A fresh, isolated fixture directory under node_modules/.cache/, removed after the run. */
async function fixtureDir(): Promise<string> {
	if (!fixtureRoot) {
		await mkdir(FIXTURE_PARENT, { recursive: true });
		fixtureRoot = await mkdtemp(`${FIXTURE_PARENT}run-`);
	}
	return mkdtemp(`${fixtureRoot}/t-`);
}

/** Writes a minimal scratch vitest.config.ts to `dir`, holding only what the driver reads:
 * `test.coverage.exclude`. Real test-support globs are included alongside `humbleObjectPaths` so
 * these tests also prove the driver does not try to treat a glob entry as a literal file path. */
async function writeScratchConfig(
	dir: string,
	humbleObjectPaths: string[],
): Promise<void> {
	const exclude = JSON.stringify([
		"src/**/*.test.*",
		"src/**/*.fixtures.*",
		...humbleObjectPaths,
	]);
	await writeFile(
		`${dir}/vitest.config.ts`,
		`export default { test: { coverage: { exclude: ${exclude} } } };\n`,
	);
}

function runCheckBranchGuard(cwd: string) {
	return spawnSync(TSX, [SCRIPT], { cwd, encoding: "utf8" });
}

/** Writes `contents` to `path` (relative to `dir`), creating any parent directories (e.g.
 * `src/`) first - fixture paths in these tests are repo-relative like the real coverage.exclude
 * entries they stand in for, so most of them sit inside a src/ this scratch directory does not
 * start with. */
async function writeScratchFile(
	dir: string,
	path: string,
	contents: string,
): Promise<void> {
	const full = `${dir}/${path}`;
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, contents);
}

describe("scripts/check-branch-guard.mjs against a real scratch tree", () => {
	it("fails when a humble-object path listed in coverage.exclude has a banned if statement", async () => {
		const dir = await fixtureDir();
		await writeScratchConfig(dir, ["src/humble.ts"]);
		await writeScratchFile(
			dir,
			"src/humble.ts",
			"export function f(x: number): number {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n",
		);

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/humble\.ts:2 has a banned if construct/,
		);
	});

	it("passes for a clean humble-object file with no banned construct", async () => {
		const dir = await fixtureDir();
		await writeScratchConfig(dir, ["src/humble.ts"]);
		await writeScratchFile(
			dir,
			"src/humble.ts",
			"export interface Options {\n\ttimeout?: number;\n}\n",
		);

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/check-branch-guard: OK/);
		expect(result.stdout).toMatch(/src\/humble\.ts/);
	});

	it("does not try to scan the test-support glob entries as literal file paths", async () => {
		const dir = await fixtureDir();
		// No humble-object paths at all: coverage.exclude holds only the two test-support globs.
		// If the driver mistakenly treated "src/**/*.test.*" as a literal path, this would fail
		// with a missing-file error instead of passing with zero files scanned.
		await writeScratchConfig(dir, []);

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(
			/check-branch-guard: OK - 0 humble-object file\(s\) scanned/,
		);
	});

	it("fails with a clear error, not a raw stack trace, when a listed humble-object path does not exist on disk", async () => {
		const dir = await fixtureDir();
		await writeScratchConfig(dir, ["src/missing.ts"]);

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/missing\.ts is listed in vitest\.config\.ts's coverage\.exclude but does not exist on disk/,
		);
	});

	it("fails with a clear error, not a raw EISDIR stack trace, when a listed humble-object path is a directory (myusage-4xu.65: coverage.exclude's type guard forbids a glob but not a directory, so this is legal input the driver must still fail closed on cleanly)", async () => {
		const dir = await fixtureDir();
		await writeScratchConfig(dir, ["src/humble-dir"]);
		await mkdir(`${dir}/src/humble-dir`, { recursive: true });

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/humble-dir is listed in vitest\.config\.ts's coverage\.exclude but is a directory, not a file/,
		);
		expect(result.stderr).not.toMatch(/EISDIR/);
	});

	it("fails with a clear error when vitest.config.ts itself is missing from the current directory", async () => {
		const dir = await fixtureDir();

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/vitest\.config\.ts not found in the current directory/,
		);
	});

	it("scans every humble-object path coverage.exclude names, not just the first", async () => {
		const dir = await fixtureDir();
		await writeScratchConfig(dir, ["src/a.ts", "src/b.ts"]);
		await writeScratchFile(dir, "src/a.ts", "export const a = 1;\n");
		await writeScratchFile(
			dir,
			"src/b.ts",
			"export const b = (x: unknown) => x ?? 0;\n",
		);

		const result = runCheckBranchGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/src\/b\.ts:1 has a banned \?\? construct/);
	});
});
