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

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	DIST,
	filterTestOrSupportPaths,
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
	process.exit(1);
}

console.log(
	`check-package: OK - ${distFiles.length} files in ${DIST}/, ${packed.length} in the npm package, none are test or support files`,
);
