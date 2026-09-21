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
// purely as a lint rule would not turn this file green. That is a scope decision, not an
// oversight: the bead's acceptance criteria reads "fails yarn typecheck OR yarn lint", and this
// suite exercises only the typecheck half on purpose, because it is the stronger seam - it
// rejects a bad shape at compile time, before any test or lint step runs - and a hollowing this
// narrow (one glob character in one array entry) needs no separate lint rule once the type-level
// guard exists. Within that seam, the guard is free to take any TypeScript shape - a per-element
// branded type, a typed helper function, or a value pinned with `satisfies` (mirroring the
// existing `CoverageGate` pattern below) - so every anchor here finds `exclude:`/`include:` plus
// the first balanced `[...]` that follows, never a literal `key: [` string: a value wrapped in a
// helper call (`exclude: explicitPaths([...])`) or an `as const` cast mutates the same way a bare
// array literal does. This guard is scoped to a single file (`vitest.config.ts` alone, no sibling
// module it imports); a guard split across files is out of scope for this fixture.
//
// A passing "fails typecheck" assertion needs more than a non-zero exit status: tsc also fails
// loudly on an unrelated problem (a typo elsewhere in the file, say), and a check that only
// looks at the exit code cannot tell that apart from the real, intended failure. Every such
// assertion below also ties the failure back to the specific value the guard should be reacting
// to - either by requiring the diagnostic text to name it, or by requiring the diagnostic to
// land on the mutated entry's own line - so a spurious failure for the wrong reason no longer
// reads as a passing test. Verified against real, throwaway implementations that a guard may
// equally validly report the mismatch at a `satisfies` expression elsewhere in the file
// (mirroring the CoverageGate pattern below, quoting the entry but not its line) or as a
// type error pointing straight at the mutated line (naming no text at all) - both are treated as
// equally valid evidence, and neither is required in isolation.
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
// Must stay under the repo's own node_modules: Node's upward module resolution from here is
// what lets each sandboxed tsc project find "vitest/config" and @types/node without a
// package.json or node_modules of its own. Moving this to os.tmpdir() breaks every case in this
// file uniformly with "error TS2688: Cannot find type definition file for 'node'" - a diagnostic
// that looks like a real failure but is really a broken fixture, not a broken guard.
const FIXTURE_ROOT = join(
	REPO_ROOT,
	"node_modules",
	".cache",
	"my-usage-tests",
);
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const TSC_DIAGNOSTIC = /vitest\.config\.ts\((\d+),\d+\): error (TS\d+):/;
const REQUIRED_COVERAGE_INCLUDE = '"src/**/*.ts"';

// Pure syntax/parse errors - the array literal's own grammar breaking (a graft landing
// without a separating comma, say), not a guard rejecting a shape. Verified end to end
// (myusage-c2a critical round 4): hoisting coverage.exclude into a same-file
// `const COVERAGE_EXCLUDE = [...]` with NO guard at all makes `findKeyedArray`'s anchor
// silently misfire onto coverage.reporter's array (see `assertLooksLikeCoveragePathArray`
// below, which closes that half of the gap), and the resulting missing-comma graft trips
// only TS1005 - proof the mutated source doesn't parse, not that any guard fired. Excluding
// these codes from "the guard's diagnostic" keeps a syntax accident from being accepted as
// guard evidence.
const SYNTAX_DIAGNOSTIC_CODES = new Set(["TS1005", "TS1109", "TS1136"]);

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
 * instead of silently matching the wrong text.
 *
 * `source.indexOf("[", keyStart)` assumes the array literal sits inline right after the key -
 * true for every wrapping shape the header comment above promises to support, but not for a
 * same-file hoist (`const COVERAGE_EXCLUDE = [...]` above the config, `exclude:
 * COVERAGE_EXCLUDE,` inline). Verified (myusage-c2a critical round 4): that shape puts an
 * identifier after the key, not a bracket, so the scan walks past it to the next real array
 * literal in the file - coverage.reporter's `["text", "html"]` - and returns it with a
 * perfectly balanced bracket pair, no thrown assertion. `assertLooksLikeCoveragePathArray`
 * closes that gap below: every coverage.exclude/coverage.include entry is, by this file's own
 * convention, an explicit `src/`-rooted path or negation, so an anchor that lands on anything
 * else fails loudly here instead of returning a plausible-looking wrong span. */
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
	assertLooksLikeCoveragePathArray(source, key, arrayStart, arrayEnd);
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
 * never lands among the pre-existing, intentionally-glob test-support entries (AGENTS.md:
 * only the humble-object entries have to be explicit paths, not the whole array; myusage-9os
 * trimmed that set from three globs to two, dropping the unused *.spec.* convention - see
 * vitest.config.ts's own TestSupportPattern comment). Also returns
 * the grafted entry's own 1-indexed line number in the mutated source, so a caller can tell a
 * diagnostic reported there apart from one reported for an unrelated reason - the guard is free
 * to point tsc at that line instead of quoting the entry's text (see `expectDiagnosticNaming`).
 *
 * This, and every other mutation above and below, only ever appends a new entry or restructures
 * the array as a whole (emptying it, deleting the key) - none of them rewrite an *existing*
 * entry's own value in place. That was never a scope decision, just an untested gap (myusage-c2a
 * round 3): a guard built to validate only newly-appended entries, or only a tail slice of the
 * array, would pass every test in this file while missing the more common real-world edit -
 * narrowing a line already in the config, in place. `replaceEntryInPlace` below closes that gap,
 * exercised by the `it.each` over every entry the array currently has. */
