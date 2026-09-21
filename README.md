# my-usage

A local, offline dashboard for your own AI coding-agent usage - the tokens you're burning over time, and what it'd notionally cost - built from the session data already on your machine.

> **Status:** early. The design's settled and the first slice is being built. It doesn't do anything useful yet.

## Why

Most AI coding tools show you one session at a time, if that. You don't get a feel for what you did across a whole day or week. And for subscription or gateway usage the reported cost is usually $0, so there's no cost signal at all.

This closes that gap - an over-time view of your usage, with a notional cost worked out from token counts and published model rates, so you get a number even when the tool says $0. The idea is to build a bit of a sixth sense for cost, the way you learn to glance at the fuel gauge without thinking about it.

## How it works

- Reads your local coding-agent session data, read-only - opencode first, more agents to follow.
- Computes notional cost as tokens times published per-model rates, with cache reads and writes priced separately.
- Rolls it into an over-time view and serves it from a local server, opened in your browser.

## Local by design

Everything runs on your machine. It reads local files and serves a local page from a local server - no account, no upload, nothing ever leaves the machine. That's the point: it's what lets it run in locked-down environments.

## Proxies and offline machines

The one network call this tool makes is a one-time fetch of the public [LiteLLM price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), cached locally afterward. A cache hit skips the fetch entirely.

That fetch honors `HTTPS_PROXY` and `HTTP_PROXY` (lowercase forms work too, and take priority over the uppercase ones), so it works behind a mandatory corporate proxy without any extra setup. `NO_PROXY` opts specific hosts out - a bare hostname, a `.`- or `*.`-prefixed one for its subdomains, an optional `:port` qualifier, a comma- or whitespace-separated list, or `*` to bypass every host.

On a machine with no outbound access at all, seed the cache by hand: copy that same JSON file to

- macOS / Linux: `~/.cache/my-usage/litellm-model-prices.json` (note: not `~/Library/Caches` on macOS)
- Windows: `<home>\.cache\my-usage\litellm-model-prices.json`, where `<home>` is your account's home directory

or, on any OS, to `$XDG_CACHE_HOME/my-usage/litellm-model-prices.json` if `XDG_CACHE_HOME` is set to an absolute path. Once that file is there, this tool never fetches or sends anything over the network.

## Usage

Planned, not wired up yet:

```
npx <package-tbd>
```

Scans your local session data, starts a local server, and opens it in your browser.

## License

[MIT](LICENSE)
