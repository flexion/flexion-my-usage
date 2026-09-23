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

// pool: "forks" (see the comment on that line below for why it's pinned) has the same gap
// CoverageGate closes above, for a different reason: vitest's own `Pool` type is `BuiltinPool |
// (string & {})` - a structural escape hatch so a custom pool package can supply its own string -
// and that escape hatch widens the field to accept ANY string, typo included. Verified by hand
// (myusage-7j2): `pool: "forkz"` compiles clean under `tsc -p tsconfig.config.json` with no
// PoolGate check in place. Unlike CoverageGate, this needs no `as const` on the value itself -
// a plain string literal in an object literal already infers as its own fresh literal type
// (`"forks"`, not widened to `string`) when the contextual type from `satisfies ViteUserConfig`
// offers that literal as one branch of a union, which BuiltinPool does. `config.test.pool
// satisfies PoolGate` below is the same post-hoc-reference shape as `thresholds satisfies
// CoverageGate`: naming the one literal this repo actually wants turns a silently-accepted typo
// into a `tsc` diagnostic that quotes the bad value directly (TS1360, "does not satisfy the
// expected type").
type PoolGate = "forks";

// --- coverage.exclude: two policies share one array (myusage-c2a, myusage-9os) ---
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
// The array below holds two DIFFERENT kinds of entry, not one (myusage-9os: the original
// header here claimed "every entry must be an explicit path, never a glob", which was never
// true of the first two entries and said nothing about why that was fine): TestSupportPattern
// whitelists the globs AGENTS.md itself carves out for test code and test support (*.test.*,
// *.fixtures.* - *.spec.* was dropped from this convention entirely, see the exclude array's
// own comment below for why). Everything else coverage.exclude holds is a humble-object path
// (AGENTS.md: "Humble objects are listed as explicit paths, never globs"), so ExplicitPath
// below lets the whitelisted test-support globs through unchanged and maps every OTHER entry
// containing a glob metacharacter to `never` - unassignable to anything, so it fails right
// where the offending literal sits. A fixtures file's own CONTENT (does it actually behave
// like test support, or does it hide real logic production code depends on?) is a different
// question this type-level guard cannot ask - see scripts/fixtures-guard.ts, wired into
// `yarn lint`, for the runtime half of that check.
type TestSupportPattern = "src/**/*.test.*" | "src/**/*.fixtures.*";

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

// --- test.include: the widened glob must stay present (myusage-4xu.56) ---
//
// myusage-9os (see the comment on `include:` below) widened test.include from the literal
// "src/**/*.test.ts" to "src/**/*.test.*" so .test.mts/.cts/.tsx files actually run, instead of
// being silently invisible to both the test runner and, via coverage.exclude's own matching
// glob, the coverage gate too. That fix had nothing pinning it in place: narrowing test.include
// back to the old literal compiled clean under `tsc -p tsconfig.config.json` and left `yarn
// test` green, since no .test.mts/.cts/.tsx file exists in this repo today - confirmed by hand
// before this guard existed. requireTestIncludePattern below is CoveragePatterns/
// requireCoveragePattern's own shape, for the identical reason: `satisfies ViteUserConfig`
// widens `include` to plain `string[]` by the time anything reads `config.test.include` back,
// so the required literal has to be checked where the array is actually written, not after.
const REQUIRED_TEST_INCLUDE = "src/**/*.test.*";

type TestIncludePatterns<T extends readonly string[]> = T extends readonly [
	typeof REQUIRED_TEST_INCLUDE,
	...string[],
]
	? T
	: readonly [typeof REQUIRED_TEST_INCLUDE, ...string[]];

/** Requires REQUIRED_TEST_INCLUDE as `patterns`' first element - narrowing it away fails `tsc`
 * with a tuple mismatch that names the required literal. Mirrors requireCoveragePattern above
 * in every particular but the literal it pins; see that function's own doc comment for why the
 * `satisfies string[]` line near the bottom of this file (here, on `config.test.include`) is
 * what closes the other half of the same gap - the key deleted outright, not just narrowed. */
