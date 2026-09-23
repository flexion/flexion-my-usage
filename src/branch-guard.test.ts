// Behavioral tests for the pure decision logic behind scripts/check-branch-guard.mjs (bead
// myusage-qx9): see scripts/branch-guard.ts's own header for the gap this closes and the
// investigation (GritQL + Biome overrides, and why a regex scan was chosen instead) behind it.
//
// This logic lives in scripts/branch-guard.ts, not src/ - the same reason
// scripts/fixtures-guard.ts does, see that file's header - but it is still type-checked by
// `yarn typecheck` and gated at 100% coverage by `yarn test` like every other file this project
// cares about, via vitest.config.ts's coverage.include. The other half of the bead's fix -
// proving scripts/check-branch-guard.mjs actually calls this module, reads vitest.config.ts's
// real coverage.exclude, and exits non-zero for real - is covered separately in
// src/check-branch-guard.integration.test.ts, the same split src/fixtures-guard.test.ts and
// src/check-fixtures-guard.integration.test.ts already use.
import { describe, expect, it } from "vitest";
import {
	checkBranchGuard,
	formatViolation,
	humbleObjectPaths,
	isHumbleObjectPath,
	maskNonCode,
} from "../scripts/branch-guard.js";

describe("isHumbleObjectPath", () => {
	it("accepts an explicit path with no glob metacharacter", () => {
		expect(isHumbleObjectPath("src/index.ts")).toBe(true);
		expect(isHumbleObjectPath("src/sources/types.ts")).toBe(true);
	});

	it.each([
		["src/**/*.test.*", "*"],
		["src/**/*.fixtures.*", "*"],
		["src/x?.ts", "?"],
		["src/[abc].ts", "["],
		["src/a].ts", "]"],
		["src/{a,b}.ts", "{"],
		["src/a}.ts", "}"],
		["!src/a.ts", "!"],
	])("rejects %s (contains %s)", (entry) => {
		expect(isHumbleObjectPath(entry)).toBe(false);
	});
});

describe("humbleObjectPaths", () => {
	it("filters a coverage.exclude-shaped array down to the explicit humble-object paths, dropping the test-support globs", () => {
		expect(
			humbleObjectPaths([
				"src/**/*.test.*",
				"src/**/*.fixtures.*",
				"src/index.ts",
				"src/sources/types.ts",
			]),
		).toEqual(["src/index.ts", "src/sources/types.ts"]);
	});

	it("returns an empty list when every entry is a glob", () => {
		expect(
			humbleObjectPaths(["src/**/*.test.*", "src/**/*.fixtures.*"]),
		).toEqual([]);
	});
});

