// Pure decision logic for the round-cap/critical-persisted check bead-drain.md's clause (a)
// describes: "stop the instant a CRITICAL flag survives a fix round" - the SAME critical,
// by identity, still present after a fix round. That is NOT the same thing as "a critical
// exists this round AND a critical existed last round" (a boolean AND with no identity
// check) - the bug this module fixes (bead myusage-4xu.25). That boolean-AND shape caused
// three false escalations in one day (myusage-4xu.19, myusage-c2a twice) across
// independently-authored, ephemeral pipeline scripts, because there was no shared, tested
// implementation and every session re-derived the check from bead-drain.md's prose from
// scratch. See myusage-5ai for the decision to fix this structurally with a shared module
// instead of patching any one script.
//
// Lives under scripts/, not src/ - same convention, and the same reasoning, as
// scripts/package-rules.ts (see that file's header comment): this is tooling for the
// bead-drain automation loop itself, not part of the my-usage-standalone product, and src/'s
// rootDir feeds `yarn build` - nothing under src/ should ship in dist/ unless it's actually
// part of the product. Still type-checked (tsconfig.config.json's `include`) and covered at
// 100% (vitest.config.ts's coverage.include) like everything else in this repo, via the same
// non-src explicit-path precedent package-rules.ts already established.
//
// Identity rule (the exact thing the original bug got wrong): two critical flags are the SAME
// critical only when they match by `id` (when BOTH sides carry one that is non-empty - a
// reviewer-assigned per-round label like "F1" is not guaranteed to mean the same defect two
// rounds running, so an id match only counts when it's a comparison of two ids that both
// actually exist AND are non-empty; an empty string is not a real id, so it is treated as
// absent, same as no id at all - see myusage-4xu.48) or, failing that, by an exact (never
// substring) match on `evidence` (trimmed; blank evidence never counts as a match against
// anything - not against another blank, since blank carries no more identity information than
// a missing id, and not against real evidence, since a blank string can never equal a non-blank
// one) - the reviewer's own description of what the flag is about. Merely having a critical in
// both rounds' lists is not enough; one of the current round's flags must be the SAME flag as
// one of the previous round's by one of those two keys. No prior-round criticals, or no
// current-round criticals, can never count as "persisted" - there is nothing for a current flag
// to match against.

/** One critical-severity flag a test-review round raised. `evidence` is required - even a
 * flag that carries a stable `id` still has its own description - because `evidence` is the
 * identity fallback whenever `id` can't be trusted for comparison (see the header comment
 * above for exactly when that is). */
export interface CriticalFlag {
	/** A stable identifier for this flag, when one exists (e.g. a tracked issue id, not a
	 * reviewer's per-round slot label). Compared for equality only when BOTH the current and
	 * previous flag carry one. */
	id?: string;
	/** The reviewer's evidence or description of what the flag is about. Used as the identity
	 * key whenever `id` is missing on either side. */
	evidence: string;
}

/** The result of comparing a round's critical flag(s) against the immediately preceding
 * round's. `current` and `previous` are the matched pair when `persisted` is true, so a
 * caller can build an escalation message that names the actual surviving flag instead of just
 * reporting a boolean. */
export interface CriticalPersistenceResult {
	/** Whether a current-round critical flag is the SAME critical (by identity) as a
	 * previous-round one. */
	persisted: boolean;
	/** The current-round flag that persisted. Present only when `persisted` is true. */
	current?: CriticalFlag;
	/** The previous-round flag `current` matched. Present only when `persisted` is true. */
	previous?: CriticalFlag;
}

function normalizeEvidence(evidence: string): string {
	return evidence.trim();
}

/** Whether `flag` carries a real, present `id` - present and non-empty. An empty string is not
 * a real identifier (it carries no more identity information than a missing one), so it is
 * treated as absent rather than as a real id value that trivially equals another empty id. */
function hasId(flag: CriticalFlag): boolean {
	return flag.id !== undefined && flag.id !== "";
}

/** Whether `a` and `b` are the SAME critical flag, per the identity rule in this file's
 * header comment: matched by `id` when both sides carry one that is non-empty, otherwise by an
 * exact (trimmed, non-empty) match on `evidence`. A flag with a real `id` on only one side
 * still falls back to `evidence` - a one-sided id proves nothing about identity, since there is
 * no matching id on the other side to compare it against. Blank (post-trim) evidence never
 * counts as a match, even against another blank evidence string, for the same reason an empty
 * id doesn't: no real identity information to compare. */
export function sameCriticalFlag(a: CriticalFlag, b: CriticalFlag): boolean {
	if (hasId(a) && hasId(b)) {
		return a.id === b.id;
	}
	const normalizedA = normalizeEvidence(a.evidence);
	const normalizedB = normalizeEvidence(b.evidence);
	// Both conjuncts here are individually droppable with the full test suite staying green:
	// whenever exactly one side is blank, the fallthrough `normalizedA === normalizedB` below
	// already returns false on its own (a blank string can never equal a non-blank one), so only
	// the both-blank case strictly needs this guard. Kept as a two-sided `&&` rather than
	// collapsed to a single-sided check for readability - a lone `normalizedA === ""` (or the
	// mirror `normalizedB === ""`) would read as an asymmetric, likely-buggy guard to a future
	// maintainer, even though it would be behaviorally equivalent to this one.
	if (normalizedA === "" && normalizedB === "") {
		return false;
	}
	return normalizedA === normalizedB;
}

/** Whether a critical genuinely "persisted" from the previous round into the current one: the
 * SAME critical (by `sameCriticalFlag`) appears in both `currentRoundCriticals` and
 * `previousRoundCriticals`. A different, unrelated critical appearing after a prior one was
 * fixed does NOT count - see the header comment's identity rule. Either list being empty
 * (no critical this round, or none last round) can never yield `persisted: true`: there is
 * nothing on one side for the other side to match. */
export function criticalPersisted(
	currentRoundCriticals: readonly CriticalFlag[],
	previousRoundCriticals: readonly CriticalFlag[],
): CriticalPersistenceResult {
	for (const current of currentRoundCriticals) {
		for (const previous of previousRoundCriticals) {
			if (sameCriticalFlag(current, previous)) {
				return { persisted: true, current, previous };
			}
		}
	}
	return { persisted: false };
}
