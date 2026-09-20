// myusage-c2a: the independent reviewer of PR #9 (myusage-2xv) found that `satisfies
// CoverageGate` in vitest.config.ts type-checks the four threshold VALUES by name, but says
// nothing about the shape of coverage.exclude/coverage.include. Confirmed by hand before
// writing these tests: planting a throwaway wildcard in `exclude` (e.g. "src/**/*.ts") or
// narrowing `include` to a single file both compile clean today under `tsc -p
// tsconfig.config.json` (the exact command `yarn typecheck` runs for this file) and both
// genuinely hollow the 100%-per-file coverage gate at runtime - `yarn test` would exit 0
// having checked almost nothing. Deleting `include` outright is the same hollowing taken to
// its simplest form: no type constrains its shape, or even its presence, at all.
//
// These tests run that real command against a real, on-disk variant of vitest.config.ts. This
// spec deliberately pins the typecheck seam (`tsc -p tsconfig.config.json`) as the enforcement
// boundary, not `yarn lint`: every assertion below only ever runs tsc, so a guard implemented
// purely as a lint rule would not turn this file green. Within that seam, the guard is free to
// take any TypeScript shape - a per-element branded type, a typed helper function, or a value
// pinned with `satisfies` (mirroring the existing `CoverageGate` pattern below) - so every
// anchor here finds `exclude:`/`include:` plus the first balanced `[...]` that follows, never a
// literal `key: [` string: a value wrapped in a helper call (`exclude: explicitPaths([...])`)
// or an `as const` cast mutates the same way a bare array literal does. This guard is scoped to
// a single file (`vitest.config.ts` alone, no sibling module it imports); a guard split across
// files is out of scope for this fixture.
//
// A passing "fails typecheck" assertion needs more than a non-zero exit status: tsc also fails
// loudly on an unrelated problem (a typo elsewhere in the file, say), and a check that only
// looks at the exit code cannot tell that apart from the real, intended failure. Every such
// assertion below also requires the diagnostic text to name the value the guard should be
// reacting to, so a spurious failure for the wrong reason no longer reads as a passing test. It
// deliberately does not also pin a line number: verified against a real, throwaway
// implementation that either entry's guard may report the mismatch at a `satisfies` expression
// elsewhere in the file (mirroring the CoverageGate pattern below) rather than inside the array
// literal itself, and that shape is just as valid.
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** A throwaway tsc project: the real tsconfigs, unmodified, plus the given config source. */
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

/** Finds the first balanced `[...]` array literal that follows `key:` in `source`, starting the
 * search at `fromIndex` so a caller can scope it to a block (the coverage options object, so
 * `include:` here can never match `test.include`, a different, out-of-scope glob spelled the
 * same way). Returns the key name's own start offset (`keyStart`) and the array literal's own
 * `[`/`]` offsets (`arrayStart`/`arrayEnd`, inclusive), so a caller can graft into the array,
 * replace just the array, or drop the whole `key: ...` entry - regardless of what wraps the
 * array (a bare literal, an `as const` cast, or a typed helper function call). Throws (via
 * `expect`) if the key or a balanced array can't be found, so a stale anchor fails loudly
 * instead of silently matching the wrong text. */
function findKeyedArray(
	source: string,
	key: "exclude" | "include",
	fromIndex: number,
): { keyStart: number; arrayStart: number; arrayEnd: number } {
	const keyPattern = new RegExp(`\\b${key}\\s*:`);
	const keyMatch = source.slice(fromIndex).match(keyPattern);
	expect(
		keyMatch,
		`expected "${key}:" in vitest.config.ts (fixture anchor stale?)`,
	).not.toBeNull();
	const keyStart = fromIndex + (keyMatch?.index ?? 0);
	const arrayStart = source.indexOf("[", keyStart);
	expect(
		arrayStart,
		`expected an array literal after "${key}:" in vitest.config.ts (fixture anchor stale?)`,
	).toBeGreaterThan(-1);
	let depth = 0;
	let arrayEnd = -1;
	for (let i = arrayStart; i < source.length; i += 1) {
		if (source[i] === "[") {
			depth += 1;
		} else if (source[i] === "]") {
			depth -= 1;
			if (depth === 0) {
				arrayEnd = i;
				break;
			}
		}
	}
	expect(
		arrayEnd,
		`expected a balanced array literal after "${key}:" in vitest.config.ts (fixture anchor stale?)`,
	).toBeGreaterThan(-1);
	return { keyStart, arrayStart, arrayEnd };
}

