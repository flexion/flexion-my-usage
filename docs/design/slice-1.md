# Slice 1 - opencode usage, over time

First vertical slice. One local command produces a self-contained web page showing your opencode usage over time, with a notional cost.

## Goal

Over-time visibility into your own AI coding-agent usage, plus a cost figure even when the tool reports $0. This is the view a session-only status line can't give you.

## Non-goals (this slice)

- No server or daemon - a static page, generated on demand.
- No sources beyond opencode (the adapter seam exists; other agents come later).
- No write-back anywhere, no network egress beyond a one-time price-table fetch.

## Data source

- opencode's local SQLite DB at `~/.local/share/opencode/opencode.db`, read-only and WAL-aware (honor `XDG_DATA_HOME` if set).
- Per assistant response, read: provider, model id, token buckets (input / output / reasoning / cache-read / cache-write), timestamp (epoch ms), session id, message id.
- opencode also keeps per-session rollups, but we aggregate from per-response rows for full control over the window and the cost math.

## Cost model

- Notional cost = tokens x published per-model rate, with cache-read and cache-write priced at their own rates.
- Rates come from the LiteLLM public price table, fetched once and cached locally; if offline, fall back to the cached copy.
- Model-id form varies by provider, so normalize `(provider, model)` to a canonical id for the rate lookup. An unknown model still counts its tokens, gets cost 0, and is flagged.

## Pipeline

`read -> normalize -> price -> aggregate (daily, by model) -> render`

- **read**: the opencode adapter emits normalized per-response usage rows.
- **aggregate**: daily buckets over a default 30-day window (configurable) - notional cost and token buckets, split by model.
- **render**: emit one self-contained `index.html` and open it.

## UI

Reuses a proven daily cost-over-time chart pattern, fed from the local aggregation:

- **KPI row**: notional $, total tokens, number of responses.
- **Hero chart**: daily cost over time, stacked by model, with a cost <-> tokens toggle; click a day to see that day's responses.
- **Per-model breakdown**: from the stacked bars plus a small table.
- A single notional measure - no billed-vs-subscription split.

## Delivery

- `npx` entrypoint: scan local data, run the pipeline, write `index.html`, open it.
- No server, no database writes.
- TypeScript/Node, bundled to a single self-contained HTML.

## Source adapter seam

```
interface UsageSource {
  discover(): SourceHandle[]        // locate local session stores
  read(handle): NormalizedUsageRow[] // per-response usage, normalized
}
```

opencode is the first implementation. Additional agents (for example pi) plug in behind the same interface as later slices.

## Constraints

- Fully local: read-only on the source, nothing sent anywhere, never writes back to any central system.
- Public repo: no secrets, internal hostnames/URLs, or client names in code, docs, or history.
- Dependencies pinned and current: committed lockfile, frozen install in CI, SHA-pinned actions.

## Open questions

- npm package name.
- Single-file bundling approach (inline assets vs. a single-file bundler).
- How much of the chart component ports cleanly vs. needs a local reimplementation.

## Done when

`npx <tool>` on a machine with opencode history writes an `index.html` showing a 30-day daily notional-cost chart (stacked by model) plus the KPI row, opens it, and sends nothing over the network once the price table is cached (verifiable offline).
