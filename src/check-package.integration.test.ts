// End-to-end tests for scripts/check-package.mjs itself, run as a real subprocess against a
// real (fixture) dist/ tree and a real `npm pack --dry-run` (bead myusage-4xu.19).
//
// src/package-rules.test.ts pins the pure decision logic with plain data, but nothing there
// proves check-package.mjs actually calls it. These tests close that gap: they run the
// unmodified script exactly as `yarn check:package` does - via tsx, minus the `tsc` build
// step, which is orthogonal to this guard's decisions, so each fixture supplies its own
// already-built dist/ - so a change that leaves the script's real behavior unfixed fails here
// even if every pure-function test in isolation passes.
//
// Spawned via tsx, not a bare `node`: check-package.mjs imports scripts/package-rules.ts
// directly (see that script's header comment for why), so plain `node` cannot run it without
// relying on Node's experimental, version-dependent type stripping - the same thing
// package.json's check:package script avoids. This mirrors the real invocation exactly.
//
// Fixtures live under node_modules/.cache/ (never the real home or the system temp dir) and
// are removed afterward. `npm pack --dry-run --json --ignore-scripts` never touches the
// network: verified locally (npm 11.19.1) against an isolated fixture directory with no
// registry reachable.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-package.mjs", import.meta.url),
);

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const FIXTURE_BASE = fileURLToPath(
	new URL(
		"../node_modules/.cache/my-usage-tests/check-package/",
		import.meta.url,
	),
);

afterAll(async () => {
	await rm(FIXTURE_BASE, { recursive: true, force: true });
});

/** A fresh, isolated fixture directory under node_modules/.cache/, removed after the run. */
async function fixtureDir(): Promise<string> {
	await mkdir(FIXTURE_BASE, { recursive: true });
	return mkdtemp(`${FIXTURE_BASE}t-`);
}

/** A minimal package.json shaped like this repo's real one: a bin target under dist/. */
async function writeFixturePackageJson(
	dir: string,
	files: string[],
): Promise<void> {
	await writeFile(
		`${dir}/package.json`,
		JSON.stringify(
			{
				name: "check-package-fixture",
				version: "0.0.0",
				private: true,
				bin: "./dist/index.js",
				files,
			},
			null,
			2,
		),
	);
}

function runCheckPackage(cwd: string) {
	// check-package.mjs shells out to `npm pack`, which by default reads config from the
	// real $HOME (~/.npmrc, its cache). Redirect it into the fixture directory itself so
	// the subprocess never resolves the real home, matching every other test in this repo
	// that could touch a home or XDG path.
	const fakeHome = `${cwd}/.fake-home`;
	return spawnSync(TSX, [SCRIPT], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: fakeHome,
			USERPROFILE: fakeHome,
			XDG_CACHE_HOME: `${fakeHome}/.cache`,
			XDG_DATA_HOME: `${fakeHome}/.local/share`,
			npm_config_userconfig: `${fakeHome}/.npmrc`,
		},
	});
}

describe("scripts/check-package.mjs against a real dist/ and a real npm pack", () => {
	it("fails when `files` excludes dist/ but npm still ships the bin target", async () => {
		// npm always packs the file `bin` points to, regardless of `files` - so a `files`
		// list that excludes dist/ still yields one dist/ entry in the pack list. The old
		// vacuity check only asked "is the pack list missing dist/ entirely", which this
		// satisfies; the guard must instead notice the pack list covers only 1 of the 2
		// real dist/ files. Reproduced directly against the unmodified script: it exits 0
		// (wrongly) on exactly this fixture.
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/lib.js`, "console.log(2);\n");
		await writeFile(`${dir}/README.md`, "# fixture\n");
		await writeFixturePackageJson(dir, ["README.md"]);

		const result = runCheckPackage(dir);

		// Exit 2 is emitted from four distinct spots in check-package.mjs (npm pack
		// failure, dist/ missing, dist/ empty, and this pack-list-vacuity guard), so a bare
		// status check alone does not prove THIS guard is what fired - a regression that
		// broke this check but let a different exit-2 path fire earlier would still pass.
		// Pin the message this guard specifically emits.
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/lists only \d+ of \d+ dist\/ files/);
	});

	it("passes when the pack list covers every real dist/ file", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/lib.js`, "console.log(2);\n");
		await writeFixturePackageJson(dir, ["dist"]);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(0);
	});

	it("still fails, for the separate and already-correct reason, on a stale test file left in dist/", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/index.test.js`, "console.log('stale');\n");
		await writeFixturePackageJson(dir, ["dist"]);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(1);
	});

	it("still fails, for the separate and already-correct reason, on a file left under a stale dist/__mocks__/ directory", async () => {
		// bead myusage-4xu.20: tsconfig.build.json now excludes __mocks__/** from a real
		// build, but this guard is the backstop for a file that reaches dist/ some other
		// way (a stale build predating that exclude, for one) - and its own basename
		// ("x.js") would never trip the old name-pattern check on its own. Reproduced
		// directly against the pre-fix script: it exits 0, because neither the basename
		// pattern nor anything else noticed the __mocks__/ directory.
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await mkdir(`${dir}/dist/__mocks__`, { recursive: true });
		await writeFile(`${dir}/dist/__mocks__/x.js`, "export const x = 1;\n");
		await writeFixturePackageJson(dir, ["dist"]);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(1);
	});

	it("does not false-accuse `files` of excluding dist/ over a stray dist/.DS_Store", async () => {
		// npm never packs .DS_Store - it is on npm's own always-ignored list, regardless of
		// `files`. Reproduced directly against the pre-fix script: with a correct
		// `files: ["dist"]` and this exact fixture, it exited 2, falsely claiming `files`
		// excludes dist/, because the raw on-disk dist/ count (3, including the junk file)
		// never matched npm's pack-list count (2, since npm dropped the junk on its own).
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/lib.js`, "console.log(2);\n");
		await writeFile(
			`${dir}/dist/.DS_Store`,
			"not a real .DS_Store, just junk\n",
		);
		await writeFixturePackageJson(dir, ["dist"]);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(0);
	});
});
