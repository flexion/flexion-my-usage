// Behavioral tests for the pure decision logic behind scripts/check-package.mjs (bead
// myusage-4xu.19): the pack-list vacuity check, the separator-safe directory-prefix check,
// and the test-or-support name pattern.
//
// This logic lives in src/package-rules.ts, not under scripts/ - so it is type-checked by
// `yarn typecheck`, gated at 100% coverage by `yarn test` like every other file under src/,
// and never needs a real npm invocation or a real dist/ tree on disk. The other half of the
// bead's fix - proving check-package.mjs actually calls this module instead of keeping its
// old, buggy checks - is covered separately in src/check-package.integration.test.ts, which
// runs the real script against a real dist/ and a real `npm pack --dry-run`.
//
// The module under test does not exist yet (GREEN adds it). Importing it fails today
// with a module-resolution error, which is the expected RED signal.
import { describe, expect, it } from "vitest";
import {
	filterTestOrSupportPaths,
	isUnderDir,
	packListCoversDist,
} from "./package-rules.js";

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

		expect(packListCoversDist(distFiles, packedFiles)).toBe(false);
	});

	it("passes when the pack list holds every dist entry", () => {
		const distFiles = ["dist/index.js", "dist/lib.js"];
		const packedFiles = ["dist/index.js", "dist/lib.js", "package.json"];

		expect(packListCoversDist(distFiles, packedFiles)).toBe(true);
	});

	it("fails when dist entries use native (backslash) separators and only the unnormalized count is compared", () => {
		// Isolates normalization of the DIST side. Both real dist/a.js and dist/b.js are
		// backslash-separated (as node:path's join() would produce on a real Windows
		// runner); only one of the two shows up, unnormalized, in the packed list. A
		// comparison that does not normalize the dist side undercounts it as 0 (neither
		// "dist\a.js" nor "dist\b.js" starts with "dist/"), so 1 >= 0 wrongly passes;
		// normalized, dist counts 2 and 1 >= 2 correctly fails.
		const distFiles = ["dist\\a.js", "dist\\b.js"];
		const packedFiles = ["dist/a.js"];

		expect(packListCoversDist(distFiles, packedFiles)).toBe(false);
	});

	it("still counts a match when the packed list uses native (backslash) separators", () => {
		// Isolates normalization of the PACKED side - the side npm actually emits on a
		// Windows runner. A comparison that does not normalize the packed side
		// undercounts it as 0 ("dist\a.js" does not start with "dist/"), so 0 >= 1
		// wrongly fails; normalized, packed counts 1 and 1 >= 1 correctly passes.
		const distFiles = ["dist/a.js"];
		const packedFiles = ["dist\\a.js"];

		expect(packListCoversDist(distFiles, packedFiles)).toBe(true);
	});

	it("treats an empty dist as vacuously covered by an empty pack count (0 >= 0)", () => {
		// check-package.mjs already exits 2 before this function is ever called when
		// dist/ is empty (its own, separate "dist/ is empty" guard) - this input never
		// reaches production code. This case only pins the contract for documentation:
		// no branch or special case should exist in packListCoversDist for it. The plain
		// count comparison already returns true for 0 >= 0, at zero implementation cost.
		expect(packListCoversDist([], [])).toBe(true);
	});
});
