// Shared "mkdtemp fixture root" idiom for every integration test that spawns a real subprocess
// against a real, on-disk scratch directory, plus src/pricing.fixtures.ts's useTempCacheDirs.
// Consolidated here (myusage-4xu.116) after src/check-package.integration.test.ts,
// src/check-fixtures-guard.integration.test.ts, src/check-branch-guard.integration.test.ts,
// src/check-renovate-engines.integration.test.ts, src/clean-dist.integration.test.ts (myusage-
// 4xu.114, myusage-5vf) and pricing.fixtures.ts (independently, earlier) all grew byte-for-byte
// copies of the same fix for the same race.
//
// The race: an earlier version fixed each fixture root to one path derived from
// import.meta.url - identical across every process that runs the same test file against the
// same checkout. Two vitest processes running that file at once - e.g. two overlapping `yarn
// test` invocations, or one overlapping the tail of another - resolved to that same path, so
// one process's own cleanup (`rm(fixtureRoot, { recursive: true })`) deleted the other
// process's still-in-flight fixtures out from under it mid-test. Reproduced directly against
// check-package.integration.test.ts: 8 concurrent `yarn vitest run` invocations of that file,
// repeated over several rounds, failed nearly every time - wrong exit codes from files
// vanishing mid-run, and once an `ENOTEMPTY: directory not empty, rmdir ...` from one
// process's recursive `rm` racing another process's concurrent writes into the same tree.
//
// An earlier fix namespaced the path by process.pid instead. That closes the race between two
// *live* processes, but a pid is only unique among processes currently running: a hard-killed
// process (SIGKILL, OOM) never reaches its cleanup, so nothing sweeps its `pid-<n>/` directory,
// and the OS is free to reuse that pid later - at which point a new run's "unique" path
// collides with the dead run's leftover tree. `mkdtemp` instead asks the OS to atomically
// allocate a directory guaranteed not to already exist, so the uniqueness guarantee holds
// across time, not just among live processes - and a stale run's leftovers under
// `<fixtureParent>run-*/` are still simple to spot and prune by hand if one is ever hard-killed
// before cleanup.
//
// Deliberately not named *.fixtures.ts (myusage-4xu.116): that suffix opts a file out of the
// coverage gate entirely (AGENTS.md's test-support convention), which is the right call for
// pure test doubles with no decisions to get wrong, but wrong here - the lazy-init guard below
// IS the fix for the race above, and letting it go untested would just recreate the same blind
// spot under a different name. See src/__tests__/test-fixture-root.test.ts for its direct coverage.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterAll } from "vitest";

/**
 * Builds a `fixtureDir()` factory scoped to `fixtureParent`. The first call creates
 * `fixtureParent` (shared by every process that runs against the same checkout, and never
 * itself removed) if needed, then `mkdtemp`s a per-run root directory inside it; every call -
 * including the first - `mkdtemp`s a fresh subdirectory inside that per-run root, so no two
 * calls, even across concurrent test files, ever return the same directory.
 *
 * `registerCleanup` defaults to vitest's real `afterAll`, which removes the per-run root (not
 * `fixtureParent` itself) once this module's caller's suite finishes. It is overridable only so
 * src/__tests__/test-fixture-root.test.ts can capture and invoke that cleanup directly instead of waiting
 * on a real end-of-suite hook; every real call site relies on the default.
 */
export function makeFixtureDir(
	fixtureParent: string,
	registerCleanup: (cleanup: () => Promise<void>) => void = afterAll,
): () => Promise<string> {
	let fixtureRoot: string | undefined;

	registerCleanup(async () => {
		if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
	});

	return async function fixtureDir(): Promise<string> {
		if (!fixtureRoot) {
			await mkdir(fixtureParent, { recursive: true });
			fixtureRoot = await mkdtemp(`${fixtureParent}run-`);
		}
		return mkdtemp(`${fixtureRoot}/t-`);
	};
}
