// Pure decision logic behind scripts/check-fixtures-guard.mjs (bead myusage-9os): whether a
// src/**/*.fixtures.* file is genuinely test support, or just named like it.
//
// coverage.exclude in vitest.config.ts drops every *.fixtures.* file unconditionally - that's
// what makes a real fixture (src/pricing.fixtures.ts) invisible to coverage/src/*.html, and
// it's exactly what makes a MISUSED fixtures name invisible too. Reproduced by hand before this
// fix (see vitest.config.ts's own comment on the exclude array for the full repro): a throwaway
// src/zzz-scratch.fixtures.ts holding a real, uncovered branch, imported and called from
// src/aggregate.ts like any other dependency, left `yarn lint`, `yarn typecheck` and `yarn test`
// all exiting 0 - the 100%-per-file gate never looked at it.
//
// This closes that gap two ways, both read off the same import-reference scan:
//   1. No file outside test code or test support (package-rules.ts's own
//      filterTestOrSupportPaths - the same convention scripts/check-package.mjs already uses to
//      keep test files out of dist/) may reference a *.fixtures.* file. Production code reaching
//      for test support by name is exactly the shape of the bug above, whether or not the
//      fixtures file happens to hold an uncovered branch today - a fixtures file a production
//      module depends on isn't test support, no matter what it's named.
//   2. A *.fixtures.* file that clears check 1 must still prove it's actually test support, not
//      merely unreferenced by anything this scan found: it must either import "vitest" itself
//      (src/pricing.fixtures.ts does), or be referenced by a real *.test.*-named file - not
//      merely another *.fixtures.* file - among the references this scan found. That covers
//      src/load-price-table-via-proxy.fixtures.ts, which imports no test framework at all (it's
//      a standalone tsx subprocess entry point) but is handed to a real subprocess via
//      `new URL("./load-price-table-via-proxy.fixtures.ts", import.meta.url)` in
//      pricing-table.test.ts, not a static `import` - see extractReferences below for why that
//      idiom is scanned too, not just import/export declarations.
//
// Lives under scripts/, next to package-rules.ts, for the same reason that file does: this is
// build-time-only tooling, and src/ is what `yarn build` ships - a checker that lived under
// src/ would ship itself into dist/ (round-2 review of myusage-4xu.19 caught exactly that for
// package-rules.ts). Type-checked via tsconfig.config.json and covered at 100% via
// vitest.config.ts's coverage.include, both already listing package-rules.ts and
// critical-persisted.ts this same way; this file joins them.
//
// Deliberately NOT built on TypeScript's own compiler API: the `typescript` package this repo
// depends on (7.0.2) ships the new native-compiler layout, whose only documented AST surface is
// under `typescript/unstable/ast` - an explicitly unstable entry point unsuited to a checked-in
// gate this repo's tests can't afford to have break on an ordinary typescript bump. A
// comment-and-string-aware regex scan (stripComments below), the same class of tool
// package-rules.ts already uses for its own name-based classification, gets the same result
// with no dependency on an API surface that says "unstable" in its own path.
import { posix } from "node:path";
import { filterTestOrSupportPaths } from "./package-rules.js";

/** A source file this guard reads: its path (POSIX-separated, repo-relative, e.g.
 * "src/aggregate.ts") and its own text. */
export interface SourceFile {
	path: string;
	text: string;
}

/** Matches a real, non-test-only-verified string capture: a string or template literal
 * (captured whole, group 1) OR a `//` line comment OR a `/* *‍/`-style block comment (neither
 * captured). Standard technique for a comment-strip regex: alternation tries the string-literal
 * branch first at every position, so a `//` or `/*` that starts INSIDE an already-open string
 * (a URL like "https://…", say) is consumed as part of that string and never reaches the comment
 * branches - the comment branches only ever get a chance to match between real string literals.
 * Known, accepted gap: a template literal's `${...}` interpolation can itself contain `//` or
 * `/*`, and this does not parse expressions inside `${}`, only the outer backtick pair - no
 * specifier this file cares about (`from "..."`, `new URL("...", ...)`) is ever built from a
 * template literal anywhere in this repo, so that gap never matters for what stripComments is
 * actually used for. */
