// Pure decision logic behind scripts/check-package.mjs (bead myusage-4xu.19): the
// test-or-support name pattern, the separator-safe directory-prefix check, and the pack-list
// vacuity check. Lives under scripts/, next to the script that wires it to real I/O, not
// under src/: this is build-time-only tooling, and src/'s rootDir feeds `yarn build`, so a
// module that only exists to check the package must never itself ship inside the package
// (round-2 review, myusage-4xu.19 - the earlier src/ placement did exactly that: tsc emitted
// dist/package-rules.js and it shipped).
//
// Still type-checked and covered like everything else, just via the same precedent
// tsconfig.config.json already set for vitest.config.ts (a non-src file explicitly added to
// its own `include`, extending tsconfig.json's strict options with rootDir "."): this file is
// listed there too, so `yarn typecheck` still catches a type error here. `yarn test` covers it
// at 100% via vitest.config.ts's coverage.include, which lists this path explicitly, the same
// way humble-object exclusions are explicit paths, never globs.
import { basename } from "node:path";

/** The build's output directory. Single source of truth: scripts/check-package.mjs imports
 * this instead of repeating the literal. */
export const DIST = "dist";

// Convention (keep in sync with tsconfig.build.json): a file whose name contains ".test." or
// ".fixtures." is test code or test support. Anything only tests import belongs in one of
// those names so the build leaves it out. ".spec." is deliberately NOT part of this
// convention (myusage-9os): it used to be, but vitest.config.ts's test.include never matched
// it, so a *.spec.ts file was invisible to the coverage gate while also never running as a
// test - see that file's own comment for the full reasoning. No *.spec.* file has ever
// existed in this repo.
const TEST_OR_SUPPORT = /\.(test|fixtures)\./;

// bead myusage-4xu.20: a second, independent way a path can be test support - living under one
// of these directories, regardless of the file's own name inside it (test-utils.ts under
// __mocks__/ has a name the pattern above would never catch on its own). Exact segment match
// only, the same discipline TEST_OR_SUPPORT already applies to basenames: a directory named
// `my__mocks__ish` is a real name, not this convention. tsconfig.build.json excludes
// __tests__/** and __mocks__/** so a real build never emits them into dist/ in the first place;
// it does NOT exclude a plain `fixtures/` directory (too generic a name to blanket-exclude from
// every build), so this filter is the only thing standing between a `fixtures/` directory and
// the published package.
const TEST_OR_SUPPORT_DIR = new Set(["__tests__", "__mocks__", "fixtures"]);

function normalizeSeparators(path: string): string {
	return path.replaceAll("\\", "/");
}

/** Whether `path` has one of TEST_OR_SUPPORT_DIR as a directory segment - the file's own
 * basename never counts, only what sits above it, and separators are normalized first so a
 * backslash-separated path (e.g. from npm's JSON output on Windows) is checked the same way as
 * a POSIX one. */
function hasTestSupportDir(path: string): boolean {
	const segments = normalizeSeparators(path).split("/");
	segments.pop(); // the basename itself is not a directory segment
	return segments.some((segment) => TEST_OR_SUPPORT_DIR.has(segment));
}

/** The paths that are test code or test support, either by the TEST_OR_SUPPORT basename
 * pattern (e.g. `pricing.fixtures.ts`) or by living under a TEST_OR_SUPPORT_DIR directory (e.g.
 * anything under `__mocks__/`) - a directory segment that merely contains one of these markers
 * (e.g. `my.test.dir/index.ts`, `my__mocks__ish/index.ts`) does not count either way; only an
 * exact basename match or an exact directory-segment match decides. */
export function filterTestOrSupportPaths(paths: string[]): string[] {
	return paths.filter(
		(path) => TEST_OR_SUPPORT.test(basename(path)) || hasTestSupportDir(path),
	);
}

/** Whether `path` sits strictly under `dir` - a same-prefix sibling directory (`distant/` vs
 * `dist`) does not count - independent of whether `path` is POSIX- or Windows-separated. */
export function isUnderDir(path: string, dir: string): boolean {
	return normalizeSeparators(path).startsWith(`${dir}/`);
}

// Basenames npm always leaves out of the published package, regardless of package.json's
// `files` (see https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files, "Some
// special files and directories are also included or excluded regardless of whether they
// exist in the files array"). Counting one of these against dist/'s expected pack count blames
// a correct `files: ["dist"]` for excluding dist/ when the real cause is npm's own hygiene -
// verified against a throwaway fixture with a correct `files: ["dist"]` and a stray
// dist/.DS_Store: the unfiltered comparison exited 2 with exactly that false accusation. This
// covers the patterns realistic for a `tsc` build's output directory; it is deliberately not a
// port of npm's full internal ignore-walk (VCS directories, swap files, lockfiles, etc. do not
// occur in dist/).
const NPM_ALWAYS_IGNORED = /^(\.DS_Store|\.gitignore|\.npmrc|\._.*|.*\.orig)$/;

export type PackListCoverage = {
	/** Whether the packed file list accounts for every dist/ entry npm was ever going to
	 * pack. False means `files` probably excludes dist/. */
	covered: boolean;
	/** How many packed entries actually fall under dist/. */
	packedDistCount: number;
	/** How many dist/ entries npm was expected to pack, after dropping npm's own
	 * always-ignored junk (see NPM_ALWAYS_IGNORED). */
	expectedDistCount: number;
};

