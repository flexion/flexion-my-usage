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
			//
			// scripts/critical-persisted.ts (bead myusage-4xu.25) is the same shape of file
			// for the same reason: non-product tooling that must not ship in dist/, listed
			// here explicitly rather than folded into a glob.
			include: [
				"src/**/*.ts",
				"scripts/package-rules.ts",
				"scripts/critical-persisted.ts",
			],

			exclude: [
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
				// after `yarn test`, `grep -rl "BEGIN PRIVATE KEY" coverage/` returns
				// nothing, and `find coverage -iname '*fixtures*'` finds no report file
				// at all.
				"src/**/*.fixtures.*",

				// Humble objects (invasive-species rule): I/O and wiring only, no logic.
				// Each entry is an explicit path on purpose - never a glob - so a new file
				// cannot be excluded by accident. If one of these grows a decision or a
				// data transform, move that logic into a covered pure module instead.
				"src/index.ts", // composition root: wires the pipeline, touches process/console
				"src/sources/types.ts", // type-only: compiles to no runtime code
			],

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

export default defineConfig(config);
