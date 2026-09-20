// myusage-c2a: the independent reviewer of PR #9 (myusage-2xv) found that `satisfies
// CoverageGate` in vitest.config.ts type-checks the four threshold VALUES by name, but says
// nothing about the shape of coverage.exclude/coverage.include. Confirmed by hand before
// writing these tests: planting a throwaway wildcard in `exclude` (e.g. "src/**/*.ts") or
// narrowing `include` to a single file both compile clean today under `tsc -p
// tsconfig.config.json` (the exact command `yarn typecheck` runs for this file) and both
// genuinely hollow the 100%-per-file coverage gate at runtime - `yarn test` would exit 0
// having checked almost nothing.
//
// These tests run that real command against a real, on-disk variant of vitest.config.ts. This
// spec deliberately pins the typecheck seam (`tsc -p tsconfig.config.json`) as the enforcement
// boundary, not `yarn lint`: every assertion below only ever runs tsc, so a guard implemented
// purely as a lint rule would not turn this file green. Within that seam, the guard is free to
// take any TypeScript shape - a per-element branded type, a typed helper function, or a value
// pinned with `satisfies` (mirroring the existing `CoverageGate` pattern below) - and it may
// span more than one file: `typecheckProjectWith` copies any sibling .ts file the config
// source imports by a relative path (transitively), so a guard that lives in its own module
// still gets a working fixture. Each mutation variant is a copy of the repo's real
// tsconfig.json + tsconfig.config.json (unmodified) plus a text-mutated copy of the real
// vitest.config.ts, written into its own throwaway directory under node_modules/.cache so
// module resolution for "vitest/config" and "@types/node" still finds this checkout's
// node_modules by walking up parent directories - the same fixture convention
// src/sources/opencode.test.ts already uses.
//
// A passing "fails typecheck" assertion needs more than a non-zero exit status: tsc also
// fails loudly on an unrelated problem (a guard split across files whose fixture is missing a
// sibling module, say), and a check that only looks at the exit code cannot tell that apart
// from the real, intended failure. Every such assertion below also requires the diagnostic
// text to name the value the guard should be reacting to, so a spurious failure for the wrong
// reason no longer reads as a passing test. It deliberately does not also pin a line number:
// verified against a real, throwaway implementation that either entry's guard may report the
// mismatch at a `satisfies` expression elsewhere in the file (mirroring the CoverageGate
// pattern below) rather than inside the array literal itself, and that shape is just as valid.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_ROOT = join(
	REPO_ROOT,
	"node_modules",
	".cache",
	"my-usage-tests",
);
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const RELATIVE_IMPORT = /from\s+["'](\.\.?\/[^"']+)["']/g;
const TSC_DIAGNOSTIC = /vitest\.config\.ts\((\d+),\d+\): error TS\d+:/;
const REQUIRED_COVERAGE_INCLUDE = '"src/**/*.ts"';

let sandboxes: string[] = [];

afterEach(async () => {
	for (const dir of sandboxes) {
		await rm(dir, { recursive: true, force: true });
	}
	sandboxes = [];
});

async function sandbox(): Promise<string> {
	await mkdir(FIXTURE_ROOT, { recursive: true });
	const dir = await mkdtemp(join(FIXTURE_ROOT, "vitest-config-guard-"));
	sandboxes.push(dir);
	return dir;
}

/** Copies any sibling .ts file `source` imports by relative path into `dir`, transitively, so
 * a guard split across files (e.g. `vitest.config.ts` importing `./coverage-guard.js`) gets a
 * fixture where module resolution actually succeeds instead of failing for an unrelated
 * reason. A specifier that doesn't resolve to a real file under the repo root is skipped. */
async function copySiblingImports(dir: string, source: string): Promise<void> {
	const seen = new Set<string>();
	const queue = [source];
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		for (const match of next.matchAll(RELATIVE_IMPORT)) {
			const specifier = match[1];
			if (specifier === undefined) {
				continue;
			}
			const withoutExtension = specifier.replace(/\.(js|ts)$/, "");
			if (seen.has(withoutExtension)) {
				continue;
			}
			seen.add(withoutExtension);
			const from = join(REPO_ROOT, `${withoutExtension}.ts`);
			if (!existsSync(from)) {
				continue;
			}
			const to = join(dir, `${withoutExtension}.ts`);
			await mkdir(dirname(to), { recursive: true });
			const siblingSource = await readFile(from, "utf8");
			await writeFile(to, siblingSource);
			queue.push(siblingSource);
		}
	}
}

