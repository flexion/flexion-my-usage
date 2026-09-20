// Pure decision logic behind scripts/check-package.mjs (bead myusage-4xu.19): the
// test-or-support name pattern, the separator-safe directory-prefix check, and the pack-list
// vacuity check. Kept here, under src/, instead of inline in the script so it is type-checked
// by `yarn typecheck` and covered at 100% by `yarn test` like every other file under src/ -
// scripts/ is outside tsconfig.json's `include` and is only linted, never type-checked or
// unit tested. scripts/check-package.mjs imports this module directly (via tsx, not a build)
// and only wires it to real I/O: a real dist/ tree and a real `npm pack --dry-run`.
import { basename } from "node:path";

/** The build's output directory. Single source of truth: scripts/check-package.mjs imports
 * this instead of repeating the literal. */
export const DIST = "dist";

// Convention (keep in sync with tsconfig.build.json): a file whose name contains ".test.",
// ".spec." or ".fixtures." is test code or test support. Anything only tests import belongs
// in one of those names so the build leaves it out.
const TEST_OR_SUPPORT = /\.(test|spec|fixtures)\./;

/** The paths whose basename matches the test-or-support name pattern - a directory segment
 * that happens to contain one of these markers (e.g. `my.test.dir/index.ts`) does not count;
 * only the file's own name decides. */
export function filterTestOrSupportPaths(paths: string[]): string[] {
	return paths.filter((path) => TEST_OR_SUPPORT.test(basename(path)));
}

function normalizeSeparators(path: string): string {
	return path.replaceAll("\\", "/");
}

/** Whether `path` sits strictly under `dir` - a same-prefix sibling directory (`distant/` vs
 * `dist`) does not count - independent of whether `path` is POSIX- or Windows-separated. */
export function isUnderDir(path: string, dir: string): boolean {
	return normalizeSeparators(path).startsWith(`${dir}/`);
}

/** Whether the packed file list accounts for at least as many `dist/` entries as `dist/`
 * actually holds. npm always packs the file `bin` points to regardless of package.json's
 * `files`, so a pack list that merely contains at least one dist/ path is not proof `files`
 * covers the built output: a `files` list that excludes dist/ still yields one dist/ entry
 * (the bin target) and would pass a "some dist/ file is listed" check vacuously. Comparing
 * counts instead catches that. `distFiles` is trusted to already be dist/'s own listing (see
 * listFiles(DIST) in check-package.mjs), so its entries count directly; `packedFiles` is
 * filtered by isUnderDir so either side can be POSIX- or Windows-separated. */
export function packListCoversDist(
	distFiles: string[],
	packedFiles: string[],
): boolean {
	const packedDistCount = packedFiles.filter((path) =>
		isUnderDir(path, DIST),
	).length;
	return packedDistCount >= distFiles.length;
}
