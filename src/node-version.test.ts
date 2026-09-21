// Specifies the Node-version preflight with plain version strings - no process.versions, no
// import of node:sqlite - so the decision is proven identically on every Node the suite runs
// under (the coverage gate runs on both 26.x and the 22.13.0 floor in CI).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	isOlder,
	NODE_FLOOR,
	nodeUpgradeMessage,
	parseVersion,
	type Version,
} from "./node-version.js";

const FLOOR: Version = [22, 13, 0];

describe("NODE_FLOOR", () => {
	it("is exactly package.json's engines.node floor, so the two cannot drift apart", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { engines: { node: string } };
		expect(packageJson.engines.node).toBe(`>=${NODE_FLOOR.join(".")}`);
	});
});

describe("parseVersion", () => {
	it.each([
		["22.13.0", [22, 13, 0]],
		["26.8.2", [26, 8, 2]],
		["0.0.0", [0, 0, 0]],
		["22.13.0-nightly20250101abcdef", [22, 13, 0]],
		["22.13.0+build", [22, 13, 0]],
	])("%s -> %j", (input, expected) => {
		expect(parseVersion(input)).toEqual(expected);
	});

	it.each([
		["", "empty"],
		["v22.13.0", "a leading v"],
		["22.13", "only major.minor"],
		["22", "only major"],
		["abc", "not a version at all"],
		[" 22.13.0", "leading whitespace"],
	])("%s (%s) -> undefined", (input) => {
		expect(parseVersion(input)).toBeUndefined();
	});
});

describe("isOlder", () => {
	it.each([
		[[21, 99, 99], [22, 13, 0], true],
		[[22, 12, 99], [22, 13, 0], true],
		[[22, 13, 0], [22, 13, 1], true],
		[[22, 13, 0], [22, 13, 0], false],
		[[22, 13, 1], [22, 13, 0], false],
		[[22, 14, 0], [22, 13, 0], false],
		[[23, 0, 0], [22, 13, 0], false],
	] as const)("%j older than %j -> %s", (a, b, expected) => {
		expect(isOlder([...a], [...b])).toBe(expected);
	});
});

describe("nodeUpgradeMessage", () => {
	it("is undefined when the running Node is exactly the floor", () => {
		expect(nodeUpgradeMessage("22.13.0", FLOOR)).toBeUndefined();
	});

	it("is undefined when the running Node is newer than the floor", () => {
		expect(nodeUpgradeMessage("26.8.2", FLOOR)).toBeUndefined();
	});

	it("names the floor and the running version when the running Node is older", () => {
		const message = nodeUpgradeMessage("20.11.1", FLOOR);
		expect(message).toContain("Node 22.13.0 or newer");
		expect(message).toContain("This is Node 20.11.1");
		expect(message).toContain("node:sqlite");
		expect(message).toContain("upgrade Node");
	});

	it("fails open (no message) when the running version cannot be parsed", () => {
		expect(nodeUpgradeMessage("custom-build", FLOOR)).toBeUndefined();
	});

	it("is undefined for the real NODE_FLOOR against the Node running this test", () => {
		// The suite only runs on Node >= NODE_FLOOR (package.json engines), so this is a live
		// check that the real constant and the real process version agree.
		expect(
			nodeUpgradeMessage(process.versions.node, NODE_FLOOR),
		).toBeUndefined();
	});
});
