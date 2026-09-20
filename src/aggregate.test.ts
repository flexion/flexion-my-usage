import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aggregateDaily,
	type DayBucket,
	type ModelTotals,
	unpricedModels,
} from "./aggregate.js";
import type { PricedRow } from "./pricing.js";

// Every test runs in one fixed zone that observes daylight saving, never the machine's own. On a
// UTC runner local days and UTC days coincide, so a bucketing that wrongly used UTC days would
// pass; in New York the two differ for most of the day.
//
// Fixtures are LOCAL wall-clock times (never epoch ms or UTC strings), so each names the same
// calendar day in whichever zone the test runs in.
const ZONE = "America/New_York";

// process.env.TZ is process-global, so each test sets it and puts it back: nothing leaks to the
// next test and nothing relies on the runner isolating files. It only takes effect in a process
// that owns its environment (vitest's default forks pool; worker threads ignore it). The guard
// turns a runner that ignores it into a failure in every test, not a vacuous pass.
//
// Reviewed: this guard is the fix that belongs here. Pinning `pool: "forks"` so a misconfigured
// runner can never reach the wrong pool in the first place is a vitest.config.ts change, out of
// this file's scope (tracked separately as myusage-40s).
let ambientTz: string | undefined;
beforeEach(() => {
	ambientTz = process.env.TZ;
	process.env.TZ = ZONE;
	// 1 July is summer time in New York: four hours behind UTC.
	expect(new Date(2026, 6, 1, 12).getTimezoneOffset()).toBe(240);
});
afterEach(() => {
	if (ambientTz === undefined) delete process.env.TZ;
	else process.env.TZ = ambientTz;
});

/** A local wall-clock time; `month` is 1-based. */
function at(
	year: number,
	month: number,
	day: number,
	hour = 12,
	minute = 0,
): Date {
	return new Date(year, month - 1, day, hour, minute);
}

/** The last millisecond of a local calendar day. */
function endOfDay(year: number, month: number, day: number): Date {
	return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/** The local calendar day the real clock is on right now, formatted YYYY-MM-DD. */
function today(): string {
	// Local getters, zero-padded: no Intl or locale data involved, so it holds on any Node build.
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// "Now" for most tests: mid-afternoon on 2026-09-19. A function, so each call reads the wall
// clock in the zone the test is running in (a module-level Date would be built before it is set).
const now = () => at(2026, 9, 19, 15, 30);

/**
 * A day's per-model series, in a fixed order. The record's keys are an implementation detail
 * that no consumer should parse, so tests read the series and let each name its own provider
 * and model.
 */
function seriesOf(day: DayBucket | undefined): ModelTotals[] {
	return Object.values(day?.byModel ?? {}).sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
	);
}

// Reviewed (round 1, F3): aggregate.ts is strictly downstream of the opencode reader, which
// already clamps every token bucket to a finite positive number or 0, rejects any row with an
// empty provider/model/messageId/sessionId or an unusable `completed` timestamp, and drops rows
// whose five buckets are all zero (src/sources/opencode.ts, `toRow`/`bucket`). No PricedRow this
// fixture builds, or that a real read can produce, can carry a non-finite or negative token, an
// empty provider or model string, or an all-zero bucket set. This factory's four unspecified
// token buckets default to 0, which is why a `Number.isFinite(x) && x > 0` clamp on the buckets,
// or an `if (rows.length === 0) return days;` early-out, both slip past the coverage gate here
// (the zero default drives both sides of `x > 0`, and the "defaults to 30 days" test supplies
// the empty array) without the guard doing anything real. The green stage reads row.tokens.*,
// row.provider, row.model, row.timestamp and row.notionalCost directly: no Number.isFinite,
// >= 0, empty-string, rows.length === 0 or windowDays <= 0 guard belongs in aggregate.ts. That
// is an instruction for the green implementation, not something to add another test for.
function pricedRow(
	overrides: Partial<Omit<PricedRow, "tokens">> & {
		tokens?: Partial<PricedRow["tokens"]>;
	} = {},
): PricedRow {
	const { tokens, ...rest } = overrides;
	return {
		source: "opencode",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: at(2026, 9, 19, 9, 0),
		sessionId: "ses_test",
		messageId: "msg_test",
		notionalCost: 0,
		unpriced: false,
		...rest,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			...tokens,
		},
	};
}

