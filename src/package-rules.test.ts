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
	filterTestOrSupportPaths,
	isUnderDir,
	packListCoversDist,
} from "../scripts/package-rules.js";

describe("filterTestOrSupportPaths: the test-or-support name pattern and its offender filter", () => {
	it("flags a fixtures file and a spec file", () => {
		const paths = [
			"src/pricing.fixtures.ts",
			"src/pricing-table.spec.ts",
			"src/aggregate.test.ts",
		];

		expect(filterTestOrSupportPaths(paths)).toEqual([
			"src/pricing.fixtures.ts",
			"src/pricing-table.spec.ts",
			"src/aggregate.test.ts",
		]);
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
		// __mocks__ sits at a fixed, non-first segment (dist/sources/__mocks__/...), not at a
		// fixed index, and two more real directories (nested/, then deep/) sit between it and
		// the file - a non-immediate ancestor, not the immediate parent segment. This only
		// passes if the check walks every ancestor segment, not just the last one, and not
		// just a fixed index: a fixture with __mocks__ pinned to path-segment index 1 (e.g.
		// dist/__mocks__/nested/deep/file.js) would also pass a buggy "check only
		// segments[1]" implementation, so this fixture puts __mocks__ one level deeper.
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
