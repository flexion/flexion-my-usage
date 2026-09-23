import { describe, expect, it } from "vitest";
import { type UsagePayload, usagePayloadJson } from "./usage-payload.js";

describe("usagePayloadJson", () => {
	it("round-trips the payload through JSON unchanged", () => {
		const payload: UsagePayload = {
			days: [
				{
					day: "2026-09-23",
					byModel: {
						"anthropic\u0000claude-sonnet-4-5": {
							provider: "anthropic",
							model: "claude-sonnet-4-5",
							notionalCost: 1.25,
							tokens: 1000,
							unpricedTokens: 0,
						},
					},
					notionalCost: 1.25,
					tokens: 1000,
					responses: 2,
				},
			],
			skipped: { skipped: 1, total: 3 },
		};
		expect(JSON.parse(usagePayloadJson(payload))).toEqual(payload);
	});
});
