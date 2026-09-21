#!/usr/bin/env sh
# IP-leak guardrail for a public repo: secret scan (gitleaks) + internal-term denylist.
# Tracked: myusage-6d9.
#
# This script is committed, but the denylist of internal terms is NOT - it lives in a
# gitignored local file (.guardrail/denylist) and, in CI, in a repo secret. That keeps
# the internal terms themselves out of public history.
#
# Usage:
#   scripts/guardrail-scan.sh staged     # pre-commit: scan staged changes
#   scripts/guardrail-scan.sh tree       # CI backstop: scan each commit's added diff lines
#   scripts/guardrail-scan.sh snapshot   # CI backstop: full-snapshot scan of the working tree
#
# staged and tree are both diff-based (gitleaks protect --staged / gitleaks detect): they only
# see lines a diff reports as added. An in-place body swap inside an existing secret block -
# replacing the base64 content between unchanged BEGIN/END marker lines - never shows up as an
# added line in either mode, so a rule that anchors on the BEGIN marker (e.g. gitleaks'
# private-key rule) can't catch it there. snapshot (gitleaks detect --no-git) scans the tree's
# current file contents directly, independent of git history or diffs, and catches that class of
# swap. Tracked: myusage-hfu.
#
# snapshot also walks the gitignored coverage/ directory, since it scans the filesystem
# directly rather than tracked files. That's safe: src/pricing.fixtures.ts's throwaway
# TEST_ORIGIN_KEY never appears there, because vitest.config.ts excludes *.fixtures.*
# files from coverage instrumentation and reporting entirely (see the comment there) -
# not because of the allowlist in .gitleaks.toml, which only applies to gitleaks'
# own scans of tracked source and has no bearing on coverage/'s contents. Tracked:
# myusage-qhc (corrects a wrong claim about this in PR #48's own body).
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
    snapshot) gitleaks detect --no-git --redact --no-banner || status=1 ;;
    *) echo "guardrail: unknown mode '$mode'" >&2; exit 2 ;;
  esac
else
  echo "guardrail: gitleaks not found - skipping secret scan (install gitleaks to enable)" >&2
fi

# 2) Internal-term denylist.
# snapshot mode skips this: it already runs unconditionally in tree mode against every tracked
# file's current content (not a diff), so a snapshot re-run of the same check adds no coverage -
# only the gitleaks call above needs a separate, non-diff-based pass.
if [ -f "$denylist" ] && [ "$mode" != "snapshot" ]; then
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
elif [ "$mode" = "snapshot" ]; then
  echo "guardrail: snapshot mode - term check already covered by tree mode, skipping." >&2
else
  echo "guardrail: denylist '$denylist' not found - skipping term check." >&2
  echo "          Populate it locally (see README) - CI enforces via a repo secret." >&2
fi

if [ "$status" -ne 0 ]; then
  echo "guardrail: BLOCKED. Remove the findings above (or amend the denylist if it is a false positive)." >&2
fi
exit "$status"
