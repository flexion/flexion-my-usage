// Behavioral tests for the pure decision logic behind scripts/check-package.mjs (bead
// myusage-4xu.19): the pack-list vacuity check, the separator-safe directory-prefix check,
// and the test-or-support name pattern.
//
// This logic lives in scripts/package-rules.ts, not src/ - a build-time-only checker must not
// ship inside the package it checks (see that file's header comment) - but it is still
// type-checked by `yarn typecheck` and gated at 100% coverage by `yarn test` like every other
// file this project cares about, and never needs a real npm invocation or a real dist/ tree on
// disk. The other half of the bead's fix - proving check-package.mjs actually calls this
// module instead of keeping its old, buggy checks - is covered separately in
// src/check-package.integration.test.ts, which runs the real script against a real dist/ and a
// real `npm pack --dry-run`.
import { describe, expect, it } from "vitest";
import {
	devDependencyOnlyPackages,
	filterTestOrSupportPaths,
	findDevOnlyImports,
	importsPackage,
	isUnderDir,
	packListCoversDist,
} from "../scripts/package-rules.js";

describe("filterTestOrSupportPaths: the test-or-support name pattern and its offender filter", () => {
	it("flags a fixtures file and a test file", () => {
		const paths = ["src/pricing.fixtures.ts", "src/aggregate.test.ts"];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"src/pricing.fixtures.ts",
			"src/aggregate.test.ts",
		]);
	});

	it("does not flag a .spec. file - that suffix is not part of this convention (myusage-9os)", () => {
		// vitest.config.ts's test.include never matched *.spec.ts, so a file named this way was
		// invisible to the coverage gate while also never running as a test - the repo dropped
		// the suffix from the convention entirely rather than widen test.include to match a
		// pattern nothing here actually uses. This pins that a *.spec.ts file is now treated
		// like any other real source file by this check, not test support.
		const paths = ["src/pricing-table.spec.ts"];

		expect(filterTestOrSupportPaths(paths)).toEqual([]);
	});

	it("does not flag testing.ts or contest.ts - real names that merely contain the substring 'test'", () => {
		const paths = ["src/testing.ts", "src/contest.ts", "src/index.ts"];

		expect(filterTestOrSupportPaths(paths)).toEqual([]);
	});

	it("matches on the basename, not the full path", () => {
		// A directory segment that happens to contain ".test." must not trip the guard;
		// only the file's own basename decides.
		const paths = ["src/my.test.dir/index.ts", "src/my.test.dir/index.test.ts"];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"src/my.test.dir/index.test.ts",
		]);
	});

	it("flags any file under a __tests__ directory, regardless of its own name", () => {
		// bead myusage-4xu.20: a test-support directory catches everything under it, even a
		// file whose own basename would otherwise pass the name-pattern check clean.
		const paths = ["dist/__tests__/helpers.js", "dist/index.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"dist/__tests__/helpers.js",
		]);
	});

	it("flags any file under a __mocks__ directory, regardless of its own name", () => {
		const paths = ["dist/__mocks__/x.js", "dist/index.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual(["dist/__mocks__/x.js"]);
	});

	it("flags any file under a fixtures directory, regardless of its own name", () => {
		const paths = ["dist/fixtures/sample.js", "dist/index.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"dist/fixtures/sample.js",
		]);
	});

	it("flags a file nested several levels below a test-support directory", () => {
		// __mocks__ sits at path-segment index 2 here (dist/sources/__mocks__/...), with two
		// more real directories (nested/, then deep/) between it and the file - a non-immediate
		// ancestor, not the immediate parent segment. In isolation this test alone would still
		// pass a buggy "check only segments[2]" implementation, since that's exactly where
		// __mocks__ sits in this one fixture. What defeats a fixed-index implementation is the
		// suite as a whole: every other fixture in this file pins its test-support directory to
		// index 1, so this fixture's index 2 means no single segments[k] check can satisfy every
		// fixture at once - only walking every ancestor segment can.
		const paths = ["dist/sources/__mocks__/nested/deep/file.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"dist/sources/__mocks__/nested/deep/file.js",
		]);
	});

	it("flags a test-support directory on a Windows-style backslash path", () => {
		// Same separator-independence isUnderDir already gives the packed-file side (see
		// below) - the pack list can arrive backslash-separated on a Windows runner.
		const paths = ["dist\\__mocks__\\x.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual(["dist\\__mocks__\\x.js"]);
	});

	it("does not flag a directory whose name merely contains __mocks__ as a substring", () => {
		// Exact segment match, the same discipline the basename pattern already applies: a
		// directory named `my__mocks__ish` is a real name, not the __mocks__ convention.
		const paths = ["dist/my__mocks__ish/index.js"];

		expect(filterTestOrSupportPaths(paths)).toEqual([]);
	});

	it("does not flag the bare directory name itself with nothing under it", () => {
		// "fixtures" as a FILE's own basename (no extension) is not the fixtures directory
		// convention this rule targets - only a path that has fixtures as one of its
		// directory segments counts.
		const paths = ["dist/fixtures"];

		expect(filterTestOrSupportPaths(paths)).toEqual([]);
	});
});

