import { describe, expect, it } from "vitest";
import {
	isSqliteExperimentalWarning,
	withoutSqliteWarning,
} from "./sqlite-warning.js";

const MESSAGE =
	"SQLite is an experimental feature and might change at any time";

function experimentalError(): Error {
	return Object.assign(new Error(MESSAGE), { name: "ExperimentalWarning" });
}

describe("isSqliteExperimentalWarning", () => {
	it("matches when the type is passed as a string argument", () => {
		expect(isSqliteExperimentalWarning(MESSAGE, ["ExperimentalWarning"])).toBe(
			true,
		);
	});

	it("matches when the type is passed in an options object", () => {
		expect(
			isSqliteExperimentalWarning(MESSAGE, [{ type: "ExperimentalWarning" }]),
		).toBe(true);
	});

	it("matches an Error named ExperimentalWarning when no type is passed", () => {
		expect(isSqliteExperimentalWarning(experimentalError(), [])).toBe(true);
		expect(isSqliteExperimentalWarning(experimentalError(), [null])).toBe(true);
	});

	it("does not match a warning with no type", () => {
		expect(isSqliteExperimentalWarning(MESSAGE, [])).toBe(false);
		expect(isSqliteExperimentalWarning(MESSAGE, [{}])).toBe(false);
	});

	it("does not match another warning type carrying the same message", () => {
		expect(isSqliteExperimentalWarning(MESSAGE, ["DeprecationWarning"])).toBe(
			false,
		);
	});

	it("does not match an ExperimentalWarning about something else", () => {
		expect(
			isSqliteExperimentalWarning("Fetch is an experimental feature", [
				"ExperimentalWarning",
			]),
		).toBe(false);
	});
});

describe("withoutSqliteWarning", () => {
	function recorder() {
		const calls: { self: unknown; args: unknown[] }[] = [];
		const original = function (this: unknown, ...args: unknown[]) {
			calls.push({ self: this, args });
		} as unknown as typeof process.emitWarning;
		return { calls, original };
	}

	it("drops the SQLite experimental warning", () => {
		const { calls, original } = recorder();

		withoutSqliteWarning(original)(MESSAGE, "ExperimentalWarning");

		expect(calls).toEqual([]);
	});

	it("forwards every other warning to the original, bound to process", () => {
		const { calls, original } = recorder();

		withoutSqliteWarning(original)(
			"something else",
			"DeprecationWarning",
			"DEP0001",
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.self).toBe(process);
		expect(calls[0]?.args).toEqual([
			"something else",
			"DeprecationWarning",
			"DEP0001",
		]);
	});
});
