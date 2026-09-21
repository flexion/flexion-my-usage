// Real I/O wiring for scripts/branch-guard.ts (bead myusage-qx9): reads vitest.config.ts's own
// resolved coverage.exclude array (single source of truth - not a second, hand-maintained copy
// of it), filters it down to the humble-object explicit paths, reads each one's real text off
// disk, and reports branch-guard.ts's violations with a real exit code. Humble by design - no
// decision logic lives here, just fs, module-resolution, and process wiring - so it's
// deliberately NOT in vitest.config.ts's coverage.include, mirroring scripts/check-fixtures-
// guard.mjs's own split from scripts/fixtures-guard.ts (see that file's header for the fuller
// reasoning). src/check-branch-guard.integration.test.ts runs this exact script, unmodified,
// against a real scratch vitest.config.ts and scratch source tree.
//
// Invoked via tsx (not a bare `node`), so it can import branch-guard.ts and vitest.config.ts
// directly - the same reason check-fixtures-guard.mjs imports fixtures-guard.ts this way. Run by
// `yarn lint`, not `yarn test`: this is static analysis, no build and no vitest run required
// first.
//
// vitest.config.ts is resolved against process.cwd(), not against this script's own file
// location: a static `import ... from "../vitest.config.ts"` would always resolve to THIS repo's
// real config, no matter what directory the script is run from, which would make it impossible
// for an integration test to exercise a different coverage.exclude list by spawning this script
// against a scratch cwd (see src/check-fixtures-guard.integration.test.ts and
// src/check-package.integration.test.ts for the established cwd-swapping test convention this
// mirrors). A dynamic import built from `process.cwd()` keeps both true: `yarn lint`'s real
// invocation (cwd is always the repo root) picks up the real config, and a spawned test can swap
// in its own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	checkBranchGuard,
	formatViolation,
	humbleObjectPaths,
} from "./branch-guard.js";

const CONFIG_PATH = join(process.cwd(), "vitest.config.ts");

// Matches check-fixtures-guard.mjs's own refusal for a missing src/: a missing config is not a
// "nothing excluded, so nothing to scan" pass, it's a broken invocation.
if (!existsSync(CONFIG_PATH)) {
	console.error(
		"check-branch-guard: vitest.config.ts not found in the current directory; refusing to pass a check that scanned nothing.",
	);
	process.exit(1);
}

const { default: config } = await import(pathToFileURL(CONFIG_PATH).href);
const excludePaths = humbleObjectPaths(config.test.coverage.exclude);

const files = [];
for (const path of excludePaths) {
	const absolute = join(process.cwd(), path);
	if (!existsSync(absolute)) {
		console.error(
			`check-branch-guard: ${path} is listed in vitest.config.ts's coverage.exclude but does not exist on disk; refusing to pass a check that scanned nothing for it.`,
		);
		process.exit(1);
	}
	files.push({ path, text: readFileSync(absolute, "utf8") });
}

const violations = checkBranchGuard(files);

if (violations.length > 0) {
	console.error("check-branch-guard: FAILED");
	for (const violation of violations) {
		console.error(`  ${formatViolation(violation)}`);
	}
	process.exit(1);
}

console.log(
	`check-branch-guard: OK - ${files.length} humble-object file(s) scanned (${excludePaths.join(", ")}), no banned branching constructs found`,
);