/** Whether the packed file list accounts for at least as many `dist/` entries as `dist/`
 * actually holds, once npm's own always-ignored junk is discounted. npm always packs the file
 * `bin` points to regardless of package.json's `files`, so a pack list that merely contains at
 * least one dist/ path is not proof `files` covers the built output: a `files` list that
 * excludes dist/ still yields one dist/ entry (the bin target) and would pass a "some dist/
 * file is listed" check vacuously. Comparing counts instead catches that, without also
 * blaming `files` for junk npm was never going to pack in the first place (NPM_ALWAYS_IGNORED).
 * `distFiles` is trusted to already be dist/'s own listing (see listFiles(DIST) in
 * check-package.mjs); `packedFiles` is filtered by isUnderDir so either side can be POSIX- or
 * Windows-separated. Returns the counts alongside the verdict so the caller can build its
 * error message from them instead of re-deriving packedDistCount itself. */
export function packListCoversDist(
	distFiles: string[],
	packedFiles: string[],
): PackListCoverage {
	const expectedDistCount = distFiles.filter(
		(path) => !NPM_ALWAYS_IGNORED.test(basename(path)),
	).length;
	const packedDistCount = packedFiles.filter((path) =>
		isUnderDir(path, DIST),
	).length;
	return {
		covered: packedDistCount >= expectedDistCount,
		packedDistCount,
		expectedDistCount,
	};
}

// --- devDependency-only content scan (bead myusage-4xu.119) ---------------------------------
//
// filterTestOrSupportPaths and its helpers above are purely name/location based: a basename
// pattern or a directory segment, never a file's actual content. That leaves a gap a
// differently-named file placed directly under src/ walks straight through. myusage-4xu.116
// found this for real: src/test-fixture-root.ts (before it was renamed/relocated to dodge these
// same filters) imported from "vitest" - a real devDependency, never listed in this package's
// own `dependencies` - and would have shipped that import into dist/ with check:package still
// exiting 0, simply because its name held neither ".test." nor ".fixtures." and it didn't sit
// under a __tests__/__mocks__/fixtures directory. The three functions below close that gap by
// looking at what a file actually imports, compared against what package.json's own
// `dependencies` say the published package may depend on at runtime - data-driven from the real
// package.json, not a hardcoded package-name list.

/** The subset of package.json this module reads: just enough to tell a devDependency-only
 * package apart from one the published package also lists as a real runtime dependency. Both
 * keys are optional, matching real package.json shapes that omit either or both - most of this
 * repo's own integration fixtures write neither key at all. */
export type PackageJsonDeps = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

/** Package names listed in `devDependencies` but not also in `dependencies` - the packages a
 * built file must never depend on, since nothing in `dependencies` promises they'll be
 * installed for a consumer of the published package. A missing `dependencies` and/or
 * `devDependencies` key is treated as empty, not an error - most of this repo's own dist/
 * fixtures (and plenty of real package.json files) omit one or both keys entirely, so `pkg.x ??
 * {}` must not throw on either being absent. Order matches `Object.keys(devDependencies)`'s own
 * insertion order, not sorted or otherwise reshaped. */
export function devDependencyOnlyPackages(pkg: PackageJsonDeps): string[] {
	const dependencies = pkg.dependencies ?? {};
	const devDependencies = pkg.devDependencies ?? {};
	return Object.keys(devDependencies).filter((name) => !(name in dependencies));
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One anchored regex per package name - not a tokenizer or a JS parser. This repo already has a
// tokenizing-scan precedent (myusage-4xu.115's pricing-cache doc-comment scan), and the RED-stage
// reviewer for this bead named it as a cautionary example here, not a pattern to repeat: a single
// regex is sufficient for this shape of input. Matches a quoted specifier immediately following
// `from`, a bare `import`, `import(`, or `require(`, where the specifier is exactly the package
// name or the package name plus a `/subpath` - anchored so "vite" never matches a "vitest/config"
// specifier just because it's a literal prefix of "vitest".
const IMPORT_CONTEXT = String.raw`(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)`;

/** Whether `content` imports or requires `packageName` - a default import, a named import, a
 * bare side-effect import, `require(...)`, a dynamic `import(...)`, or a subpath import (e.g.
 * `"vitest/config"` counts as importing `"vitest"`, since the built file depends on the
 * `vitest` package at runtime either way). A plain mention of the package name inside an
 * unrelated string or comment does not count: the match is anchored to a quoted specifier
 * directly after one of the import/require keywords above, never a bare substring search. */
export function importsPackage(content: string, packageName: string): boolean {
	const escaped = escapeRegExpLiteral(packageName);
	const pattern = new RegExp(
		`${IMPORT_CONTEXT}(['"])${escaped}(?:/[^'"]*)?\\1`,
	);
	return pattern.test(content);
}

/** The subset of `devOnlyPackages` that `content` actually imports - what check-package.mjs
 * reports as offenders for one file, instead of every devDependency-only package in
 * package.json regardless of whether this particular file references it. */
export function findDevOnlyImports(
	content: string,
	devOnlyPackages: string[],
): string[] {
	return devOnlyPackages.filter((name) => importsPackage(content, name));
}
