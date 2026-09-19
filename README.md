# my-usage

A local, offline dashboard for your own AI coding-agent usage - the tokens you're burning over time, and what it'd notionally cost - built from the session data already on your machine.

> **Status:** early. The design's settled and the first slice is being built. It doesn't do anything useful yet.

## Why

Most AI coding tools show you one session at a time, if that. You don't get a feel for what you did across a whole day or week. And for subscription or gateway usage the reported cost is usually $0, so there's no cost signal at all.

This closes that gap - an over-time view of your usage, with a notional cost worked out from token counts and published model rates, so you get a number even when the tool says $0. The idea is to build a bit of a sixth sense for cost, the way you learn to glance at the fuel gauge without thinking about it.

## How it works

- Reads your local coding-agent session data, read-only - opencode first, more agents to follow.
- Computes notional cost as tokens times published per-model rates, with cache reads and writes priced separately.
- Rolls it into an over-time view and renders a single self-contained web page.

## Local by design

Everything runs on your machine. It reads local files, writes a local page, and never phones home - no account, no upload, no back end. That's the point: it's what lets it run in locked-down environments.

## Usage

Planned, not wired up yet:

```
npx <package-tbd>
```

Scans your local session data, writes an `index.html`, and opens it.

## License

[MIT](LICENSE)
