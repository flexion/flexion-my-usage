// Behavioral tests for the pure decision logic behind scripts/check-renovate-engines.mjs (bead
// myusage-4xu.85): see scripts/renovate-engines-guard.ts's own header for the gap this closes
// (PR #81's reviewer-flagged drift risk between renovate.json's @types/node allowedVersions
// ceiling and package.json's engines.node floor) and the precise drift formula it enforces.
//
// This logic lives in scripts/renovate-engines-guard.ts, not src/ - the same reason
// scripts/fixtures-guard.ts and scripts/branch-guard.ts do, see either file's header - but it is
// still type-checked by `yarn typecheck` and gated at 100% coverage by `yarn test` like every
// other file this project cares about, via vitest.config.ts's coverage.include. The other half of
// the bead's fix - proving scripts/check-renovate-engines.mjs actually calls this module, reads
// the real package.json/renovate.json, and exits non-zero for real - is covered separately in
// src/check-renovate-engines.integration.test.ts, the same split src/branch-guard.test.ts and
// src/check-branch-guard.integration.test.ts already use.
import { describe, expect, it } from "vitest";
import {
	checkRenovateEnginesGuard,
	findTypesNodeRule,
	formatSemVer,
	formatViolation,
	nextMinorCeiling,
	parseCeiling,
	parseFloor,
	sameSemVer,
} from "../scripts/renovate-engines-guard.js";

describe("parseFloor", () => {
	it("parses a well-formed engines.node floor", () => {
		expect(parseFloor(">=22.13.0")).toEqual({ major: 22, minor: 13, patch: 0 });
	});

	it("parses a floor with a non-zero patch", () => {
		expect(parseFloor(">=22.15.2")).toEqual({ major: 22, minor: 15, patch: 2 });
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseFloor("  >=22.13.0  ")).toEqual({
			major: 22,
			minor: 13,
			patch: 0,
		});
	});

	it("rejects a value with no comparator", () => {
		expect(parseFloor("22.13.0")).toBeUndefined();
	});

	it("rejects a range with a second bound - only a single floor is supported", () => {
		expect(parseFloor(">=22.13.0 <23.0.0")).toBeUndefined();
	});

	it("rejects a non-numeric version segment", () => {
		expect(parseFloor(">=22.x.0")).toBeUndefined();
	});

	it("rejects an empty string", () => {
		expect(parseFloor("")).toBeUndefined();
	});

	it("rejects extra content before the comparator - the leading anchor isn't satisfied by a substring match", () => {
		expect(parseFloor("x>=22.13.0")).toBeUndefined();
	});
});

describe("parseCeiling", () => {
	it("parses a well-formed allowedVersions ceiling", () => {
		expect(parseCeiling("<22.14.0")).toEqual({
			major: 22,
			minor: 14,
			patch: 0,
		});
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseCeiling("  <22.14.0  ")).toEqual({
			major: 22,
			minor: 14,
			patch: 0,
		});
	});

	it("rejects a value with no comparator", () => {
		expect(parseCeiling("22.14.0")).toBeUndefined();
	});

	it("rejects the wrong comparator (>= instead of <)", () => {
		expect(parseCeiling(">=22.14.0")).toBeUndefined();
	});

	it("rejects a non-numeric version segment", () => {
		expect(parseCeiling("<22.x.0")).toBeUndefined();
	});

	it("rejects extra content before the comparator - the leading anchor isn't satisfied by a substring match", () => {
		expect(parseCeiling("x<22.14.0")).toBeUndefined();
	});

	it("rejects extra content after the version - the trailing anchor isn't satisfied by a prefix match", () => {
		expect(parseCeiling("<22.14.0x")).toBeUndefined();
	});

	it("rejects a <= comparator - only a strict < ceiling is supported", () => {
		expect(parseCeiling("<=22.14.0")).toBeUndefined();
	});

	it("rejects a compound OR range", () => {
		expect(parseCeiling("<22.14.0 || >=23.0.0")).toBeUndefined();
	});

	it("rejects a space-separated compound range", () => {
		expect(parseCeiling(">=22.13.0 <22.14.0")).toBeUndefined();
	});

	it("rejects a caret range", () => {
		expect(parseCeiling("^22.13.0")).toBeUndefined();
	});
});

