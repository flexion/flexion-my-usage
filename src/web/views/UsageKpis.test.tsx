// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { UsageKpis } from "./UsageKpis";

afterEach(cleanup);

it("shows notional cost (accented), responses and tokens for the window", () => {
	render(
		<UsageKpis
			totals={{ notionalCost: 12.5, tokens: 3_400_000, responses: 1_234 }}
			windowLabel="Last 30 days"
		/>,
	);
	const cost = screen.getByRole("region", { name: "Notional Cost" });
	expect(within(cost).getByText("$12.50")).toBeTruthy();
	expect(
		within(cost).getByText("Last 30 days · tokens x published rates"),
	).toBeTruthy();
	const responses = screen.getByRole("region", { name: "Responses" });
	expect(within(responses).getByText("1,234")).toBeTruthy();
	expect(within(responses).getByText("Last 30 days")).toBeTruthy();
	const tokens = screen.getByRole("region", { name: "Total Tokens" });
	expect(within(tokens).getByText("3.40M")).toBeTruthy();
	// Only the headline tile carries the accent stripe.
	expect(cost.children).toHaveLength(4);
	expect(responses.children).toHaveLength(3);
});