function requireTestIncludePattern<const T extends readonly string[]>(
	patterns: TestIncludePatterns<T>,
): string[] {
	return [...patterns];
}

const config = {
	test: {
		// Only this checkout's tests. Vitest's default glob also matches other agents'
		// git worktrees under .claude/worktrees/, which would run (and report) their
		// in-flight work as if it were ours.
		//
		// `*.test.*`, not the literal `*.test.ts` this held before myusage-9os: the old,
		// narrower glob silently dropped `.test.mts`/`.test.cts`/`.test.tsx` too (none exist in
		// this repo today, but nothing stopped one from being added and never running, the same
		// blind spot that let a whole `*.spec.ts` file go unrun - see coverage.exclude's own
		// comment below for that half of the story). Matching coverage.exclude's own
		// `src/**/*.test.*` keeps include and exclude symmetric on the one convention they both
		// still recognize. requireTestIncludePattern (myusage-4xu.56, above) now pins this
		// literal at typecheck time, the same way requireCoveragePattern pins coverage.include's
		// own required literal below.
		include: requireTestIncludePattern(["src/**/*.test.*"]),

		// Pinned, not left to vitest's default. src/aggregate.test.ts's beforeEach mutates
		// process.env.TZ to exercise daylight-saving edge cases, then asserts a known
		// UTC offset before every test runs; that mutation only reaches Date's timezone
		// lookups in a process pool.forks owns, so pool: "threads" makes the assertion
		// fail loudly instead of silently skipping TZ isolation. Pinning here means a
		// future vitest default change can't move that failure from loud to silent.
		// A typo'd value here (e.g. "forkz") still fails loudly at runtime - vitest throws
		// "Runner ... is not supported" - but PoolGate above (see its own comment) also
		// catches it at typecheck time now, before the test run gets that far.
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
			//
			// scripts/critical-persisted.ts (bead myusage-4xu.25) is the same shape of file
			// for the same reason: non-product tooling that must not ship in dist/, listed
			// here explicitly rather than folded into a glob.
			//
			// scripts/fixtures-guard.ts (bead myusage-9os) is the same shape again: the pure
			// decision logic behind the runtime check that a *.fixtures.* file excluded below
			// is actually test support (see that file's header and
			// scripts/check-fixtures-guard.mjs, wired into `yarn lint`).
			//
			// scripts/branch-guard.ts (bead myusage-qx9) is the same shape once more: the pure
			// decision logic behind the runtime check that every humble-object path below
			// actually stays logic-free (see that file's header and
			// scripts/check-branch-guard.mjs, wired into `yarn lint`).
			//
			// scripts/renovate-engines-guard.ts (bead myusage-4xu.85) is the same shape again:
			// the pure decision logic behind the runtime check that renovate.json's @types/node
			// allowedVersions ceiling still corresponds to package.json's engines.node floor
			// (see that file's header and scripts/check-renovate-engines.mjs, wired into
			// `yarn lint`).
			include: requireCoveragePattern([
				"src/**/*.ts",
				// The React page's components (myusage-4xu.118). Same gate, same 100%: src/web/
				// is application code like the rest of src/, just built by vite instead of tsc.
				"src/**/*.tsx",
				"scripts/package-rules.ts",
				"scripts/critical-persisted.ts",
				"scripts/fixtures-guard.ts",
				"scripts/branch-guard.ts",
				"scripts/renovate-engines-guard.ts",
			]),

			exclude: explicitPaths([
				// Test code and test support. Same convention as tsconfig.build.json.
				//
				// *.spec.* is deliberately NOT here (myusage-9os): it used to be, alongside
				// *.test.* and *.fixtures.*, but test.include above only ever matched literal
				// `.test.ts` - so a src/x.spec.ts landed here, in coverage.exclude, while never
				// once being run by test.include. It was invisible either way: not run, not
				// counted, a failing assertion inside one produced a green `yarn test`.
				// Reproduced by hand before this fix: a throwaway src/zzz-scratch.spec.ts with
				// `expect(true).toBe(false)` left `yarn test` exiting 0, the file named nowhere
				// in its output, while an identical src/zzz-scratch-control.test.ts failed
				// loudly, as expected. Confirmed no src/**/*.spec.* file exists anywhere in this
				// repo (`find src -name '*.spec.*'` - empty) - the convention was copied in from
				// a template and never actually used, so this drops it everywhere it was
				// documented (AGENTS.md, CLAUDE.md, tsconfig.build.json,
				// scripts/package-rules.ts) rather than widening test.include to make an unused
				// convention work. Reintroducing `.spec.` as a recognized test-file suffix needs
				// test.include widened first, in the same commit - see this array's sibling
				// comment on `include` above.
				"src/**/*.test.*",
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
				//
				// Unlike *.test.*, excluding a *.fixtures.* file here is not by itself proof
				// it's actually test support (myusage-9os): this array only says a file named
				// this way is skipped, never why that name is trustworthy. Reproduced by hand
				// before this fix: a throwaway src/zzz-scratch.fixtures.ts holding a real,
				// uncovered branch, imported and called from src/aggregate.ts exactly like a
				// normal dependency, left `yarn lint`, `yarn typecheck` and `yarn test` all
				// exiting 0 - `yarn test` reported 100% coverage having never looked at the
				// branch. scripts/fixtures-guard.ts (wired into `yarn lint` via
				// scripts/check-fixtures-guard.mjs) is the runtime check this array's shape
				// alone can't express: it fails the moment anything outside test support imports
				// a *.fixtures.* file, and separately fails a *.fixtures.* file that can't be
				// verified as test-only (it doesn't import vitest, and no real *.test.* file
				// or __tests__/__mocks__-directory file references it either).
				"src/**/*.fixtures.*",

				// Humble objects (invasive-species rule): I/O and wiring only, no logic.
				// Each entry is an explicit path on purpose - never a glob - so a new file
				// cannot be excluded by accident. If one of these grows a decision or a
				// data transform, move that logic into a covered pure module instead.
				"src/index.ts", // composition root: wires real deps into runCli (src/cli.ts), touches process
				"src/sources/types.ts", // type-only: compiles to no runtime code
				"src/web/main.tsx", // browser composition root: mounts App with the real fetch, touches document
			]),

			// The "text" entry is a [name, options] tuple, not the bare string, to pin
			// `skipFull: false` (myusage-4xu.49). Vitest's own agent-detection (std-env's
			// `isAgent`, tripped by env vars like CLAUDECODE that Claude Code sets on every
			// subprocess it runs) silently rewrites a bare "text" reporter to skipFull: true
			// - it assumes an agent only wants to see files below 100%. That assumption
			// inverts here: this repo's gate requires 100% on every file, so under that
			// rewrite *every* row reads as "full" and the whole per-file table vanishes,
			// leaving only the aggregate totals vitest also auto-appends via "text-summary".
			// Verified empirically: unsetting CLAUDECODE/CLAUDE_CODE/AI_AGENT restores the
			// full table even with the bare string, and vitest's own merge
			// (`text[1] = { skipFull: true, ...text[1] }`, in the isAgent branch of
			// resolveConfig in vitest/dist/chunks/index.*.js) lets an explicit `skipFull`
			// here win over its forced default, because it spreads our options *after* its
			// own. This is a reporter-output setting only; it has no effect on
			// `thresholds.perFile` below, which still fails the run on any file under 100%.
			reporter: [["text", { skipFull: false }], "html"],
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

// Same presence check as coverage.include's own line above, for test.include (myusage-4xu.56):
// requireTestIncludePattern already checked the array's content where it's written; this line's
// only job is to exist and go missing - "Property 'include' does not exist" - the moment the
// key, and the call wrapping it, are deleted outright.
config.test.include satisfies string[];

// Same shape as the thresholds check above, for `pool` (myusage-7j2): PoolGate names the one
// literal this repo actually wants, so a typo like "forkz" - which `satisfies ViteUserConfig`
// alone accepts via vitest's own `(string & {})` escape hatch - fails here instead, with a
// diagnostic that quotes the bad value directly.
config.test.pool satisfies PoolGate;

export default defineConfig(config);