describe("isUnderDir: separator-safe directory-prefix check", () => {
	it("recognizes a POSIX-style nested path under the directory", () => {
		expect(isUnderDir("dist/nested/index.js", "dist")).toBe(true);
	});

	it("recognizes a Windows-style backslash path under the directory", () => {
		// Whatever format npm's own JSON output turns out to use on a Windows runner is
		// unverified from here (this repo only observed macOS/POSIX output while writing
		// this test) - the point of this check is to not depend on that either way, the
		// same way the rest of the script normalizes via basename() instead of hardcoding
		// a separator.
		expect(isUnderDir("dist\\nested\\index.js", "dist")).toBe(true);
	});

	it("does not treat a same-prefix sibling directory as a match", () => {
		// A naive `path.startsWith("dist/")` at least guards this; a naive
		// `path.startsWith("dist")` would not. Pin the correct, stricter semantics.
		expect(isUnderDir("distant/index.js", "dist")).toBe(false);
	});

	it("does not match the bare directory name with nothing under it", () => {
		expect(isUnderDir("dist", "dist")).toBe(false);
	});
});

describe("packListCoversDist: the pack list must be able to fail the vacuity check", () => {
	it("fails when the pack list holds fewer dist entries than dist actually holds", () => {
		// The exact shape the reviewer found: `files` excludes dist, but npm still ships
		// the bin target, so the pack list holds 1 of the 2 real dist files.
		const distFiles = ["dist/index.js", "dist/lib.js"];
		const packedFiles = ["dist/index.js", "package.json", "README.md"];

		const result = packListCoversDist(distFiles, packedFiles);

		expect(result.covered).toBe(false);
		expect(result.packedDistCount).toBe(1);
		expect(result.expectedDistCount).toBe(2);
	});

	it("passes when the pack list holds every dist entry", () => {
		const distFiles = ["dist/index.js", "dist/lib.js"];
		const packedFiles = ["dist/index.js", "dist/lib.js", "package.json"];

		const result = packListCoversDist(distFiles, packedFiles);

		expect(result.covered).toBe(true);
		expect(result.packedDistCount).toBe(2);
		expect(result.expectedDistCount).toBe(2);
	});

	it("does not undercount the dist side by filtering or normalizing its raw entries", () => {
		// packListCoversDist filters the dist side ONLY to drop npm's own always-ignored
		// junk (NPM_ALWAYS_IGNORED, e.g. .DS_Store) - it does not reshape or normalize the
		// surviving paths the way isUnderDir does for the packed side. Both of these entries
		// are real, non-ignored dist files, so both must count regardless of separator
		// style. VERIFIED: with normalizeSeparators removed entirely, this test still
		// passes, because the dist side's count never runs through it - only the packed
		// side's isUnderDir check does. This pins that fact: it forbids a reimplementation
		// that runs the dist side through isUnderDir-style normalization too, which would
		// wrongly drop the backslash-separated entries and undercount what npm was expected
		// to pack.
		const distFiles = ["dist\\a.js", "dist\\b.js"];
		const packedFiles = ["dist/a.js"];

		const result = packListCoversDist(distFiles, packedFiles);

		expect(result.covered).toBe(false);
		expect(result.expectedDistCount).toBe(2);
	});

	it("still counts a match when the packed list uses native (backslash) separators", () => {
		// Isolates normalization of the PACKED side - the side npm actually emits on a
		// Windows runner. A comparison that does not normalize the packed side
		// undercounts it as 0 ("dist\a.js" does not start with "dist/"), so 0 >= 1
		// wrongly fails; normalized, packed counts 1 and 1 >= 1 correctly passes.
		const distFiles = ["dist/a.js"];
		const packedFiles = ["dist\\a.js"];

		expect(packListCoversDist(distFiles, packedFiles).covered).toBe(true);
	});

	it("does not false-accuse `files` of excluding dist/ over npm's own always-ignored junk (e.g. .DS_Store)", () => {
		// VERIFIED against a throwaway fixture with a correct `files: ["dist"]` and a stray
		// dist/.DS_Store: the unfiltered comparison exited 2, falsely blaming `files` for
		// excluding dist/, when the real cause was npm never intending to pack that file at
		// all. distFiles holds 3 raw entries (2 real + 1 junk); only 2 are ever packable, and
		// the pack list covers both, so this must read as fully covered.
		const distFiles = ["dist/index.js", "dist/lib.js", "dist/.DS_Store"];
		const packedFiles = ["dist/index.js", "dist/lib.js", "package.json"];

		const result = packListCoversDist(distFiles, packedFiles);

		expect(result.covered).toBe(true);
		expect(result.packedDistCount).toBe(2);
		expect(result.expectedDistCount).toBe(2);
	});

	it("still fails on a real gap even alongside npm's always-ignored junk", () => {
		// Guards against a broken filter that discounts everything (which would make this
		// vacuously pass no matter what): one real dist file plus a stray .DS_Store, but
		// the pack list covers neither.
		const distFiles = ["dist/index.js", "dist/.DS_Store"];
		const packedFiles = ["package.json"];

		const result = packListCoversDist(distFiles, packedFiles);

		expect(result.covered).toBe(false);
		expect(result.packedDistCount).toBe(0);
		expect(result.expectedDistCount).toBe(1);
	});

	it("treats an empty dist as vacuously covered by an empty pack count (0 >= 0)", () => {
		// check-package.mjs already exits 2 before this function is ever called when dist/
		// is empty (its own, separate "dist/ is empty" guard), so this exact input never
		// reaches production code. Kept anyway for contract-pinning value: it documents that
		// packListCoversDist needs no special-cased branch for an empty dist/ - the plain
		// count comparison already returns true for 0 >= 0, at zero implementation cost.
		expect(packListCoversDist([], []).covered).toBe(true);
	});
});

