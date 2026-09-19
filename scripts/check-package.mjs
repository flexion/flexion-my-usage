// Guard: the built output and the published npm package must not ship test or
// test-support files.
//
// Convention (keep in sync with tsconfig.build.json): a file whose name contains
// ".test.", ".spec." or ".fixtures." is test code or test support. Anything only
// tests import belongs in one of those names so the build leaves it out.
//
// Run it after a build. `yarn check:package` builds first, then asserts, against
// the real output:
//   1. dist/ exists and is non-empty, so the checks below cannot pass vacuously.
//   2. No test or support file exists anywhere under dist/.
//   3. No test or support file appears in the `npm pack --dry-run` file list.

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const DIST = "dist";
const TEST_OR_SUPPORT = /\.(test|spec|fixtures)\./;

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
if (!packed.some((p) => p.startsWith(`${DIST}/`))) {
	console.error(
		`check-package: npm pack lists no ${DIST}/ files - nothing to check`,
	);
	process.exit(2);
}

const inDist = distFiles.filter((p) => TEST_OR_SUPPORT.test(basename(p)));
if (inDist.length > 0) {
	problems.push(
		`test or support files in ${DIST}/:`,
		...inDist.map((p) => `  ${p}`),
	);
}

const inPack = packed.filter((p) => TEST_OR_SUPPORT.test(basename(p)));
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
