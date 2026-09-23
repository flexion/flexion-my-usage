// End-to-end tests for scripts/check-renovate-engines.mjs itself, run as a real subprocess
// against real, on-disk scratch package.json/renovate.json fixtures (bead myusage-4xu.85).
//
// src/renovate-engines-guard.test.ts pins the pure decision logic with plain data, but nothing
// there proves check-renovate-engines.mjs actually reads real package.json/renovate.json files,
// calls that module, or exits with the right code. These tests close that gap: they run the
// unmodified script exactly as `yarn lint` does - via tsx - against a real scratch directory, the
// same split src/check-branch-guard.integration.test.ts already uses for check-branch-
// guard.mjs/branch-guard.ts.
//
// Each fixture supplies its OWN scratch package.json and renovate.json: the driver resolves both
// against process.cwd() (see scripts/check-renovate-engines.mjs), so spawning it with a scratch
// cwd is what lets these tests control the floor/ceiling values it compares, without touching
// this repo's real package.json or renovate.json.
//
// Spawned via tsx, not a bare `node`: check-renovate-engines.mjs imports scripts/renovate-
// engines-guard.ts directly, which needs TS handling plain node lacks by default.
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
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-renovate-engines.mjs", import.meta.url),
);

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

// Fixed parent directory, shared by every process that runs this file against this checkout.
// Never removed directly - only the per-run directory allocated inside it (see fixtureDir
// below) is ever passed to `rm`.
const FIXTURE_PARENT = fileURLToPath(
	new URL(
		"../node_modules/.cache/my-usage-tests/check-renovate-engines/",
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

/** Writes a minimal scratch package.json holding only what the driver reads: engines.node. */
async function writePackageJson(
	dir: string,
	enginesNode: string,
): Promise<void> {
	await writeFile(
		`${dir}/package.json`,
		JSON.stringify({ engines: { node: enginesNode } }),
	);
}

/** Writes a minimal scratch renovate.json holding only what the driver reads: a packageRules
 * entry matching @types/node with the given allowedVersions ceiling. */
async function writeRenovateJson(
	dir: string,
	allowedVersions: string,
): Promise<void> {
	await writeFile(
		`${dir}/renovate.json`,
		JSON.stringify({
			packageRules: [
				{
					matchManagers: ["npm"],
					matchPackageNames: ["@types/node"],
					allowedVersions,
				},
			],
		}),
	);
}

function runCheckRenovateEngines(cwd: string) {
	return spawnSync(TSX, [SCRIPT], { cwd, encoding: "utf8" });
}

describe("scripts/check-renovate-engines.mjs against a real scratch tree", () => {
	it("passes when the ceiling matches the floor's next minor line", async () => {
		const dir = await fixtureDir();
		await writePackageJson(dir, ">=22.13.0");
		await writeRenovateJson(dir, "<22.14.0");

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/check-renovate-engines: OK/);
	});

	it("fails when engines.node is bumped without updating renovate.json's ceiling - the deliberately-introduced mismatch the acceptance criteria calls for", async () => {
		const dir = await fixtureDir();
		await writePackageJson(dir, ">=22.15.0");
		await writeRenovateJson(dir, "<22.14.0");

		const result = runCheckRenovateEngines(dir);

		// Reproduced directly against the pre-fix state (no check-renovate-engines.mjs at all):
		// this exact fixture would leave `yarn lint` exiting 0, silently, forever rejecting every
		// valid @types/node update once the real floor moved this way.
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/check-renovate-engines: FAILED/);
		expect(result.stderr).toMatch(/22\.15\.0/);
		expect(result.stderr).toMatch(/<22\.14\.0/);
		expect(result.stderr).toMatch(/<22\.16\.0/);
	});

	it("fails with a clear message when renovate.json has no @types/node rule", async () => {
		const dir = await fixtureDir();
		await writePackageJson(dir, ">=22.13.0");
		await writeFile(
			`${dir}/renovate.json`,
			JSON.stringify({ packageRules: [] }),
		);

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/no packageRules entry/);
	});

	// myusage-4xu.91: the "no @types/node rule" case above never approaches a raw-stack-trace
	// path at all - `{packageRules: []}` is well-formed JSON that just fails
	// checkRenovateEnginesGuard's own missing-rule check. Malformed JSON is the input that
	// actually WOULD surface a raw SyntaxError stack trace if check-renovate-engines.mjs didn't
	// catch it (see that script's readJson helper) - these are the tests that genuinely exercise
	// that path, the same way check-branch-guard.integration.test.ts's own "not a raw stack trace"
	// tests do for a missing/directory humble-object path.
	it("fails with a clear message, not a raw stack trace, when renovate.json is not valid JSON", async () => {
		const dir = await fixtureDir();
		await writePackageJson(dir, ">=22.13.0");
		await writeFile(`${dir}/renovate.json`, "{not valid json");

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/check-renovate-engines: renovate\.json is not valid JSON/,
		);
		expect(result.stderr).not.toMatch(/^\s+at /m);
		expect(result.stderr).not.toMatch(/Node\.js v\d/);
	});

	// A BOM-prefixed package.json (a stray leading U+FEFF byte, which some Windows editors write
	// unprompted) is the malformed-package.json case that DOES reach this script's own readJson:
	// tsx/Node's own loader tolerates a leading BOM when resolving cwd's package.json for module
	// resolution, but JSON.parse rejects it outright - reproduced directly against the unfixed
	// driver, confirming a raw SyntaxError stack trace before this fix, and a clean message after.
	// A more severely broken package.json (e.g. truncated JSON) is intercepted by Node's own
	// loader before this script's code ever runs, with its own raw, Node-version-specific stack
	// trace this driver cannot intercept either way - that case is deliberately not tested here:
	// pinning that shape would make this suite's outcome depend on which Node version runs it,
	// the same runtime-independence AGENTS.md's "Coverage must not depend on the runtime" rule
	// asks for from coverage, applied here to a test that would have the identical problem.
	it("fails with a clear message, not a raw stack trace, when package.json has a leading BOM that JSON.parse rejects but Node's own loader tolerates", async () => {
		const dir = await fixtureDir();
		await writeFile(
			`${dir}/package.json`,
			`\ufeff${JSON.stringify({ engines: { node: ">=22.13.0" } })}`,
		);
		await writeRenovateJson(dir, "<22.14.0");

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/check-renovate-engines: package\.json is not valid JSON/,
		);
		expect(result.stderr).not.toMatch(/^\s+at /m);
		expect(result.stderr).not.toMatch(/Node\.js v\d/);
	});

	it("fails with a clear error when package.json is missing from the current directory", async () => {
		const dir = await fixtureDir();
		await writeRenovateJson(dir, "<22.14.0");

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/package\.json not found in the current directory/,
		);
	});

	it("fails with a clear error when renovate.json is missing from the current directory", async () => {
		const dir = await fixtureDir();
		await writePackageJson(dir, ">=22.13.0");

		const result = runCheckRenovateEngines(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/renovate\.json not found in the current directory/,
		);
	});
});
