// Behavioral tests for the pure decision logic behind scripts/check-package.mjs
// (bead myusage-4xu.19). scripts/ sits outside tsconfig.json's `include` and outside
// vitest's coverage.include, so this file does not gate on coverage; it exists to prove
// the three fixed behaviors with plain data, per AGENTS.md's "extract to a pure function"
// rule - none of this needs a real npm invocation or a real dist/ tree on disk.
//
// The module under test does not exist yet (GREEN adds it). Importing it fails today
// with a module-resolution error, which is the expected RED signal.
import { describe, expect, it } from "vitest";
import {
	filterTestOrSupportPaths,
	isUnderDir,
	packListCoversDist,
} from "../scripts/check-package-rules.mjs";

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
		// npm's own JSON output is POSIX-style, but the check itself must not assume
		// that of every path it is ever given - the rest of the script normalizes via
		// basename() rather than hardcoding a separator, and this must do the same.
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

	it("still counts a match when dist entries use native (backslash) separators", () => {
		const distFiles = ["dist\\index.js"];
		const packedFiles = ["dist/index.js"];

		expect(packListCoversDist(distFiles, packedFiles)).toBe(true);
	});

	it("treats an empty dist as vacuously covered by an empty pack count (0 >= 0)", () => {
		// Guarding against an empty dist/ is check-package.mjs's separate, already-correct
		// "dist/ is empty" exit-2 path; this function only owns the coverage comparison.
		expect(packListCoversDist([], [])).toBe(true);
	});
});
