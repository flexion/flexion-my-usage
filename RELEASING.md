# Releasing

Merging to `main` never publishes. A release has two manual gates: you push a version tag, CI stages the version on npm, and a maintainer approves it with 2FA before anyone can install it.

## Cut a release

1. Bump `version` in `package.json` in a PR, and merge it to `main`.
2. Tag that merge commit and push the tag:

   ```
   git tag vX.Y.Z <merge-sha>
   git push origin vX.Y.Z
   ```

3. Once the `release` job finishes, approve the staged version with 2FA - either on npmjs.com, or from the CLI:

   ```
   npm stage list @flexion.us/my-usage
   npm stage approve <stage-id>
   ```

   Until it's approved, the version isn't installable. `npm stage reject <stage-id>` throws it away instead.

The tag must be `v` plus the exact `package.json` version - package `0.3.1` means tag `v0.3.1`. The `release` job re-runs the checks, asserts the tag matches `package.json` (and fails loud on a mismatch), builds, stages the version on npm (when enabled - see below), and creates a GitHub Release with auto-generated notes.

## Enable npm publish (first release only)

Publishing is gated so nothing ships by accident. The package is `@flexion.us/my-usage`, published public (`publishConfig.access` in `package.json`) under the `flexion.us` npm org.

npm can only attach a trusted publisher to a package that already exists, so the very first version goes out by hand:

1. `npm login` as an owner of the `flexion.us` org.
2. From a clean checkout of the release commit: `yarn install --immutable && yarn build && npm publish`. This version has no provenance - every CI release after it does.
3. On npmjs.com, open the package's **Settings > Trusted Publisher**, choose GitHub Actions, and enter organization `flexion`, repository `flexion-my-usage`, workflow filename `ci.yml` (filename only, no path). Leave **Allow `npm publish`** unchecked, so CI can only stage a version and every release waits for 2FA approval.
4. Once Trusted Publishing works, set **Publishing access** on that same settings page to disallow tokens, so only CI can stage a version and only a maintainer's 2FA can publish one.
5. Tag that commit `v<version>` and push the tag while `NPM_PUBLISH_ENABLED` is still unset. That creates the GitHub Release and skips the npm step, which would otherwise fail on a version already published by hand.
6. Set the repo variable `NPM_PUBLISH_ENABLED` to `true`. The next version bump is the first one CI stages.

After that, releases follow [Cut a release](#cut-a-release): the `release` job authenticates via OIDC (no long-lived token) and runs `npm stage publish --provenance`. It runs on Node 24 because Trusted Publishing needs npm 11.5.1 or newer, and it fails before staging if npm is older or has no `npm stage` command.

Until `NPM_PUBLISH_ENABLED` is `true`, a tag still builds and creates a GitHub Release but skips the npm stage - useful for a dry run.