/** A throwaway tsc project: the real tsconfigs, unmodified, the given config source, and any
 * sibling file that source imports by relative path. */
async function typecheckProjectWith(
	vitestConfigSource: string,
): Promise<string> {
	const dir = await sandbox();
	copyFileSync(join(REPO_ROOT, "tsconfig.json"), join(dir, "tsconfig.json"));
	copyFileSync(
		join(REPO_ROOT, "tsconfig.config.json"),
		join(dir, "tsconfig.config.json"),
	);
	await writeFile(join(dir, "vitest.config.ts"), vitestConfigSource);
	await copySiblingImports(dir, vitestConfigSource);
	return dir;
}

/** Runs the exact command `yarn typecheck` runs for vitest.config.ts. */
function runTypecheck(dir: string) {
	return spawnSync(process.execPath, [TSC_BIN, "-p", "tsconfig.config.json"], {
		cwd: dir,
		encoding: "utf8",
	});
}

async function realConfigSource(): Promise<string> {
	return readFile(join(REPO_ROOT, "vitest.config.ts"), "utf8");
}

/** Appends a new entry as the array's last element, right before its closing `]` - where a
 * new humble-object path actually gets added in practice, and, unlike inserting at the front,
 * never lands among the three pre-existing, intentionally-glob test-support entries (AGENTS.md:
 * only the humble-object entries have to be explicit paths, not the whole array). Anchored on
 * `exclude: [` plus the array's own closing bracket - no comment text, so cosmetic changes
 * elsewhere in the array can't make this test fail for the wrong reason. */