function graftIntoExcludeArray(
	source: string,
	entry: string,
): { source: string; entryLine: number } {
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
	const entryLine = prefix.split("\n").length + 1;
	return {
		source: `${prefix}\n${indent}\t${entry},\n${indent}${source.slice(arrayEnd)}`,
		entryLine,
	};
}

/** Inserts `comment` (a full `//`-prefixed line, no leading whitespace of its own) as the very
 * first line inside coverage.exclude's array, right after its opening `[` - the same position
 * real explanatory comments already occupy in this array today (see vitest.config.ts's own "Test
 * code and test support" and "Humble objects" comments). Exists to plant a comment containing a
 * quoted word (myusage-4xu.54) ahead of a real entry, so `stripComments`/`findStringLiteralsInRange`
 * are exercised against the real, on-disk array - not just proven by a standalone reproduction -
 * for the same class of bug myusage-4xu.51 fixed and myusage-4xu.53 fixed a second half of. */
function insertCommentIntoExcludeArray(
	source: string,
	comment: string,
): string {
	const { arrayStart } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	const afterBracket = source.slice(arrayStart + 1);
	const indentMatch = afterBracket.match(/^\n([ \t]*)/);
	const indent = indentMatch?.[1] ?? "";
	return `${source.slice(0, arrayStart + 1)}\n${indent}${comment}${afterBracket}`;
}

/** Blanks out `//`-to-end-of-line comments in `text`, replacing every non-newline character of a
 * comment with a space - so every OTHER character keeps its exact offset. `findStringLiteralsInRange`
 * below scans this blanked output instead of the raw source (myusage-4xu.51) so a quoted word
 * inside a comment (e.g. `// NOTE: keep this list sorted "alphabetically"`) can never be mistaken
 * for a real array entry: a space can't open or close a string literal, so blanking only ever
 * removes a would-be match, never adds one. Deliberately naive, matching this file's other
 * helpers' own conventions: doesn't distinguish a `//` that appears inside a real string literal
 * from a genuine comment start, which would misfire on a path containing that character - safe
 * here because, by this repo's own convention (AGENTS.md), every coverage.exclude/coverage.include
 * entry is a plain `src/`- or `scripts/`-rooted path or negation, and none of those contain `//`.
 *
 * Line comments only - no `/* *\/` block-comment handling (myusage-4xu.53, removed after a
 * review found it unsound): the block-comment branch this file originally shipped with (PR #61,
 * myusage-4xu.51) didn't respect string-literal boundaries, so a `/*`-like substring inside one
 * array entry's string content could pair with a `*\/`-like substring inside a LATER, separate
 * entry, blanking everything between them - including the comma and quotes that actually separate
 * two distinct literals - as if it were one comment. Demonstrated with a hypothetical
 * coverage.include of `["src/**\/*.ts", "scripts/*.ts", "src/**\/*.bench.ts"]`: the array-close
 * "*\/" inside "src/**\/*.bench.ts" paired with the "/*" inside "scripts/*.ts", and the scanner
 * found 2 literals instead of 3. Dropping the branch entirely, rather than hardening it, is safe
 * because no block comment has ever existed anywhere in this array (verified: `grep -n '/\*'
 * vitest.config.ts` around coverage.exclude/coverage.include turns up nothing but `/**` glob
 * segments inside string literals and JSDoc-style `/**` doc comments elsewhere in the file, never
 * a `/* ... *\/` comment written between array entries) - every real in-array comment here is a
 * `//` line comment. Narrowing to only what's ever actually occurred removes real, demonstrated
 * risk and adds none: there's no "can't-happen state" left to defend against speculatively. */
function stripComments(text: string): string {
	return text.replace(/\/\/[^\n]*/g, (comment) =>
		comment.replace(/[^\n]/g, " "),
	);
}

/** Finds every top-level string-literal element within `[start, end)` of `source` - the same
 * span `findKeyedArray` returns for coverage.exclude's own array literal - in source order.
 * `replaceEntryInPlace` and `findExcludeEntryIndex` use this to locate an entry by its position
 * in the array rather than by its (mutable) text, so replacing entry 0's value doesn't require
 * already knowing what entry 0 currently says. Scans `stripComments`' blanked output, not the raw
 * slice (myusage-4xu.51), so a comment's own quoted text is never counted as an entry; every
 * returned offset is still relative to the ORIGINAL `source`, since `stripComments` preserves
 * length and position one-for-one and this adds `start` back onto each match index - callers
 * that slice `source` with these offsets need no adjustment. */