const STRING_OR_COMMENT =
	/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Removes `//` and `/* *‍/` comments from `source` while leaving every string and template
 * literal byte-for-byte untouched - so a comment that quotes example import syntax (this very
 * file's own header does, several times) can never be mistaken for a real reference, and a real
 * specifier that happens to contain "//" is never corrupted either. See STRING_OR_COMMENT's own
 * comment for the technique and its one known, accepted gap. */
export function stripComments(source: string): string {
	return source.replace(
		STRING_OR_COMMENT,
		(_whole, stringLiteral: string | undefined) => stringLiteral ?? "",
	);
}

// Both patterns hold exactly one capturing group, and `[^"']+` requires at least one character -
// so a successful match always fills index 1; the casts below avoid a TS-only "possibly
// undefined" (noUncheckedIndexedAccess) that no input could ever produce, the same reasoning
// proxy.ts's parseNoProxyEntries already documents for its own regex match.
const FROM_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;
const NEW_URL_LITERAL = /\bnew\s+URL\s*\(\s*["']([^"']+)["']/g;

function allCaptures(pattern: RegExp, text: string): string[] {
	const specifiers: string[] = [];
	for (const raw of text.matchAll(pattern)) {
		const match = raw as unknown as [string, string];
		specifiers.push(match[1]);
	}
	return specifiers;
}

/** Every module specifier `sourceText` statically imports or exports-from, plus every
 * string-literal first argument to a `new URL(...)` call - the idiom
 * src/pricing-table.test.ts uses to hand a fixtures file's own path to a real `tsx` subprocess
 * (see src/load-price-table-via-proxy.fixtures.ts's header) rather than a static import.
 * Comments are stripped first (stripComments), so neither pattern can fire on prose that merely
 * quotes import-shaped or `new URL(...)`-shaped example text - this file's own header does
 * exactly that, more than once. */
export function extractReferences(sourceText: string): string[] {
	const stripped = stripComments(sourceText);
	return [
		...allCaptures(FROM_SPECIFIER, stripped),
		...allCaptures(NEW_URL_LITERAL, stripped),
	];
}

/** Resolves a relative specifier (starting with "./" or "../") against the repo-relative path
 * that holds it, to the repo-relative source path it names - e.g. "src/pricing-table.test.ts"
 * plus "./pricing.fixtures.js" resolves to "src/pricing.fixtures.ts". Applies this repo's own
 * ESM convention (tsconfig.json: `"moduleResolution": "NodeNext"`) that a relative import names
 * its compiled ".js" output even though the real file on disk is ".ts" - every relative
 * specifier in this repo already follows it. A non-relative specifier (a bare package name like
 * "vitest") returns undefined: it can never name a same-tree fixtures file, and the caller
 * doesn't need to tell "not a file reference" apart from "resolved somewhere else" any more
 * precisely than that. */
export function resolveRelativeSpecifier(
	fromPath: string,
	specifier: string,
): string | undefined {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return undefined;
	}
	const resolved = posix.normalize(
		posix.join(posix.dirname(fromPath), specifier),
	);
	return resolved.endsWith(".js")
		? `${resolved.slice(0, -".js".length)}.ts`
		: resolved;
}

function isFixturesFile(path: string): boolean {
	return /\.fixtures\./.test(posix.basename(path));
}

// bead myusage-4xu.58: a legitimate test-support helper shaped like src/__tests__/helper.ts (no
// ".test." anywhere in its own basename) wasn't counted as a real test referencer, producing a
// false-positive unverified-fixtures violation on an otherwise-fine fixtures file only referenced
// by such a helper. Mirrors package-rules.ts's own hasTestSupportDir - exact directory-segment
// match, not a substring check, same discipline isFixturesFile/isRealTestFile's basename checks
// already apply - but deliberately a narrower set than package-rules.ts's TEST_SUPPORT_DIR: that
// one also includes "fixtures", which is right for ITS purpose (classifying what a build may ship)
// but wrong for this one (a bare fixtures/ directory proves a file is test SUPPORT, not that it's
// a REAL test able to verify another fixtures file - the same distinction hasRealTestReferencer
// already draws against a *.fixtures.* referencer below).
const TEST_SUPPORT_DIR = new Set(["__tests__", "__mocks__"]);

function isUnderTestSupportDir(path: string): boolean {
	// SourceFile's contract is already POSIX-separated repo-relative paths (see that interface's
	// own doc comment), so unlike package-rules.ts's normalizeSeparators (built for npm's raw,
	// possibly Windows-separated pack output) no separator normalization is needed here.
	const segments = path.split("/");
	segments.pop(); // the basename itself is not a directory segment
	return segments.some((segment) => TEST_SUPPORT_DIR.has(segment));
}

function isRealTestFile(path: string): boolean {
	return /\.test\./.test(posix.basename(path)) || isUnderTestSupportDir(path);
}

export type FixturesGuardViolation =
	| {
			kind: "banned-import";
			/** The non-test-or-support file that references the fixtures file. */
			importer: string;
			fixturesFile: string;
	  }
	| {
			kind: "unverified-fixtures";
			/** A *.fixtures.* file that imports no test framework and has no real *.test.*
			 * referencer this scan could find, so it can't be trusted to stay excluded from
			 * coverage. */
			fixturesFile: string;
	  };

/** Human-readable text for one violation, shared by the driver script (real stderr output) and
 * this file's own tests (so the message text itself stays covered and pinned, not just the
 * structured violation). */
export function formatViolation(violation: FixturesGuardViolation): string {
	if (violation.kind === "banned-import") {
		return `${violation.importer} imports ${violation.fixturesFile}, a *.fixtures.* file - production code may not import test support (AGENTS.md: "Don't give production code those names")`;
	}
	return `${violation.fixturesFile} cannot be verified as test-only: it does not import "vitest", and no real *.test.* file references it`;
}

/** Every violation of the two rules this file's header describes, found by scanning every
 * reference (import/export specifier or `new URL(...)` literal) each file in `files` holds. A
 * file that references a *.fixtures.* file counts as its referencer whether or not the
 * reference resolves to a file actually present in `files` - a broken relative import is
 * TypeScript's problem to catch, not this guard's, so this never needs to check existence, only
 * the referencing text's shape. */
export function checkFixturesGuard(
	files: readonly SourceFile[],
): FixturesGuardViolation[] {
	const paths = files.map((file) => file.path);
	const testOrSupport = new Set(filterTestOrSupportPaths(paths));

	const referencersByTarget = new Map<string, string[]>();
	const violations: FixturesGuardViolation[] = [];

	for (const file of files) {
		for (const specifier of extractReferences(file.text)) {
			const resolved = resolveRelativeSpecifier(file.path, specifier);
			if (resolved === undefined || !isFixturesFile(resolved)) continue;

			const referencers = referencersByTarget.get(resolved) ?? [];
			referencers.push(file.path);
			referencersByTarget.set(resolved, referencers);

			if (!testOrSupport.has(file.path)) {
				violations.push({
					kind: "banned-import",
					importer: file.path,
					fixturesFile: resolved,
				});
			}
		}
	}

	// Iterates `files` directly, not `paths.filter(isFixturesFile)` followed by a second lookup
	// back into `files`: every fixtures file this loop needs to inspect is already right here,
	// so a name-then-refind round trip would only add a `.find()` call whose "not found" branch
	// could never actually happen - and an unreachable branch fails this repo's own 100%
	// branch-coverage gate for exactly the reason AGENTS.md's "fabricated-input-only branches"
	// rule bans it (no real caller could ever produce that input).
	for (const file of files) {
		if (!isFixturesFile(file.path)) continue;

		const importsVitest = extractReferences(file.text).includes("vitest");
		const referencers = referencersByTarget.get(file.path) ?? [];
		const hasRealTestReferencer = referencers.some(isRealTestFile);

		if (!importsVitest && !hasRealTestReferencer) {
			violations.push({ kind: "unverified-fixtures", fixturesFile: file.path });
		}
	}

	return violations;
}
