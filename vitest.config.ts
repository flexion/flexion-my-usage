import { defineConfig, type ViteUserConfig } from "vitest/config";

// Coverage policy: 100% statements, branches, functions and lines, per file.
// See "Testing & coverage policy" in AGENTS.md before touching `exclude`.
//
// `satisfies` below is the enforcement, not decoration. tsconfig.json's rootDir is `src`,
// so this file sits outside it and plain `tsc --noEmit` never type-checks it; a misspelled
// key (e.g. `branchez`) or a weakened value would compile clean and the threshold would
// silently vanish. tsconfig.config.json (see `yarn typecheck`) brings this file under tsc,
// and the two `satisfies` clauses below make that check reject an unknown coverage option
// by name and reject any of the four thresholds, or `perFile`, being anything but the
// literal 100 / true the gate requires.
type CoverageGate = {
	perFile: true;
	statements: 100;
	branches: 100;
	functions: 100;
	lines: 100;
};

// --- coverage.exclude: every entry must be an explicit path, never a glob (myusage-c2a) ---
//
// CoverageGate above pins the four threshold numbers by name, but says nothing about the
// SHAPE of coverage.exclude/coverage.include - and nothing else did either. Confirmed by
// hand: planting a wildcard in `exclude` (e.g. "src/**/*.ts") or narrowing `include` to one
// file both compiled clean under `tsc -p tsconfig.config.json` and genuinely hollowed the
// 100%-per-file gate at runtime - `yarn test` exited 0 having checked almost nothing.
// Deleting `include` outright was the same hollowing taken to its simplest form: nothing
// constrained its shape, or even its presence, at all. The two blocks below close both
// halves. src/vitest-config-guard.test.ts is the executable spec for this (real `tsc` runs
// against on-disk variants of this file, not a lint rule) - see that file's own header for
// why the enforcement boundary is `tsc -p tsconfig.config.json`, not `yarn lint`.
//
// TestSupportPattern whitelists the three globs AGENTS.md itself carves out ("Test code and
// test support are excluded by naming: *.test.*, *.spec.*, *.fixtures.*"). Everything else
// coverage.exclude holds is a humble-object path (AGENTS.md: "explicit paths, never globs"),
// so ExplicitPath below lets the three whitelisted globs through unchanged and maps every
// OTHER entry containing a glob metacharacter to `never` - unassignable to anything, so it
// fails right where the offending literal sits.
type TestSupportPattern =
	| "src/**/*.test.*"
	| "src/**/*.spec.*"
	| "src/**/*.fixtures.*";

// Deliberately a flat ternary chain, not a distributive conditional over a union of
// characters: distributing over a union (`GlobChar extends infer C ? ... : never`)
// collapses to bare `never` - not `false` - when nothing matches, since an empty union IS
// `never`. This form always produces `true` or `false`, so ExplicitPath below can compare
// against `true` directly instead of also handling "is this never".
type HasGlobChar<S extends string> = S extends `${string}*${string}`
	? true
	: S extends `${string}?${string}`
		? true
		: S extends `${string}[${string}`
			? true
			: S extends `${string}]${string}`
				? true
				: S extends `${string}{${string}`
					? true
					: S extends `${string}}${string}`
						? true
						: S extends `${string}!${string}`
							? true
							: false;

type ExplicitPath<S extends string> = S extends TestSupportPattern
	? S
	: HasGlobChar<S> extends true
		? never
		: S;

/** Type-checks every element of `paths` against `ExplicitPath` - a glob outside the
 * TestSupportPattern whitelist, in any position (appended, or an existing entry rewritten
 * in place), fails `tsc -p tsconfig.config.json` pointing at that element, since it's typed
 * `never` and nothing is assignable to `never`. `const T` (not a plain `T extends readonly
 * string[]`) is what keeps each element's own literal type visible to ExplicitPath -
 * without it, TS widens the argument to plain `string` before this function ever sees it,
 * and `ExplicitPath<string>` can't tell "src/index.ts" apart from "src/**\/*.ts". The
 * return type is annotated `string[]`, not `T`: `const T`'s inferred tuple is `readonly
 * [...]`, and a readonly array can't stand in for coverage.exclude's own declared
 * `string[]` under the `satisfies ViteUserConfig` check below - spreading into a fresh
 * mutable array here keeps that check unaffected by this one. */
function explicitPaths<const T extends readonly string[]>(
	paths: { [K in keyof T]: ExplicitPath<T[K]> },
): string[] {
	return [...paths];
}

// --- coverage.include: the pattern that covers every src/ file must stay present ---
//
// AGENTS.md: "Every file under `src/` counts, tested or not (`coverage.include`)." Deleting
// this key, or narrowing the array to drop REQUIRED_COVERAGE_INCLUDE, is the simplest
// complete hollowing there is - nothing then constrains which files the gate even looks at.
// This can't be checked with a plain post-hoc `satisfies` reference the way CoverageGate is
// checked below: `satisfies ViteUserConfig` contextually types `include` against
// CoverageOptions' own declared `include?: string[]`, so by the time anything reads
// `config.test.coverage.include` back, its type is already the general `string[]` - no
// specific literal content survives to check there. requireCoveragePattern below checks the
// array's content where it's actually written instead, the same way explicitPaths does for
// `exclude` above, so the required literal is still visible before that widening happens.
const REQUIRED_COVERAGE_INCLUDE = "src/**/*.ts";

