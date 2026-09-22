#!/usr/bin/env sh
# Coverage-exclusion guard: fail on inline coverage-ignore comments anywhere the 100%
# coverage gate applies.
#
# The 100% coverage gate (vitest.config.ts) is only meaningful if the ONLY way to exclude
# code is the explicit, path-based `coverage.exclude` list, where a reviewer sees it.
# v8 also honors inline comments such as `/* v8 ignore next */`, which would let any
# change carve out untested code without touching config. Those are banned.
#
# Scans src/ plus every path in COVERED_NON_SRC below: scripts/package-rules.ts (bead
# myusage-4xu.19) is build-time-only tooling that lives outside src/ on purpose (src/ is what
# `yarn build` ships, and this checker must not ship itself), but vitest.config.ts's
# coverage.include still covers it at 100% like every src/ file - so it needs the same pragma
# ban. Explicit paths here, not a scripts/**/*.ts glob, matching how tsconfig.config.json and
# vitest.config.ts already reference them: nothing else under scripts/ is covered, so nothing
# else needs scanning. scripts/critical-persisted.ts (bead myusage-4xu.25) and
# scripts/fixtures-guard.ts (bead myusage-9os) are the same shape, for the same reason;
# critical-persisted.ts was covered by vitest.config.ts's coverage.include from the start but
# missed here until myusage-9os noticed the two lists had drifted apart while auditing this
# exact class of "covered somewhere, gated nowhere" gap. scripts/branch-guard.ts (bead
# myusage-qx9) is the same shape once more. scripts/renovate-engines-guard.ts (bead
# myusage-4xu.85) is the same shape again.
#
# Fails closed: a missing or renamed src/ or COVERED_NON_SRC entry is a hard error, not a
# silent pass, and grep's own error exit (2) is treated the same as a match, not swallowed
# as "no hits". The match is case-insensitive so an uppercase or mixed-case pragma (e.g.
# `V8 ignore`) is still caught, even though v8 itself only honors the lowercase form today -
# defence in depth. Portable to both BSD grep (macOS) and GNU grep (CI, ubuntu): -r, -n, -i,
# -E and the [[:space:]] POSIX class all work on both.
#
# See "Testing & coverage policy" in AGENTS.md. Run via `yarn lint`.

set -eu

if [ ! -d src ]; then
  echo "coverage-pragmas: src/ not found; refusing to pass a check that scanned nothing." >&2
  exit 1
fi

COVERED_NON_SRC="scripts/package-rules.ts scripts/critical-persisted.ts scripts/fixtures-guard.ts scripts/branch-guard.ts scripts/renovate-engines-guard.ts"
for f in $COVERED_NON_SRC; do
  if [ ! -f "$f" ]; then
    echo "coverage-pragmas: $f not found; refusing to pass a check that scanned nothing." >&2
    exit 1
  fi
done

pattern='(v8|c8|istanbul|node:coverage)[[:space:]]+ignore'

set +e
# shellcheck disable=SC2086  # COVERED_NON_SRC is a deliberate space-separated path list, not a
# single quoted argument - none of its entries contain a space, so word-splitting is safe here.
hits=$(grep -rniE "$pattern" src $COVERED_NON_SRC)
rc=$?
set -e

case "$rc" in
  0)
    echo "coverage-pragmas: inline coverage-ignore comments are not allowed:" >&2
    printf '%s\n' "$hits" | sed 's/^/  /' >&2
    echo "coverage-pragmas: exclude a humble object in vitest.config.ts, or move the logic" >&2
    echo "                  into a covered pure module. See AGENTS.md." >&2
    exit 1
    ;;
  1)
    # No match: pass.
    ;;
  *)
    echo "coverage-pragmas: grep failed scanning src/ (exit $rc); treating that as a failure" >&2
    echo "                  rather than a silent pass." >&2
    exit 1
    ;;
esac