describe("nextMinorCeiling", () => {
	it("increments the minor line and resets patch to zero, keeping major unchanged", () => {
		expect(nextMinorCeiling({ major: 22, minor: 13, patch: 0 })).toEqual({
			major: 22,
			minor: 14,
			patch: 0,
		});
	});

	it("drops the floor's own non-zero patch entirely - the ceiling never carries it", () => {
		expect(nextMinorCeiling({ major: 22, minor: 15, patch: 2 })).toEqual({
			major: 22,
			minor: 16,
			patch: 0,
		});
	});
});

describe("sameSemVer", () => {
	it("is true for identical major/minor/patch", () => {
		expect(
			sameSemVer(
				{ major: 22, minor: 14, patch: 0 },
				{ major: 22, minor: 14, patch: 0 },
			),
		).toBe(true);
	});

	it("is false when only the minor differs", () => {
		expect(
			sameSemVer(
				{ major: 22, minor: 14, patch: 0 },
				{ major: 22, minor: 15, patch: 0 },
			),
		).toBe(false);
	});

	it("is false when only the patch differs", () => {
		expect(
			sameSemVer(
				{ major: 22, minor: 14, patch: 0 },
				{ major: 22, minor: 14, patch: 1 },
			),
		).toBe(false);
	});

	it("is false when only the major differs", () => {
		expect(
			sameSemVer(
				{ major: 22, minor: 14, patch: 0 },
				{ major: 23, minor: 14, patch: 0 },
			),
		).toBe(false);
	});
});

describe("formatSemVer", () => {
	it("formats major.minor.patch with no comparator prefix", () => {
		expect(formatSemVer({ major: 22, minor: 14, patch: 0 })).toBe("22.14.0");
	});
});

describe("findTypesNodeRule", () => {
	it("finds the entry whose matchPackageNames includes @types/node", () => {
		const rules = [
			{ matchPackageNames: ["undici"], allowedVersions: "<9.0.0" },
			{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
		];

		expect(findTypesNodeRule(rules)).toBe(rules[1]);
	});

	it("returns undefined when no entry matches", () => {
		const rules = [
			{ matchPackageNames: ["undici"], allowedVersions: "<9.0.0" },
		];

		expect(findTypesNodeRule(rules)).toBeUndefined();
	});

	it("returns undefined for an empty packageRules array", () => {
		expect(findTypesNodeRule([])).toBeUndefined();
	});

	it("does not match an entry with no matchPackageNames at all", () => {
		const rules = [{ allowedVersions: "<9.0.0" }];

		expect(findTypesNodeRule(rules)).toBeUndefined();
	});

	it("returns the first matching entry when more than one exists", () => {
		const rules = [
			{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
			{ matchPackageNames: ["@types/node"], allowedVersions: "<99.0.0" },
		];

		expect(findTypesNodeRule(rules)).toBe(rules[0]);
	});
});

describe("checkRenovateEnginesGuard", () => {
	it("passes (no violations) when the ceiling matches the floor's next minor line - the real PR #81 shape", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
			],
		});

		expect(result).toEqual([]);
	});

	it("passes when the floor carries a non-zero patch that the ceiling correctly drops", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.15.2",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.16.0" },
			],
		});

		expect(result).toEqual([]);
	});

	it("flags ceiling-drift when the floor moved but renovate.json's ceiling did not - the deliberately-introduced mismatch the acceptance criteria calls for (engines.node bumped to >=22.15.0, allowedVersions left at <22.14.0)", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.15.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
			],
		});

		expect(result).toEqual([
			{
				kind: "ceiling-drift",
				floor: "22.15.0",
				actualCeiling: "22.14.0",
				expectedCeiling: "22.16.0",
			},
		]);
	});

	it("flags ceiling-drift when the ceiling is ahead of what the floor requires, not just behind", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.20.0" },
			],
		});

		expect(result).toEqual([
			{
				kind: "ceiling-drift",
				floor: "22.13.0",
				actualCeiling: "22.20.0",
				expectedCeiling: "22.14.0",
			},
		]);
	});

	it("flags ceiling-drift when only the ceiling's major differs from the expected next-minor ceiling", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<23.14.0" },
			],
		});

		expect(result).toEqual([
			{
				kind: "ceiling-drift",
				floor: "22.13.0",
				actualCeiling: "23.14.0",
				expectedCeiling: "22.14.0",
			},
		]);
	});

	it("flags ceiling-drift when only the ceiling's patch differs from the required .0", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.1" },
			],
		});

		expect(result).toEqual([
			{
				kind: "ceiling-drift",
				floor: "22.13.0",
				actualCeiling: "22.14.1",
				expectedCeiling: "22.14.0",
			},
		]);
	});

	it("flags unparseable-floor when engines.node is missing entirely", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: undefined,
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
			],
		});

		expect(result).toEqual([
			{ kind: "unparseable-floor", enginesNode: undefined },
		]);
	});

	it("flags unparseable-floor when engines.node is not in the >=X.Y.Z form", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: "22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "<22.14.0" },
			],
		});

		expect(result).toEqual([
			{ kind: "unparseable-floor", enginesNode: "22.13.0" },
		]);
	});

	it("flags missing-rule when renovate.json has no @types/node packageRules entry", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["undici"], allowedVersions: "<9.0.0" },
			],
		});

		expect(result).toEqual([{ kind: "missing-rule" }]);
	});

	it("flags missing-rule when the @types/node entry exists but carries no allowedVersions", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [{ matchPackageNames: ["@types/node"] }],
		});

		expect(result).toEqual([{ kind: "missing-rule" }]);
	});

	it("flags unparseable-ceiling when allowedVersions is not in the <X.Y.Z form", () => {
		const result = checkRenovateEnginesGuard({
			enginesNode: ">=22.13.0",
			packageRules: [
				{ matchPackageNames: ["@types/node"], allowedVersions: "22.14.0" },
			],
		});

		expect(result).toEqual([
			{ kind: "unparseable-ceiling", allowedVersions: "22.14.0" },
		]);
	});
});

