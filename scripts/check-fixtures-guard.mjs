// Real I/O wiring for scripts/fixtures-guard.ts (bead myusage-9os): walks the real src/ tree,
// reads each .ts file's real text, and reports checkFixturesGuard's violations with a real exit
// code. Humble by design - no decision logic lives here, just fs and process wiring - so it's
// deliberately NOT in vitest.config.ts's coverage.include, mirroring scripts/check-package.mjs's
// own split from scripts/package-rules.ts (see that file's header for the fuller reasoning).
// src/check-fixtures-guard.integration.test.ts runs this exact script, unmodified, against real
// scratch fixtures, the same way src/check-package.integration.test.ts already does for
// check-package.mjs.
//
// Invoked via tsx (not a bare `node`), so it can import fixtures-guard.ts directly - the same
// reason check-package.mjs imports package-rules.ts this way. Run by `yarn lint`, not
// `yarn test`: this is static analysis, no build and no vitest run required first.
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { checkFixturesGuard, formatViolation } from "./fixtures-guard.ts";

const SRC_DIR = "src";

function listTsFiles(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listTsFiles(path));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

const files = listTsFiles(SRC_DIR).map((path) => ({
	// checkFixturesGuard's contract is POSIX-separated repo-relative paths (see
	// fixtures-guard.ts's SourceFile doc comment); join() above uses the platform separator.
	path: path.split(sep).join("/"),
	text: readFileSync(path, "utf8"),
}));

const violations = checkFixturesGuard(files);

if (violations.length > 0) {
	console.error("check-fixtures-guard: FAILED");
	for (const violation of violations) {
		console.error(`  ${formatViolation(violation)}`);
	}
	console.error(
		[
			"A *.fixtures.* file may only be referenced by test code or test support, and must be",
			'verifiable as test-only itself (import "vitest", or a real *.test.* referencer).',
			'See AGENTS.md\'s "Testing & coverage policy".',
		].join(" "),
	);
	process.exit(1);
}

console.log(
	`check-fixtures-guard: OK - ${files.length} files scanned, no banned or unverifiable *.fixtures.* references`,
);
