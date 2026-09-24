# Releasing

Merging to `main` never publishes. A release is a separate, manual step: you push a version tag, and CI does the rest.

## Cut a release

1. Bump `version` in `package.json` in a PR, and merge it to `main`.
2. Tag that merge commit and push the tag:

   ```
   git tag vX.Y.Z <merge-sha>
   git push origin vX.Y.Z
   ```

The tag must be `v` plus the exact `package.json` version - package `0.3.1` means tag `v0.3.1`. The `release` job re-runs the checks, asserts the tag matches `package.json` (and fails loud on a mismatch), builds, publishes to npm (when enabled - see below), and creates a GitHub Release with auto-generated notes.

## Enable npm publish (first release only)

Publishing is gated so nothing ships by accident. The package is `@flexion.us/my-usage`, published public (`publishConfig.access` in `package.json`) under the `flexion.us` npm org.

npm can only attach a trusted publisher to a package that already exists, so the very first version goes out by hand:

1. `npm login` as an owner of the `flexion.us` org.
2. From a clean checkout of the release commit: `yarn install --immutable && yarn build && npm publish`. This version has no provenance - every CI release after it does.
3. On npmjs.com, open the package's **Settings > Trusted Publisher**, choose GitHub Actions, and enter organization `flexion`, repository `flexion-my-usage`, workflow filename `ci.yml` (filename only, no path).
4. Once Trusted Publishing works, set **Publishing access** on that same settings page to disallow tokens, so only CI can publish.
5. Tag that commit `v<version>` and push the tag while `NPM_PUBLISH_ENABLED` is still unset. That creates the GitHub Release and skips the npm step, which would otherwise fail on a version already published by hand.
6. Set the repo variable `NPM_PUBLISH_ENABLED` to `true`. The next version bump is the first one CI publishes.

After that, releases follow [Cut a release](#cut-a-release): the `release` job authenticates via OIDC (no long-lived token) and npm attaches provenance automatically. It runs on Node 24 because Trusted Publishing needs npm 11.5.1 or newer, and it fails before publishing if npm is older.

Until `NPM_PUBLISH_ENABLED` is `true`, a tag still builds and creates a GitHub Release but skips the npm publish - useful for a dry run.
