import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isSqliteExperimentalWarning,
	withoutSqliteWarning,
	withSqliteWarningSuppressed,
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

function recorder() {
	const calls: { self: unknown; args: unknown[] }[] = [];
	const original = function (this: unknown, ...args: unknown[]) {
		calls.push({ self: this, args });
	} as unknown as typeof process.emitWarning;
	return { calls, original };
}

describe("withoutSqliteWarning", () => {
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

describe("withSqliteWarningSuppressed", () => {
	// Stand a recorder in for process.emitWarning, so nothing a test emits reaches the real
	// process, and always put the real one back.
	const realEmitWarning = process.emitWarning;
	let calls: { self: unknown; args: unknown[] }[];
	let installed: typeof process.emitWarning;

	beforeEach(() => {
		const { calls: recorded, original } = recorder();
		calls = recorded;
		installed = original;
		process.emitWarning = installed;
	});

	afterEach(() => {
		process.emitWarning = realEmitWarning;
	});

	it("drops the SQLite warning raised while loading and forwards every other warning", async () => {
		const loaded = await withSqliteWarningSuppressed(async () => {
			// Force a real suspension point, so restoring the original emitWarning too early
			// (a `return load()` that drops the `await`) lets this warning through unfiltered
			// instead of being caught here.
			await Promise.resolve();
			process.emitWarning(MESSAGE, "ExperimentalWarning");
			process.emitWarning("something else", "DeprecationWarning", "DEP0001");
			return "module";
		});

		expect(loaded).toBe("module");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.self).toBe(process);
		expect(calls[0]?.args).toEqual([
			"something else",
			"DeprecationWarning",
			"DEP0001",
		]);
	});

	it("hands the original emitWarning back once the load resolves", async () => {
		let during: typeof process.emitWarning | undefined;

		await withSqliteWarningSuppressed(async () => {
			during = process.emitWarning;
		});

		expect(during).not.toBe(installed);
		expect(process.emitWarning).toBe(installed);
	});

	it("hands the original emitWarning back and rethrows when the load rejects", async () => {
		const failure = new Error("import failed");

		await expect(
			withSqliteWarningSuppressed(async () => {
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(process.emitWarning).toBe(installed);
	});

	it("throws instead of restoring in the wrong order when a second call overlaps", async () => {
		let releaseOuter: (() => void) | undefined;
		const outerGate = new Promise<void>((resolve) => {
			releaseOuter = resolve;
		});

		const outer = withSqliteWarningSuppressed(async () => {
			await outerGate;
			return "outer";
		});

		// releaseOuter always runs, even if an assertion below throws - otherwise a failure here
		// would leave `outer` pending and the module-level in-flight flag stuck, poisoning every
		// test that runs after this one in the same file.
		try {
			// The outer call has already installed its patched emitWarning and set the in-flight
			// flag by the time it suspends on outerGate, so this overlapping call must fail loudly
			// instead of silently reinstalling on top of it.
			const beforeRejection = process.emitWarning;
			await expect(
				withSqliteWarningSuppressed(async () => "inner"),
			).rejects.toThrow(/not re-entrant/);
			// The rejected call must never have touched process.emitWarning at all - the guard
			// check has to run before the patch, not just before `load()`. A version that checked
			// `inFlight` after already installing its own wrapper would still reject here, but
			// would leave a second, orphaned wrapper installed on top of the outer call's.
			expect(process.emitWarning).toBe(beforeRejection);
		} finally {
			releaseOuter?.();
		}

		await expect(outer).resolves.toBe("outer");
		expect(process.emitWarning).toBe(installed);

		// The guard releases once the outer call finishes, so a later, non-overlapping call
		// still works.
		await expect(
			withSqliteWarningSuppressed(async () => "again"),
		).resolves.toBe("again");
	});
});
