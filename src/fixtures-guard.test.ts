// Behavioral tests for the pure decision logic behind scripts/check-fixtures-guard.mjs (bead
// myusage-9os): see scripts/fixtures-guard.ts's own header for the bug this closes and why.
//
// This logic lives in scripts/fixtures-guard.ts, not src/ - the same reason
// scripts/package-rules.ts does, see that file's header - but it is still type-checked by
// `yarn typecheck` and gated at 100% coverage by `yarn test` like every other file this project
// cares about, via vitest.config.ts's coverage.include. The other half of the bead's fix - proving
// scripts/check-fixtures-guard.mjs actually calls this module and exits non-zero for real - is
// covered separately in src/check-fixtures-guard.integration.test.ts, the same split
// src/check-package.integration.test.ts already uses for check-package.mjs/package-rules.ts.
import { describe, expect, it } from "vitest";
import {
	checkFixturesGuard,
	extractReferences,
	formatViolation,
	resolveRelativeSpecifier,
	stripComments,
} from "../scripts/fixtures-guard.js";

describe("stripComments", () => {
	it("removes a // line comment, keeping the code before it", () => {
		expect(stripComments("const x = 1; // a comment\nconst y = 2;")).toBe(
			"const x = 1; \nconst y = 2;",
		);
	});

	it("removes a /* */ block comment, including one spanning multiple lines", () => {
		expect(
			stripComments("const x = 1;\n/* block\n   comment */\nconst y = 2;"),
		).toBe("const x = 1;\n\nconst y = 2;");
	});

	it("does not corrupt a string literal containing // - the string-literal branch wins the alternation first", () => {
		const source = 'const u = "https://example.com/x";';

		expect(stripComments(source)).toBe(source);
	});

	it("does not corrupt a single-quoted string literal containing /*", () => {
		const source = "const u = 'not /* a comment';";

		expect(stripComments(source)).toBe(source);
	});

	it("does not corrupt a template literal", () => {
		const source = "const u = `a template literal`;";

		expect(stripComments(source)).toBe(source);
	});
});

describe("extractReferences", () => {
	it("extracts a named import's module specifier", () => {
		expect(
			extractReferences('import { helper } from "./thing.fixtures.js";'),
		).toEqual(["./thing.fixtures.js"]);
	});

	it("extracts a type-only import's module specifier", () => {
		expect(extractReferences('import type { X } from "./x.js";')).toEqual([
			"./x.js",
		]);
	});

	it("extracts an export-from's module specifier", () => {
		expect(extractReferences('export { helper } from "./thing.js";')).toEqual([
			"./thing.js",
		]);
	});

	it("extracts a multi-line import's specifier from its closing line, not its opening one", () => {
		// Real shape from this repo (src/pricing.ts): the keyword and "from" land on different
		// lines, so a scan anchored to "import" appearing on the SAME line as "from" would miss
		// this entirely.
		const source =
			'import {\n\thelperOne,\n\thelperTwo,\n} from "./thing.fixtures.js";';

		expect(extractReferences(source)).toEqual(["./thing.fixtures.js"]);
	});

	it("extracts a new URL(...) literal's first argument", () => {
		expect(
			extractReferences('new URL("./thing.fixtures.ts", import.meta.url);'),
		).toEqual(["./thing.fixtures.ts"]);
	});

	it("does not extract a new URL(...) call whose first argument is not a string literal", () => {
		expect(extractReferences("new URL(someVariable);")).toEqual([]);
	});

	it("ignores a comment that quotes fake import syntax", () => {
		const source = [
			'// import { helper } from "./thing.fixtures.js";',
			"const real = 1;",
		].join("\n");

		expect(extractReferences(source)).toEqual([]);
	});

	it("ignores a block comment that quotes a fake new URL(...) call", () => {
		const source = [
			"/*",
			' * new URL("./thing.fixtures.ts", import.meta.url)',
			" */",
			"const real = 1;",
		].join("\n");

		expect(extractReferences(source)).toEqual([]);
	});

	it("extracts both a real import and a real new URL(...) reference from the same file", () => {
		const source = [
			'import { vi } from "vitest";',
			'const p = new URL("./sibling.fixtures.ts", import.meta.url);',
		].join("\n");

		expect(extractReferences(source)).toEqual([
			"vitest",
			"./sibling.fixtures.ts",
		]);
	});

	it("returns an empty list for a file with no imports or new URL(...) calls", () => {
		expect(extractReferences("export const x = 1;")).toEqual([]);
	});
});

