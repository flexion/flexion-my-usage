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

	it('does not flag an identifier that merely contains "if" as a substring, like verifyIf(...) or motif(...)', () => {
		const files = [
			{
				path: "src/index.ts",
				text: "verifyIf(x);\nmotif(y);\n",
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

	it("does not flag .forEach( or .map( - a method call is not a for/while/do keyword", () => {
		const files = [
			{
				path: "src/index.ts",
				text: "items.forEach((item) => use(item));\nitems.map((item) => item);\n",
			},
		];

		expect(checkBranchGuard(files)).toEqual([]);
	});

	it('does not flag "meanwhile" or "todo" as while/do keywords', () => {
		const files = [
			{ path: "src/index.ts", text: "const meanwhile = 1;\nconst todo = 2;\n" },
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