describe("aggregateDaily: window", () => {
	it("returns one bucket per calendar day ending today, oldest first, with quiet days zero-filled", () => {
		const days = aggregateDaily(
			[
				pricedRow({
					timestamp: at(2026, 9, 15),
					tokens: { input: 100 },
					notionalCost: 0.5,
				}),
				pricedRow({
					timestamp: at(2026, 9, 19),
					tokens: { output: 40 },
					notionalCost: 0.25,
				}),
			],
			5,
			now(),
		);

		expect(
			days.map((d) => [d.day, d.responses, d.tokens, d.notionalCost]),
		).toEqual([
			["2026-09-15", 1, 100, 0.5],
			["2026-09-16", 0, 0, 0],
			["2026-09-17", 0, 0, 0],
			["2026-09-18", 0, 0, 0],
			["2026-09-19", 1, 40, 0.25],
		]);
		expect(days[2]).toEqual({
			day: "2026-09-17",
			byModel: {},
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		});

		// F10/F11: cost and per-model series must land on the day the row completed on, not pile
		// onto one end of the window. Two distinct non-quiet days pin that a mutant routing every
		// row's cost or series through the first or last bucket cannot pass unnoticed.
		expect(seriesOf(days[0])).toEqual([
			{
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 0.5,
				tokens: 100,
				unpricedTokens: 0,
			},
		]);
		expect(seriesOf(days[4])).toEqual([
			{
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 0.25,
				tokens: 40,
				unpricedTokens: 0,
			},
		]);
	});

	it("defaults to the 30 days ending today", () => {
		// The real clock, never faked: bracket the call so a midnight rollover cannot flake it.
		const before = today();
		const days = aggregateDaily([]);
		const after = today();

		expect(days).toHaveLength(30);
		expect([before, after]).toContain(days.at(-1)?.day);
	});

	it("assigns each response to the local calendar day it completed on, and counts whole calendar days: nothing before the first day, nothing after today", () => {
		const days = aggregateDaily(
			[
				// Last millisecond before the window (a rolling 3 x 24h window would keep it).
				pricedRow({ timestamp: endOfDay(2026, 9, 16), tokens: { input: 1 } }),
				// First moment of the window.
				pricedRow({ timestamp: at(2026, 9, 17, 0, 0), tokens: { input: 10 } }),
				// Last moment of today, later than now() but still today.
				pricedRow({ timestamp: endOfDay(2026, 9, 19), tokens: { input: 100 } }),
				// Tomorrow.
				pricedRow({
					timestamp: at(2026, 9, 20, 0, 0),
					tokens: { input: 1000 },
				}),
			],
			3,
			now(),
		);

		expect(days.map((d) => [d.day, d.tokens])).toEqual([
			["2026-09-17", 10],
			["2026-09-18", 0],
			["2026-09-19", 100],
		]);
	});
});