type CoveragePatterns<T extends readonly string[]> = T extends readonly [
	typeof REQUIRED_COVERAGE_INCLUDE,
	...string[],
]
	? T
	: readonly [typeof REQUIRED_COVERAGE_INCLUDE, ...string[]];

/** Requires REQUIRED_COVERAGE_INCLUDE as `patterns`' first element - narrowing it away, or
 * emptying the array, fails `tsc` with a tuple mismatch that names the required literal.
 * Mirrors explicitPaths above: `const T` keeps each element's literal type visible to
 * CoveragePatterns, and the return type widens to plain `string[]` so the result stays
 * compatible with coverage.include's own declared type. This only proves the array's
 * CONTENT is right while the `include` key exists - it can't prove the key is still there
 * at all, since deleting `include: requireCoveragePattern(...)` deletes the call along with
 * it, leaving nothing left to fail. The `satisfies string[]` line near the bottom of this
 * file closes that other half: a post-hoc reference to `config.test.coverage.include` that
 * turns into "Property 'include' does not exist" the moment the key is gone - a
 * deliberately trivial check (`string[]` accepts anything) whose only job is to exist and
 * go missing when the key does. Don't delete it as dead code later; it's the only thing
 * that half of the guard depends on. */
function requireCoveragePattern<const T extends readonly string[]>(
	patterns: CoveragePatterns<T>,
): string[] {
	return [...patterns];
}

const config = {
	test: {
		// Only this checkout's tests. Vitest's default glob also matches other agents'
		// git worktrees under .claude/worktrees/, which would run (and report) their
		// in-flight work as if it were ours.
		include: ["src/**/*.test.ts"],

		// Pinned, not left to vitest's default. src/aggregate.test.ts's beforeEach mutates
		// process.env.TZ to exercise daylight-saving edge cases, then asserts a known
		// UTC offset before every test runs; that mutation only reaches Date's timezone
		// lookups in a process pool.forks owns, so pool: "threads" makes the assertion
		// fail loudly instead of silently skipping TZ isolation. Pinning here means a
		// future vitest default change can't move that failure from loud to silent.
		pool: "forks",

		coverage: {
			provider: "v8",

			// Count every source file, tested or not. Without `include`, a module no test
			// imports is invisible to the report and the gate passes on a lie.
			//
			// scripts/package-rules.ts is listed explicitly alongside the src/ glob: it is
			// build-time-only tooling that deliberately lives outside src/ (bead
			// myusage-4xu.19 - src/ is what `yarn build` ships, and this file must not ship),
			// but it still holds real logic and stays covered like everything else. One
			// explicit path, matching the humble-object exclusions' own convention below,
			// not a scripts/**/*.ts glob - a future non-logic .ts file added under scripts/
			// should not be swept into the coverage gate by accident.
			include: requireCoveragePattern([
				"src/**/*.ts",
				"scripts/package-rules.ts",
			]),

			exclude: explicitPaths([
				// Test code and test support. Same convention as tsconfig.build.json.
				"src/**/*.test.*",
				"src/**/*.spec.*",
				//
				// This is *why* the gitignored coverage/ directory never leaks
				// src/pricing.fixtures.ts's throwaway TEST_ORIGIN_KEY (myusage-qhc,
				// correcting PR #48's body): pricing.fixtures.ts is excluded from
				// coverage right here, so vitest never instruments or reports it -
				// no coverage/src/pricing.fixtures.ts.html is even generated. The key's
				// text never lands in coverage/ at all. It is NOT the .gitleaks.toml
				// content-scoped allowlist doing that job; that allowlist only governs
				// gitleaks' own scans (scripts/guardrail-scan.sh) of tracked source, and
				// has no bearing on what vitest writes under coverage/. Verified empirically:
				// after `yarn test`, `grep -rl 'BEGIN PRIVATE KEY' coverage/` returns
				// nothing, and `find coverage -iname '*fixtures*'` finds no report file
				// at all.
				"src/**/*.fixtures.*",

				// Humble objects (invasive-species rule): I/O and wiring only, no logic.
				// Each entry is an explicit path on purpose - never a glob - so a new file
				// cannot be excluded by accident. If one of these grows a decision or a
				// data transform, move that logic into a covered pure module instead.
				"src/index.ts", // composition root: wires the pipeline, touches process/console
				"src/sources/types.ts", // type-only: compiles to no runtime code
			]),

			reporter: ["text", "html"],
			// Still write the report when the gate fails, so the misses are visible.
			reportOnFailure: true,

			thresholds: {
				perFile: true,
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			} as const,
		},
	},
} satisfies ViteUserConfig;

// Named, per-key enforcement: renaming or weakening any one of these five fails here,
// pointing at the exact field, instead of the object literal above merely widening to
// `number`/`boolean` under `CoverageOptions` and letting the change through.
config.test.coverage.thresholds satisfies CoverageGate;

// Presence check, not a shape check (requireCoveragePattern above already checked the
// shape where the array is written) - see that function's own doc comment for why this
// second, deliberately trivial line is what actually fails when `include` is deleted.
config.test.coverage.include satisfies string[];

export default defineConfig(config);