describe("maskNonCode", () => {
	it("blanks a // line comment, keeping the code before it and the newline", () => {
		expect(maskNonCode("const x = 1; // if (real) {}\nconst y = 2;")).toBe(
			"const x = 1;                \nconst y = 2;",
		);
	});

	it("blanks a /* */ block comment spanning multiple lines, keeping the newlines", () => {
		const masked = maskNonCode(
			"const x = 1;\n/* if (fake) {\n  return 1;\n} */\nconst y = 2;",
		);
		expect(masked).toBe(
			"const x = 1;\n              \n           \n    \nconst y = 2;",
		);
		expect(masked.split("\n")).toHaveLength(5);
	});

	it("blanks a double-quoted string literal, so branch-shaped text inside it is not real code", () => {
		expect(maskNonCode('const u = "a && b ? c : d";')).toBe(
			"const u =                 ;",
		);
	});

	it("blanks a single-quoted string literal", () => {
		expect(maskNonCode("const u = 'if (x) return x;';")).toBe(
			"const u =                   ;",
		);
	});

	it("blanks a whole template literal, including an interpolation - a known, documented gap (a real branch inside the interpolation is invisible too)", () => {
		// This string is deliberately plain, HOLDING source text that itself contains a
		// template literal with an interpolation - the input maskNonCode is meant to mask, not a
		// mistaken template string of this test file's own.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: see comment above.
		expect(maskNonCode("const u = `${a ?? b}`;")).toBe(
			"const u =            ;",
		);
	});

	it("does not corrupt a string literal containing a /* -shaped substring", () => {
		const source = 'const u = "not /* a comment";';
		expect(maskNonCode(source)).toBe(
			'const u = "not /* a comment";'.replace(/"(?:[^"\\]|\\.)*"/, (whole) =>
				whole.replace(/[^\n]/g, " "),
			),
		);
	});

	it("leaves ordinary code with no strings or comments unchanged", () => {
		const source =
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
		expect(maskNonCode(source)).toBe(source);
	});

	it("blanks a regex literal preceded by =, so branch-shaped characters inside it (?, &&) are not real code (myusage-4xu.65)", () => {
		const source = "export const COLOR_RE = /colou?r/;\n";
		const REGEX_LITERAL = /\/(?:[^/\\\n]|\\.)+\/[a-z]*/;
		expect(maskNonCode(source)).toBe(
			source.replace(REGEX_LITERAL, (whole) => whole.replace(/[^\n]/g, " ")),
		);
	});

	it("does not desync string parity across lines when a regex literal's unescaped quote follows a keyword the lookbehind heuristic doesn't recognize (myusage-4xu.138: PR #122's independent reviewer found this scanner shares the risk family PR #122 fixed in package-rules.ts/fixtures-guard.ts's STRING_OR_COMMENT, reachable through this file's OWN documented false-negative failure direction - \"a real regex right after a keyword that ends in a letter (return /foo/;, typeof /foo/;) is not recognized as one\", see this file's header). `return /\"/g;`'s lookbehind sees \"n\" (from \"return\", skipping the space) immediately before the regex's opening `/`, a word character, so the regex-literal alternative does NOT match here - exactly like the OLD, unfixed STRING_OR_COMMENT in the other two files, nothing matches at the `/` position, so the scan advances to the bare `\"` right after it and (BEFORE this fix) the double-quote branch opened a phantom string there. Unlike those two files' STRING_OR_COMMENT (already fixed to exclude a raw newline from the quote branches' content class), this file's quote branches still allowed one, so the phantom string didn't stop at end of line - it ran on to the NEXT real quote in the file, here the opening `\"` of `\"text\"` two lines down, swallowing the real `if (real) {}` line between them as if it were string content. REPRODUCED directly against the pre-fix regex: maskNonCode blanked the entire `if (real) {}` line. Confining the quote branches to one line (this fix) bounds the corruption to the single line the stray quote sits on, matching PR #122's own mitigation: the phantom string here now fails to find a same-line closer and never matches at all, leaving `if (real) {}` untouched, and the real `\"text\"` string two lines down is masked as itself, not as some earlier match's closing delimiter.", () => {
		const source = ['return /"/g;', "if (real) {}", 'const s = "text";'].join(
			"\n",
		);
		expect(maskNonCode(source)).toBe(
			['return /"/g;', "if (real) {}", "const s =       ;"].join("\n"),
		);
	});

	it("does not mask an ordinary division expression following an identifier - a known, documented heuristic limitation (see this file's header) (myusage-4xu.66: the prior fixture, \"total / 2\", had only one / on the line, so it could never reach the closing-/ half of the regex-literal alternative at all, let alone the value-ending lookbehind guard it claimed to test - it passed whether or not that guard existed. This fixture has two /s, so it actually exercises the guard: also asserting checkBranchGuard sees the real && between the two divisions proves the guard, not just maskNonCode's no-op output, is doing the work)", () => {
		const source = "export const x = (a / b) && (c / d);\n";
		expect(maskNonCode(source)).toBe(source);
		expect(checkBranchGuard([{ path: "src/index.ts", text: source }])).toEqual([
			{ path: "src/index.ts", kind: "&&", line: 1, snippet: "&&" },
		]);
	});
});

