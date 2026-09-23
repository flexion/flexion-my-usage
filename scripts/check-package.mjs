// Guard: the built output and the published npm package must not ship test or
// test-support files.
//
// The pack-list vacuity check, the separator-safe dist-prefix check, and the test-or-support
// name pattern live in scripts/package-rules.ts (bead myusage-4xu.19), next to this script,
// not under src/: this is build-time-only tooling, and anything under src/ is what `yarn
// build` emits into dist/ - a checker that lived under src/ would ship itself inside the
// package it checks (round-2 review caught exactly that). scripts/package-rules.ts is still
// type-checked by `yarn typecheck` and covered at 100% by `yarn test` - see its header comment
// for how, given it now sits outside src/'s rootDir. This script wires that pure logic to real
// I/O: a real dist/ tree and a real `npm pack --dry-run`.
//
// `yarn check:package` runs it as `yarn build && tsx scripts/check-package.mjs`: tsx (not a
// bare `node`, and not Node's --experimental-strip-types - see package-rules.test.ts for why)
// lets this script import package-rules.ts directly, without needing `yarn build` to run first
// for THIS import. The build still runs first because the checks below assert against real
// build output, not because the import needs it.
//
// Asserts:
//   1. dist/ exists and is non-empty, so the checks below cannot pass vacuously.
//   2. The npm pack file list accounts for at least as many dist/ entries as dist/ actually
//      holds (after discounting npm's own always-ignored junk, e.g. .DS_Store - see
//      package-rules.ts's NPM_ALWAYS_IGNORED), so a `files` list that excludes dist/ cannot
//      pass just because npm always packs the `bin` target regardless of `files`.
//   3. No test or support file exists anywhere under dist/.
//   4. No test or support file appears in the `npm pack --dry-run` file list.
//   5. No dist/ file that isn't already caught by #3 imports a package.json `devDependencies`-
//      only package (bead myusage-4xu.119) - a name/location-based filter alone misses a
//      differently-named file under src/ that imports a devDependency, the exact real-world gap
//      myusage-4xu.116 found (see package-rules.ts's own header comment on this).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DIST,
	devDependencyOnlyPackages,
	filterTestOrSupportPaths,
	findDevOnlyImports,
	packListCoversDist,
} from "./package-rules.ts";

function listFiles(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listFiles(path));
		else found.push(path);
	}
	return found;
}

function packedFiles() {
	let out;
	try {
		out = execSync("npm pack --dry-run --json --ignore-scripts", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		console.error("check-package: `npm pack --dry-run` failed");
		console.error(String(err.stderr ?? err.message));
		process.exit(2);
	}
	return JSON.parse(out)[0].files.map((f) => f.path);
}

const problems = [];

if (!existsSync(DIST)) {
	console.error(`check-package: ${DIST}/ not found - build first (yarn build)`);
	process.exit(2);
}

const distFiles = listFiles(DIST);
if (distFiles.length === 0) {
	console.error(`check-package: ${DIST}/ is empty - nothing to check`);
	process.exit(2);
}

const packed = packedFiles();
const coverage = packListCoversDist(distFiles, packed);
if (!coverage.covered) {
	console.error(
		`check-package: npm pack lists only ${coverage.packedDistCount} of ${coverage.expectedDistCount} ${DIST}/ files - package.json's "files" probably excludes ${DIST}/`,
	);
	process.exit(2);
}

const inDist = filterTestOrSupportPaths(distFiles);
if (inDist.length > 0) {
	problems.push(
		`test or support files in ${DIST}/:`,
		...inDist.map((p) => `  ${p}`),
	);
}

const inPack = filterTestOrSupportPaths(packed);
if (inPack.length > 0) {
	problems.push(
		"test or support files in the npm package:",
		...inPack.map((p) => `  ${p}`),
	);
}

// bead myusage-4xu.119: data-driven from the real package.json, not a hardcoded package-name
// list. Only scans files the test-or-support checks above didn't already flag - a file already
// caught by #3 (inDist) fails for that reason regardless of what it imports.
//
// No `if (devOnlyPackages.length > 0)` guard around this (myusage-4xu.128, reviewer follow-up
// on PR #117): findDevOnlyImports already returns [] for every file when devOnlyPackages is
// empty, so the guard was genuinely equivalent to `if (true)` - it changed no output, only
// whether the scan ran, and nothing here proved that skip was ever worth having. This file
// sits outside vitest.config.ts's coverage.include, so an untested branch like that would never
// be caught by the coverage gate either.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const devOnlyPackages = devDependencyOnlyPackages(pkg);
let hasDevDependencyProblem = false;
const contentCheckFiles = distFiles.filter((path) => !inDist.includes(path));
const offenders = [];
for (const path of contentCheckFiles) {
	const content = readFileSync(path, "utf8");
	const found = findDevOnlyImports(content, devOnlyPackages);
	if (found.length > 0) offenders.push(`  ${path}: ${found.join(", ")}`);
}
if (offenders.length > 0) {
	hasDevDependencyProblem = true;
	problems.push(
		`devDependency-only package(s) imported in ${DIST}/ (not listed in "dependencies"):`,
		...offenders,
	);
}

if (problems.length > 0) {
	console.error("check-package: FAILED");
	for (const line of problems) console.error(line);
	console.error(
		[
			"Exclude them from the build in tsconfig.build.json.",
			"Excluded files still ship if runtime code imports them - check for that.",
			"If dist/ is stale from an older build, delete it and rebuild.",
		].join(" "),
	);
	if (hasDevDependencyProblem) {
		console.error(
			'A devDependency import in dist/ means either move that package to "dependencies" (it is a real runtime dependency) or stop importing it from that file.',
		);
	}
	process.exit(1);
}

console.log(
	`check-package: OK - ${distFiles.length} files in ${DIST}/, ${packed.length} in the npm package, none are test or support files or import a devDependency-only package`,
);
