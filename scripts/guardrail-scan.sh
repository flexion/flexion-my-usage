#!/usr/bin/env sh
# IP-leak guardrail for a public repo: secret scan (gitleaks) + internal-term denylist.
# Tracked: myusage-6d9.
#
# This script is committed, but the denylist of internal terms is NOT - it lives in a
# gitignored local file (.guardrail/denylist) and, in CI, in a repo secret. That keeps
# the internal terms themselves out of public history.
#
# Usage:
#   scripts/guardrail-scan.sh staged   # pre-commit: scan staged changes
#   scripts/guardrail-scan.sh tree     # CI backstop: scan the whole working tree
#
# Denylist path override: GUARDRAIL_DENYLIST_FILE (default .guardrail/denylist).
# Each non-blank, non-comment (#) line is a case-insensitive extended regex.

set -eu

mode="${1:-staged}"
denylist="${GUARDRAIL_DENYLIST_FILE:-.guardrail/denylist}"
status=0

# 1) Secret scan (gitleaks).
if command -v gitleaks >/dev/null 2>&1; then
  case "$mode" in
    staged) gitleaks protect --staged --redact --no-banner || status=1 ;;
    tree) gitleaks detect --redact --no-banner || status=1 ;;
    *) echo "guardrail: unknown mode '$mode'" >&2; exit 2 ;;
  esac
else
  echo "guardrail: gitleaks not found - skipping secret scan (install gitleaks to enable)" >&2
fi

# 2) Internal-term denylist.
if [ -f "$denylist" ]; then
  case "$mode" in
    staged) files=$(git diff --cached --name-only --diff-filter=ACM) ;;
    tree) files=$(git ls-files) ;;
  esac

  patterns=$(mktemp)
  grep -vE '^[[:space:]]*(#|$)' "$denylist" > "$patterns" || true

  if [ -s "$patterns" ] && [ -n "$files" ]; then
    hits=$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 grep -inEf "$patterns" 2>/dev/null || true)
    if [ -n "$hits" ]; then
      echo "guardrail: internal-term denylist matched - do NOT commit these to a public repo:" >&2
      printf '%s\n' "$hits" | sed 's/^/  /' >&2
      status=1
    fi
  fi
  rm -f "$patterns"
else
  echo "guardrail: denylist '$denylist' not found - skipping term check." >&2
  echo "          Populate it locally (see README) - CI enforces via a repo secret." >&2
fi

if [ "$status" -ne 0 ]; then
  echo "guardrail: BLOCKED. Remove the findings above (or amend the denylist if it is a false positive)." >&2
fi
exit "$status"
