// Real I/O wiring for scripts/renovate-engines-guard.ts (bead myusage-4xu.85): reads the real
// package.json and renovate.json off disk and reports checkRenovateEnginesGuard's violations with
// a real exit code. Humble by design - no decision logic lives here, just fs and process wiring -
// so it's deliberately NOT in vitest.config.ts's coverage.include, mirroring scripts/check-
// fixtures-guard.mjs's and scripts/check-branch-guard.mjs's own split from their pure-logic
// modules (see either file's header for the fuller reasoning).
// src/check-renovate-engines.integration.test.ts runs this exact script, unmodified, against real
// scratch package.json/renovate.json fixtures, the same convention every other scripts/check-*.mjs
// driver in this repo uses.
//
// Invoked via tsx (not a bare `node`), so it can import renovate-engines-guard.ts directly - the
// same reason every sibling driver in this repo does. Run by `yarn lint`, not `yarn test`: this is
// static analysis, no build and no vitest run required first.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkRenovateEnginesGuard,
	formatViolation,
} from "./renovate-engines-guard.js";

const PACKAGE_JSON = "package.json";
const RENOVATE_JSON = "renovate.json";

// Matches every sibling driver's own refusal for a missing required input (see check-fixtures-
// guard.mjs / check-branch-guard.mjs): a missing config file is not "nothing to check", it's a
// broken invocation.
for (const relPath of [PACKAGE_JSON, RENOVATE_JSON]) {
	if (!existsSync(join(process.cwd(), relPath))) {
		console.error(
			`check-renovate-engines: ${relPath} not found in the current directory; refusing to pass a check that scanned nothing.`,
		);
		process.exit(1);
	}
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), PACKAGE_JSON), "utf8"));
const renovate = JSON.parse(
	readFileSync(join(process.cwd(), RENOVATE_JSON), "utf8"),
);

const violations = checkRenovateEnginesGuard({
	enginesNode: pkg.engines?.node,
	packageRules: renovate.packageRules ?? [],
});

if (violations.length > 0) {
	console.error("check-renovate-engines: FAILED");
	for (const violation of violations) {
		console.error(`  ${formatViolation(violation)}`);
	}
	process.exit(1);
}

console.log(
	"check-renovate-engines: OK - renovate.json's @types/node allowedVersions ceiling matches package.json's engines.node floor",
);