function findStringLiteralsInRange(
	source: string,
	start: number,
	end: number,
): { start: number; end: number }[] {
	const scanned = stripComments(source.slice(start, end));
	const literals: { start: number; end: number }[] = [];
	const pattern = /"(?:[^"\\]|\\.)*"/g;
	let match = pattern.exec(scanned);
	while (match !== null) {
		literals.push({
			start: start + match.index,
			end: start + match.index + match[0].length,
		});
		match = pattern.exec(scanned);
	}
	return literals;
}

/** Guards `findKeyedArray` against silently binding to the wrong array (myusage-c2a critical
 * round 4). Every entry coverage.exclude/coverage.include ever holds is, by this repo's own
 * convention (AGENTS.md), an explicit `src/`- or `scripts/`-rooted path or negation - never
 * bare text like `"text"` or `"html"`, which is exactly what coverage.reporter's own array
 * holds and exactly what a misfired anchor would return instead. The `scripts/` half of that
 * is coverage.include's own `"scripts/package-rules.ts"` entry (bead myusage-4xu.19, merged to
 * main after this file was first authored on a long-lived branch - see vitest.config.ts's own
 * comment on that entry for why it's listed explicitly, one directory outside src/, instead of
 * a glob): a real, already-accepted entry, not a hollowing, so this check has to allow it
 * rather than the guard fixture staying permanently stale against it. Called from within
 * `findKeyedArray` itself (forward reference; `function` declarations hoist), so every caller
 * gets this for free without having to remember to call it. An array that fails this -
 * including an empty one, since an anchor bound to nothing valid is exactly as stale as one
 * bound to the wrong thing entirely - fails loudly right here instead of quietly handing back
 * a plausible-looking wrong span for every later mutation to build on. */
function assertLooksLikeCoveragePathArray(
	source: string,
	key: "exclude" | "include",
	arrayStart: number,
	arrayEnd: number,
): void {
	const literals = findStringLiteralsInRange(source, arrayStart, arrayEnd);
	expect(
		literals.length,
		`expected coverage.${key}'s array to contain at least one string literal (fixture anchor stale - bound to the wrong array?)`,
	).toBeGreaterThan(0);
	for (const literal of literals) {
		const text = source.slice(literal.start, literal.end);
		expect(
			text.startsWith('"src/') ||
				text.startsWith('"!src/') ||
				text.startsWith('"scripts/'),
			`expected every coverage.${key} entry to look like a src/ or scripts/ path, got ${text} (fixture anchor stale - bound to the wrong array?)`,
		).toBe(true);
	}
}

/** Replaces the Nth (0-indexed) string-literal entry of coverage.exclude's array in place -
 * unlike `graftIntoExcludeArray` above (which only ever appends past the array's end), this
 * rewrites an *existing* entry's own text, leaving every other entry, and the array's structure,
 * untouched. Asserts the index actually exists first, so a stale anchor (the array shrinking
 * without whoever calls this being updated) fails loudly right here, instead of silently matching
 * nothing and the mutation quietly no-op'ing into a false pass. Also returns the replaced entry's
 * own 1-indexed line number in the mutated source, for `expectDiagnosticNaming` the same way
 * `graftIntoExcludeArray` does. */
