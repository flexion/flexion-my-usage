// Pure decision logic behind scripts/check-renovate-engines.mjs (bead myusage-4xu.85): whether
// renovate.json's @types/node packageRules entry's `allowedVersions` ceiling still corresponds
// to package.json's `engines.node` floor.
//
// Background: PR #81 added a renovate.json rule (`allowedVersions: "<22.14.0"`) pinning
// @types/node to the 22.13.x line, matching engines.node's `>=22.13.0` floor. The reviewer
// flagged that the ceiling is a hardcoded literal with nothing tying it to engines.node's real
// value - if the floor is ever raised (say, to `>=22.15.0`) without also updating renovate.json,
// this rule would silently keep rejecting every valid @types/node update forever, with no CI
// signal that the two values drifted apart. This module is the drift check; the caller
// (scripts/check-renovate-engines.mjs) wires it to real file reads and exits non-zero when it
// finds a violation.
//
// The drift rule, precisely: engines.node's floor and renovate.json's ceiling are related by a
// formula, not string equality - given a floor `X.Y.Z`, the ONLY correct ceiling is `X.(Y+1).0`:
// same major, minor incremented by one, patch reset to zero ("the next minor line above the
// floor"). A floor of `22.13.0` requires a ceiling of exactly `22.14.0`; a floor of `22.15.2`
// requires `22.16.0` (the floor's own patch, 2, plays no part in the ceiling - only its major and
// minor do). This mirrors Renovate's own `minimumReleaseAge`-adjacent pinning idiom: the ceiling
// exists to keep @types/node from running ahead of the runtime floor tsc type-checks against, so
// it always tracks the floor's minor line, never its patch.
//
// Lives under scripts/, not src/, following the same convention scripts/package-rules.ts,
// scripts/critical-persisted.ts, scripts/fixtures-guard.ts and scripts/branch-guard.ts all
// already established (see any of their header comments for the fuller reasoning): this is
// build-time-only tooling, and src/'s rootDir feeds `yarn build`, so a checker module must never
// itself ship inside dist/. Still type-checked (tsconfig.config.json's `include`) and covered at
// 100% (vitest.config.ts's coverage.include) like every other file this project cares about, via
// the same non-src explicit-path precedent those four files already set.
//
// A comment-and-string-aware regex scan is overkill here - unlike fixtures-guard.ts and
// branch-guard.ts, this module never reads source code, only two short, already-JSON-parsed
// strings (package.json's engines.node value and renovate.json's allowedVersions value) the
// driver hands it. A small anchored regex per string is enough; no dependency on a semver parsing
// library is needed for a two-part "next minor line" comparison this narrow.
//
// Fails CLOSED by design, the same direction every sibling guard in this repo takes: a value that
// doesn't parse (a missing engines.node, a missing @types/node packageRules entry, an
// allowedVersions string not shaped like "<X.Y.Z") is reported as a violation, not silently
// skipped - an unexpected shape here is exactly the kind of drift a human should look at, not a
// reason to let `yarn lint` pass quietly.

export interface SemVer {
	major: number;
	minor: number;
	patch: number;
}

/** The subset of a real renovate.json packageRules entry this guard reads. Every other field a
 * real entry carries (matchManagers, description, minimumReleaseAge, ...) is irrelevant to this
 * check and intentionally not modeled here. */
export interface TypesNodePackageRule {
	matchPackageNames?: readonly string[];
	allowedVersions?: string;
}

export interface RenovateEnginesGuardInput {
	/** package.json's `engines.node` value, e.g. ">=22.13.0" - undefined when package.json has
	 * no `engines.node` key at all (the driver passes through `pkg.engines?.node` unchanged, so
	 * this guard can report that absence as its own violation instead of the driver crashing on
	 * a missing property). */
	enginesNode: string | undefined;
	/** renovate.json's `packageRules` array, already JSON.parse'd by the driver. */
	packageRules: readonly TypesNodePackageRule[];
}

