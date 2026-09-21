

## Testing & coverage policy

`yarn test` enforces **100% statements, branches, functions and lines, per file**. Below that, it fails. There's no baseline and no ratchet.

| Command | Use |
| --- | --- |
| `yarn test` | The gate. All tests plus coverage. CI runs this. |
| `yarn vitest run <path>` | Fast loop on one file. No coverage, so it doesn't gate. |
| `yarn lint` | Biome, the inline coverage-pragma guard, and the fixtures-import guard. |

`yarn test <path>` fails on purpose: every file you didn't run counts as uncovered. Use `yarn vitest run <path>` to iterate.

### Rules

- Every file under `src/` counts, tested or not (`coverage.include`). An untested file fails the gate.
- Exclusions live in `coverage.exclude` in `vitest.config.ts`, and hold two different kinds of entry. Test code and test support are excluded by naming: `*.test.*`, `*.fixtures.*` (the same convention `tsconfig.build.json` uses) - these two are globs, on purpose, so the convention applies across all of `src/` without listing every file. Humble objects are everything else in that array: each is an explicit path, never a glob, so a new file can't be excluded by accident. Don't give production code test-support names.
- `*.spec.*` is not a recognized test-file suffix in this repo (myusage-9os): it used to be listed as one, but `test.include` never matched it, so a `src/x.spec.ts` file was excluded from coverage while never actually running - a failing assertion inside one still produced a green `yarn test`. No `src/**/*.spec.*` file has ever existed here; don't reintroduce the suffix without also widening `test.include` in `vitest.config.ts` in the same change.
- A `*.fixtures.*` file being excluded from coverage is not by itself proof it's test support - only that the gate skips it. `yarn lint` runs `scripts/check-fixtures-guard.mjs` (pure logic in `scripts/fixtures-guard.ts`) to check that separately, by scanning exactly two reference shapes: a static `from "..."` import/export specifier, and a `new URL("...", ...)` call's string-literal first argument (the idiom a subprocess fixture uses to hand itself its own path). It fails if either shape, outside test code or test support, names a `*.fixtures.*` file, and it fails a `*.fixtures.*` file that can't be verified as test-only through those same two shapes - it must either import `"vitest"` itself, or be referenced that way by a real `*.test.*`-named file (basename match, not merely a `.test.`-shaped ancestor directory), or by a file under an exact `__tests__/` or `__mocks__/` directory segment (not merely a directory whose name contains one as a substring). A `*.fixtures.*` file never counts as that referencer either way, no matter which directory it sits under - only a real test, or a non-fixtures helper under `__tests__/`/`__mocks__/`, can vouch for another fixtures file's test-only status. It does **not** see a dynamic `await import("./x.fixtures.js")` or a bare side-effect `import "./x.fixtures.js"` - neither shape occurs in this repo today, and `yarn check:package` independently catches either one if it ever shipped a fixtures file into `dist/`.
- Inline `v8 ignore`, `c8 ignore` and `istanbul ignore` comments fail `yarn lint`.
- Don't lower thresholds, add an exclusion to turn a build green, or write a test that asserts nothing just to touch lines.
- Don't reach 100% by mocking a vendor module (`vi.mock` on a driver, `fs`, `fetch`). Use a real local fixture (a throwaway SQLite file, a temp directory) or a small fake behind a seam we own, like the injected `fetch` in the price table. If neither works, extract the logic.
- Coverage must not depend on the runtime. If a line only runs on some Node versions (for example, the `node:sqlite` warning), move the decision into a pure function and test it directly.
- **Failed cleanup** (a stream `cancel()`, an `rm()` of a stray temp file, or similar best-effort teardown after a real error) is swallowed, not left to replace the operation's own error with a less useful one - but only when a real test proves the swallow does what it claims. Give the cleanup call a seam that can genuinely fail without mocking a vendor module (a real `ReadableStream` whose `cancel()` rejects, or an injected function like the price table's `LoadOptions.rm`), then assert two things: the cleanup call actually ran, and the operation's original error still surfaces unchanged. A `.catch(() => {})` (or `Promise.allSettled`) with no such test is unproven defensive code - either earn it with that test or delete the swallow so the failure surfaces.
- **Fabricated-input-only branches** (the broader pattern the failed-cleanup rule above is one case of): a branch reachable only through a fabricated or cast test double - `as unknown as Response`, a hand-built object shaped like a type without being one - isn't proven, no matter how green the suite is. If no real caller can produce that input at the actual trust boundary, delete the branch instead of covering it with a cast. Keep it only when it guards a genuine trust boundary (untrusted network input, a real vendor object, real filesystem state) *and* a real instance of that boundary type can be constructed to reach it - a real `Response` with a null body, a real `ReadableStream` whose `cancel()` rejects, not a stand-in shaped like one.

### The invasive-species rule

- Control third-party dependencies to avoid entangling them with core business logic
- Humble objects or adapters SHALL be used to ensure the majority of code depends on things under our control
- Isolate third-party components to protect application logic
- Focus on keeping application logic independent of tactical dependencies

Why this gets us to 100%: logic that depends only on things we control takes plain data in and returns plain data out, so it needs no mocks. What's left is a thin seam to the outside world, and that seam is too simple to test.

### What counts as a humble object

A file may be excluded only if **all** of these hold:

1. **Zero business logic.** No decisions, transforms, parsing, or rules. Passing a value along is fine. Choosing or reshaping one is not.
2. **A test would exercise a vendor or the runtime, not our code.**
3. **Correct by inspection.** If you'd need to run it to trust it, it has logic.

| Excluded file | Why it's humble |
| --- | --- |
| `src/index.ts` | Composition root. Wires the pipeline and touches `process` and `console`. |
| `src/sources/types.ts` | Type-only. Compiles to no runtime code. |

Not humble, so covered: anything that parses, maps, normalizes, prices, aggregates, formats or decides. That includes turning a raw DB row into a `NormalizedUsageRow`.

The opencode reader (`src/sources/opencode.ts`) and the price table (`src/pricing-table.ts`) sit next to vendors but are **not** excluded. They hold real logic (row validation, size caps, cache fallback), so they stay covered and are tested against real fixtures.

### Keeping vendors out of application logic

- Application logic (pricing math, aggregation, rendering) doesn't import vendors. Adapters do, and stay thin.
- If an adapter needs a decision or a data transform, move it out. The adapter fetches raw data and calls a pure function (raw shape in, domain shape out). Test that function with plain objects.
- If logic needs I/O (for example, cache-then-fetch with an offline fallback), take the dependency as an option we own (the price table takes `fetch`, `cacheDir`, `env`). Tests pass a fake or a temp directory.
- A humble file stays excluded only while it stays logic-free. If it grows a branch or a transform, split it or remove it from `coverage.exclude` and cover it.

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

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
