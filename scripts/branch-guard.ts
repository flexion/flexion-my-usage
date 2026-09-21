// Pure decision logic behind scripts/check-branch-guard.mjs (bead myusage-qx9): "excluded files
// stay logic-free" is upheld by review only today - nothing stops a file listed in
// vitest.config.ts's coverage.exclude from growing an if/switch/ternary/loop/&&/?? and shipping
// completely untested, since coverage instrumentation simply never looks at that file. See
// ~/.claude/skills/full-coverage-humble-objects/SKILL.md's "Known gap" for the fuller problem
// statement this closes.
//
// GritQL + a Biome `overrides` block (the bead's own suggested approach) was investigated first
// and DOES work for most of these constructs - if, ternary, &&, ??, while, do-while, classic
// for, and for-of all match reliably with the right metavariable syntax (`$body`, not `$$body`,
// for a single-statement block; `$...` for a multi-statement one), and `overrides[].plugins` +
// `overrides[].includes` genuinely scopes a plugin to exactly the listed files - confirmed
// end-to-end with `biome check` (not just the `search` subcommand, whose plain-text "Found N
// match(es)" summary and --reporter=json "matches" count are BOTH unreliable in this Biome
// version: they report a nonzero count even for a pattern that cannot possibly match, e.g. a
// bare made-up identifier; the `diagnostics` array is the only trustworthy signal). What did NOT
// work, after roughly twenty pattern variants: a general (metavariable-based) `switch` match.
// A fully literal switch (exact discriminant, exact case values, exact case bodies) matches; the
// moment ANY case body is generalized to a metavariable - singular or spread (`$...`) - the match
// silently stops firing, on real switch statements that visibly contain it. That is a genuine,
// reproducible gap in this Biome version's GritQL support for `switch`, not a syntax mistake
// (confirmed by first getting the literal form to match, then removing generality one token at a
// time until it broke).
//
// Even setting that gap aside, biome.json is static JSON: it cannot import vitest.config.ts's
// coverage.exclude array at config-load time, so an `overrides[].includes` glob list there would
// need its own generation step or a separate agreement check against vitest.config.ts - an extra
// moving part with no precedent in this repo. This checker instead follows the established
// scripts/package-rules.ts + src/package-rules.test.ts and scripts/fixtures-guard.ts +
// src/fixtures-guard.test.ts convention: pure logic here, wired to real I/O by a small .mjs
// driver (scripts/check-branch-guard.mjs), tested from src/. That driver imports
// vitest.config.ts's own resolved config directly (dynamic import via tsx - confirmed to work
// against the real file), so humbleObjectPaths below reads the SAME array coverage.exclude
// already holds - not a second, hand-maintained copy that could drift out of sync with it.
//
// A comment-and-string-aware regex scan, not a real parser, for the same reason
// scripts/fixtures-guard.ts gives (see that file's header): the `typescript` package this repo
// depends on (7.0.2) only exposes its AST under the explicitly unstable
// `typescript/unstable/ast` entry point, unsuited to a checked-in gate. Known, accepted gaps this
// scan does not attempt to close (both fail CLOSED - a missed violation ships silently untested,
// not a false alarm that blocks a clean file - so they matter, unlike a false positive, which
// merely costs a reviewer a second look):
//   - A `${...}` interpolation inside a template literal can itself hold a real branch (e.g.
//     `` `${a ?? b}` ``); maskNonCode blanks the whole template literal, interpolation included,
//     the same limitation scripts/fixtures-guard.ts's own stripComments documents for its
//     narrower purpose.
//   - A TYPE-LEVEL conditional type (`type X<T> = T extends U ? A : B`) uses the identical `? :`
//     tokens as a runtime ternary. It has no runtime behavior - tsc, not vitest, is what "tests"
//     it - so treating it as a violation would be a false positive, not a gap; this scan does not
//     attempt to tell the two apart by position, so a genuinely runtime ternary sitting next to a
//     conditional type in the same excluded file could, in principle, hide behind that ambiguity.
//     Moot for the excluded set as it stands today: src/sources/types.ts holds no conditional
//     type, confirmed by hand.
//   - Regex literals: masked with a heuristic, not a parser-accurate rule (myusage-4xu.65). A
//     literal like `/colou?r/` or `/a&&b/` could otherwise false-positive as a ternary or `&&` -
//     `/` alone can't tell a regex literal from division (`a / b`) without knowing the grammar
//     position, so maskNonCode (below) only blanks a `/.../flags` span when the character right
//     before its opening `/` - skipping any run of spaces/tabs, but not a newline - is NOT one of:
//     a word character, `$`, `)`, `]`, or a closing quote, i.e. not something that ends a VALUE a
//     real `/` after it would divide. This correctly masks `const RE = /colou?r/;` (preceded by
//     `=`) and leaves `total / 2` alone (preceded by the identifier `total`, once the surrounding
//     spaces are skipped), but has two known, accepted failure directions: a real regex right
//     after a keyword that ends in a letter (`return /foo/;`, `typeof /foo/;`) is not recognized
//     as one - a false negative, the same "fails closed" direction as this file's other
//     documented gaps - and an arithmetic `/` with no identifier immediately before it once
//     whitespace is skipped (`x++ / y`) could be misread as a regex opener, blanking real code up
//     to the next unescaped `/` on the line - a false-positive MASKING (treating real code as if
//     it were a regex literal), which can hide a real `&&` or ternary sitting inside the wrongly-
//     blanked span. That's a silent miss, the same failure direction as this file's other
//     documented gaps, not a mere nuisance that costs a reviewer a second look. Neither shape
//     occurs in src/index.ts or src/sources/types.ts today, confirmed by hand; a genuinely general
//     fix needs real tokenization, not a regex.
import { posix } from "node:path";
import type { SourceFile } from "./fixtures-guard.js";

