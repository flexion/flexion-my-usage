// Behavioral tests for the round-cap/critical-persisted decision logic (bead myusage-4xu.25,
// re-scoped by myusage-5ai) that lives in scripts/critical-persisted.ts, not src/ - same
// non-product, build/tooling-only placement as scripts/package-rules.ts (see that file's
// header comment, and src/package-rules.test.ts's own header comment, for why). This test
// file lives under src/ anyway, specifically so vitest's `test.include: ["src/**/*.test.ts"]`
// glob in vitest.config.ts picks it up; the module it tests is still type-checked
// (tsconfig.config.json's `include`) and covered at 100% (vitest.config.ts's
// coverage.include) via the same explicit non-src path precedent.
//
// The acceptance criteria this file proves: (1) the true-positive case - the SAME critical,
// by identity, persists across two rounds, and IS reported as persisted; (2) the exact
// false-positive the original bug got wrong - a critical existed last round, a DIFFERENT
// critical exists this round, and the prior one is NOT reported as persisted; (3) the "no
// critical last round" and "no critical this round" base cases, neither of which can ever
// report persisted.
import { describe, expect, it } from "vitest";
import {
	type CriticalFlag,
	criticalPersisted,
	sameCriticalFlag,
} from "../scripts/critical-persisted.js";

describe("sameCriticalFlag: the identity rule itself", () => {
	it("matches two flags with the same id, ignoring differing evidence text", () => {
		const a: CriticalFlag = { id: "BUG-1", evidence: "round 1 description" };
		const b: CriticalFlag = {
			id: "BUG-1",
			evidence: "round 2 description, reworded",
		};

		expect(sameCriticalFlag(a, b)).toBe(true);
	});

	it("does not match two flags with different ids, even with identical evidence text", () => {
		// A per-round reviewer slot label ("F1") is not a stable identifier across rounds -
		// but if two flags DO both carry real, differing ids, that's decisive on its own:
		// an id mismatch means a different defect even if the description text happens to
		// coincide.
		const a: CriticalFlag = { id: "F1", evidence: "same wording" };
		const b: CriticalFlag = { id: "F2", evidence: "same wording" };

		expect(sameCriticalFlag(a, b)).toBe(false);
	});

	it("falls back to evidence when only one side carries an id", () => {
		// A one-sided id proves nothing about identity - there's no matching id on the other
		// side to compare it against - so this must fall back to the evidence comparison
		// rather than treating the presence of an id on either side as decisive.
		const withId: CriticalFlag = {
			id: "F1",
			evidence: "null pointer in aggregate()",
		};
		const withoutId: CriticalFlag = { evidence: "null pointer in aggregate()" };

		expect(sameCriticalFlag(withId, withoutId)).toBe(true);
		expect(sameCriticalFlag(withoutId, withId)).toBe(true);
	});

	it("falls back to evidence when neither side carries an id, and evidence matches", () => {
		const a: CriticalFlag = {
			evidence: "off-by-one in pricing-table row index",
		};
		const b: CriticalFlag = {
			evidence: "off-by-one in pricing-table row index",
		};

		expect(sameCriticalFlag(a, b)).toBe(true);
	});

	it("does not match on evidence when neither side carries an id and the text differs", () => {
		const a: CriticalFlag = {
			evidence: "off-by-one in pricing-table row index",
		};
		const b: CriticalFlag = { evidence: "unhandled rejection in proxy.ts" };

		expect(sameCriticalFlag(a, b)).toBe(false);
	});

	it("trims evidence before comparing, so incidental surrounding whitespace doesn't defeat a real match", () => {
		const a: CriticalFlag = { evidence: "  same defect, same wording  " };
		const b: CriticalFlag = { evidence: "same defect, same wording" };

		expect(sameCriticalFlag(a, b)).toBe(true);
	});
});

describe("criticalPersisted: the round-over-round check", () => {
	it("true positive - reports persisted when the SAME critical (by id) survives a fix round", () => {
		const previousRound: CriticalFlag[] = [
			{
				id: "F1",
				evidence: "aggregate() drops the last row on a leap-year boundary",
			},
		];
		const currentRound: CriticalFlag[] = [
			{
				id: "F1",
				evidence:
					"aggregate() still drops the last row on a leap-year boundary",
			},
		];

		const result = criticalPersisted(currentRound, previousRound);

		expect(result.persisted).toBe(true);
		expect(result.current).toBe(currentRound[0]);
		expect(result.previous).toBe(previousRound[0]);
	});

	it("true positive - reports persisted when the SAME critical (by evidence, no id) survives a fix round", () => {
		const previousRound: CriticalFlag[] = [
			{ evidence: "pricing cache never invalidates on a currency change" },
		];
		const currentRound: CriticalFlag[] = [
			{ evidence: "pricing cache never invalidates on a currency change" },
		];

		const result = criticalPersisted(currentRound, previousRound);

		expect(result.persisted).toBe(true);
		expect(result.current).toBe(currentRound[0]);
		expect(result.previous).toBe(previousRound[0]);
	});

	it("false positive the original bug got wrong - a DIFFERENT critical after the prior one was resolved is NOT persisted", () => {
		// This is exactly the myusage-4xu.19 / myusage-c2a shape: round 1's F1 was fixed and
		// is gone; round 2 raises a new, unrelated F6. The old `hadCriticalLastRound` boolean
		// AND would wrongly report this as persisted. It must not.
		const previousRound: CriticalFlag[] = [
			{
				id: "F1",
				evidence: "aggregate() drops the last row on a leap-year boundary",
			},
		];
		const currentRound: CriticalFlag[] = [
			{ id: "F6", evidence: "render() throws on an empty sources list" },
		];

		const result = criticalPersisted(currentRound, previousRound);

		expect(result.persisted).toBe(false);
		expect(result.current).toBeUndefined();
		expect(result.previous).toBeUndefined();
	});

	it("base case - no critical this round can never be persisted, regardless of last round", () => {
		const previousRound: CriticalFlag[] = [
			{
				id: "F1",
				evidence: "aggregate() drops the last row on a leap-year boundary",
			},
		];

		expect(criticalPersisted([], previousRound).persisted).toBe(false);
	});

	it("base case - no critical last round can never be persisted, regardless of this round", () => {
		const currentRound: CriticalFlag[] = [
			{ id: "F6", evidence: "render() throws on an empty sources list" },
		];

		expect(criticalPersisted(currentRound, []).persisted).toBe(false);
	});

	it("base case - no critical in either round is not persisted", () => {
		expect(criticalPersisted([], []).persisted).toBe(false);
	});

	it("matches against the right prior flag when either round carries several criticals", () => {
		const previousRound: CriticalFlag[] = [
			{ id: "F1", evidence: "first defect" },
			{ id: "F2", evidence: "second defect" },
		];
		const currentRound: CriticalFlag[] = [
			{ id: "F9", evidence: "a brand-new, unrelated defect" },
			{ id: "F2", evidence: "second defect, still present" },
		];

		const result = criticalPersisted(currentRound, previousRound);

		expect(result.persisted).toBe(true);
		expect(result.current).toBe(currentRound[1]);
		expect(result.previous).toBe(previousRound[1]);
	});
});
