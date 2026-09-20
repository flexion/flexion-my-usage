#!/usr/bin/env sh
# Coverage-exclusion guard: fail on inline coverage-ignore comments in src/.
#
# The 100% coverage gate (vitest.config.ts) is only meaningful if the ONLY way to exclude
# code is the explicit, path-based `coverage.exclude` list, where a reviewer sees it.
# v8 also honors inline comments such as `/* v8 ignore next */`, which would let any
# change carve out untested code without touching config. Those are banned.
#
# Fails closed: a missing or renamed src/ is a hard error, not a silent pass, and grep's
# own error exit (2) is treated the same as a match, not swallowed as "no hits". The match
# is case-insensitive so an uppercase or mixed-case pragma (e.g. `V8 ignore`) is still
# caught, even though v8 itself only honors the lowercase form today - defence in depth.
# Portable to both BSD grep (macOS) and GNU grep (CI, ubuntu): -r, -n, -i, -E and the
# [[:space:]] POSIX class all work on both.
#
# See "Testing & coverage policy" in AGENTS.md. Run via `yarn lint`.

set -eu

if [ ! -d src ]; then
  echo "coverage-pragmas: src/ not found; refusing to pass a check that scanned nothing." >&2
  exit 1
fi

pattern='(v8|c8|istanbul|node:coverage)[[:space:]]+ignore'

set +e
hits=$(grep -rniE "$pattern" src)
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