// bead myusage-4xu.119: TEST_OR_SUPPORT and TEST_OR_SUPPORT_DIR above are purely name/location
// based. A differently-named file placed directly under src/ that imports a devDependency (e.g.
// vitest) ships that import into dist/ undetected - neither filter above ever looks at a file's
// CONTENT. This was surfaced for real during myusage-4xu.116: src/test-fixture-root.ts (before
// it was renamed/relocated to dodge the name-based filters) imported from "vitest" and would
// have shipped that devDependency import into dist/ with check:package still exiting 0.
//
// devDependencyOnlyPackages, importsPackage and findDevOnlyImports below are the content-based
// detector that closes that gap: package.json's real dependencies/devDependencies decide which
// package names are devDependency-only, and a single anchored regex per candidate name (see
// package-rules.ts) decides whether a given file's content actually imports one of them.
describe("devDependencyOnlyPackages: package.json packages listed only in devDependencies, not also in dependencies", () => {
	it("returns a package present in devDependencies but absent from dependencies", () => {
		const pkg = {
			dependencies: { undici: "8.10.2" },
			devDependencies: { vitest: "5.0.1", tsx: "4.23.15" },
		};

		expect(devDependencyOnlyPackages(pkg)).toEqual(["vitest", "tsx"]);
	});

	it("excludes a package listed in both dependencies and devDependencies", () => {
		// A package the published package's own runtime code also needs is not
		// devDependency-ONLY - importing it into dist/ is not evidence of a missing real
		// dependency, since `dependencies` already covers it.
		const pkg = {
			dependencies: { shared: "1.0.0" },
			devDependencies: { shared: "1.0.0", vitest: "5.0.1" },
		};

		expect(devDependencyOnlyPackages(pkg)).toEqual(["vitest"]);
	});

	it("returns an empty array when package.json has no devDependencies", () => {
		expect(
			devDependencyOnlyPackages({ dependencies: { undici: "8.10.2" } }),
		).toEqual([]);
	});

	it("returns a devDependencies-only package when package.json has no dependencies key at all", () => {
		// Realistic, not a corner case: most of src/check-package.integration.test.ts's fixture
		// package.json files (writeFixturePackageJson) write neither `dependencies` nor
		// `devDependencies` at all, and a real package.json commonly omits `dependencies` when
		// it has none. `pkg.dependencies ?? {}` must not throw when `dependencies` is absent - a
		// careless `name in undefined` would.
		expect(
			devDependencyOnlyPackages({ devDependencies: { vitest: "5.0.1" } }),
		).toEqual(["vitest"]);
	});

	it("flags a devDependencies-only package literally named 'constructor', 'toString', or 'hasOwnProperty' (myusage-4xu.122)", () => {
		// `name in dependencies` on a plain JSON.parse'd object returns true for these three
		// names even when `dependencies` is empty and never actually declares them - they exist
		// on every plain object via Object.prototype. Reproduced against the pre-fix `in`
		// check: all three were silently treated as "already a real dependency" and dropped
		// from the result, even though "constructor" is a real, valid, published npm package
		// name that could genuinely be devDependencies-only.
		const pkg = {
			dependencies: {},
			devDependencies: {
				constructor: "1.0.0",
				toString: "2.0.0",
				hasOwnProperty: "3.0.0",
			},
		};

		expect(devDependencyOnlyPackages(pkg)).toEqual([
			"constructor",
			"toString",
			"hasOwnProperty",
		]);
	});

	it("excludes a package listed in peerDependencies, even though it's not in dependencies (myusage-4xu.123)", () => {
		// The standard peer-dep pattern: a package a consumer is expected to supply themselves
		// is listed in both peerDependencies and devDependencies (so contributors can still run
		// it locally), never in dependencies. This repo has no peerDependencies today, but a
		// package listed there must not be flagged as a build-time offender if one is ever
		// added.
		const pkg = {
			devDependencies: { react: "18.0.0", vitest: "5.0.1" },
			peerDependencies: { react: "18.0.0" },
		};

		expect(devDependencyOnlyPackages(pkg)).toEqual(["vitest"]);
	});

	it("excludes a package listed in optionalDependencies, even though it's not in dependencies", () => {
		const pkg = {
			devDependencies: { fsevents: "2.0.0", vitest: "5.0.1" },
			optionalDependencies: { fsevents: "2.0.0" },
		};

		expect(devDependencyOnlyPackages(pkg)).toEqual(["vitest"]);
	});
});