describe("formatViolation", () => {
	it("names the missing engines.node explicitly, not as an empty string", () => {
		const message = formatViolation({
			kind: "unparseable-floor",
			enginesNode: undefined,
		});

		expect(message).toMatch(/\(missing\)/);
		expect(message).toMatch(/engines\.node/);
	});

	it("quotes a malformed engines.node value", () => {
		const message = formatViolation({
			kind: "unparseable-floor",
			enginesNode: "22.13.0",
		});

		expect(message).toMatch(/"22\.13\.0"/);
	});

	it("names @types/node and packageRules for a missing rule", () => {
		const message = formatViolation({ kind: "missing-rule" });

		expect(message).toMatch(/@types\/node/);
		expect(message).toMatch(/packageRules/);
	});

	it("quotes a malformed allowedVersions value", () => {
		const message = formatViolation({
			kind: "unparseable-ceiling",
			allowedVersions: "22.14.0",
		});

		expect(message).toMatch(/"22\.14\.0"/);
	});

	it("names the floor, the actual ceiling, and the expected ceiling for a drift violation", () => {
		const message = formatViolation({
			kind: "ceiling-drift",
			floor: "22.15.0",
			actualCeiling: "22.14.0",
			expectedCeiling: "22.16.0",
		});

		expect(message).toMatch(/floor \(">=22\.15\.0"\)/);
		expect(message).toMatch(/<22\.14\.0/);
		// myusage-4xu.91: expectedCeiling is interpolated TWICE in the real message - once in the
		// "expected ..." clause, once in the remedy sentence. Asserting `/<22\.16\.0/` alone left
		// this green even if either interpolation were deleted, since the other occurrence still
		// matched. Pinning both phrases specifically, not just presence of the raw value anywhere
		// in the string, is what catches either mutation.
		expect(message).toMatch(/expected "<22\.16\.0"/);
		expect(message).toMatch(
			/Update renovate\.json's allowedVersions to "<22\.16\.0"/,
		);
	});
});