function graftIntoExcludeArray(source: string, entry: string): string {
	const start = source.indexOf("exclude: [");
	expect(
		start,
		'expected "exclude: [" in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	const closingBracket = /\n([ \t]*)\]/;
	const tail = source.slice(start);
	const match = tail.match(closingBracket);
	expect(
		match,
		"expected a closing ] for coverage.exclude (fixture anchor stale?)",
	).not.toBeNull();
	const indent = match?.[1] ?? "";
	const mutatedTail = tail.replace(
		closingBracket,
		`\n${indent}\t${entry},\n${indent}]`,
	);
	return source.slice(0, start) + mutatedTail;
}

/** Replaces the whole coverage.exclude array (everything between its `exclude: [` and the
 * `reporter:` key that follows it) with `[]`. */
function emptyCoverageExclude(source: string): string {
	const start = source.indexOf("exclude: [");
	expect(
		start,
		'expected "exclude: [" in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	const end = source.indexOf("reporter:", start);
	expect(
		end,
		'expected "reporter:" after coverage.exclude in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(start);
	return `${source.slice(0, start)}exclude: [],\n\n\t\t\t${source.slice(end)}`;
}

/** Replaces coverage.include's `include: [...]` with `replacement`. Scoped to the text after
 * `coverage: {` so it can never touch `test.include` (a different, out-of-scope glob) even
 * though both keys are spelled the same way. */
function narrowCoverageInclude(source: string, replacement: string): string {
	const coverageStart = source.indexOf("coverage: {");
	expect(
		coverageStart,
		'expected a "coverage: {" block in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	const tail = source.slice(coverageStart);
	const includePattern = /include:\s*\[[^\]]*\]/;
	expect(
		tail,
		"expected an `include: [...]` entry inside the coverage block (fixture anchor stale?)",
	).toMatch(includePattern);
	return (
		source.slice(0, coverageStart) + tail.replace(includePattern, replacement)
	);
}

/** Confirms a typecheck failure is the real thing, not a spurious failure for an unrelated
 * reason (a guard split across files whose fixture is missing a sibling module, say): tsc
 * must exit non-zero, emit a genuine diagnostic against vitest.config.ts, and that diagnostic
 * must reference `requiredText` - the one value the mutation put in question.
 *
 * Verified against a real, throwaway two-case implementation (a per-element branded type for
 * coverage.exclude, a `satisfies`-pinned literal tuple for coverage.include, mirroring the
 * file's existing `CoverageGate` pattern): tsc's TS1360 "does not satisfy the expected type"
 * quotes the offending literal on both sides of the comparison, but reports the diagnostic at
 * the `satisfies` expression, not inside the array literal being checked - so this
 * deliberately does not also assert a line number or location, only content. */
function expectDiagnosticNaming(
	result: ReturnType<typeof runTypecheck>,
	requiredText: string,
	context: string,
): void {
	expect(
		result.status,
		`expected typecheck to fail for ${context}; got status 0 with:\n${result.stdout}`,
	).not.toBe(0);
	const output = result.stdout + result.stderr;
	expect(
		output,
		`expected a tsc diagnostic against vitest.config.ts; got:\n${output}`,
	).toMatch(TSC_DIAGNOSTIC);
	expect(
		output,
		`expected the diagnostic to reference ${requiredText}; got:\n${output}`,
	).toContain(requiredText);
}

// Verified against the same throwaway implementation: narrowing coverage.include to one file
// produces a diagnostic that quotes both the offending and the required literal, but emptying
// it to `[]` is a tuple-*length* mismatch, and tsc's TS1360 doesn't expand the target alias for
// that shape - it falls back to "Source has 0 element(s) but target requires 1." with neither
// literal spelled out. Both are real, tsc-standard wording for "this shape is wrong", and
// neither would appear in an unrelated failure (a missing sibling module, say), so either one
// is accepted here instead of requiring the golden pattern's literal text specifically.
const COVERAGE_INCLUDE_MISMATCH = /"src\/\*\*\/\*\.ts"|element\(s\)/;

function expectIncludeShapeMismatch(
	result: ReturnType<typeof runTypecheck>,
	context: string,
): void {
	expect(
		result.status,
		`expected typecheck to fail for ${context}; got status 0 with:\n${result.stdout}`,
	).not.toBe(0);
	const output = result.stdout + result.stderr;
	expect(
		output,
		`expected a tsc diagnostic against vitest.config.ts; got:\n${output}`,
	).toMatch(TSC_DIAGNOSTIC);
	expect(
		output,
		`expected the diagnostic to reference coverage.include's required pattern (${REQUIRED_COVERAGE_INCLUDE}) or a tuple-arity mismatch - a spurious failure for an unrelated reason would show neither; got:\n${output}`,
	).toMatch(COVERAGE_INCLUDE_MISMATCH);
}

const GLOB_FORMS = [
	["a `*` wildcard", '"src/**/*.ts"'],
	["a `{...}` brace expansion", '"src/sources/{opencode,types}.ts"'],
	["a `?` single-character wildcard", '"src/sources/opencode?.ts"'],
	["a `[...]` character class", '"src/sources/opencode[12].ts"'],
	["a `!` negation", '"!src/sources/opencode.ts"'],
] as const;

describe("vitest.config.ts: coverage.exclude/coverage.include stay explicit", () => {
	it("lets the real, unmodified config through cleanly", async () => {
		const dir = await typecheckProjectWith(await realConfigSource());

		const result = runTypecheck(dir);

		expect(result.status).toBe(0);
	});

	describe("coverage.exclude", () => {
		it.each(GLOB_FORMS)(
			"fails typecheck when %s lands in an entry",
			async (label, entry) => {
				const real = await realConfigSource();
				const mutated = graftIntoExcludeArray(real, entry);
				const dir = await typecheckProjectWith(mutated);

				const result = runTypecheck(dir);

				expectDiagnosticNaming(
					result,
					entry,
					`coverage.exclude gaining ${label}`,
				);
			},
		);

		it("still typechecks when a new, legitimate humble-object path is added", async () => {
			const real = await realConfigSource();
			const mutated = graftIntoExcludeArray(real, '"src/cli-entry.ts"');
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected a new explicit path to typecheck cleanly, the way adding a future humble object would; got:\n${result.stdout}${result.stderr}`,
			).toBe(0);
		});

		it("still typechecks when emptied to `[]`", async () => {
			const real = await realConfigSource();
			const mutated = emptyCoverageExclude(real);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected an empty coverage.exclude to typecheck cleanly - it excludes nothing, which is stricter than today, not a hollowing; got:\n${result.stdout}${result.stderr}`,
			).toBe(0);
		});
	});

	describe("coverage.include", () => {
		it("fails typecheck when narrowed to a single file", async () => {
			const real = await realConfigSource();
			const mutated = narrowCoverageInclude(real, 'include: ["src/index.ts"]');
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expectIncludeShapeMismatch(
				result,
				"coverage.include narrowed to a single file",
			);
		});

		it("fails typecheck when emptied to `[]`", async () => {
			const real = await realConfigSource();
			const mutated = narrowCoverageInclude(real, "include: []");
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expectIncludeShapeMismatch(result, "coverage.include emptied to `[]`");
		});
	});
});
