import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateDaily, unpricedModels } from "./aggregate.js";
import type { PricedRow } from "./pricing.js";

// Fixtures are LOCAL wall-clock times (never epoch ms or UTC strings), so a fixture names the
// same calendar day on any machine timezone. The daylight-saving cases pin their own zone.

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

// "Now" for most tests: mid-afternoon on 2026-09-19. Rows default to earlier that morning.
const NOW = at(2026, 9, 19, 15, 30);

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
			NOW,
		);

		expect(days.map((d) => [d.day, d.responses, d.tokens])).toEqual([
			["2026-09-15", 1, 100],
			["2026-09-16", 0, 0],
			["2026-09-17", 0, 0],
			["2026-09-18", 0, 0],
			["2026-09-19", 1, 40],
		]);
		expect(days[2]).toEqual({
			day: "2026-09-17",
			byModel: {},
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		});
	});

	it("defaults to the 30 days ending today", () => {
		// The real clock, never faked: bracket the call so a midnight rollover cannot flake it.
		const before = today();
		const days = aggregateDaily([]);
		const after = today();

		expect(days).toHaveLength(30);
		expect([before, after]).toContain(days.at(-1)?.day);
	});

	it("assigns a response to the local calendar day it completed on, either side of midnight", () => {
		const days = aggregateDaily(
			[
				pricedRow({ timestamp: at(2026, 9, 18, 23, 30), tokens: { input: 1 } }),
				pricedRow({ timestamp: at(2026, 9, 19, 0, 30), tokens: { input: 10 } }),
			],
			3,
			NOW,
		);

		expect(days.map((d) => [d.day, d.tokens])).toEqual([
			["2026-09-17", 0],
			["2026-09-18", 1],
			["2026-09-19", 10],
		]);
	});

	it("counts whole calendar days: nothing before the first day, nothing after today", () => {
		const days = aggregateDaily(
			[
				// Last millisecond before the window (a rolling 3 x 24h window would keep it).
				pricedRow({ timestamp: endOfDay(2026, 9, 16), tokens: { input: 1 } }),
				// First moment of the window.
				pricedRow({ timestamp: at(2026, 9, 17, 0, 0), tokens: { input: 10 } }),
				// Last moment of today, later than NOW but still today.
				pricedRow({ timestamp: endOfDay(2026, 9, 19), tokens: { input: 100 } }),
				// Tomorrow.
				pricedRow({
					timestamp: at(2026, 9, 20, 0, 0),
					tokens: { input: 1000 },
				}),
			],
			3,
			NOW,
		);

		expect(days.map((d) => [d.day, d.tokens])).toEqual([
			["2026-09-17", 10],
			["2026-09-18", 0],
			["2026-09-19", 100],
		]);
	});
});