describe("checkBranchGuard", () => {
	it("returns no violations for an empty file list", () => {
		expect(checkBranchGuard([])).toEqual([]);
	});

	it("returns no violations for a genuinely humble file (real src/sources/types.ts shape)", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: [
					"export interface Handle {",
					"\tsource: string;",
					"\tpath: string;",
					"}",
					"",
					"export interface UsageSource {",
					"\treadonly name: string;",
					"\tdiscover(): Promise<Handle[]>;",
					"}",
					"",
				].join("\n"),
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("flags an if statement, reporting the file, line, kind, and matched snippet", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export function f(x: number): number {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "if", line: 2, snippet: "if (" },
		]);
	});

	it('does not flag an identifier that merely contains "if" as a substring, like motif(...) (myusage-4xu.73: a prior verifyIf(...) fixture alongside this one was inert padding - "verifyIf" has a capital I, so the lowercase-only \\bif\\s*\\( pattern was never going to reach it regardless of the leading \\b boundary this test means to pin; only motif(y) does real work, so it stands alone here)', () => {
		const files = [
			{
				path: "src/index.ts",
				text: "motif(y);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("flags a switch statement - the construct GritQL could not generally match (see scripts/branch-guard.ts's header)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "switch (x) {\n\tcase 1:\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "switch", line: 1, snippet: "switch (" },
		]);
	});

	it('does not flag an identifier that merely contains "switch" as a substring, like toggleswitch(...) (myusage-4xu.67: unlike its siblings if/while - see the motif and meanwhile/todo{ tests above and below (myusage-4xu.74: this cross-reference previously named "verifyIf/motif" and "dowhile", both since removed or renamed) - nothing previously pinned that the switch pattern\'s leading \\b is load-bearing; hand-verified: stripping \\b from just the switch pattern left the full suite green before this test existed. The fixture ends its identifier in "switch" with the call\'s "(" immediately after, mirroring motif(...) and meanwhile(...)\'s shape - "switch" alone, without an immediately-following "(", would never even reach the pattern, the same reason myusage-4xu.66 rejected a fixture with only one "/" for the regex-masking guard)', () => {
		const files = [{ path: "src/index.ts", text: "toggleswitch(3);\n" }];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("flags a classic for loop as a loop violation", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "for (let i = 0; i < 3; i++) {\n\tdoWork(i);\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "loop", line: 1, snippet: "for (" },
		]);
	});

	it("flags a for...of loop as a loop violation, not just classic for (myusage-4xu.63: this shape shared the classic-for pattern with no dedicated test pinning it)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "for (const x of [1, 2, 3]) {\n\tuse(x);\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "loop", line: 1, snippet: "for (" },
		]);
	});

	it("flags a for...in loop as a loop violation, not just classic for (myusage-4xu.63: same unpinned gap as for...of above)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "for (const k in { a: 1 }) {\n\tuse(k);\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "loop", line: 1, snippet: "for (" },
		]);
	});

	it("flags a for-await-of loop as a loop violation (myusage-4xu.63: the await token between for and ( broke the original pattern entirely - this planted a real for-await-of loop and confirmed the pre-fix driver reported no violations at all)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "async function drain(xs: AsyncIterable<number>): Promise<void> {\n\tfor await (const x of xs) {\n\t\tuse(x);\n\t}\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{
				path: "src/index.ts",
				kind: "loop",
				line: 2,
				snippet: "for await (",
			},
		]);
	});

	it("flags a while loop as a loop violation", () => {
		const files = [
			{ path: "src/index.ts", text: "while (running) {\n\ttick();\n}\n" },
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "loop", line: 1, snippet: "while (" },
		]);
	});

	it("flags both ends of a do-while loop as two loop violations - the do{ and the trailing while(...) are each independently banned control-flow keywords", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "let n = 0;\ndo {\n\tn += 1;\n} while (n < 3);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "loop", line: 2, snippet: "do {" },
			{ path: "src/index.ts", kind: "loop", line: 4, snippet: "while (" },
		]);
	});

	it('does not flag .forEach( (rejected by the \\s*\\( requirement right after the keyword - forEach\'s next character is "E", not "(" or whitespace) or waitfor( (rejected by the leading \\b boundary instead - "wait" ends in a word character, so \\bfor never reaches the "for" inside "waitfor") - two different mechanisms, each pinned by its own line (myusage-4xu.71: waitfor(3) is the missing pin for for\'s leading \\b, the one loop keyword whose live leading-boundary check had zero coverage - confirmed by mutation: stripping that \\b makes this fixture fail with a false-positive "for (" match. myusage-4xu.72/.74: a prior .map( line in this fixture was inert padding - "map" contains neither "for", "while", nor "do", so no boundary condition of this pattern was ever exercised by it, and the fixture\'s own title incorrectly attributed its rejection to the \\s*\\( mechanism that only actually explains forEach\'s rejection; removed rather than kept as an unexplained pass. The dead-trailing-\\b claim this title previously made for \\bfor\\b - "this fixture is the proof" - is also removed here: a green test proves this fixture doesn\'t detect the change, not that the regex path is dead; the actual proof is the brute-force differential documented in scripts/branch-guard.ts\'s header comment)', () => {
		const files = [
			{
				path: "src/index.ts",
				text: "items.forEach((item) => use(item));\nwaitfor(3);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it('does not flag "meanwhile" or "todo {" as while/do keywords (myusage-4xu.65: the original fixture - const meanwhile = 1; / const todo = 2; - never reached the pattern\'s \\b guards at all, since neither line had the ( or { the loop pattern requires; meanwhile(3) does, mirroring the sibling "if" test\'s motif(...) fixture above. myusage-4xu.69: the do half of THIS test was itself inert even after that fix - the dowhile(3) fixture it used can never reach do\'s pattern at all, since do requires a following {, not (, so only the meanwhile half ever did real work; confirmed by mutation - removing do\'s leading \\b left dowhile(3) green. Swapped in todo { instead: "do" inside "todo" fails the leading \\b the same way "while" inside "meanwhile" does, and removing do\'s leading \\b now makes this fixture fail with a false-positive "do {" match - the same hand-verification meanwhile\'s while-boundary already had)', () => {
		const files = [
			{ path: "src/index.ts", text: "meanwhile(3);\ntodo {\n\tx();\n}\n" },
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it('does not flag whileLoop( or doThing { as while/do keywords (myusage-4xu.104: the missing counterpart to the forEach(/waitfor( pair above - "meanwhile"/"todo {" above pin the LEADING \\b boundary (the keyword does not start at a word boundary), but nothing pinned the ADJACENCY requirement right after the keyword for while/do the way forEach( pins it for for. whileLoop( starts with a real "while" at a genuine word boundary, then continues with more word characters ("Loop") before reaching "(", so it must be rejected by the \\s*\\( requirement, not the \\b one; doThing { is the same shape for do\'s \\s*\\{ requirement. Confirmed by mutation: widening the pattern to \\bwhile\\w*\\s*\\( or \\bdo\\w*\\s*\\{ leaves the rest of the suite green but makes this fixture fail with a false-positive "while (" or "do {" match)', () => {
		const files = [
			{ path: "src/index.ts", text: "whileLoop(3);\ndoThing {\n\tx();\n}\n" },
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("flags && as a violation", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export const both = (a: unknown, b: unknown) => a && b;\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "&&", line: 1, snippet: "&&" },
		]);
	});

	it("flags ?? as a violation", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export const c = (a: unknown, b: unknown) => a ?? b;\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "??", line: 1, snippet: "??" },
		]);
	});

	it("flags ??= as a ?? violation - nullish assignment is still nullish coalescing", () => {
		const files = [
			{ path: "src/index.ts", text: "let x: unknown;\nx ??= 1;\n" },
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "??", line: 2, snippet: "??" },
		]);
	});

	it("flags a ternary conditional expression", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export const t = (x: number) => (x > 0 ? 1 : -1);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "ternary", line: 1, snippet: "?" },
		]);
	});

	it("does not flag optional chaining (?.) as a ternary", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export const v = (a?: { b: number }) => a?.b;\n",
			},
		];

		// a?.b is optional chaining, not a ternary - but a?: is an optional PARAMETER marker,
		// also not a ternary. Neither should be flagged at all.
		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("does not flag an optional property marker in an interface (x?: T)", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: "export interface Options {\n\ttimeout?: number;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("does not flag an optional parameter with no default (x?) followed by a type", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export function f(x?: number) {\n\treturn x;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("does not flag an optional method signature (discover?(): Promise<void>;) as a ternary (myusage-4xu.64: the original optional-marker guard excluded x?:/x?)/x?, but not ?( - reproduced end-to-end before this fix by planting this exact shape into a scratch src/sources/types.ts and confirming the real driver reported a banned-ternary violation)", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: [
					"export interface UsageSource {",
					"\treadonly name: string;",
					"\tdiscover?(): Promise<void>;",
					"\tclose?(): Promise<void>;",
					"}",
					"",
				].join("\n"),
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("does not flag an optional generic method signature (load?<T>(id: string): Promise<T>;) as a ternary - the ?< half of the same fix", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: "export interface Loader {\n\tload?<T>(id: string): Promise<T>;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("still flags a real ternary whose consequent starts with a parenthesized expression (x ? (x) : -x) - proves the ?( exclusion above didn't also swallow this legitimate shape, since a real ternary always has whitespace between ? and (, unlike an optional method signature's ?(", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "export const t = (x: number) => (x > 0 ? (x) : -x);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "ternary", line: 1, snippet: "?" },
		]);
	});

	it("flags a ternary whose consequent is a string literal (myusage-4xu.67: maskNonCode blanks the consequent to spaces before the ternary pattern ever runs, so the old whitespace-tolerant `?`-then-`:` optional-marker exclusion misread the masked gap as a real x?: marker's empty one and swallowed the ternary - checkBranchGuard on this exact source returned [] on origin/main, confirmed by direct execution before this fix)", () => {
		const files = [
			{ path: "src/index.ts", text: 'const x = c ? "a" : "b";\n' },
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "ternary", line: 1, snippet: "?" },
		]);
	});

	it("flags a ternary whose consequent is a template literal - the same masked-consequent gap as the string case above, spelled with backticks", () => {
		const files = [
			{ path: "src/index.ts", text: "const x = c ? `a` : `b`;\n" },
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "ternary", line: 1, snippet: "?" },
		]);
	});

	it("still does not flag a real optional property/parameter marker (x?:, x?), x?,) now that the exclusion requires zero whitespace - proves tightening the gap above didn't also break the shapes it was written for (myusage-4xu.68: the x?, shape was previously untested despite the title's own claim - the fixture only ever had x?: and x?); confirmed by mutation - dropping the comma from the optional-marker character class [:),] left this test green. g(x?, y?: number) below adds a genuine x?, occurrence, an optional parameter with no type annotation immediately followed by a comma)", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: "export interface Options {\n\ttimeout?: number;\n}\n",
			},
			{
				path: "src/index.ts",
				text: "export function f(x?: number, y?) {\n\treturn x;\n}\nexport function g(x?, y?: number) {\n\treturn y;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("DOES flag a false-positive ternary for an optional marker with an inline block comment between ? and its terminator (timeout?/* note */: number;) - a known, accepted gap this file's header now documents (myusage-4xu.68): maskNonCode blanks the comment to spaces before the ternary pattern ever runs, leaving the same masked-whitespace-before-terminator shape the zero-whitespace tightening (myusage-4xu.67) exists to catch, indistinguishable at that point from a real ternary's masked string/template consequent. Unlike hand-typed whitespace (x? : number), which Biome's formatter collapses back to x?: number, a block comment survives formatting unchanged, so this shape can genuinely arise in formatted code", () => {
		const files = [
			{
				path: "src/sources/types.ts",
				text: "export interface Options {\n\ttimeout?/* note */: number;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{
				path: "src/sources/types.ts",
				kind: "ternary",
				line: 2,
				snippet: "?",
			},
		]);
	});

	it("does not flag ?/&&/?? characters inside a regex literal as real branching constructs (myusage-4xu.65)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: [
					"export const COLOR_RE = /colou?r/;",
					"export const AND_RE = /a&&b/;",
					"export const real = 1;",
				].join("\n"),
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("still flags a real if statement that sits between a regex literal's unrecognized quote and a later real string literal (myusage-4xu.138: the checkBranchGuard-level consequence of the maskNonCode fix above - before it, this exact if was silently swallowed by the cross-line phantom string, a missed violation, not a false alarm)", () => {
		const files = [
			{
				path: "src/index.ts",
				text: ['return /"/g;', "if (real) {}", 'const s = "text";'].join("\n"),
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "if", line: 2, snippet: "if (" },
		]);
	});

	it("normalizes a coverage.exclude-shaped path like ./src/index.ts to src/index.ts in a violation's reported path (myusage-4xu.65: posix.normalize's own effect was previously untested)", () => {
		const files = [
			{
				path: "./src/index.ts",
				text: "if (a) {\n\treturn 1;\n}\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "if", line: 1, snippet: "if (" },
		]);
	});

	it("does not flag branch-shaped text inside a string or comment literal", () => {
		const files = [
			{
				path: "src/index.ts",
				text: [
					"// if (fake) { switch (fake) { while (fake) {} } }",
					'const s = "a && b ?? c ? d : e";',
					"export const real = 1;",
				].join("\n"),
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it("reports every violation across multiple files, each with its own path", () => {
		const files = [
			{ path: "src/index.ts", text: "if (a) {\n\treturn 1;\n}\n" },
			{ path: "src/sources/types.ts", text: "export const b = a ?? c;\n" },
		];

		expect(checkBranchGuard(files)).toEqual([
			{ path: "src/index.ts", kind: "if", line: 1, snippet: "if (" },
			{ path: "src/sources/types.ts", kind: "??", line: 1, snippet: "??" },
		]);
	});
});

describe("formatViolation", () => {
	it("names the path, line, kind, and matched snippet, and points at AGENTS.md", () => {
		const message = formatViolation({
			path: "src/index.ts",
			kind: "if",
			line: 4,
			snippet: "if (",
		});

		expect(message).toMatch(/src\/index\.ts:4/);
		expect(message).toMatch(/banned if construct/);
		expect(message).toMatch(/`if \(`/);
		expect(message).toMatch(/coverage\.exclude/);
		expect(message).toMatch(/AGENTS\.md/);
	});
});
