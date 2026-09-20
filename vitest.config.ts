import { defineConfig } from "vitest/config";

// Coverage policy: 100% statements, branches, functions and lines, per file.
// See "Testing & coverage policy" in AGENTS.md before touching `exclude`.
export default defineConfig({
	test: {
		// Only this checkout's tests. Vitest's default glob also matches other agents'
		// git worktrees under .claude/worktrees/, which would run (and report) their
		// in-flight work as if it were ours.
		include: ["src/**/*.test.ts"],

		coverage: {
			provider: "v8",

			// Count every source file, tested or not. Without `include`, a module no test
			// imports is invisible to the report and the gate passes on a lie.
			include: ["src/**/*.ts"],

			exclude: [
				// Test code and test support. Same convention as tsconfig.build.json.
				"src/**/*.test.*",
				"src/**/*.spec.*",
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
			},
		},
	},
});