describe("aggregateDaily: totals", () => {
	// `responses` counts rows, not tokens: every matching row is one response, even a row whose
	// priced tokens are all zero. Reviewed: implement this as a plain `+= 1` per row with no
	// `tokens > 0` guard; that guard would still pass every case below, so it is an implementation
	// instruction for this bead rather than something to add another test for.
	it("sums cost, tokens (all five buckets) and responses per day, split by provider and model", () => {
		const [day] = aggregateDaily(
			[
				pricedRow({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: {
						input: 1000,
						output: 200,
						reasoning: 30,
						cacheRead: 4000,
						cacheWrite: 500,
					},
					notionalCost: 0.25,
				}),
				pricedRow({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { input: 10, output: 20 },
					notionalCost: 0.5,
				}),
				// Same model id through another provider stays a separate series.
				pricedRow({
					provider: "github-copilot",
					model: "claude-sonnet-4-5",
					tokens: { input: 100, output: 50 },
					notionalCost: 1.5,
				}),
				// A gateway's model id can itself contain a slash. The series still names its provider
				// and model as they arrived; a joined "provider/model" string cannot be split back.
				pricedRow({
					provider: "openrouter",
					model: "anthropic/claude-sonnet-4.5",
					tokens: { input: 200, output: 40 },
					notionalCost: 0.5,
				}),
			],
			1,
			now(),
		);

		expect(day?.day).toBe("2026-09-19");
		expect(day?.notionalCost).toBe(2.75);
		expect(day?.tokens).toBe(6150);
		expect(day?.responses).toBe(4);
		expect(seriesOf(day)).toEqual([
			{
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 0.75,
				tokens: 5760,
				unpricedTokens: 0,
			},
			{
				provider: "github-copilot",
				model: "claude-sonnet-4-5",
				notionalCost: 1.5,
				tokens: 150,
				unpricedTokens: 0,
			},
			{
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.5",
				notionalCost: 0.5,
				tokens: 240,
				unpricedTokens: 0,
			},
		]);
	});

	it("keeps unpriced responses' tokens at cost 0 and reports them per model", () => {
		const [day] = aggregateDaily(
			[
				pricedRow({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { input: 100 },
					notionalCost: 1,
				}),
				// Same model, but this response had a bucket with no published rate.
				pricedRow({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { cacheWrite: 50 },
					notionalCost: 0,
					unpriced: true,
				}),
				pricedRow({
					provider: "example-gateway",
					model: "example-model",
					tokens: { input: 700, output: 300 },
					notionalCost: 0,
					unpriced: true,
				}),
			],
			1,
			now(),
		);

		expect(seriesOf(day)).toEqual([
			{
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 1,
				tokens: 150,
				unpricedTokens: 50,
			},
			{
				provider: "example-gateway",
				model: "example-model",
				notionalCost: 0,
				tokens: 1000,
				unpricedTokens: 1000,
			},
		]);
		expect(day?.tokens).toBe(1150);
		expect(day?.notionalCost).toBe(1);
	});

	it("adds costs without rounding them", () => {
		const [day] = aggregateDaily(
			[
				pricedRow({ notionalCost: 0.0012345 }),
				pricedRow({ notionalCost: 0.0045678 }),
			],
			1,
			now(),
		);

		// Sub-cent amounts, so a bucket that rounds its cost (to cents, mills or any display
		// precision), per model or per day, cannot match. Rounding is the renderer's job.
		expect(day?.notionalCost).toBeCloseTo(0.0058023, 10);
		expect(seriesOf(day)[0]?.notionalCost).toBeCloseTo(0.0058023, 10);
	});
});

describe("aggregateDaily: daylight-saving changes", () => {
	// On the day a zone's clocks change, that day is 23 or 25 hours long, and a window that counts
	// 24-hour steps skips the short day or repeats the long one. One zone with both changes covers
	// both failures; the file pins the zone (see the top).
	//
	// `days` is [change day - 2, - 1, change day, + 1]; `hours` is the length of the change day.
	const changes = [
		{
			name: "US spring forward",
			hours: 23,
			year: 2026,
			month: 3,
			day: 8,
			days: ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"],
		},
		{
			name: "US fall back",
			hours: 25,
			year: 2026,
			month: 11,
			day: 1,
			days: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
		},
	];

	it.each(changes)(
		"neither skips nor repeats a day across the $name",
		({ hours, year, month, day, days }) => {
			// The zone must really change its clocks on this day, or the case would pass vacuously.
			const dayLength =
				new Date(year, month - 1, day + 1).getTime() -
				new Date(year, month - 1, day).getTime();
			expect(dayLength / 3_600_000).toBe(hours);

			const rows = [
				pricedRow({
					timestamp: at(year, month, day, 0, 30),
					tokens: { input: 1 },
				}),
				pricedRow({
					timestamp: at(year, month, day, 23, 30),
					tokens: { input: 10 },
				}),
			];
			const [d0, d1, d2, d3] = days;
			const tokensPerDay = (out: ReturnType<typeof aggregateDaily>) =>
				out.map((d) => [d.day, d.tokens]);

			// Shortly after midnight the day after the change: 24 hours earlier is NOT the change day
			// when that day had only 23 hours.
			const justAfter = aggregateDaily(
				rows,
				4,
				at(year, month, day + 1, 0, 30),
			);
			expect(tokensPerDay(justAfter)).toEqual([
				[d0, 0],
				[d1, 0],
				[d2, 11],
				[d3, 0],
			]);

			// Late on the change day: 24 hours earlier is still the change day when it had 25 hours.
			const lateOnDay = aggregateDaily(rows, 3, at(year, month, day, 23, 30));
			expect(tokensPerDay(lateOnDay)).toEqual([
				[d0, 0],
				[d1, 0],
				[d2, 11],
			]);
		},
	);
});

