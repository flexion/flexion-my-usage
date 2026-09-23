// End-to-end tests for scripts/check-fixtures-guard.mjs itself, run as a real subprocess against
// a real, on-disk scratch src/ tree (bead myusage-9os).
//
// src/fixtures-guard.test.ts pins the pure decision logic with plain data, but nothing there
// proves check-fixtures-guard.mjs actually calls it, reads real files, or exits with the right
// code. These tests close that gap: they run the unmodified script exactly as `yarn lint` does -
// via tsx - against a real scratch src/ tree, the same split
// src/check-package.integration.test.ts already uses for check-package.mjs/package-rules.ts.
//
// Spawned via tsx, not a bare `node`: check-fixtures-guard.mjs imports scripts/fixtures-guard.ts
// directly (see that script's header comment for why), so plain `node` cannot run it without
// relying on Node's experimental, version-dependent type stripping.
//
// Fixtures live under node_modules/.cache/ (never the real home or the system temp dir) and are
// removed afterward, the same convention every other integration test in this repo uses.
//
// The fixture root is allocated per-run via `mkdtemp` (bead myusage-5vf) - see
// src/__tests__/test-fixture-root.ts for the canonical writeup of the cross-process race this avoids.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFixtureDir } from "./__tests__/test-fixture-root.js";

const SCRIPT = fileURLToPath(
	new URL("../scripts/check-fixtures-guard.mjs", import.meta.url),
);

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const FIXTURE_PARENT = fileURLToPath(
	new URL(
		"../node_modules/.cache/my-usage-tests/check-fixtures-guard/",
		import.meta.url,
	),
);

const fixtureDir = makeFixtureDir(FIXTURE_PARENT);

function runCheckFixturesGuard(cwd: string) {
	return spawnSync(TSX, [SCRIPT], { cwd, encoding: "utf8" });
}

describe("scripts/check-fixtures-guard.mjs against a real scratch src/ tree", () => {
	it("fails when a production file imports a fixtures file", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/src`, { recursive: true });
		await writeFile(
			`${dir}/src/prod.ts`,
			'import { helper } from "./thing.fixtures.js";\nhelper();\n',
		);
		await writeFile(
			`${dir}/src/thing.fixtures.ts`,
			'import { vi } from "vitest";\nexport function helper() {\n\treturn vi.fn();\n}\n',
		);

		const result = runCheckFixturesGuard(dir);

		// Reproduced directly against the pre-fix state (no check-fixtures-guard.mjs at all):
		// this exact fixture left `yarn lint` exiting 0, silently.
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/prod\.ts imports src\/thing\.fixtures\.ts/,
		);
	});

	it("fails when a fixtures file cannot be verified as test-only", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/src`, { recursive: true });
		await writeFile(
			`${dir}/src/orphan.fixtures.ts`,
			"export function helper() {\n\treturn 1;\n}\n",
		);

		const result = runCheckFixturesGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/orphan\.fixtures\.ts cannot be verified as test-only/,
		);
	});

	it("passes for a clean tree where a fixtures file is imported only by a real test file and imports vitest itself", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/src`, { recursive: true });
		await writeFile(
			`${dir}/src/thing.test.ts`,
			'import { helper } from "./thing.fixtures.js";\n',
		);
		await writeFile(
			`${dir}/src/thing.fixtures.ts`,
			'import { vi } from "vitest";\nexport function helper() {\n\treturn vi.fn();\n}\n',
		);

		const result = runCheckFixturesGuard(dir);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/check-fixtures-guard: OK/);
	});

	it("recurses into subdirectories of src/", async () => {
		const dir = await fixtureDir();
		await mkdir(`${dir}/src/sources`, { recursive: true });
		await writeFile(
			`${dir}/src/sources/prod.ts`,
			'import { helper } from "./thing.fixtures.js";\nhelper();\n',
		);
		await writeFile(
			`${dir}/src/sources/thing.fixtures.ts`,
			'import { vi } from "vitest";\nexport function helper() {\n\treturn vi.fn();\n}\n',
		);

		const result = runCheckFixturesGuard(dir);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/src\/sources\/prod\.ts imports src\/sources\/thing\.fixtures\.ts/,
		);
	});
});