export type RenovateEnginesGuardViolation =
	| {
			kind: "unparseable-floor";
			/** The raw engines.node value that failed to parse, or undefined if the key was
			 * missing entirely. */
			enginesNode: string | undefined;
	  }
	| {
			kind: "missing-rule";
	  }
	| {
			kind: "unparseable-ceiling";
			/** The raw allowedVersions value that failed to parse. */
			allowedVersions: string;
	  }
	| {
			kind: "ceiling-drift";
			/** The parsed engines.node floor, formatted "X.Y.Z" (no ">="). */
			floor: string;
			/** The parsed renovate.json ceiling, formatted "X.Y.Z" (no "<"). */
			actualCeiling: string;
			/** The ceiling `floor` actually requires, formatted "X.Y.Z" (no "<"). */
			expectedCeiling: string;
	  };

// Anchored (^...$) so a value carrying anything beyond a plain ">=X.Y.Z"/"<X.Y.Z" - a range with
// a second bound, trailing whitespace the .trim() below didn't already strip because it was
// internal, a pre-release suffix - is treated as unparseable (a violation) rather than silently
// matched on a prefix. package.json's real engines.node and renovate.json's real allowedVersions
// have never been anything but these exact shapes in this repo; a future value that needs
// something richer is a reason to revisit this guard deliberately, not a case to guess at here.
const FLOOR_PATTERN = /^>=(\d+)\.(\d+)\.(\d+)$/;
const CEILING_PATTERN = /^<(\d+)\.(\d+)\.(\d+)$/;

/** Parses an `engines.node`-shaped string (">=X.Y.Z") into its floor SemVer, or undefined if it
 * isn't in that exact form. */