describe("importsPackage: content-based import detection for one package name", () => {
	it("matches a default import", () => {
		// Also stands in for a named import (myusage-4xu.127): the regex only ever looks at
		// `from "vitest"`, never at what's inside the import clause before it, so a dedicated
		// "matches a named import" test using `import { describe } from "vitest"` was
		// behaviorally identical to this one - no mutation could kill one without the other.
		// Deleted as redundant rather than kept for its own sake.
		expect(importsPackage('import x from "vitest";', "vitest")).toBe(true);
	});

	it("matches a bare side-effect import", () => {
		expect(importsPackage('import "vitest";', "vitest")).toBe(true);
	});

	it("matches a dynamic import()", () => {
		expect(importsPackage('const v = await import("vitest");', "vitest")).toBe(
			true,
		);
	});

	it("matches a subpath import as importing the base package", () => {
		// vitest/config is a real subpath of the vitest package (this repo's own
		// vitest.config.ts imports it) - importing the subpath still means the built file
		// depends on vitest at runtime, so it must count as importing "vitest".
		expect(
			importsPackage('import { defineConfig } from "vitest/config";', "vitest"),
		).toBe(true);
	});

	it("does not match a bare quoted string literal exactly equal to the package name, with no import keyword before it (myusage-4xu.125)", () => {
		// Every individual IMPORT_CONTEXT alternative (from/import/import() is pinned by its
		// own positive test above, but nothing before this test discriminated the
		// overarching anchor itself: that the specifier must actually follow one of those
		// keywords, not just appear as a quoted string anywhere. This fixture's quoted string is
		// nothing BUT the package name, so an anchor-stripped mutant (IMPORT_CONTEXT replaced by
		// "") would wrongly match it - verified by hand against that exact mutant before writing
		// this test.
		//
		// A prior sibling test asserting the plainer substring case ('const msg = "please run
		// vitest to check this";') was deleted as redundant (myusage-4xu.134): every mutation
		// that flips that fixture also flips this one (verified by hand against several
		// candidate mutants - none isolate a kill unique to the substring fixture), since
		// matching "vitest" as an exact full quoted string is strictly easier to reach than
		// matching it as a mid-sentence substring inside a longer quoted string with no import
		// keyword at all.
		expect(importsPackage('const p = "vitest";', "vitest")).toBe(false);
	});

	it("does not match a different real package whose name is a literal prefix of the imported specifier", () => {
		// "vite" and "vitest" are both real, separately-published packages, and "vite" is a
		// literal prefix of "vitest" - importing "vitest/config" must not be reported as
		// importing "vite". Pins the anchored (not prefix-substring) matching this needs, and -
		// being a strictly harder case - subsumes a plainer "does not match when the package
		// isn't referenced at all" test (myusage-4xu.127: deleted as redundant, since no
		// mutation could weaken the match enough to pass that plainer case without also
		// failing this one).
		expect(
			importsPackage('import { defineConfig } from "vitest/config";', "vite"),
		).toBe(false);
	});

	it("treats a regex metacharacter in the package name literally, not as a wildcard", () => {
		// "socket.io" contains a literal dot. Without escaping it first, that dot compiles
		// into a regex wildcard matching any character, so a specifier like "socketXio" would
		// wrongly match too. Every other importsPackage test in this file uses a package name
		// with no regex metacharacters, so this is the only one that would fail if the
		// escaping helper were deleted outright.
		expect(importsPackage('import x from "socketXio";', "socket.io")).toBe(
			false,
		);
	});

	it("still matches the real package name once its metacharacter is escaped correctly", () => {
		expect(importsPackage('import x from "socket.io";', "socket.io")).toBe(
			true,
		);
	});

	it("does not match an import-shaped mention inside a // line comment (myusage-4xu.121)", () => {
		// tsconfig.build.json does not set removeComments, so tsc preserves comments into
		// dist/ - PR #117's independent reviewer found that a src/ comment merely mentioning a
		// devDependency's name in import-shaped prose (this repo's own comment style is
		// comment-heavy) false-positived, since a plain regex scan has no concept of "comment"
		// on its own. Reproduced directly against the pre-fix regex: it matched `from
		// "vitest/config"` here even though the whole line is a comment, not code.
		expect(
			importsPackage(
				'// Historical note: this file used to import defineConfig from "vitest/config".',
				"vitest",
			),
		).toBe(false);
	});

	it("does not match an import-shaped mention inside a /* block */ comment, including a JSDoc-style one", () => {
		expect(
			importsPackage(
				'/** Old header: this once imported defineConfig from "vitest/config". */\nexport const x = 1;',
				"vitest",
			),
		).toBe(false);
	});

	it("does not false-positive on a comment following a regex literal with an unescaped quote character, when the comment is on a later line (myusage-4xu.131)", () => {
		// PR #119's independent reviewer found: stripComments (this file's own STRING_OR_COMMENT
		// scan) has no concept of a regex literal - it only tracks bare `"`, `'`, and backtick
		// characters. A regex literal containing an unescaped quote (e.g. `/"/g`, as used below)
		// contains a bare `"` inside `/.../` that the scanner reads as OPENING a phantom string.
		// That flips string/comment parity for the rest of the file, so a later real `//` comment
		// is no longer recognized as a comment at all - it survives stripComments untouched, and
		// an import-shaped mention inside it (this repo's own comment-heavy style, same as the
		// myusage-4xu.121 tests above) then false-positives here. REPRODUCED directly against the
		// current regex: it returns true for this exact input.
		expect(
			importsPackage(
				[
					'const escaped = value.replace(/"/g, "&quot;");',
					'// Historical note: this file used to import defineConfig from "vitest/config".',
				].join("\n"),
				"vitest",
			),
		).toBe(false);
	});

	it("does not misread a division expression as opening a regex literal - a real comment right after it still gets stripped (regression guard)", () => {
		// Guards against the fix the myusage-4xu.131 reviewer explicitly REJECTED: adding a
		// regex-literal-matching alternative to STRING_OR_COMMENT (instead of the fix actually
		// applied - forbidding a raw newline inside the `"..."`/`'...'` branches) makes the test
		// above pass too, but introduces a NEW false negative: `a / b` would read as opening a
		// regex literal at the first `/`, consuming everything up to the next `/` - here, the
		// `//` that starts the real comment - so the comment (and the import-shaped text inside
		// it) would never be recognized as a comment at all, and this would wrongly return
		// `true`. The fix actually applied doesn't touch `/` handling at all, so this already
		// passes; it exists to keep it that way if stripComments is ever touched again.
		expect(
			importsPackage('const r = a / b; // import x from "vitest";', "vitest"),
		).toBe(false);
	});

	it("still detects a real import that follows a genuine string literal, when that string sits on the line after a regex literal with an unescaped quote character (myusage-4xu.137)", () => {
		// stripComments isn't exported here (unlike fixtures-guard.ts's copy - see that file's
		// test of the same name for the direct, byte-for-byte version of this pin); importsPackage
		// is the only exposed surface, so this pins the same PR #122 fix indirectly: a real import
		// must survive being on the same line as a genuine string literal that immediately follows
		// a regex literal containing an unescaped quote, on the line before. REPRODUCED directly
		// against the pre-fix regex (`[^"\\]` with no `\n` exclusion): the phantom string opened by
		// the regex literal's stray quote paired against the URL string's own opening quote, which
		// left the URL's unprotected remainder - and the real import statement that followed it on
		// the same line - inside what then misread as a `//` line comment stretching to end of
		// line, deleting both. importsPackage returned false there; PR #122's newline-confinement
		// fix (this is that pin) makes it correctly return true.
		expect(
			importsPackage(
				[
					'const r = /"/;',
					'const url = "http://example.com"; import x from "vitest";',
				].join("\n"),
				"vitest",
			),
		).toBe(true);
	});

	it("still recognizes a template literal that spans multiple lines as one opaque string, not a real // comment partway through it, if the backtick branch's content class is ever restricted to a single line (myusage-4xu.143)", () => {
		// The doc comment on STRING_OR_COMMENT above claims the backtick branch is "deliberately
		// left unrestricted ... since real template literals do legitimately span multiple lines" -
		// but nothing in this suite failed if that claim stopped being true. This pins it: a
		// template literal spanning three lines, whose middle line is prefixed with "//" (so it
		// would misparse as a REAL line comment - and get deleted - the moment the backtick branch
		// ever stops spanning the newline that currently keeps it part of the string). With the
		// backtick branch newline-tolerant (current code), the whole three-line span is captured as
		// one string, byte-for-byte, so the "from \"vitest\"" text on the middle line survives into
		// the scanned content and importsPackage finds it. If the backtick branch is ever narrowed
		// to `[^\`\\\n]` (mirroring the quote branches' own [^"\\\n]/[^'\\\n]), the opening backtick
		// can no longer close across that newline, the middle line is parsed fresh instead, and its
		// "//" prefix is read as a real comment and stripped - taking the only "vitest" mention with
		// it, so importsPackage would wrongly return false.
		const source = [
			"const t = `line one",
			'// import { describe } from "vitest";',
			"line three`;",
		].join("\n");

		expect(importsPackage(source, "vitest")).toBe(true);
	});

	it("still detects a real import between two separate block comments, even if the block-comment branch's content class is ever mutated to greedy (myusage-4xu.143)", () => {
		// STRING_OR_COMMENT's block-comment branch is /\*[\s\S]*?\*\//: lazy (`*?`), so each /* ...
		// */ pair matches independently. Nothing in this suite failed if that `?` were ever dropped
		// - a greedy [\s\S]* would instead match from the FIRST "/*" all the way to the LAST "*/" in
		// the remaining content, merging two separate block comments (and everything real between
		// them, including this real import) into one. With the lazy form (current code), each
		// comment is stripped on its own and the import between them survives; with a greedy content
		// class, the whole span - both comments and the import in between - collapses into a single
		// deleted match, so importsPackage would wrongly return false.
		const source = [
			"/* first comment */",
			'import { describe } from "vitest";',
			"/* second comment */",
		].join("\n");

		expect(importsPackage(source, "vitest")).toBe(true);
	});

	it("still matches a real import when a comment elsewhere in the same content merely mentions the same package", () => {
		// Proves comment-stripping only removes the comment, not the real import that follows
		// it - a fix that stripped too aggressively (e.g. from the first "//" to end of
		// content) would wrongly hide this.
		expect(
			importsPackage(
				'// mentions vitest in prose, not as an import\nimport { describe } from "vitest";',
				"vitest",
			),
		).toBe(true);
	});

	it("matches a whitespace-free 'from\"pkg\"' specifier, as a minifier would emit it (myusage-4xu.124)", () => {
		// IMPORT_CONTEXT required \bfrom\s+ (at least one whitespace char), so a minified
		// specifier with no space between "from" and the quote slipped through undetected.
		// Irrelevant to today's tsc-only, unminified build, but would matter if a bundler or
		// minifier is ever introduced into the publish pipeline.
		expect(importsPackage('import{describe}from"vitest";', "vitest")).toBe(
			true,
		);
	});

	it("matches a template-literal dynamic import specifier", () => {
		// import(`vitest`) - a dynamic import whose specifier is a template literal with no
		// interpolation - was missed entirely, since the specifier-quote capture group only
		// recognized ' and ", never a backtick.
		expect(importsPackage("const v = await import(`vitest`);", "vitest")).toBe(
			true,
		);
	});
});

describe("findDevOnlyImports: the subset of candidate packages a file's content actually imports", () => {
	it("returns only the packages the content actually imports, dropping the rest", () => {
		const content =
			'import { defineConfig } from "vitest/config";\nimport "undici";\n';

		expect(findDevOnlyImports(content, ["vitest", "tsx"])).toEqual(["vitest"]);
	});

	it("returns an empty array when none of the candidate packages are imported", () => {
		const content = 'import "undici";\n';

		expect(findDevOnlyImports(content, ["vitest", "tsx"])).toEqual([]);
	});
});