describe("resolveRelativeSpecifier", () => {
	it("resolves a same-directory relative specifier, mapping .js to .ts", () => {
		expect(
			resolveRelativeSpecifier(
				"src/pricing-table.test.ts",
				"./thing.fixtures.js",
			),
		).toBe("src/thing.fixtures.ts");
	});

	it("resolves a parent-directory relative specifier", () => {
		expect(
			resolveRelativeSpecifier("src/sources/opencode.ts", "../aggregate.js"),
		).toBe("src/aggregate.ts");
	});

	it("leaves a non-.js extension unchanged", () => {
		expect(
			resolveRelativeSpecifier("src/thing.test.ts", "./fixture.json"),
		).toBe("src/fixture.json");
	});

	it("returns undefined for a non-relative (bare package) specifier", () => {
		expect(
			resolveRelativeSpecifier("src/thing.test.ts", "vitest"),
		).toBeUndefined();
	});
});

describe("formatViolation", () => {
	it("formats a banned-import violation", () => {
		expect(
			formatViolation({
				kind: "banned-import",
				importer: "src/aggregate.ts",
				fixturesFile: "src/thing.fixtures.ts",
			}),
		).toMatch(/src\/aggregate\.ts imports src\/thing\.fixtures\.ts/);
	});

	it("formats an unverified-fixtures violation", () => {
		expect(
			formatViolation({
				kind: "unverified-fixtures",
				fixturesFile: "src/orphan.fixtures.ts",
			}),
		).toMatch(/src\/orphan\.fixtures\.ts cannot be verified as test-only/);
	});
});

describe("checkFixturesGuard", () => {
	it("returns no violations for an empty file list", () => {
		expect(checkFixturesGuard([])).toEqual([]);
	});

	it("flags a production file that statically imports a fixtures file, even when the fixtures file is otherwise verified test support", () => {
		const files = [
			{
				path: "src/aggregate.ts",
				text: 'import { helper } from "./thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: 'import { vi } from "vitest";\nexport function helper() {\n\tvi.fn();\n\treturn 1;\n}\n',
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "banned-import",
				importer: "src/aggregate.ts",
				fixturesFile: "src/thing.fixtures.ts",
			},
		]);
	});

	it("does not flag a real test file importing a fixtures file that imports vitest itself", () => {
		const files = [
			{
				path: "src/thing.test.ts",
				text: 'import { helper } from "./thing.fixtures.js";\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: 'import { vi } from "vitest";\nexport function helper() {\n\treturn vi.fn();\n}\n',
			},
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});

	it("flags a fixtures file that imports no test framework and has no referencer at all", () => {
		const files = [
			{
				path: "src/orphan.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{ kind: "unverified-fixtures", fixturesFile: "src/orphan.fixtures.ts" },
		]);
	});

	it("does not flag a fixtures file referenced only via new URL(...) from a real test file, even without a vitest import - the load-price-table-via-proxy.fixtures.ts shape", () => {
		const files = [
			{
				path: "src/sub.test.ts",
				text: [
					'import { fileURLToPath } from "node:url";',
					'const p = fileURLToPath(new URL("./entry.fixtures.ts", import.meta.url));',
					"void p;",
				].join("\n"),
			},
			{
				path: "src/entry.fixtures.ts",
				text: 'console.log("standalone entrypoint");\n',
			},
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});

	it("does not treat a fixtures file importing another fixtures file as a banned import, but still requires each to independently verify as test-only", () => {
		const files = [
			{
				path: "src/a.fixtures.ts",
				text: 'import { helper } from "./b.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/b.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		// Neither file imports vitest, and neither has a real *.test.* referencer:
		// src/a.fixtures.ts has none at all, and src/b.fixtures.ts's only referencer
		// (src/a.fixtures.ts) is itself just another fixtures file, not proof of anything.
		expect(checkFixturesGuard(files)).toEqual([
			{ kind: "unverified-fixtures", fixturesFile: "src/a.fixtures.ts" },
			{ kind: "unverified-fixtures", fixturesFile: "src/b.fixtures.ts" },
		]);
	});

	it("reports one banned-import violation per production importer of the same fixtures file", () => {
		const files = [
			{
				path: "src/one.ts",
				text: 'import { helper } from "./shared.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/two.ts",
				text: 'import { helper } from "./shared.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/shared.fixtures.ts",
				text: 'import { vi } from "vitest";\nexport function helper() {\n\treturn vi.fn();\n}\n',
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "banned-import",
				importer: "src/one.ts",
				fixturesFile: "src/shared.fixtures.ts",
			},
			{
				kind: "banned-import",
				importer: "src/two.ts",
				fixturesFile: "src/shared.fixtures.ts",
			},
		]);
	});

	it("ignores a relative import that does not resolve to a fixtures file", () => {
		const files = [
			{
				path: "src/aggregate.ts",
				text: 'import type { PricedRow } from "./pricing.js";\n',
			},
			{ path: "src/pricing.ts", text: "export interface PricedRow {}\n" },
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});
});
