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
//
// The fixture root is allocated per-run via `mkdtemp` (bead myusage-4xu.114) - see
// src/__tests__/test-fixture-root.ts for the canonical writeup of the cross-process race this avoids.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFixtureDir } from "./__tests__/test-fixture-root.js";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-package.mjs", import.meta.url),
);

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const FIXTURE_PARENT = fileURLToPath(
	new URL(
		"../node_modules/.cache/my-usage-tests/check-package/",
		import.meta.url,
	),
);

const fixtureDir = makeFixtureDir(FIXTURE_PARENT);

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

		// This fixture's `files` config also puts dist/index.test.js in the npm pack list, so
		// the pack-side scan (see "catches a test file present only in the npm pack list"
		// below) would ALSO exit 1 even if the dist/ scan were deleted outright. A bare status
		// check doesn't pin the dist/ scan specifically - assert its own message so deleting
		// that scan alone (leaving the pack-side scan intact) fails this test.
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/test or support files in dist\//);
	});

	it("catches a stale test file nested under a subdirectory of dist/", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist/sources`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/sources/lib.js`, "console.log(2);\n");
		await writeFile(
			`${dir}/dist/sources/lib.test.js`,
			"console.log('stale');\n",
		);
		await writeFixturePackageJson(dir, ["dist"]);

		const result = runCheckPackage(dir);

		// Every other dist/ fixture in this file is flat; the real dist/ is not (e.g.
		// dist/sources/), so this pins listFiles' recursion into subdirectories. npm's own
		// pack walk finds dist/sources/lib.test.js regardless of our recursion, so assert the
		// dist/-scan-specific message rather than just the exit status - otherwise this would
		// still pass if listFiles stopped recursing and only the pack-side scan caught it.
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/test or support files in dist\//);
	});

	it("catches a test file present only in the npm pack list, not in dist/", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(`${dir}/dist/lib.js`, "console.log(2);\n");
		await writeFile(`${dir}/helper.test.js`, "console.log('stale');\n");
		await writeFixturePackageJson(dir, ["dist", "helper.test.js"]);

		const result = runCheckPackage(dir);

		// helper.test.js never lands in dist/ - it is only caught because `files` puts it
		// straight in the npm pack list. No existing fixture exercises the pack-side scan
		// without the same file also present in dist/, so that branch's own logic was
		// unexercised. Assert its specific message so deleting that scan (leaving the dist/
		// scan intact) fails this test, since dist/ itself has no test file here.
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/test or support files in the npm package:/);
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
		expect(result.stderr).toMatch(/test or support files in dist\//);
	});

	it("catches a devDependency import shipped in dist/ under a name/location that dodges the name-based filters (myusage-4xu.119)", async () => {
		// TEST_OR_SUPPORT (".test."/".fixtures." in the basename) and TEST_OR_SUPPORT_DIR
		// (__tests__/__mocks__/fixtures directory segments) are both purely name/location
		// based - neither looks at a file's actual content. dist/config.js below has neither
		// shape (no ".test."/".fixtures." in its basename, no test-support directory
		// segment), so both existing filters wave it through clean even though its content
		// imports "vitest/config" - a real subpath of a package this fixture's own
		// package.json lists only in devDependencies, never in dependencies. This is the
		// exact real-world shape that surfaced this bead (myusage-4xu.116:
		// src/test-fixture-root.ts, before it was renamed/relocated to dodge these same two
		// filters, imported from "vitest" and would have shipped undetected).
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(
			`${dir}/dist/config.js`,
			'import { defineConfig } from "vitest/config";\nexport const config = defineConfig({});\n',
		);
		await writeFile(
			`${dir}/package.json`,
			JSON.stringify(
				{
					name: "check-package-fixture",
					version: "0.0.0",
					private: true,
					bin: "./dist/index.js",
					files: ["dist"],
					dependencies: {},
					devDependencies: { vitest: "5.0.1" },
				},
				null,
				2,
			),
		);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/devDependency/i);
		expect(result.stderr).toMatch(/move that package to "dependencies"/);
	});

	it("does not flag a real dependency import - the guard is data-driven from package.json, not a hardcoded package-name list", async () => {
		// Closes a gap the test above alone leaves open: it proves the guard catches a bad
		// import, but not that it's genuinely reading package.json's own dependencies/
		// devDependencies rather than, say, flagging any bare (non-relative, non-`node:`)
		// specifier regardless of what package.json says. dist/client.js here imports
		// "undici" - this repo's own real runtime dependency - while the fixture's
		// package.json also lists an unrelated devDependency (vitest), so a naive
		// "flag any bare import" implementation would wrongly fail this fixture too.
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(
			`${dir}/dist/client.js`,
			'import { request } from "undici";\nexport const client = request;\n',
		);
		await writeFile(
			`${dir}/package.json`,
			JSON.stringify(
				{
					name: "check-package-fixture",
					version: "0.0.0",
					private: true,
					bin: "./dist/index.js",
					files: ["dist"],
					dependencies: { undici: "8.10.2" },
					devDependencies: { vitest: "5.0.1" },
				},
				null,
				2,
			),
		);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(0);
	});

	it('flags a devDependency-only import even when the flagged package is not "vitest" - proves the guard reads package.json, not a fixed package-name list', async () => {
		// A hardcoded `const devOnlyPackages = ["vitest"]` in check-package.mjs would pass
		// every fixture above without ever reading package.json: each fixture above that
		// expects exit 1 happens to import "vitest", and the one negative-control fixture
		// above (the "does not flag a real dependency import" test) imports "undici" - a name
		// that hardcoded list was never going to flag either way, so it can't tell a real
		// package.json-driven implementation apart from a hardcoded one. This fixture closes
		// that gap: package.json's only devDependency is "undici" (no "vitest" anywhere, and
		// no "dependencies" key at all), and dist/ imports "undici" - so only an
		// implementation that actually reads package.json's own devDependencies can flag it.
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(
			`${dir}/dist/client.js`,
			'import { request } from "undici";\nexport const client = request;\n',
		);
		await writeFile(
			`${dir}/package.json`,
			JSON.stringify(
				{
					name: "check-package-fixture",
					version: "0.0.0",
					private: true,
					bin: "./dist/index.js",
					files: ["dist"],
					devDependencies: { undici: "1.0.0" },
				},
				null,
				2,
			),
		);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/devDependency/i);
	});

	it("does not re-flag a devDependency import in a file already caught by the test-or-support name check (myusage-4xu.129)", async () => {
		// distFiles.filter((path) => !inDist.includes(path)) (the comment right above it in
		// check-package.mjs: "Only scans files the test-or-support checks above didn't already
		// flag") is a deliberate dedup: a file check #3 (filterTestOrSupportPaths) already
		// flagged must not also be re-flagged by check #5's devDependency content scan, or the
		// same file would be reported twice for two different reasons. dist/x.test.js below is
		// built to trip both checks at once - its basename matches TEST_OR_SUPPORT (".test."),
		// so check #3 flags it, AND its content imports "vitest/config", a real subpath of this
		// fixture's only devDependency-only package, so check #5 would flag it too if it weren't
		// excluded from that scan's candidate list. Reproduced by hand against this exact
		// fixture with the dedup filter replaced by plain `distFiles`: dist/x.test.js then
		// appeared a second time, under "devDependency-only package(s) imported in dist/" as
		// well as "test or support files in dist/".
		//
		// This fixture's `files: ["dist"]` also puts dist/x.test.js in the npm pack list, so it
		// separately appears once more under "test or support files in the npm package:" - that
		// is check #4 (a different, legitimate check on a different input list), not the check
		// #3/#5 dedup this test pins, so it is not asserted against here.
		const dir = await fixtureDir();
		await mkdir(`${dir}/dist`, { recursive: true });
		await writeFile(`${dir}/dist/index.js`, "console.log(1);\n");
		await writeFile(
			`${dir}/dist/x.test.js`,
			'import { defineConfig } from "vitest/config";\nexport const x = defineConfig({});\n',
		);
		await writeFile(
			`${dir}/package.json`,
			JSON.stringify(
				{
					name: "check-package-fixture",
					version: "0.0.0",
					private: true,
					bin: "./dist/index.js",
					files: ["dist"],
					dependencies: {},
					devDependencies: { vitest: "5.0.1" },
				},
				null,
				2,
			),
		);

		const result = runCheckPackage(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/test or support files in dist\//);
		expect(result.stderr).not.toMatch(/devDependency-only package\(s\)/);
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