// Mirrors vitest.config.ts's own HasGlobChar type-level guard (see that file's comment on
// ExplicitPath): tsc only allows a glob-shaped coverage.exclude entry when it's one of the two
// known TestSupportPattern globs ("src/**/*.test.*", "src/**/*.fixtures.*"), so by construction,
// "no glob metacharacter" and "this is a humble-object explicit path" are the same test. No
// second, hand-maintained list of glob literals is needed here to draw that line.
const GLOB_CHARS = /[*?[\]{}!]/;

/** Whether a single coverage.exclude entry is a humble-object explicit path, rather than one of
 * the test-support globs (`src/**\/*.test.*`, `src/**\/*.fixtures.*`) that array also holds. See
 * this file's header for why a glob-character test is equivalent to that distinction here. */
export function isHumbleObjectPath(excludeEntry: string): boolean {
	return !GLOB_CHARS.test(excludeEntry);
}

/** The subset of vitest.config.ts's coverage.exclude that names humble-object files this guard
 * should scan - single source of truth: the caller (scripts/check-branch-guard.mjs) passes the
 * literal array `config.test.coverage.exclude` resolves to, read directly off vitest.config.ts
 * itself, never a second copy of it. */
export function humbleObjectPaths(
	coverageExclude: readonly string[],
): string[] {
	return coverageExclude.filter(isHumbleObjectPath);
}

/** Matches a string literal, a template literal, a `//`/`/* *‍/` comment, or a regex literal - the
 * same alternation technique scripts/fixtures-guard.ts's own STRING_OR_COMMENT uses (a string/
 * template branch tried first at every position, so a `//` or `/*` - or a regex's own `/` -
 * opening INSIDE an already-open string is consumed as part of it and never reaches the later
 * branches). Unlike that file, every branch is blanked here (see maskNonCode below): this scan
 * cares about live code SHAPE, not the text a fixtures-guard-style reference scan needs to keep
 * intact.
 *
 * The regex-literal branch (myusage-4xu.65) is last, after the comment branches, on purpose: a
 * real `//` or `/* *‍/` must still win at a position where both could in principle apply. Its own
 * leading negative lookbehind (excluding a word character, `$`, `)`, `]`, or a closing quote,
 * skipping any run of spaces/tabs first) is the heuristic this file's header documents - "not
 * preceded by a value-ending character, skipping any run of spaces/tabs" - the only thing this
 * regex can use to tell a regex literal apart from division without a real parser. */
const STRING_TEMPLATE_COMMENT_OR_REGEX =
	/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<![\w$)\]"'`][ \t]*)\/(?:[^/\\\n]|\\.)+\/[a-z]*/g;

