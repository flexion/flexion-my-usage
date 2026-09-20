#!/usr/bin/env sh
# Coverage-exclusion guard: fail on inline coverage-ignore comments in src/.
#
# The 100% coverage gate (vitest.config.ts) is only meaningful if the ONLY way to exclude
# code is the explicit, path-based `coverage.exclude` list, where a reviewer sees it.
# v8 also honors inline comments such as `/* v8 ignore next */`, which would let any
# change carve out untested code without touching config. Those are banned.
#
# See "Testing & coverage policy" in AGENTS.md. Run via `yarn lint`.

set -eu

pattern='(v8|c8|istanbul|node:coverage)[[:space:]]+ignore'
hits=$(grep -rnE "$pattern" src || true)

if [ -n "$hits" ]; then
  echo "coverage-pragmas: inline coverage-ignore comments are not allowed:" >&2
  printf '%s\n' "$hits" | sed 's/^/  /' >&2
  echo "coverage-pragmas: exclude a humble object in vitest.config.ts, or move the logic" >&2
  echo "                  into a covered pure module. See AGENTS.md." >&2
  exit 1
fi