describe("aggregateDaily: totals", () => {
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
			],
			1,
			NOW,
		);

		expect(day).toEqual({
			day: "2026-09-19",
			byModel: {
				"anthropic/claude-sonnet-4-5": {
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					notionalCost: 0.75,
					tokens: 5760,
					unpricedTokens: 0,
				},
				"github-copilot/claude-sonnet-4-5": {
					provider: "github-copilot",
					model: "claude-sonnet-4-5",
					notionalCost: 1.5,
					tokens: 150,
					unpricedTokens: 0,
				},
			},
			notionalCost: 2.25,
			tokens: 5910,
			responses: 3,
		});
	});

	it("carries provider and model as a pair, even when the model id itself contains a slash", () => {
		// Gateway providers route to "vendor/model" ids, so "openrouter/anthropic/claude-sonnet-4.5"
		// cannot be trusted to split back into its two halves. Each series carries them as they
		// arrived, and the joined string is only its key.
		const days = aggregateDaily(
			[
				pricedRow({
					provider: "openrouter",
					model: "anthropic/claude-sonnet-4.5",
					tokens: { input: 100 },
					unpriced: true,
				}),
			],
			1,
			NOW,
		);

		expect(days[0]?.byModel).toEqual({
			"openrouter/anthropic/claude-sonnet-4.5": {
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.5",
				notionalCost: 0,
				tokens: 100,
				unpricedTokens: 100,
			},
		});
		expect(unpricedModels(days)).toEqual([
			{
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.5",
				tokens: 100,
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
			NOW,
		);

		expect(day?.byModel).toEqual({
			"anthropic/claude-sonnet-4-5": {
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				notionalCost: 1,
				tokens: 150,
				unpricedTokens: 50,
			},
			"example-gateway/example-model": {
				provider: "example-gateway",
				model: "example-model",
				notionalCost: 0,
				tokens: 1000,
				unpricedTokens: 1000,
			},
		});
		expect(day?.tokens).toBe(1150);
		expect(day?.notionalCost).toBe(1);
	});

	it("adds costs as plain numbers, without rounding", () => {
		const [day] = aggregateDaily(
			[pricedRow({ notionalCost: 0.1 }), pricedRow({ notionalCost: 0.2 })],
			1,
			NOW,
		);

		// 0.1 + 0.2 drifts under float addition (0.30000000000000004), so a bucket that rounds its
		// cost, whether per model or per day, cannot match it. Rounding is the renderer's job.
		const sum = 0.1 + 0.2;
		expect(day?.notionalCost).toBe(sum);
		expect(day?.byModel["anthropic/claude-sonnet-4-5"]?.notionalCost).toBe(sum);
	});
});

describe("aggregateDaily: daylight-saving changes", {
	concurrent: false,
}, () => {
	// On the day a zone's clocks change, that day is 23 or 25 hours long, and a window that counts
	// 24-hour steps skips the short day or repeats the long one. One zone with both changes covers
	// both failures. Setting the zone here makes the cases bite on every machine, a UTC CI runner
	// included.
	//
	// process.env.TZ is process-global, so the cases are fenced in. The zone is restored after each
	// case, so nothing leaks to the next case and nothing relies on per-file isolation.
	// `concurrent: false` keeps the cases sequential even if a config or a parent describe turns
	// concurrency on. And the precondition below turns a runner that ignores TZ (worker threads
	// do) into a red test instead of a vacuous pass.
	const tz = "America/New_York";
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

	let ambientTz: string | undefined;
	beforeEach(() => {
		ambientTz = process.env.TZ;
		process.env.TZ = tz;
	});
	afterEach(() => {
		if (ambientTz === undefined) delete process.env.TZ;
		else process.env.TZ = ambientTz;
	});

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
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "example-provider",
					model: "new-model",
					tokens: { output: 700 },
					unpriced: true,
				}),
				pricedRow({
					timestamp: at(2026, 9, 19),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					tokens: { input: 900 },
					notionalCost: 2,
				}),
			],
			2,
			NOW,
		);

		expect(unpricedModels(days)).toEqual([
			{ provider: "example-provider", model: "new-model", tokens: 700 },
			{ provider: "example-gateway", model: "example-model", tokens: 500 },
		]);
	});

	// Both arrival orders, so the result cannot be an accident of which row came first.
	it.each([
		{ arrival: "zeta then alpha", models: ["zeta-model", "alpha-model"] },
		{ arrival: "alpha then zeta", models: ["alpha-model", "zeta-model"] },
	])(
		"orders models with equal unpriced tokens by model id ($arrival)",
		({ models }) => {
			const days = aggregateDaily(
				models.map((model) =>
					pricedRow({
						provider: "example-gateway",
						model,
						tokens: { input: 100 },
						unpriced: true,
					}),
				),
				1,
				NOW,
			);

			expect(unpricedModels(days)).toEqual([
				{ provider: "example-gateway", model: "alpha-model", tokens: 100 },
				{ provider: "example-gateway", model: "zeta-model", tokens: 100 },
			]);
		},
	);
});
