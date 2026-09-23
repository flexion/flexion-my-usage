import { describe, expect, it } from "vitest";
import { metricFormatters } from "./chartMeasure";

describe("metricFormatters", () => {
	it("cost: dollar formatting, no unit suffix, 'Daily Cost'", () => {
		const fmt = metricFormatters("cost");
		expect(fmt.axis(1.5)).toBe("$1.50");
		expect(fmt.value(0.004)).toBe("$0.0040");
		expect(fmt.unitLabel).toBe("");
		expect(fmt.title("Daily")).toBe("Daily Cost");
	});

	it("tokens: k/M/B formatting, a 'tokens' unit, 'Daily Tokens'", () => {
		const fmt = metricFormatters("tokens");
		expect(fmt.axis(1_500)).toBe("1.5k");
		expect(fmt.value(2_000_000)).toBe("2.00M");
		expect(fmt.unitLabel).toBe("tokens");
		expect(fmt.title("Daily")).toBe("Daily Tokens");
	});
});
