# my-usage

A local, offline dashboard for your own AI coding-agent usage - the tokens you're burning over time, and what it'd notionally cost - built from the session data already on your machine.

> **Status:** early. The first slice works end to end from a checkout (scan opencode, price, chart, serve, open), but it isn't published to npm yet.

## Why

Most AI coding tools show you one session at a time, if that. You don't get a feel for what you did across a whole day or week. And for subscription or gateway usage the reported cost is usually $0, so there's no cost signal at all.

This closes that gap - an over-time view of your usage, with a notional cost worked out from token counts and published model rates, so you get a number even when the tool says $0. The idea is to build a bit of a sixth sense for cost, the way you learn to glance at the fuel gauge without thinking about it.

## How it works

- Reads your local coding-agent session data, read-only - opencode first, more agents to follow.
- Computes notional cost as tokens times published per-model rates, with cache reads and writes priced separately.
- Rolls it into an over-time view and serves it from a local server, opened in your browser.
- Reading opencode's database may leave an empty `-wal` file and a `-shm` file of about 32 KB next to it, if those sidecars weren't already there - SQLite's own machinery for reading a WAL-mode database, even read-only. opencode's next clean close removes them; the database file itself is never modified.

## Local by design

Everything runs on your machine. It reads local files and serves a local page from a local server - no account, no upload, nothing ever leaves the machine. That's the point: it's what lets it run in locked-down environments.

## Proxies and offline machines

The only network call this tool makes is fetching the public [LiteLLM price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), cached locally afterward. A cache no older than 24 hours skips the fetch entirely; once it passes 24 hours old, every run makes exactly one refresh attempt - success replaces the cache, failure falls back to the stale cache with one warning line on stderr.

That fetch honors `HTTPS_PROXY` and `HTTP_PROXY` (lowercase forms work too, and take priority over the uppercase ones), so it works behind a mandatory corporate proxy without any extra setup. `NO_PROXY` opts specific hosts out - a bare hostname, a `.`- or `*.`-prefixed one for its subdomains, an optional `:port` qualifier, a comma- or whitespace-separated list, or `*` to bypass every host.

On a machine with no outbound access at all, seed the cache by hand: copy that same JSON file to

- macOS / Linux: `~/.cache/my-usage/litellm-model-prices.json` (note: not `~/Library/Caches` on macOS)
- Windows: `<home>\.cache\my-usage\litellm-model-prices.json`, where `<home>` is your account's home directory

or, on any OS, to `$XDG_CACHE_HOME/my-usage/litellm-model-prices.json` if `XDG_CACHE_HOME` is set to an absolute path. That keeps this tool silent on the network for 24 hours at a time, not indefinitely: once the seeded file passes 24 hours old, every run makes one outbound fetch attempt before falling back to the seeded copy (with a stderr warning) if that attempt fails. Pass `--no-price-refresh` to turn that attempt off for good - it treats the cache as always fresh, so a permanently air-gapped machine with a hand-seeded cache stays silent on the network indefinitely instead of one blocked connection and one warning line per run.

## Usage

Needs Node 22.13.0 or newer (the opencode reader uses `node:sqlite`); an older Node gets a one-line upgrade message instead of a stack trace.

Not on npm yet, so run it from a checkout:

```
yarn install --immutable
yarn build
node dist/index.js        # or `yarn dev`, which builds and runs in one step
```

`yarn build` compiles the Node side with `tsc` and bundles the page (React + recharts, under `src/web/`) with vite into `dist/web/`. The server serves that bundle plus one JSON data route; nothing is fetched from anywhere else.

That scans your local opencode data (every `opencode.db` / `opencode-<channel>.db` under `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`; set `OPENCODE_DB` to point at a specific file), works out the notional cost, starts a local server on a free port, prints the URL, and opens it in your default browser. The server binds to `127.0.0.1` only and keeps serving until you press Ctrl+C - reload or reopen the page as often as you like in the meantime.

```
Usage: my-usage [options]

Scans your local opencode usage, works out a notional cost, and serves a dashboard from a
local server (bound to 127.0.0.1 only), opened in your default browser. Press Ctrl+C to stop.

Options:
  --port <n>          Listen on this port (default: a free port chosen by the OS)
  --no-open           Don't open a browser; just print the URL
  --refresh-prices    Refetch the LiteLLM price table instead of using the cached copy
  --no-price-refresh  Skip the automatic refresh of a stale price cache (--refresh-prices still forces one)
  -h, --help          Show this help
```

`--port` is for when you want a stable URL to bookmark; if that port is already taken, the command fails and says so rather than quietly picking another. `--no-open` is for headless or SSH sessions. `--refresh-prices` is the way to pick up rates for a newly released model without deleting the cache file by hand (see [Proxies and offline machines](#proxies-and-offline-machines) for where that file lives). `--no-price-refresh` is the opposite: it suppresses the automatic refresh a stale cache would otherwise trigger, for a permanently offline machine that hand-seeds the cache - an explicit `--refresh-prices` still works even with this set, since the two answer different questions.

If no opencode database is found at all, you get a hint on stderr and an empty dashboard rather than an error. If a database is found but fails to read - for example, one written entirely by opencode's V2 (2.0-preview) schema, which isn't supported yet - that database is skipped with a warning on stderr (and a callout on the page) while the dashboard still renders from whatever else was found. Only when every discovered database fails to read does the command report a failure; see [Exit codes](#exit-codes) below for exactly what each of those outcomes means for the exit code.

## Exit codes

- `0` - ran fine. Covers no opencode database being found at all, every discovered database reading successfully, and a partial failure where some databases read fine while others were skipped with a warning.
- `1` - failed, for one of three reasons: a genuine error before any database was even read (a broken `OPENCODE_DB` override, an unsupported Node version, a checkout that skipped `yarn build` so there's no page to serve, ...); every discovered database failing to read, leaving nothing to render; or a failure late in the run, after the databases were already read and priced - most commonly the chosen `--port` already being in use.
- `2` - called wrong: an unrecognized flag or similar command-line mistake; see `--help`.

A caller scripting on the exit code (`my-usage || alert`) can treat `0` as "ran fine, whether or not there was anything to show" and `1` as "something needs a look."

## License

[MIT](LICENSE)
