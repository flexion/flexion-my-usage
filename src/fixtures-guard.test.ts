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

	it("does not corrupt a single-quoted string literal containing a terminated /* ... */-shaped sequence", () => {
		// myusage-4xu.57: the previous fixture's "/*" was UNTERMINATED, so the lazy block-comment
		// branch (/\*[\s\S]*?\*\//) never matched it regardless of whether string-awareness
		// worked - this fixture terminates it, so a naive strip (matching comment shapes without
		// regard to surrounding quotes) would actually consume it, and leaving it alone is what
		// this test proves.
		const source = "const u = 'not /* a comment */ here';";

		expect(stripComments(source)).toBe(source);
	});

	it("does not corrupt a template literal containing a //- or /*-shaped substring", () => {
		// myusage-4xu.57: the previous fixture held no "//" or "/*" at all, so it could not tell
		// "stripComments works" apart from "stripComments does nothing" - this one holds both
		// shapes inside the backticks, so a naive strip (matching comment shapes without regard
		// to the enclosing template literal) would corrupt it, and leaving it alone is what this
		// test proves.
		const source =
			"const u = `see https://example.com/x or /* not a comment */ inside`;";

		expect(stripComments(source)).toBe(source);
	});

	it("still strips a real // comment that follows a regex literal with an unescaped quote character (myusage-4xu.131)", () => {
		// package-rules.ts's identical STRING_OR_COMMENT technique has the same gap (see that
		// file's test of the same name, in src/package-rules.test.ts) - this is the twin fix PR
		// #119's independent reviewer asked for in both places. This scanner has no concept of a
		// regex literal - it only tracks bare `"`, `'`, and backtick characters - so a regex
		// literal containing an unescaped quote (this repo's own src/render.ts:43:
		// `.replace(/"/g, "&quot;")`) contains a bare `"` inside `/.../` that the scanner reads
		// as OPENING a phantom string. That flips string/comment parity for the rest of the
		// file, so the real `//` comment on the next line is no longer recognized as a comment
		// at all and survives untouched. REPRODUCED directly against the current regex: the
		// comment line below is not removed from the output.
		const source = [
			'const html = value.replace(/"/g, "&quot;");',
			'// import { helper } from "./thing.fixtures.js";',
			"const real = 1;",
		].join("\n");

		expect(stripComments(source)).toBe(
			[
				'const html = value.replace(/"/g, "&quot;");',
				"",
				"const real = 1;",
			].join("\n"),
		);
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

	it("matches isFixturesFile on the basename, not the full path - a directory segment shaped like '.fixtures.' must not itself make a resolved path count as a fixtures file", () => {
		// myusage-4xu.57: src/package-rules.test.ts has a parity test for this exact discipline
		// on its own analogous helper ("matches on the basename, not the full path"); this mirrors
		// it for isFixturesFile. The resolved reference here is "src/my.fixtures.dir/index.ts" -
		// its basename ("index.ts") has no ".fixtures." in it, only an ancestor directory segment
		// ("my.fixtures.dir") does, so it must not be treated as a fixtures-file reference at all.
		const files = [
			{
				path: "src/aggregate.ts",
				text: 'import { helper } from "./my.fixtures.dir/index.js";\nhelper();\n',
			},
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});

	it("matches isRealTestFile on the basename, not the full path - a directory segment shaped like '.test.' does not count as a real test referencer", () => {
		// myusage-4xu.57: same discipline as the isFixturesFile parity test above, for
		// isRealTestFile. src/my.test.thing/helper.ts's own basename ("helper.ts") has no
		// ".test." in it, only an ancestor directory segment ("my.test.thing") does, so it must
		// not count as a real *.test.* referencer - leaving src/thing.fixtures.ts unverified (it
		// imports no test framework and has no other referencer). The banned-import violation
		// fires either way (src/my.test.thing/helper.ts is production code regardless of this
		// distinction), so its presence in the expected result doesn't mask the difference: only
		// the second, unverified-fixtures violation depends on basename-only matching.
		const files = [
			{
				path: "src/my.test.thing/helper.ts",
				text: 'import { helper } from "../thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "banned-import",
				importer: "src/my.test.thing/helper.ts",
				fixturesFile: "src/thing.fixtures.ts",
			},
			{ kind: "unverified-fixtures", fixturesFile: "src/thing.fixtures.ts" },
		]);
	});

	it("does not false-positive an unverified-fixtures violation when the only referencer is a __tests__-directory helper without '.test.' in its own basename", () => {
		// myusage-4xu.58: isRealTestFile required ".test." in the basename, so a legitimate
		// test-support helper shaped like src/__tests__/helper.ts (no ".test." in "helper.ts")
		// didn't count as a valid referencer on its own. REPRODUCED by hand against the pre-fix
		// isRealTestFile (basename-only, no directory check): this exact input produced a
		// false-positive unverified-fixtures violation for src/thing.fixtures.ts. The importer
		// itself is exempt from banned-import already (package-rules.ts's own __tests__/
		// directory convention), so this isolates the unverified-fixtures half of the fix.
		const files = [
			{
				path: "src/__tests__/helper.ts",
				text: 'import { helper } from "../thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});

	it("does not let a fixtures file under __tests__/ vouch for another fixtures file's test-only status", () => {
		// myusage-4xu.60: both PR #66 reviewers found the same gap in myusage-4xu.58's fix
		// above - isRealTestFile's new directory check didn't also exclude *.fixtures.* files,
		// so a fixtures file placed under __tests__/ could "vouch for" another fixtures file,
		// exactly the shape the header rule forbids ("referenced by a real *.test.*-named
		// file - not merely another *.fixtures.* file"). REPRODUCED by hand against the pre-fix
		// isRealTestFile (basename check OR bare directory check, no fixtures exclusion): this
		// exact input flagged only src/__tests__/a.fixtures.ts, letting src/b.fixtures.ts pass
		// unflagged - vouched for by a file that itself never runs as a test
		// (vitest.config.ts's test.include is src/**/*.test.*, which a.fixtures.ts doesn't
		// match) and is itself excluded from coverage. Both must be flagged.
		const files = [
			{
				path: "src/__tests__/a.fixtures.ts",
				text: 'import { helper } from "../b.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/b.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "unverified-fixtures",
				fixturesFile: "src/__tests__/a.fixtures.ts",
			},
			{ kind: "unverified-fixtures", fixturesFile: "src/b.fixtures.ts" },
		]);
	});

	it("does not let a referencer matching both *.test.* and *.fixtures.* vouch for another fixtures file, even though it would itself run as a real test per test.include's own glob", () => {
		// myusage-4xu.61: src/x.test.fixtures.ts genuinely matches BOTH vitest.config.ts's
		// test.include (src/**/*.test.* - it would actually run as a test) AND isFixturesFile's
		// own ".fixtures." check. isRealTestFile's `!isFixturesFile(path)` exclusion
		// (myusage-4xu.60) already treats this dual-suffix shape as ineligible to vouch for
		// another fixtures file, fail-closed - but nothing pinned that as the INTENDED behavior,
		// rather than an accidental side effect of the exclusion, until this test. Pins the
		// existing behavior: src/x.test.fixtures.ts is itself a *.fixtures.* file (nothing
		// references it, so it's separately unverified), and it cannot vouch for
		// src/thing.fixtures.ts either, so both end up flagged - the same two-violation shape
		// the __tests__/-vouching test above produces for the analogous directory-based case.
		const files = [
			{
				path: "src/x.test.fixtures.ts",
				text: 'import { helper } from "./thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "unverified-fixtures",
				fixturesFile: "src/x.test.fixtures.ts",
			},
			{ kind: "unverified-fixtures", fixturesFile: "src/thing.fixtures.ts" },
		]);
	});

	it("does not count a directory segment that merely contains __tests__ as a substring as a real test referencer", () => {
		// myusage-4xu.60 test-quality gap (a): exact-segment match, the same discipline
		// package-rules.test.ts already pins for its own analogous directory check ("does not
		// flag a directory whose name merely contains __mocks__ as a substring"). Nothing here
		// previously distinguished "isUnderTestSupportDir walks exact segments" from "it
		// substring-matches" - this does. src/my__tests__thing/helper.ts's own basename has no
		// ".test." in it either, so this isolates the directory-segment check specifically.
		const files = [
			{
				path: "src/my__tests__thing/helper.ts",
				text: 'import { helper } from "../thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{
				kind: "banned-import",
				importer: "src/my__tests__thing/helper.ts",
				fixturesFile: "src/thing.fixtures.ts",
			},
			{ kind: "unverified-fixtures", fixturesFile: "src/thing.fixtures.ts" },
		]);
	});

	it("does not false-positive an unverified-fixtures violation when the only referencer is a __mocks__-directory helper without '.test.' in its own basename", () => {
		// myusage-4xu.60 test-quality gap (c): the __tests__ case just above (and the
		// myusage-4xu.58 test further up) exercises __tests__, but __mocks__ - half of
		// TEST_SUPPORT_DIR - had zero dedicated coverage. Mirrors the __tests__ shape.
		const files = [
			{
				path: "src/__mocks__/helper.ts",
				text: 'import { helper } from "../thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([]);
	});

	it("does not count a file under a literal fixtures/ directory as a real test referencer, even though that same directory exempts it from banned-import", () => {
		// myusage-4xu.60 test-quality gap (b): isUnderTestSupportDir's own comment argues at
		// length that its directory set must NOT include "fixtures" (unlike package-rules.ts's
		// TEST_OR_SUPPORT_DIR, which does, for its own different purpose), because a bare
		// fixtures/ directory proves a file is test SUPPORT, not that it's a REAL test able to
		// verify another fixtures file. Nothing pinned that claim before this. src/fixtures/
		// helper.ts IS exempt from banned-import (filterTestOrSupportPaths' own directory set
		// includes "fixtures"), so only the unverified-fixtures violation below would disappear
		// if "fixtures" were ever added to isUnderTestSupportDir's set - which is exactly what
		// this test would then fail to catch.
		const files = [
			{
				path: "src/fixtures/helper.ts",
				text: 'import { helper } from "../thing.fixtures.js";\nhelper();\n',
			},
			{
				path: "src/thing.fixtures.ts",
				text: "export function helper() {\n\treturn 1;\n}\n",
			},
		];

		expect(checkFixturesGuard(files)).toEqual([
			{ kind: "unverified-fixtures", fixturesFile: "src/thing.fixtures.ts" },
		]);
	});
});