/** Blanks every string literal, template literal, comment, and (heuristically) regex literal in
 * `source`, replacing each of their characters with a space except newlines (kept, so a line
 * number computed against the masked text still matches the real source). This stops a comment
 * quoting example code (this very file's own header does, more than once), a string containing
 * branch-shaped text (e.g. `"a && b"`), or a regex literal containing branch-shaped text (e.g.
 * `/a&&b/`) from ever being mistaken for real code, at the cost of also being unable to see
 * inside a template literal's `${...}` interpolation, and the regex-literal heuristic's own two
 * documented failure directions - see this file's header for both gaps. */
export function maskNonCode(source: string): string {
	return source.replace(STRING_TEMPLATE_COMMENT_OR_REGEX, (whole) =>
		whole.replace(/[^\n]/g, " "),
	);
}

export type BranchKind = "if" | "switch" | "loop" | "ternary" | "&&" | "??";

interface ConstructMatcher {
	kind: BranchKind;
	pattern: RegExp;
}

// Exactly the six constructs the bead names ("if/switch/ternary/loops/&&/??"), deliberately no
// broader than that - `||`, optional chaining (`?.`), and default parameters are all real
// branch-shaped constructs too (see the coverage-branch table in
// ~/.claude/skills/full-coverage-humble-objects/SKILL.md), but adding them is a scope call for
// whoever next grows coverage.exclude into a file where they'd matter, not this bead.
//
// - "if": `\bif\s*\(` - the boundary before "if" and the required `(` right after (only
//   whitespace between) both rule out an identifier merely containing "if" (e.g. "verifyIf(" or
//   "motif(") without also requiring a trailing boundary, which `\s*\(` already guarantees.
// - "switch": same shape as "if"; GritQL could not generally match this construct (see header),
//   but a plain keyword-and-paren scan has no such limitation.
// - "loop": `for (`/`while (` (one alternation, since the bead groups "loops" as a single
//   category, not three), `for await (` (the async form of a for-of loop - myusage-4xu.63: the
//   plain `for`/`while` alternation alone doesn't match this, since the `await` keyword sits
//   between `for` and `(`, and the original pattern only ever allowed whitespace there; `\bfor`
//   below matches the "for" keyword on its own leading word boundary, then an optional
//   `(?:\s+await)?` consumes a real `for await`'s extra keyword before the same `\s*\(` every
//   other loop shape already used (myusage-4xu.69: the pattern originally also carried a trailing
//   `\b` right after "for" - `\bfor\b(?:\s+await)?\s*\(` - but it was dead code: whatever
//   character follows "for" in any successful match is already whitespace or `(`, both non-word
//   characters, so the trailing `\b` never excluded anything the `\s*\(` requirement didn't
//   already exclude on its own - confirmed by a brute-force differential run of both regex forms
//   against ~158k generated inputs, zero behavioral difference; removed as dead code, matching the
//   `.trim()` precedent below in checkBranchGuard), or `do {` - the closing `while (...)` of a
//   do/while loop also matches the `while (` half of this pattern independently, so a single
//   do-while loop is reported as two violations (its `do {` and its `while (...)`), both true
//   statements about the file.
//   `for...of` and `for...in` loops need no dedicated pattern of their own: `for (` matches
//   before this scan ever looks inside the parens, so both shapes are already caught by the same
//   classic-`for` alternative - src/branch-guard.test.ts (myusage-4xu.63) now pins that with its
//   own dedicated test cases instead of leaving it an unproven, easily-broken accident of the
//   regex.
// - "&&" / "??": the bare two-character operator. "??=" contains "??" and is caught as a "??"
//   violation too (nullish assignment IS nullish coalescing, just also an assignment).
// - "ternary": a `?` that is not immediately preceded BY, or followed by, another `?` (either
//   side of `??`/`??=` - without the lookbehind half, the SECOND `?` of `??` independently
//   satisfies the two lookaheads below and would double-report a nullish-coalescing site as a
//   ternary too; caught during this file's own test-writing by a planted `x ??= 1;` fixture, not
//   by inspection), not immediately followed by `.` (optional chaining), not immediately (ZERO
//   whitespace, no `\s*` - myusage-4xu.67, see below) followed by `:`/`)`/`,` (an optional
//   property/parameter marker - `x?:`, `x?)`, `x?,` - which has nothing between the `?` and that
//   next token; a real ternary's consequent expression can never be empty, so this is a safe
//   split between the two shapes), and not immediately (ZERO whitespace - no `\s*` here either)
//   followed by `(` or `<` (myusage-4xu.64: an optional METHOD signature -
//   `discover?(): Promise<void>;`, or its generic form - `load?<T>(id: string): Promise<T>;` - is
//   the same "empty consequent" shape as `x?:`/`x?)`/`x?,`, just spelled with `(`/`<` instead of
//   `:`/`)`/`,`.
//
//   The `:`/`)`/`,` exclusion originally allowed whitespace between `?` and the terminator
//   (`\s*[:),]`), on the theory that a real ternary's consequent can never be empty, so seeing a
//   terminator after only whitespace was safe proof of an optional marker. That reasoning broke
//   for a masked-out consequent (myusage-4xu.67): `c ? "a" : "b"` is a genuine ternary with a
//   string consequent, but maskNonCode (see that function's own header) blanks the `"a"` to
//   spaces before this pattern ever runs, so by the time the ternary check sees it, `?` IS
//   followed by nothing but whitespace before `:` - indistinguishable, under the old
//   `\s*`-tolerant rule, from a real `x?:` marker's genuinely empty gap. checkBranchGuard on
//   `const x = c ? "a" : "b";` returned no violations at all, on already-shipped, unmodified
//   code - a real ternary silently unflagged, confirmed by direct execution before this fix.
//   Tightening the exclusion to zero whitespace closes this cleanly: a real optional marker's gap
//   is empty in the UNMASKED source too, so requiring immediate adjacency still excludes it
//   correctly, while a masked string/template consequent always leaves at least one blanked
//   character between `?` and the terminator (even `""`, the shortest possible string literal,
//   masks to two space characters), which the tightened check now correctly reads as a non-empty
//   consequent and flags as a ternary. src/branch-guard.test.ts pins both directions: the real
//   optional-marker shapes (`x?:`/`x?)`/`x?,`, still zero-width and still excluded) and the
//   previously-unflagged string-consequent ternary (now flagged).
//
//   Requiring zero whitespace here trades away a hand-written optional marker with deliberate
//   whitespace before its terminator (`x? : number`) - syntactically legal TypeScript, since
//   insignificant whitespace between tokens is always allowed - which would now be misread as a
//   ternary instead of excluded. That trade is safe for literal, hand-typed whitespace
//   specifically: Biome's own formatter normalizes `x? : number` back to `x?: number`, so this
//   exact shape doesn't survive formatting even if someone types it, and it's not a realistic
//   shape in the type-only humble-object files this guard actually scans today - the same
//   trade-off this file's `?(`/`?<` exclusion below already accepts, for the same reason.
//   The claim does NOT extend to every way a "gap" can appear between `?` and its terminator,
//   though (myusage-4xu.68): an inline BLOCK COMMENT there - `timeout?/* note */: number;` - is
//   also syntactically legal TypeScript, and unlike literal whitespace, Biome's formatter
//   preserves comments, so this exact shape DOES survive formatting unchanged. maskNonCode (see
//   above) blanks that comment to spaces before the ternary pattern ever runs, leaving the same
//   masked-whitespace-before-terminator shape the zero-whitespace tightening exists to catch -
//   indistinguishable, at that point in the pipeline, from a real ternary's masked string/template
//   consequent (the exact gap myusage-4xu.67 closed). checkBranchGuard on
//   `timeout?/* note */: number;` reports a false-positive ternary violation on this file's
//   current, unmodified code, confirmed by direct execution. This is a known, accepted gap, not a
//   realistic-shape claim like the plain-whitespace case above: it fails LOUD (a confusing
//   violation a reviewer would investigate) and RECOVERABLE, the opposite direction from this
//   file's other documented gaps, which fail closed (a violation shipping silently unflagged), and
//   it has narrow blast radius - neither src/index.ts nor src/sources/types.ts, the two files this
//   guard currently scans, has this shape today, confirmed by hand. Closing it cleanly would mean
//   telling a masked comment apart from a masked string/template consequent at the point the
//   ternary pattern runs, which post-mask text alone can't do without tracking provenance through
//   the mask - a bigger change than this narrow, fail-loud gap warrants, so it's documented and
//   pinned by a test (src/branch-guard.test.ts) instead of chased with more regex.
//   Known, accepted gap this narrower rule doesn't attempt to close (fails CLOSED, matching this
//   file's other documented gaps): a genuinely zero-whitespace terse ternary immediately followed
//   by `(` or `<` - `cond?(a):(b)` - would be misread as an optional marker and go unflagged. Not
//   a realistic shape in the type-only humble-object files this guard actually scans today.
const CONSTRUCT_PATTERNS: readonly ConstructMatcher[] = [
	{ kind: "if", pattern: /\bif\s*\(/g },
	{ kind: "switch", pattern: /\bswitch\s*\(/g },
	{
		kind: "loop",
		pattern: /\bfor(?:\s+await)?\s*\(|\bwhile\s*\(|\bdo\b\s*\{/g,
	},
	{ kind: "&&", pattern: /&&/g },
	{ kind: "??", pattern: /\?\?/g },
	{ kind: "ternary", pattern: /(?<!\?)\?(?!\.|\?)(?![:),])(?![(<])/g },
];

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (text.charCodeAt(i) === 10 /* "\n" */) line += 1;
	}
	return line;
}

export interface BranchGuardViolation {
	path: string;
	kind: BranchKind;
	line: number;
	/** The literal text that matched, e.g. "if (" - quoted in the reported message so it names
	 * what tripped the guard, not just its category. */
	snippet: string;
}

/** Human-readable text for one violation, shared by the driver script (real stderr output) and
 * this file's own tests, the same split scripts/fixtures-guard.ts's formatViolation uses. */
export function formatViolation(violation: BranchGuardViolation): string {
	return (
		`${violation.path}:${violation.line} has a banned ${violation.kind} construct ` +
		`(\`${violation.snippet}\`) - files in vitest.config.ts's coverage.exclude must stay ` +
		'logic-free (AGENTS.md: "Testing & coverage policy"). Move the decision into a covered ' +
		"pure module, or drop the file from coverage.exclude if it no longer belongs there."
	);
}

/** Every banned-construct occurrence found in `files`, scanning each file's real text (with
 * strings, template literals, and comments blanked first - see maskNonCode) for the constructs
 * CONSTRUCT_PATTERNS lists. `files` is expected to already be filtered to humble-object paths
 * (humbleObjectPaths); this function itself does not care where its input came from, matching
 * scripts/fixtures-guard.ts's own checkFixturesGuard split between "what files" (the driver's
 * job) and "what's wrong with them" (this module's job). */
export function checkBranchGuard(
	files: readonly SourceFile[],
): BranchGuardViolation[] {
	const violations: BranchGuardViolation[] = [];

	for (const file of files) {
		const masked = maskNonCode(file.text);

		for (const { kind, pattern } of CONSTRUCT_PATTERNS) {
			for (const rawMatch of masked.matchAll(pattern)) {
				// matchAll's results always carry a numeric `index` for a real match - lib.dom's
				// RegExpMatchArray types it `index?: number` only because the base Array shape
				// doesn't itself guarantee one; matchAll's own contract does. A `?? 0` fallback
				// would compile, but it adds a branch no real input can ever take (an
				// always-true `match.index !== undefined`), which would itself fail this
				// project's own 100%-branch gate - the cast avoids that, the same reasoning
				// scripts/fixtures-guard.ts's allCaptures documents for its own regex match.
				const match = rawMatch as unknown as [string] & { index: number };
				violations.push({
					path: posix.normalize(file.path),
					kind,
					line: lineAt(file.text, match.index),
					// No `.trim()` here (myusage-4xu.65: removed as dead code, confirmed by
					// mutation - deleting it produced zero test failures). Every CONSTRUCT_PATTERNS
					// entry above starts and ends its match on a character that can never be
					// whitespace (a keyword letter, `(`, `{`, `&`, `?`), so `match[0]` can never
					// carry leading or trailing whitespace for `.trim()` to remove.
					snippet: match[0],
				});
			}
		}
	}

	return violations;
}
