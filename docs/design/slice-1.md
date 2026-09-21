# Slice 1 - opencode usage, over time

First vertical slice. One local command scans your opencode usage, starts a local server, and opens a page showing that usage over time, with a notional cost.

## Goal

Over-time visibility into your own AI coding-agent usage, plus a cost figure even when the tool reports $0. This is the view a session-only status line can't give you.

## Non-goals (this slice)

- No sources beyond opencode (the adapter seam exists; other agents come later).
- No write-back anywhere, no network egress beyond a one-time price-table fetch.
- No central deployment or hosted service - the server runs on your machine for this invocation only.

## Data source

- opencode's local SQLite DB at `~/.local/share/opencode/opencode.db`, read-only and WAL-aware (honor `XDG_DATA_HOME` if set).
- Per assistant response, read: provider, model id, token buckets (input / output / reasoning / cache-read / cache-write), timestamp (epoch ms), session id, message id.
- opencode also keeps per-session rollups, but we aggregate from per-response rows for full control over the window and the cost math.

## Cost model

- Notional cost = tokens x published per-model rate, with cache-read and cache-write priced at their own rates.
- Rates come from the LiteLLM public price table, fetched once and cached locally; if offline, fall back to the cached copy.
- Matching is exact-key, on purpose: each (provider, model) row is looked up under a fixed per-provider prefix rule (for example `vertex_ai/` or `azure/`, or the bare id) and the resulting entry's `litellm_provider` field, with no dot/dash rewriting or prefix stripping. Regional ids carry their own real rates - a Bedrock `us.`-prefixed Claude Sonnet id lists $3.30 per million input tokens against $3.00 for the bare and `global.` ids - so normalizing a prefix away would silently underprice those rows. A provider with no explicit rule falls back to the model maker's own list price by bare model id, labeled as approximate. An unknown model still counts its tokens, gets cost 0, and is flagged.
- The price table caches to `$XDG_CACHE_HOME/my-usage/litellm-model-prices.json` when `XDG_CACHE_HOME` is set to an absolute path, else `~/.cache/my-usage/litellm-model-prices.json` (on macOS this is NOT `~/Library/Caches`). The cache has no expiry: once fetched, it's reused indefinitely with no further network call, until the file is deleted or reseeded by hand.

## Pipeline

`read -> normalize -> price -> aggregate (daily, by model) -> render`

- **read**: the opencode adapter emits normalized per-response usage rows.
- **aggregate**: daily buckets over a default 30-day window (configurable) - notional cost and token buckets, split by model.
- **render**: start a local server exposing the aggregated data to the forked dashboard, and open it in the browser.

## UI

Reuses a proven daily cost-over-time chart pattern, fed from the local aggregation:

- **KPI row**: notional $, total tokens, number of responses.
- **Hero chart**: daily cost over time, stacked by model, with a cost <-> tokens toggle; click a day to see that day's responses.
- **Per-model breakdown**: from the stacked bars plus a small table.
- A single notional measure - no billed-vs-subscription split.

## Delivery

- `npx` entrypoint: scan local data, run the pipeline, start a local server serving the forked dashboard (data layer swapped for the opencode adapter), and open it in the browser.
- The server binds to localhost only and exits when the process is stopped; no database writes.
- TypeScript/Node.

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
- How much of the chart component ports cleanly vs. needs a local reimplementation.

## Done when

`npx <tool>` on a machine with opencode history starts a local server and opens a page showing a 30-day daily notional-cost chart (stacked by model) plus the KPI row, and sends nothing over the network once the price table is cached (verifiable offline).
