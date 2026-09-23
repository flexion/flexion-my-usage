// The Node-version preflight (myusage-4xu.7): the reader needs node:sqlite, which Node only
// ships from 22.13.0 (the engines.node floor in package.json). Below that, the raw failure is
// Node's own "No such built-in module: node:sqlite", thrown from deep inside the first read -
// accurate, but it doesn't say what to do about it. This module makes the decision ("is the
// running Node new enough?") a pure function of a version string and the floor, so the CLI can
// print a friendly upgrade message before it ever touches the reader, and so the decision is
// testable on every Node version without depending on which one the tests happen to run under.

export type Version = [major: number, minor: number, patch: number];

/**
 * The engines.node floor from package.json, already parsed. A tuple rather than a string so
 * nodeUpgradeMessage never has to handle "the floor didn't parse" - a branch no real caller
 * could reach, since this literal is the only floor ever passed. node-version.test.ts pins it
 * to package.json's own `engines.node`, so the two cannot silently drift apart; no file I/O is
 * needed before the preflight can run.
 */
export const NODE_FLOOR: Version = [22, 13, 0];

/**
 * The leading "major.minor.patch" of a version string, or undefined when it has no such prefix.
 * `process.versions.node` is a bare "X.Y.Z" on every release build; a nightly or custom build can
 * carry a suffix ("22.13.0-nightly..."), which this ignores - the numeric prefix is what the
 * comparison needs.
 */
export function parseVersion(version: string): Version | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `a` sorts strictly before `b`: major first, then minor, then patch. */
export function isOlder(a: Version, b: Version): boolean {
	const [aMajor, aMinor, aPatch] = a;
	const [bMajor, bMinor, bPatch] = b;
	if (aMajor !== bMajor) return aMajor < bMajor;
	if (aMinor !== bMinor) return aMinor < bMinor;
	return aPatch < bPatch;
}

/**
 * The upgrade message to print when `running` is an older Node than `floor`, or undefined when
 * it satisfies the floor. Fails open on an unparsable `running` string: the preflight is a
 * courtesy that improves the message for the common case (a stock, older Node), not a gate -
 * an unrecognizable version string is not that case, and the real import still fails with
 * Node's own error if the build genuinely lacks node:sqlite.
 *
 * That fail-open check is a real branch, not a fabricated one like the "floor didn't parse"
 * branch this function used to have: floor's type was tightened to an already-parsed `Version`
 * instead, since it's a literal this file owns and so can never fail to parse. `running` can't
 * be narrowed the same way - it's `process.versions.node` in production, a live string from the
 * host runtime that TypeScript can't verify at compile time (see the typecheck failure this
 * produces if the check below is deleted: `have` stays `Version | undefined`, and `isOlder`
 * won't accept it). Every real Node build satisfies parseVersion's regex, but nothing about
 * `running`'s type guarantees that; something has to decide what happens on the day it doesn't.
 */
export function nodeUpgradeMessage(
	running: string,
	floor: Version,
): string | undefined {
	const have = parseVersion(running);
	if (have === undefined) return undefined;
	if (!isOlder(have, floor)) return undefined;
	return (
		`my-usage needs Node ${floor.join(".")} or newer (it reads opencode's database through ` +
		`node:sqlite, which older releases don't ship). This is Node ${running} - ` +
		"upgrade Node and run it again."
	);
}