function replaceEntryInPlace(
	source: string,
	index: number,
	entry: string,
): { source: string; entryLine: number } {
	const { arrayStart, arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	const literals = findStringLiteralsInRange(source, arrayStart, arrayEnd);
	expect(
		literals[index],
		`expected coverage.exclude to have an entry at index ${index}; found ${literals.length} (stale anchor - did the array's entry count change?)`,
	).toBeDefined();
	const target = literals[index] ?? { start: -1, end: -1 };
	const entryLine = source.slice(0, target.start).split("\n").length;
	return {
		source: source.slice(0, target.start) + entry + source.slice(target.end),
		entryLine,
	};
}

/** Finds the index of the coverage.exclude entry whose literal text is exactly `literalText`
 * (e.g. `'"src/index.ts"'`, quotes included) - lets the positive-control test below locate an
 * existing entry by its current value instead of a hardcoded index, so it keeps working if the
 * array is ever reordered. Asserts the entry is actually found, for the same stale-anchor reason
 * as `replaceEntryInPlace`. */
function findExcludeEntryIndex(source: string, literalText: string): number {
	const { arrayStart, arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	const literals = findStringLiteralsInRange(source, arrayStart, arrayEnd);
	const index = literals.findIndex(
		(literal) => source.slice(literal.start, literal.end) === literalText,
	);
	expect(
		index,
		`expected to find ${literalText} among coverage.exclude's entries (fixture anchor stale - was it renamed?)`,
	).toBeGreaterThan(-1);
	return index;
}

/** Replaces coverage.exclude's own array literal with `[]`, leaving whatever wraps it
 * untouched - the same slice shape `narrowCoverageInclude` uses below. Replacing from
 * `keyStart` (the old approach) deleted the "exclude: " text but, for a wrapped value such as
 * `exclude: explicitPaths([...])`, left the wrapper's own trailing `)` behind with nothing to
 * close, producing a syntax error (TS1005/TS1136) instead of the intended clean typecheck. */
function emptyCoverageExclude(source: string): string {
	const { arrayStart, arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	return `${source.slice(0, arrayStart)}[]${source.slice(arrayEnd + 1)}`;
}

/** Deletes the whole `exclude: ...` entry (key, value and its own trailing comma) from the
 * coverage block, mirroring `removeCoverageInclude` below - the same key-removal shape, but for
 * the entry whose removal is stricter rather than a hollowing (see the "removed entirely" test
 * for coverage.exclude): with nothing excluded, every src file, including test files, would have
 * to hit 100% on its own. */
function removeCoverageExclude(source: string): string {
	const { keyStart, arrayEnd } = findKeyedArray(
		source,
		"exclude",
		findCoverageBlock(source),
	);
	const commaIndex = source.indexOf(",", arrayEnd);
	expect(
		commaIndex,
		"expected a trailing comma after coverage.exclude (fixture anchor stale?)",
	).toBeGreaterThan(-1);
	const lineEnd = source.indexOf("\n", commaIndex);
	const end = lineEnd === -1 ? source.length : lineEnd + 1;
	return source.slice(0, keyStart) + source.slice(end);
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

/** Replaces `pool`'s own quoted value (`pool: "forks"`) with `value` (already quoted) - the
 * scalar-field mirror of `replaceEntryInPlace` above, needed because PoolGate (vitest.config.ts,
 * myusage-7j2) guards a single string field, not an array, so there's no `findKeyedArray` span to
 * reuse. Also returns the replaced value's own 1-indexed line number, for `expectDiagnosticNaming`
 * the same way the array helpers do - though PoolGate's real diagnostic (see the test below) lands
 * on the `satisfies` expression elsewhere in the file, not this line; `expectDiagnosticNaming`
 * already accepts either as evidence.
 *
 * The pattern requires `pool:` to be the first non-whitespace text on its own line (`^[ \t]*pool:`,
 * multiline): this file's header comments quote `pool: "forks"` and `pool: "forkz"` verbatim
 * (explaining PoolGate itself, above), and a comment near the real field also mentions `pool:
 * "threads"` in prose - a plain `/pool:\s*"[^"]*"/` search with no such anchor matches the FIRST
 * of those comment lines instead of the real field (verified by hand: it silently mutates a
 * comment, and the "mutated" config then typechecks cleanly, making this test fail for the wrong
 * reason - a false pass on a no-op mutation, not proof PoolGate works). None of those comment
 * lines start with `pool:` after their own leading whitespace - they all start with `//` first -
 * so this anchor can only ever land on the actual field. */
function replacePoolValue(
	source: string,
	value: string,
): { source: string; entryLine: number } {
	const match = source.match(/^[ \t]*pool:\s*"[^"]*"/m);
	expect(
		match,
		'expected a `pool: "..."` field (not inside a comment) in vitest.config.ts (fixture anchor stale?)',
	).not.toBeNull();
	const startIndex = match?.index ?? -1;
	expect(
		startIndex,
		'expected a `pool: "..."` field (not inside a comment) in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	const entryLine = source.slice(0, startIndex).split("\n").length;
	const matched = match?.[0] ?? "";
	const fieldStart = startIndex + matched.indexOf("pool:");
	const fieldLength = matched.length - matched.indexOf("pool:");
	return {
		source: `${source.slice(0, fieldStart)}pool: ${value}${source.slice(fieldStart + fieldLength)}`,
		entryLine,
	};
}

function findThresholdsBlock(source: string): number {
	const start = source.indexOf("thresholds: {");
	expect(
		start,
		'expected a "thresholds: {" block in vitest.config.ts (fixture anchor stale?)',
	).toBeGreaterThan(-1);
	return start;
}

/** Replaces one of `thresholds`' own four numeric fields (`statements: 100`, say) with `value` -
 * the scalar mirror of `replacePoolValue` above, for CoverageGate instead of PoolGate. Scoped to
 * start searching after `thresholds: {` (`findThresholdsBlock`) so this can never match
 * CoverageGate's own type declaration near the top of the file, which repeats the same four field
 * names as TYPE members, not values - an unscoped search would silently rewrite the type instead
 * of the config, turning "weaken the threshold" into "weaken the guard", a very different, much
 * more dangerous mutation this helper isn't meant to make. */
function replaceThresholdValue(
	source: string,
	field: "statements" | "branches" | "functions" | "lines",
	value: string,
): { source: string; entryLine: number } {
	const blockStart = findThresholdsBlock(source);
	const fieldPattern = new RegExp(`\\b${field}\\s*:\\s*\\d+`);
	const match = source.slice(blockStart).match(fieldPattern);
	expect(
		match,
		`expected "${field}: <number>" inside coverage.thresholds in vitest.config.ts (fixture anchor stale?)`,
	).not.toBeNull();
	const startIndex = blockStart + (match?.index ?? -1);
	const entryLine = source.slice(0, startIndex).split("\n").length;
	const matchLength = match?.[0].length ?? 0;
	return {
		source: `${source.slice(0, startIndex)}${field}: ${value}${source.slice(startIndex + matchLength)}`,
		entryLine,
	};
}

/** Confirms a typecheck failure is the real thing, not a spurious failure for an unrelated
 * reason: tsc must exit non-zero and emit a genuine diagnostic against vitest.config.ts, and
 * that diagnostic must tie back to `requiredText` - the one value the mutation put in question
 * - EITHER by quoting it directly OR by pointing at `entryLine`, the grafted entry's own line
 * (from `graftIntoExcludeArray`).
 *
 * Verified against four real, throwaway guard shapes: a per-element branded type and a
 * conditional-type parameter both point tsc at the grafted line (`vitest.config.ts(N,5)`)
 * without quoting the entry anywhere in the message; a `satisfies`-pinned literal tuple quotes
 * the entry but reports it at the `satisfies` expression elsewhere in the file; a
 * message-engineered type quotes the entry but at a worse, misleading location. Requiring the
 * text alone rejects the first two correct guards; requiring the line alone would accept a
 * guard that never actually explains itself. Either is real, human-verifiable evidence the
 * diagnostic is about this entry, so this deliberately does not also assert a line number for
 * the quoting shape or text for the line-pointing shape.
 *
 * A tsc failure alone isn't enough either: a mutation can corrupt the source's own grammar
 * (see `SYNTAX_DIAGNOSTIC_CODES`) without any guard ever evaluating the shape. This only draws
 * evidence from diagnostics whose code isn't a bare syntax/parse error, so a syntax accident
 * can't be mistaken for a guard firing (myusage-c2a critical round 4). */
function expectDiagnosticNaming(
	result: ReturnType<typeof runTypecheck>,
	requiredText: string,
	entryLine: number,
	context: string,
): void {
	expect(
		result.status,
		`expected typecheck to fail for ${context}; got status 0 with:\n${result.stdout}`,
	).not.toBe(0);
	const output = result.stdout + result.stderr;
	const diagnostics = [...output.matchAll(new RegExp(TSC_DIAGNOSTIC, "g"))];
	expect(
		diagnostics.length,
		`expected a tsc diagnostic against vitest.config.ts; got:\n${output}`,
	).toBeGreaterThan(0);
	const semanticDiagnostics = diagnostics.filter(
		(diagnostic) => !SYNTAX_DIAGNOSTIC_CODES.has(diagnostic[2] ?? ""),
	);
	expect(
		semanticDiagnostics.length,
		`expected a semantic tsc diagnostic against vitest.config.ts, not just a syntax error (${[...SYNTAX_DIAGNOSTIC_CODES].join(", ")}) - a syntax error only proves the mutated source doesn't parse, not that a guard rejected the shape; got:\n${output}`,
	).toBeGreaterThan(0);
	const semanticDiagnosticLines = semanticDiagnostics.map((diagnostic) =>
		Number(diagnostic[1] ?? "-1"),
	);
	const namesTheOffender =
		output.includes(requiredText) ||
		semanticDiagnosticLines.includes(entryLine);
	expect(
		namesTheOffender,
		`expected a semantic diagnostic to either quote ${requiredText} or be reported on the grafted entry's own line (${entryLine}, got ${semanticDiagnosticLines.join(", ")}); got:\n${output}`,
	).toBe(true);
}

// Verified against the same throwaway implementation: narrowing coverage.include to one file
// produces a diagnostic that quotes both the offending and the required literal, but emptying
// it to `[]` is a tuple-*length* mismatch, and tsc's TS1360 doesn't expand the target alias for
// that shape - it falls back to "Source has 0 element(s) but target requires 1." with neither
// literal spelled out. Deleting the key outright is a different shape again: verified against a
// third throwaway implementation (`config.test.coverage.include satisfies IncludeGate` mirroring
// the file's `CoverageGate` pattern) that an object literal missing the property entirely trips
// TS2339 "Property 'include' does not exist on type ..." at the `satisfies` reference, since the
// literal's own inferred type never had that key to begin with. A fourth, equally standard shape
// for the same "key missing" case - an excess/missing-property check against a structural type
// rather than a `satisfies` reference - reports it instead as "Property 'include' is missing in
// type ... but required in type ...", so that wording is accepted too. All four are real,
// tsc-standard wording for "this shape is wrong", and none would appear in an unrelated failure
// (a typo elsewhere in the file, say), so any of them is accepted here instead of requiring one
// golden pattern's literal text specifically.
const COVERAGE_INCLUDE_MISMATCH =
	/"src\/\*\*\/\*\.ts"|element\(s\)|Property ['"]include['"] (does not exist|is missing in type)/;

function expectIncludeShapeMismatch(
	result: ReturnType<typeof runTypecheck>,
	context: string,
): void {
	expect(
		result.status,
		`expected typecheck to fail for ${context}; got status 0 with:\n${result.stdout}`,
	).not.toBe(0);
	const output = result.stdout + result.stderr;
	const diagnostics = [...output.matchAll(new RegExp(TSC_DIAGNOSTIC, "g"))];
	const semanticDiagnostics = diagnostics.filter(
		(diagnostic) => !SYNTAX_DIAGNOSTIC_CODES.has(diagnostic[2] ?? ""),
	);
	// Same reasoning as expectDiagnosticNaming: a bare syntax error (SYNTAX_DIAGNOSTIC_CODES)
	// proves only that the mutated source doesn't parse, not that a guard rejected the shape
	// (myusage-c2a critical round 4).
	expect(
		semanticDiagnostics.length,
		`expected a semantic tsc diagnostic against vitest.config.ts, not just a syntax error (${[...SYNTAX_DIAGNOSTIC_CODES].join(", ")}); got:\n${output}`,
	).toBeGreaterThan(0);
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

// Distinct from GLOB_FORMS's own `"src/**/*.ts"` on purpose (myusage-c2a critical round 4,
// N5): that exact literal is byte-identical to REQUIRED_COVERAGE_INCLUDE, coverage.include's
// own required entry. Six of the it.each cases below would otherwise plant that same text into
// coverage.exclude, and expectDiagnosticNaming's `output.includes(requiredText)` branch could
// then no longer tell "the guard named this mutated entry" apart from "tsc's message happened
// to mention coverage.include for an unrelated reason". This sentinel still carries a `*`
// wildcard - the same hollowing shape the bug report names - but cannot appear anywhere else in
// the config, so a match on it is unambiguous. GLOB_FORMS keeps the original literal for its
// one headline case, matching the bug report's own example.
const IN_PLACE_WILDCARD_SENTINEL = '"src/**/zzz-guard-probe-*.ts"';

// Every existing coverage.exclude entry's index, derived from the real array's current length -
// not hardcoded - so the it.each below tracks the array automatically: it grows the moment a
// sixth entry is added, and shrinks if one is removed, with nobody touching this file. Read
// synchronously and once, at module load, because it.each needs its case list before any test
// body runs; the async, per-test `realConfigSource()` used inside each case still re-reads the
// file fresh at test time, same as every other test in this file.
const REAL_CONFIG_SOURCE_AT_LOAD = readFileSync(
	join(REPO_ROOT, "vitest.config.ts"),
	"utf8",
);
const REAL_EXCLUDE_ARRAY_AT_LOAD = findKeyedArray(
	REAL_CONFIG_SOURCE_AT_LOAD,
	"exclude",
	findCoverageBlock(REAL_CONFIG_SOURCE_AT_LOAD),
);
const EXISTING_EXCLUDE_ENTRY_INDEXES = findStringLiteralsInRange(
	REAL_CONFIG_SOURCE_AT_LOAD,
	REAL_EXCLUDE_ARRAY_AT_LOAD.arrayStart,
	REAL_EXCLUDE_ARRAY_AT_LOAD.arrayEnd,
).map((_, index) => index);

// Belt-and-suspenders on top of `assertLooksLikeCoveragePathArray` (myusage-c2a critical round
// 4, N2): that check already runs inside `findKeyedArray` above, on the exact span this list is
// derived from, so a retargeted anchor already fails loudly there. This asserts the derived
// case list itself directly, at module load, so a reader of *this* list doesn't have to trust
// that the earlier check ran and trace back to it: in the round-4 experiment (an unguarded
// same-file hoist), this list silently shrank from 5 cases to 2 - it picked up "text" and
// "html" from coverage.reporter - and the run reported 15 tests instead of 18 with nobody
// noticing. A list that's empty, or holds anything that isn't a `src/`-rooted path or negation,
// means the anchor bound to the wrong array; fail here, at collection, instead of quietly
// dropping coverage of the it.each below.
expect(
	EXISTING_EXCLUDE_ENTRY_INDEXES.length,
	`expected coverage.exclude to have at least one entry at module load (fixture anchor stale - bound to the wrong array?); found ${EXISTING_EXCLUDE_ENTRY_INDEXES.length}`,
).toBeGreaterThan(0);

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
				const { source: mutated, entryLine } = graftIntoExcludeArray(
					real,
					entry,
				);
				const dir = await typecheckProjectWith(mutated);

				const result = runTypecheck(dir);

				expectDiagnosticNaming(
					result,
					entry,
					entryLine,
					`coverage.exclude gaining ${label}`,
				);
			},
		);

		it("still typechecks when a new, legitimate humble-object path is added", async () => {
			const real = await realConfigSource();
			const { source: mutated } = graftIntoExcludeArray(
				real,
				'"src/cli-entry.ts"',
			);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected a new explicit path to typecheck cleanly, the way adding a future humble object would; got:\n${result.stdout}${result.stderr}`,
			).toBe(0);
		});

		// Directly exercises stripComments/findStringLiteralsInRange (myusage-4xu.54), rather than
		// relying on a coincidental workaround: PR #57 already had to reword a "BEGIN PRIVATE KEY"
		// comment in vitest.config.ts to single quotes to dodge the ORIGINAL version of this bug
		// (before myusage-4xu.51's fix), and that workaround is still in place today - so nothing
		// in the real, unmodified config exercises a `//` comment containing a double-quoted word
		// inside coverage.exclude's array. This plants one on purpose. If stripComments regressed
		// (the myusage-4xu.51 bug, or the myusage-4xu.53 block-comment variant), the planted
		// comment's own quoted text would either get miscounted as an array entry or merge two
		// real entries together - either way `assertLooksLikeCoveragePathArray` (called from
		// `findKeyedArray`, itself called by `graftIntoExcludeArray` below) would throw its own
		// "fixture anchor stale" assertion before typecheck ever runs, failing this test loudly
		// for the right reason.
		it("still scans coverage.exclude correctly when a comment containing a quoted word sits inside the array", async () => {
			const real = await realConfigSource();
			const withComment = insertCommentIntoExcludeArray(
				real,
				'// NOTE: keep this list sorted "alphabetically"',
			);
			const { source: mutated } = graftIntoExcludeArray(
				withComment,
				'"src/cli-entry.ts"',
			);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected a legitimate new entry to typecheck cleanly alongside a // comment containing a quoted word elsewhere in the array; got:\n${result.stdout}${result.stderr}`,
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

		// Distinct from the `[]` case above: this drops the `exclude` key itself, not just its
		// value. A guard that only inspects the array's elements (e.g. a helper-call whose
		// argument type does the checking) would have nothing left to inspect once the key -
		// and the call - are gone, so this pins the key's absence too, not just an empty value.
		//
		// This deliberately rules out one otherwise-legitimate guard shape (myusage-c2a N1,
		// flagged in review): a post-hoc `config.test.coverage.exclude satisfies ExcludeGate<...>`
		// line, the direct mirror of this file's own existing `thresholds satisfies CoverageGate`
		// pattern above, also passes every other case in this describe block but fails this one -
		// removing the key turns that reference into TS2339, the same error shape
		// coverage.include's "removed entirely" test below requires as PASSING evidence of a
		// hollowing. That's not a bug in either test: exclude's key-removed and include's
		// key-removed cases have opposite correct outcomes (removing exclude is stricter, not a
		// hollowing; removing include is the simplest possible hollowing), so no single mechanism
		// can be reused for both halves unchanged. A conforming guard reaches for a different
		// shape here - e.g. a typed helper call (`exclude: explicitPaths([...])`) whose own
		// argument type does the checking, so there's nothing left to fail once the call is gone -
		// rather than the reference `satisfies` this file already uses for include.
		it("still typechecks when the exclude key is removed entirely", async () => {
			const real = await realConfigSource();
			const mutated = removeCoverageExclude(real);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected coverage.exclude removed entirely to typecheck cleanly - like the empty-array case, this excludes nothing (stricter, not a hollowing); got:\n${result.stdout}${result.stderr}`,
			).toBe(0);
		});

		// The GLOB_FORMS cases above only ever graft a brand-new sixth entry onto the array - they
		// never touch an entry that was already there. That leaves the far more common real-world
		// edit unproven: narrowing a line already in the config, in place, rather than adding a new
		// one. Verified by mutation (myusage-c2a round 3): a guard that validates only a tail slice
		// of the array - skipping the first few positions entirely - passes every test above, and
		// editing the real config's entry 0 from a legitimate test-support pattern to the exact
		// hollowing wildcard the bug report names ("src/**/*.ts") still typechecks clean, silently
		// dropping the coverage gate to 0/0/0/0. This drives that same in-place edit across every
		// index the array currently has, not just one demonstrated position.
		it.each(EXISTING_EXCLUDE_ENTRY_INDEXES)(
			"fails typecheck when existing entry %i is rewritten to a wildcard in place",
			async (index) => {
				const real = await realConfigSource();
				const { source: mutated, entryLine } = replaceEntryInPlace(
					real,
					index,
					IN_PLACE_WILDCARD_SENTINEL,
				);
				const dir = await typecheckProjectWith(mutated);

				const result = runTypecheck(dir);

				expectDiagnosticNaming(
					result,
					IN_PLACE_WILDCARD_SENTINEL,
					entryLine,
					`coverage.exclude entry ${index} rewritten in place to a wildcard`,
				);
			},
		);

		// A guard could satisfy every case above just by pinning the exact original tuple
		// (reject anything that isn't byte-for-byte the original array) rather than actually
		// validating each entry's shape. That would be too strict in a way nobody wants: adding a
		// future humble object by editing an existing line (not just appending one) would then also
		// fail. This proves the suite doesn't reward that shortcut: rewriting the src/index.ts entry
		// in place to a different, equally legitimate explicit path must still typecheck cleanly.
		it("still typechecks when an existing humble-object entry is replaced in place with a different legitimate humble-object path", async () => {
			const real = await realConfigSource();
			const index = findExcludeEntryIndex(real, '"src/index.ts"');
			const { source: mutated } = replaceEntryInPlace(
				real,
				index,
				'"src/cli-entry.ts"',
			);
			const dir = await typecheckProjectWith(mutated);

			const result = runTypecheck(dir);

			expect(
				result.status,
				`expected an existing entry rewritten in place to a different, equally legitimate explicit path to typecheck cleanly - a guard that instead pins the exact original tuple would wrongly reject this too; got:\n${result.stdout}${result.stderr}`,
			).toBe(0);
		});
	});

	// coverage.include broadened to add an unrelated pattern (e.g. adding "lib/**/*.ts" alongside
	// the required "src/**/*.ts") is deliberately left unpinned here. Unlike narrowing or
	// deleting the key, broadening cannot hollow the gate: every file the policy requires
	// (AGENTS.md: "every file under src/ counts") stays included either way, and the bead's own
	// acceptance criteria names only "narrowed to one file", not broadening. A guard that
	// tuple-pins the exact array and one that only requires the presence of the needed pattern
	// are both legitimate readings of that criteria, and picking one here would encode a
	// preference the bug report and AGENTS.md do not state.
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

		// Note for whoever writes the production guard (myusage-c2a N6): the only shape that
		// satisfies both this test and "narrowed to a single file" above is a post-hoc reference
		// (`config.test.coverage.include satisfies IncludeGate<...>`, or similar) - a helper-call
		// argument type can't fail *this* case, because once `include` and its call are both gone
		// there's no argument left to type-check. Verified: `satisfies ViteUserConfig` widens
		// `include` to plain `string[]` at the access site even with `as const` on the array, so
		// the shape check itself has to live in a separate helper, leaving a second, semantically
		// empty `config.test.coverage.include satisfies string[]` line whose only job is to exist
		// and go missing when the key does. Don't delete that line as dead code later - it's the
		// only thing this test actually depends on.
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

// PoolGate and CoverageGate (both above, in vitest.config.ts) each pin a value by name the same
// way explicitPaths/requireCoveragePattern pin coverage.exclude/coverage.include's shape above -
// but unlike those two, neither had its own mutation test in this file (myusage-4xu.54, found
// reviewing PR #61/myusage-4xu.51). Confirmed by hand for both: widening `type PoolGate =
// "forks"` to `type PoolGate = string`, and separately widening CoverageGate's `statements: 100`
// field to `statements: number`, each leave every one of this file's 18 pre-existing tests green
// - neither gate had anything grafting a bad value in and requiring tsc to reject it, the same
// technique explicitPaths/requireCoveragePattern's own tests already use above.
describe("vitest.config.ts: test.pool and coverage.thresholds stay guarded", () => {
	// PoolGate (myusage-7j2) exists because vitest's own `Pool` type is `BuiltinPool | (string &
	// {})` - a structural escape hatch that accepts any string, typo included - so `satisfies
	// ViteUserConfig` alone lets `pool: "forkz"` through. This grafts that exact typo into the
	// real, on-disk config and requires tsc to reject it, closing the gap confirmed above.
	it("fails typecheck when pool is typo'd", async () => {
		const real = await realConfigSource();
		const { source: mutated, entryLine } = replacePoolValue(real, '"forkz"');
		const dir = await typecheckProjectWith(mutated);

		const result = runTypecheck(dir);

		expectDiagnosticNaming(
			result,
			'"forkz"',
			entryLine,
			'test.pool typo\'d to "forkz"',
		);
	});

	// CoverageGate (PR #9/myusage-2xv) pins all four threshold numbers by name via a post-hoc
	// `satisfies` reference, the same shape PoolGate's own check mirrors - but, unlike
	// explicitPaths/requireCoveragePattern, had never had a test graft a bad value in and confirm
	// tsc rejects it. This weakens `statements` by one and requires tsc to reject it; the other
	// three thresholds (`branches`, `functions`, `lines`) go through the identical `satisfies
	// CoverageGate` check, so a regression in any of them would fail exactly the same way.
	it("fails typecheck when a coverage threshold is weakened below 100", async () => {
		const real = await realConfigSource();
		const { source: mutated, entryLine } = replaceThresholdValue(
			real,
			"statements",
			"99",
		);
		const dir = await typecheckProjectWith(mutated);

		const result = runTypecheck(dir);

		expectDiagnosticNaming(
			result,
			"statements: 99",
			entryLine,
			"coverage.thresholds.statements weakened to 99",
		);
	});
});
