# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
yarn install --immutable   # install
yarn typecheck             # tsc --noEmit
yarn lint                  # Biome + inline coverage-pragma guard + fixtures-import guard
yarn test                  # the gate: all tests + 100% coverage (see below)
yarn vitest run <path>     # fast loop on one file, no coverage
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

### Coverage: 100% lines, branches, functions, statements (per file)

Full policy is in `AGENTS.md` under "Testing & coverage policy". That file is the source of truth. The short version:

- `yarn test` fails below 100%. Every file under `src/` counts, tested or not.
- Exclude only **humble objects** (zero logic, I/O or wiring only), in `coverage.exclude` in `vitest.config.ts`, as explicit paths. No globs. Test code is excluded by name (these two ARE globs, on purpose): `*.test.*`, `*.fixtures.*`. `*.spec.*` is not a recognized suffix here (myusage-9os) - `test.include` never matched it, so it was invisible to both halves of the gate.
- Inline `v8`/`c8`/`istanbul ignore` comments fail `yarn lint`.
- Invasive-species rule: keep application logic free of vendor imports. Adapters stay thin, and one with real logic is covered, not excluded.
- Don't `vi.mock` a vendor to reach a line. Use a real local fixture or a fake behind a seam we own, or extract the logic.
- Coverage must not depend on the Node version. Test a version-specific decision as a pure function.
