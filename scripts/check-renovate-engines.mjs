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

// myusage-4xu.91: without this try/catch, JSON.parse's own SyntaxError surfaced as a raw,
// uncaught stack trace instead of a clean, explicit refusal like the missing-file check above -
// still fails closed either way (a raw stack trace also exits non-zero), just with a message that
// names the actual problem instead of a stack of internal V8/JSON frames. Scoped narrowly to what
// it actually covers: only JSON.parse's own SyntaxError (a genuinely malformed body, e.g. a stray
// leading BOM byte JSON.parse rejects but a text editor happily writes - see
// src/check-renovate-engines.integration.test.ts for the real proof, on both files). readFileSync
// itself stays outside the try, so an fs-level failure (a directory in place of a file, a
// permissions error) still raises unchanged - unlike check-branch-guard.mjs's explicit
// statSync().isDirectory() guard for its own humble-object paths, this driver has no such guard,
// and adding one is a deliberate non-goal here rather than an oversight: those inputs are out of
// scope for this bead.
//
// For RENOVATE_JSON this closes the gap completely: nothing else touches that file before this
// call. For PACKAGE_JSON, a syntactically-broken-enough body (e.g. truncated JSON, not just a
// BOM) is intercepted earlier still: reproduced directly, tsx/Node's own CJS loader reads and
// validates cwd's package.json during module resolution and crashes with its own raw,
// Node-internal, Node-version-specific stack trace before this script's first line ever runs -
// a failure this driver cannot intercept regardless of its own readFileSync/JSON.parse calls.
// This catch still covers every malformed-but-Node-loader-tolerant case (the BOM example above)
// that reaches this script's own code.
function readJson(relPath) {
	const raw = readFileSync(join(process.cwd(), relPath), "utf8");
	try {
		return JSON.parse(raw);
	} catch (err) {
		const reason = err.message;
		console.error(
			`check-renovate-engines: ${relPath} is not valid JSON (${reason}); refusing to pass a check that scanned nothing.`,
		);
		process.exit(1);
	}
}

const pkg = readJson(PACKAGE_JSON);
const renovate = readJson(RENOVATE_JSON);

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
