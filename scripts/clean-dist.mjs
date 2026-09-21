// Removes stale build output before a fresh `yarn build` (bead myusage-4xu.20). tsc only ever
// adds or overwrites what the current source produces; it never deletes what an earlier build
// emitted and the current source no longer does. Without this, a file like a stale
// dist/aggregate.test.js - left over from before tsconfig.build.json excluded test files, or
// from a branch switch - survives untouched, doubling test counts if it's ever re-run and
// silently shipping in the next `npm pack` until a developer manually `rm -rf dist`.
//
// Wired into `yarn build` directly (`"build": "node scripts/clean-dist.mjs && tsc -p
// tsconfig.build.json"`), not as a package.json "prebuild" lifecycle script: Yarn Berry (unlike
// npm and Yarn Classic) does not auto-run pre/post hooks for user-defined scripts (verified
// locally against this repo's yarn 4.18.0 - a "premytest" script never ran under `yarn mytest`
// or `yarn run mytest`), so a "prebuild" script here would silently never fire. Explicit
// chaining also sidesteps this guard's own caveat about a "prebuild" script firing during `npm
// pack` (see scripts/check-package.mjs's --ignore-scripts) - there is no lifecycle script here
// for `npm pack` to trigger in the first place.
//
// Plain `node`, not tsx: no logic here worth sharing with scripts/package-rules.ts, so there is
// nothing to import and no reason to pay tsx's startup cost on every build.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
