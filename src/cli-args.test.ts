// Specifies parseCliArgs with plain argv arrays: every flag, every combination that matters, and
// every malformed input the CLI turns into a usage error. No process.argv, no stdout.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCliArgs, parsePort, USAGE } from "./cli-args.js";

const DEFAULTS = {
	help: false,
	refreshPrices: false,
	noPriceRefresh: false,
	open: true,
	port: 0,
};

describe("parseCliArgs: defaults", () => {
	it("no arguments -> help off, no refresh, open the browser, OS-chosen port", () => {
		expect(parseCliArgs([])).toEqual({ ok: true, options: DEFAULTS });
	});
});

describe("parseCliArgs: each flag", () => {
	it("--help", () => {
		expect(parseCliArgs(["--help"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, help: true },
		});
	});

	it("-h is --help", () => {
		expect(parseCliArgs(["-h"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, help: true },
		});
	});

	it("--refresh-prices", () => {
		expect(parseCliArgs(["--refresh-prices"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, refreshPrices: true },
		});
	});

	it("--no-price-refresh", () => {
		expect(parseCliArgs(["--no-price-refresh"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, noPriceRefresh: true },
		});
	});

	it("--no-open turns the browser off", () => {
		expect(parseCliArgs(["--no-open"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, open: false },
		});
	});

	it("--port <n> as two tokens", () => {
		expect(parseCliArgs(["--port", "8123"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, port: 8123 },
		});
	});

	it("--port=<n> as one token", () => {
		expect(parseCliArgs(["--port=8123"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, port: 8123 },
		});
	});

	it("--port 0 is an explicit request for an OS-chosen port", () => {
		expect(parseCliArgs(["--port", "0"])).toEqual({
			ok: true,
			options: DEFAULTS,
		});
	});

	it("the last --port wins when it is repeated", () => {
		expect(parseCliArgs(["--port", "1", "--port", "2"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, port: 2 },
		});
	});

	// Also covers --refresh-prices and --no-price-refresh combining without either canceling
	// the other (they answer different questions): both come out true below, alongside the
	// other two flags. Hand-verified by reintroducing a cancellation bug (either price flag
	// flipping the other) and confirming this test alone still caught it - but only for that
	// cancellation shape. This test also passes --no-open and --port, so it can't see the two
	// price flags disturbing an unrelated default; the next test covers that gap.
	it("flags combine, in any order", () => {
		expect(
			parseCliArgs([
				"--no-open",
				"--port",
				"9000",
				"--refresh-prices",
				"--no-price-refresh",
			]),
		).toEqual({
			ok: true,
			options: {
				help: false,
				refreshPrices: true,
				noPriceRefresh: true,
				open: false,
				port: 9000,
			},
		});
	});

	// Narrower than the test above: both price flags set together, with open and port left at
	// their defaults, so a mutation coupling the price flags to an unrelated field isn't masked
	// by --no-open/--port also being on the command line.
	it("--refresh-prices and --no-price-refresh combine without disturbing the other defaults", () => {
		expect(parseCliArgs(["--refresh-prices", "--no-price-refresh"])).toEqual({
			ok: true,
			options: { ...DEFAULTS, refreshPrices: true, noPriceRefresh: true },
		});
	});
});

describe("parseCliArgs: usage errors", () => {
	function expectUsageError(argv: string[], ...fragments: string[]): void {
		const result = parseCliArgs(argv);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toMatch(/^my-usage: /);
		expect(result.message).toContain("Run my-usage --help for usage.");
		for (const fragment of fragments) {
			expect(result.message).toContain(fragment);
		}
	}

	it("an unknown flag names the flag", () => {
		expectUsageError(["--bogus"], "--bogus");
	});

	it("a positional argument is rejected", () => {
		expectUsageError(["extra"], "extra");
	});

	it("--port with no value", () => {
		expectUsageError(["--port"], "--port");
	});

	it("a boolean flag given a value", () => {
		expectUsageError(["--help=true"], "--help");
	});

	it.each([
		["abc", "not a number"],
		["65536", "above the TCP range"],
		["80.5", "not an integer"],
		["", "empty"],
		["0x50", "hex"],
	])("--port %s (%s) -> a range message naming the value", (raw) => {
		expectUsageError(
			["--port", raw],
			`--port must be a whole number from 0 to 65535, not "${raw}"`,
		);
	});

	it("--port=-1 (negative, joined so the tokenizer sees it as a value) -> the range message", () => {
		expectUsageError(
			["--port=-1"],
			'--port must be a whole number from 0 to 65535, not "-1"',
		);
	});

	it("--port -1 (two tokens) is ambiguous to the tokenizer, and still a usage error", () => {
		expectUsageError(["--port", "-1"], "--port");
	});
});

describe("parsePort", () => {
	it.each([
		["0", 0],
		["1", 1],
		["8080", 8080],
		["65535", 65535],
		["007", 7],
	])("%s -> %d", (raw, expected) => {
		expect(parsePort(raw)).toBe(expected);
	});

	it.each([
		"65536",
		"99999999999",
		"-1",
		"1.5",
		"1e3",
		" 80",
		"80 ",
		"",
		"port",
	])("%s -> undefined", (raw) => {
		expect(parsePort(raw)).toBeUndefined();
	});
});

describe("USAGE", () => {
	it("documents every flag the parser accepts, and the stop instruction", () => {
		for (const flag of [
			"--port <n>",
			"--no-open",
			"--refresh-prices",
			"--no-price-refresh",
			"-h, --help",
		]) {
			expect(USAGE).toContain(flag);
		}
		expect(USAGE).toContain("127.0.0.1");
		expect(USAGE).toContain("Ctrl+C");
		expect(USAGE.endsWith("\n")).toBe(true);
	});

	it("appears verbatim in README.md's Usage section, so the docs can't drift from --help", async () => {
		const readme = await readFile(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(readme).toContain(`\`\`\`\n${USAGE}\`\`\``);
	});
});
