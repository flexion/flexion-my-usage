// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UsagePayload } from "../usage-payload";
import { App, errorText } from "./App";

afterEach(cleanup);

const PAYLOAD: UsagePayload = {
	days: [
		{
			day: "2026-09-01",
			byModel: {
				"p/alpha": {
					provider: "p",
					model: "alpha",
					notionalCost: 1.25,
					tokens: 400,
					unpricedTokens: 0,
				},
			},
			notionalCost: 1.25,
			tokens: 400,
			responses: 2,
		},
		{
			day: "2026-09-02",
			byModel: {},
			notionalCost: 0,
			tokens: 0,
			responses: 0,
		},
	],
	skipped: { skipped: 0, total: 1 },
};

describe("errorText", () => {
	it("an Error's message, or anything else as text", () => {
		expect(errorText(new Error("boom"))).toBe("boom");
		expect(errorText("plain")).toBe("plain");
	});
});

describe("App", () => {
	it("shows a loading skeleton until the data arrives, then the dashboard", async () => {
		let resolve: (payload: UsagePayload) => void = () => {};
		const pending = new Promise<UsagePayload>((r) => {
			resolve = r;
		});
		render(<App load={() => pending} />);
		expect(screen.getByRole("heading", { name: "my-usage" })).toBeTruthy();
		expect(screen.getByLabelText("Loading usage")).toBeTruthy();

		resolve(PAYLOAD);
		const cost = await screen.findByRole("region", { name: "Notional Cost" });
		expect(cost.textContent).toContain("$1.25");
		expect(cost.textContent).toContain("Last 2 days");
		expect(screen.queryByLabelText("Loading usage")).toBeNull();
		expect(screen.getByRole("heading", { name: "Daily Cost" })).toBeTruthy();
		expect(screen.getByRole("table").textContent).toContain("alpha");
		// Nothing skipped, so no callout.
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("names skipped databases on the page itself", async () => {
		render(
			<App
				load={async () => ({ ...PAYLOAD, skipped: { skipped: 1, total: 3 } })}
			/>,
		);
		expect((await screen.findByRole("status")).textContent).toBe(
			"1 of 3 databases could not be read - see terminal for details.",
		);
	});

	it("a failed load shows the error and a hint instead of the dashboard", async () => {
		render(
			<App
				load={() => Promise.reject(new Error("couldn't load (HTTP 500)"))}
			/>,
		);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"couldn't load (HTTP 500) - is the my-usage process still running?",
		);
		expect(screen.queryByLabelText("Loading usage")).toBeNull();
	});
});
