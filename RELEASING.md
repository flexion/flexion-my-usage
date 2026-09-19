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

Publishing is gated so nothing ships by accident. Before the first real release:

- Pick the npm package name and set it in `package.json` (it is a placeholder today), and remove `"private": true`.
- Set up npm Trusted Publishing (OIDC) for the package, linked to this repo and the CI workflow - no long-lived token needed. The release job already requests `id-token: write` and runs `npm publish --provenance`.
- Set the repo variable `NPM_PUBLISH_ENABLED` to `true`.

Until `NPM_PUBLISH_ENABLED` is `true`, a tag still builds and creates a GitHub Release but skips the npm publish - useful for a dry run.
