// Direct unit tests for makeFixtureDir (myusage-4xu.116). This module is NOT excluded from
// coverage the way a *.fixtures.ts file would be (see its own header comment for why), so its
// lazy-init guard and cleanup guard both need to be proven here, not just exercised implicitly
// by the six call sites that use it.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeFixtureDir } from "./test-fixture-root.js";

/** A real scratch directory under the OS temp dir, removed after each test. */
async function scratchDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "my-usage-test-fixture-root-"));
}

describe("makeFixtureDir", () => {
	let scratch: string | undefined;

	afterEach(async () => {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		scratch = undefined;
	});

	it("creates fixtureParent and a per-run root on the first call, then reuses that root for later calls", async () => {
		scratch = await scratchDir();
		const fixtureParent = `${scratch}/nested/parent/`;
		const fixtureDir = makeFixtureDir(fixtureParent, () => {});

		const first = await fixtureDir();
		const second = await fixtureDir();

		expect((await stat(fixtureParent)).isDirectory()).toBe(true);
		expect(first).not.toBe(second);
		expect(dirname(first)).toBe(dirname(second));
		expect(dirname(first)).toMatch(/\/nested\/parent\/run-/);

		const parentEntries = await readdir(fixtureParent);
		// Both fixtureDir() calls share one run- root: only one entry directly under
		// fixtureParent, not one per call.
		expect(parentEntries).toHaveLength(1);
	});

	it("removes the per-run root, but not fixtureParent itself, when cleanup runs after a call", async () => {
		scratch = await scratchDir();
		const fixtureParent = `${scratch}/parent/`;
		let cleanup: () => Promise<void> = async () => {};
		const fixtureDir = makeFixtureDir(fixtureParent, (fn) => {
			cleanup = fn;
		});

		const dir = await fixtureDir();
		await cleanup();

		await expect(stat(dir)).rejects.toThrow();
		expect((await stat(fixtureParent)).isDirectory()).toBe(true);
	});

	it("does nothing when cleanup runs but fixtureDir() was never called", async () => {
		scratch = await scratchDir();
		const fixtureParent = `${scratch}/parent/`;
		let cleanup: () => Promise<void> = async () => {};
		makeFixtureDir(fixtureParent, (fn) => {
			cleanup = fn;
		});

		await expect(cleanup()).resolves.toBeUndefined();
	});
});
