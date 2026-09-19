import { describe, expect, it } from "vitest";
import { aggregateDaily } from "./aggregate.js";

describe("aggregateDaily", () => {
	it("returns no buckets for no rows (scaffold placeholder)", () => {
		expect(aggregateDaily([])).toEqual([]);
	});
});