describe("unpricedModels", () => {
	it("lists each model with unpriced usage once, tokens summed across days, largest first", () => {
		const days = aggregateDaily(
			[
				pricedRow({
					timestamp: at(2026, 9, 18),
					provider: "example-gateway",
					model: "example-model",
					tokens: { input: 300 },
					unpriced: true,
				}),
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "example-gateway",
					model: "example-model",
					tokens: { input: 200 },
					unpriced: true,
				}),
				// A gateway's model id can itself contain a slash; the pair still comes back whole.
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "openrouter",
					model: "anthropic/claude-sonnet-4.5",
					tokens: { output: 700 },
					unpriced: true,
				}),
				// Reviewed (F9): same day, same series as the row above, but this response's tokens
				// were fully priced. The series is now mixed (700 unpriced + 40 priced = 740 total
				// tokens), so on the totals map's *fresh*-entry arm, summing `series.tokens` instead of
				// `series.unpricedTokens` would report 740, not 700. Every other series in this fixture
				// that creates a fresh entry is wholly unpriced (tokens === unpricedTokens there), so
				// without this row that substitution passes unnoticed.
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "openrouter",
					model: "anthropic/claude-sonnet-4.5",
					tokens: { input: 40 },
					notionalCost: 0.3,
				}),
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { input: 900 },
					notionalCost: 2,
				}),
				// Reviewed (F6): same series as the row above, but this response's cache-write bucket
				// had no published rate. The series is now mixed (900 priced tokens, 50 unpriced), so
				// summing `series.tokens` here instead of `series.unpricedTokens` would report 950, not
				// 50, and still pass every other case in this file (every other unpriced fixture row is
				// wholly unpriced, so tokens == unpricedTokens there).
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { cacheWrite: 50 },
					unpriced: true,
				}),
				// Reviewed (F7): same series as above, but this row lands on the earlier day and is
				// itself unpriced. It makes the anthropic series span both days with nonzero unpriced
				// tokens on each, so the second day hits the totals map's *accumulate* arm rather than
				// creating a fresh entry (unlike a wholly priced earlier row, which the F8 skip drops
				// before an entry ever exists, leaving the second day to hit the fresh arm instead and
				// masking this exact mutant). Summing `series.tokens` instead of `series.unpricedTokens`
				// on that accumulate step would report 975 (25 + 950), not 75 (25 + 50).
				pricedRow({
					timestamp: at(2026, 9, 18),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { cacheRead: 25 },
					unpriced: true,
				}),
			],
			2,
			now(),
		);

		expect(unpricedModels(days)).toEqual([
			{
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.5",
				tokens: 700,
			},
			{ provider: "example-gateway", model: "example-model", tokens: 500 },
			{ provider: "anthropic", model: "claude-sonnet-4-5", tokens: 75 },
		]);
	});

	// Reviewed (F8): a model can appear in `days` with no unpriced usage at all (every row priced).
	// unpricedModels reports models with unpriced usage, not every model that was ever seen, so a
	// wholly priced series must not show up as a false alarm at `tokens: 0`.
	it("omits models whose usage was entirely priced", () => {
		const days = aggregateDaily(
			[
				pricedRow({
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { input: 100 },
					notionalCost: 1,
				}),
			],
			1,
			now(),
		);

		expect(unpricedModels(days)).toEqual([]);
	});

	// Equal tokens tie-break on model id, then provider (the same model id can come through two
	// providers). Reviewed (round 1, F4): a stable sort with no tie-break at all returns arrival
	// order, so only a reversed arrival can expose that; feeding the already-sorted order too
	// added no kill a reversed arrival didn't already cover (mutation testing), so one case
	// carries the check.
	const sorted = [
		{ provider: "example-gateway", model: "alpha-model" },
		{ provider: "provider-a", model: "shared-model" },
		{ provider: "provider-b", model: "shared-model" },
		{ provider: "example-gateway", model: "zeta-model" },
	];
	it("orders models with equal unpriced tokens by model id, then provider", () => {
		const days = aggregateDaily(
			[...sorted].reverse().map(({ provider, model }) =>
				pricedRow({
					provider,
					model,
					tokens: { input: 100 },
					unpriced: true,
				}),
			),
			1,
			now(),
		);

		expect(unpricedModels(days)).toEqual(
			sorted.map((pair) => ({ ...pair, tokens: 100 })),
		);
	});
});
