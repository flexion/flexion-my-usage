import { describe, expect, it } from "vitest";
import { formatCurrency, formatInt, formatTokens } from "./formatters";

describe("formatCurrency", () => {
	it.each([
		[0, "$0.00"],
		[Number.NaN, "$0.00"],
		[12.345, "$12.35"],
		[0.01, "$0.01"],
		[0.0045, "$0.0045"],
		[-0.0045, "$-0.0045"],
		[-3.5, "$-3.50"],
	])("%s -> %s", (n, expected) => {
		expect(formatCurrency(n)).toBe(expected);
	});
});

describe("formatTokens", () => {
	it.each([
		[0, "0"],
		[Number.NaN, "0"],
		[999.4, "999"],
		[1_000, "1.0k"],
		[42_049, "42.0k"],
		[1_200_000, "1.20M"],
		[7_060_000_000, "7.06B"],
		[-2_500, "-2.5k"],
	])("%s -> %s", (n, expected) => {
		expect(formatTokens(n)).toBe(expected);
	});
});

describe("formatInt", () => {
	it.each([
		[0, "0"],
		[Number.NaN, "0"],
		[1_234_567, "1,234,567"],
	])("%s -> %s", (n, expected) => {
		expect(formatInt(n)).toBe(expected);
	});
});