export function parseFloor(enginesNode: string): SemVer | undefined {
	const raw = FLOOR_PATTERN.exec(enginesNode.trim());
	if (raw === null) return undefined;
	// FLOOR_PATTERN has exactly three required capturing groups, each requiring at least one
	// digit (\d+) - a successful match always fills indices 1-3. noUncheckedIndexedAccess types
	// RegExpExecArray's indexed access as `string | undefined` regardless, so this cast
	// documents that guarantee instead of leaving an unreachable `undefined` branch no real
	// input could ever take - the same reasoning scripts/fixtures-guard.ts's allCaptures and
	// scripts/branch-guard.ts's checkBranchGuard document for their own regex matches.
	const match = raw as unknown as [string, string, string, string];
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

/** Parses an `allowedVersions`-shaped string ("<X.Y.Z") into its ceiling SemVer, or undefined if
 * it isn't in that exact form. Same parsing shape as parseFloor, mirrored rather than shared: the
 * two patterns differ by their leading comparator (">=" vs "<"), and collapsing them into one
 * parameterized function would trade a one-character regex difference for an extra layer of
 * indirection neither caller needs. */
export function parseCeiling(allowedVersions: string): SemVer | undefined {
	const raw = CEILING_PATTERN.exec(allowedVersions.trim());
	if (raw === null) return undefined;
	const match = raw as unknown as [string, string, string, string];
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

/** The formula this whole guard exists to enforce: the ONLY correct ceiling for a given floor is
 * the next minor line above it - same major, minor incremented by one, patch reset to zero. See
 * this file's header for the worked examples (22.13.0 -> 22.14.0, 22.15.2 -> 22.16.0). */
export function nextMinorCeiling(floor: SemVer): SemVer {
	return { major: floor.major, minor: floor.minor + 1, patch: 0 };
}

export function sameSemVer(a: SemVer, b: SemVer): boolean {
	return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

export function formatSemVer(v: SemVer): string {
	return `${v.major}.${v.minor}.${v.patch}`;
}

/** Finds renovate.json's @types/node packageRules entry - the one PR #81 added to pin
 * @types/node to the same minor line as package.json's engines.node floor. Matched on
 * matchPackageNames including "@types/node" only: matchManagers is not required to be exactly
 * ["npm"], since nothing about this guard's drift check depends on which manager the rule
 * targets, only on the allowedVersions ceiling it sets for this one package name. The first
 * matching entry wins if more than one exists; this repo has never had more than one, and
 * arbitrating between two differently-scoped @types/node rules is out of scope for this guard. */
export function findTypesNodeRule(
	packageRules: readonly TypesNodePackageRule[],
): TypesNodePackageRule | undefined {
	return packageRules.find((rule) =>
		(rule.matchPackageNames ?? []).includes("@types/node"),
	);
}

/** Human-readable text for one violation, shared by the driver script (real stderr output) and
 * this file's own tests, the same split every sibling guard in this repo uses. */
export function formatViolation(
	violation: RenovateEnginesGuardViolation,
): string {
	if (violation.kind === "unparseable-floor") {
		const found =
			violation.enginesNode === undefined
				? "(missing)"
				: `"${violation.enginesNode}"`;
		return (
			`package.json's engines.node is ${found}, not the expected ">=X.Y.Z" form - ` +
			"renovate-engines-guard cannot compute the renovate.json @types/node ceiling this " +
			"repo expects without a parseable floor"
		);
	}
	if (violation.kind === "missing-rule") {
		return (
			"renovate.json has no packageRules entry with matchPackageNames including " +
			'"@types/node" and an allowedVersions ceiling - add one so this guard has something ' +
			"to check against package.json's engines.node floor (see AGENTS.md and renovate.json's " +
			"own @types/node rule comment for why this pin exists)"
		);
	}
	if (violation.kind === "unparseable-ceiling") {
		return (
			`renovate.json's @types/node allowedVersions ("${violation.allowedVersions}") is ` +
			'not the expected "<X.Y.Z" form - renovate-engines-guard cannot compare it against ' +
			"package.json's engines.node floor"
		);
	}
	return (
		`renovate.json's @types/node allowedVersions ceiling ("<${violation.actualCeiling}") ` +
		`does not match package.json's engines.node floor (">=${violation.floor}") - expected ` +
		`"<${violation.expectedCeiling}" (the next minor line above the floor: same major, ` +
		"minor+1, patch reset to 0). Update renovate.json's allowedVersions to " +
		`"<${violation.expectedCeiling}", or this rule will keep rejecting every valid ` +
		"@types/node update once the floor moves past its current minor line."
	);
}

/** Every violation this guard finds comparing `input.packageRules`' @types/node ceiling against
 * `input.enginesNode`'s floor. Returns at most one violation - the parsing/lookup steps below are
 * an early-return chain, not an accumulator, because each is a precondition for the next: there
 * is nothing meaningful to say about ceiling drift once the floor itself, or the rule holding the
 * ceiling, can't be found at all. */
export function checkRenovateEnginesGuard(
	input: RenovateEnginesGuardInput,
): RenovateEnginesGuardViolation[] {
	if (input.enginesNode === undefined) {
		return [{ kind: "unparseable-floor", enginesNode: undefined }];
	}

	const floor = parseFloor(input.enginesNode);
	if (floor === undefined) {
		return [{ kind: "unparseable-floor", enginesNode: input.enginesNode }];
	}

	const rule = findTypesNodeRule(input.packageRules);
	if (rule === undefined || rule.allowedVersions === undefined) {
		return [{ kind: "missing-rule" }];
	}

	const ceiling = parseCeiling(rule.allowedVersions);
	if (ceiling === undefined) {
		return [
			{ kind: "unparseable-ceiling", allowedVersions: rule.allowedVersions },
		];
	}

	const expected = nextMinorCeiling(floor);
	if (sameSemVer(ceiling, expected)) {
		return [];
	}

	return [
		{
			kind: "ceiling-drift",
			floor: formatSemVer(floor),
			actualCeiling: formatSemVer(ceiling),
			expectedCeiling: formatSemVer(expected),
		},
	];
}