function findCoverageBlock(source: string): number {
	const coverageStart = source.indexOf("coverage: {");
	expect(
		coverageStart,
		'expected a "coverage: {" block in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	return coverageStart;
}

/** Appends a new entry as the array's last element, right before its closing `]` - where a
 * new humble-object path actually gets added in practice, and, unlike inserting at the front,
 * never lands among the three pre-existing, intentionally-glob test-support entries (AGENTS.md:
 * only the humble-object entries have to be explicit paths, not the whole array). */
function graftIntoExcludeArray(source: string, entry: string): string {
	const { arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	const beforeBracket = source.slice(0, arrayEnd);
	const indentMatch = beforeBracket.match(/\n([ \t]*)$/);
	const indent = indentMatch?.[1] ?? "";
	const prefix = indentMatch
		? beforeBracket.slice(0, beforeBracket.length - indentMatch[0].length)
		: beforeBracket;
	return `${prefix}\n${indent}\t${entry},\n${indent}${source.slice(arrayEnd)}`;
}

/** Replaces the whole coverage.exclude array with `[]`. */
function emptyCoverageExclude(source: string): string {
	const { keyStart, arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	return `${source.slice(0, keyStart)}exclude: []${source.slice(arrayEnd + 1)}`;
}

/** Replaces coverage.include's own array literal with `replacementArray` (just the `[...]`
 * text), leaving whatever wraps it untouched. */
function narrowCoverageInclude(
	source: string,
	replacementArray: string,
): string {
	const { arrayStart, arrayEnd } = findKeyedArray(
		source,
		"include",
		findCoverageBlock(source),
	);
	return `${source.slice(0, arrayStart)}${replacementArray}${source.slice(arrayEnd + 1)}`;
}

/** Deletes the whole `include: ...` entry (key, value and its own trailing comma) from the
 * coverage block - the simplest complete hollowing of the three: with no `include` key at all,
 * nothing constrains its shape, or even its presence. Reuses the same shape-tolerant anchor as
 * `narrowCoverageInclude`, then removes through the next comma so a wrapped value (`include:
 * someHelper([...])`) is removed whole, wrapper included. */
function removeCoverageInclude(source: string): string {
	const { keyStart, arrayEnd } = findKeyedArray(
		source,
		"include",
		findCoverageBlock(source),
	);
	const commaIndex = source.indexOf(",", arrayEnd);
	expect(
		commaIndex,
		"expected a trailing comma after coverage.include (fixture anchor stale?)",
	).toBeGreaterThan(-1);
	const lineEnd = source.indexOf("\n", commaIndex);
	const end = lineEnd === -1 ? source.length : lineEnd + 1;
	return source.slice(0, keyStart) + source.slice(end);
}

/** Confirms a typecheck failure is the real thing, not a spurious failure for an unrelated
 * reason: tsc must exit non-zero, emit a genuine diagnostic against vitest.config.ts, and that
 * diagnostic must reference `requiredText` - the one value the mutation put in question.
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
// literal spelled out. Deleting the key outright is a different shape again: verified against a
// third throwaway implementation (`config.test.coverage.include satisfies IncludeGate` mirroring
// the file's `CoverageGate` pattern) that an object literal missing the property entirely trips
// TS2339 "Property 'include' does not exist on type ..." at the `satisfies` reference, since the
// literal's own inferred type never had that key to begin with. All three are real, tsc-standard
// wording for "this shape is wrong", and none would appear in an unrelated failure (a typo
// elsewhere in the file, say), so any of the three is accepted here instead of requiring one
// golden pattern's literal text specifically.
const COVERAGE_INCLUDE_MISMATCH =
	/"src\/\*\*\/\*\.ts"|element\(s\)|Property ['"]include['"] does not exist/;

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
		`expected the diagnostic to reference coverage.include's required pattern (${REQUIRED_COVERAGE_INCLUDE}), a tuple-arity mismatch, or a missing-property error - a spurious failure for an unrelated reason would show none of these; got:\n${output}`,
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
			const mutated = narrowCoverageInclude(real, '["src/index.ts"]');
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expectIncludeShapeMismatch(
				result,
				"coverage.include narrowed to a single file",
			);
		});

		it("fails typecheck when emptied to `[]`", async () => {
			const real = await realConfigSource();
			const mutated = narrowCoverageInclude(real, "[]");
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expectIncludeShapeMismatch(result, "coverage.include emptied to `[]`");
		});

		it("fails typecheck when the include key is removed entirely", async () => {
			const real = await realConfigSource();
			const mutated = removeCoverageInclude(real);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expectIncludeShapeMismatch(
				result,
				"coverage.include removed entirely - the easiest complete hollowing",
			);
		});
	});
});
