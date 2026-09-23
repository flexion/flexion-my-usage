// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRow } from "../lib/modelStacks";
import { ModelTableSection, sharePct } from "./ModelTableSection";

afterEach(cleanup);

function row(
	model: string,
	notionalCost: number,
	tokens: number,
	unpricedTokens = 0,
): ModelRow {
	return {
		key: `p/${model}`,
		provider: "p",
		model,
		notionalCost,
		tokens,
		unpricedTokens,
	};
}

const label = (key: string) => key.replace(/^p\//, "");

describe("sharePct", () => {
	it("is a one-decimal percentage, or '-' with nothing to divide by", () => {
		expect(sharePct(1, 3)).toBe("33.3%");
		expect(sharePct(0, 0)).toBe("-");
	});
});

describe("ModelTableSection", () => {
	it("one row per model: label, tokens, share of cost, notional cost", () => {
		render(
			<ModelTableSection
				models={[row("alpha", 3, 1_500), row("beta", 1, 20)]}
				labelFor={label}
			/>,
		);
		const rows = within(screen.getByRole("table")).getAllByRole("row");
		expect(rows.map((r) => r.textContent)).toEqual([
			"ModelTokensShareNotional cost",
			"alpha1.5k75.0%$3.00",
			"beta2025.0%$1.00",
		]);
	});

	it("badges a model with unpriced tokens, naming how many in its title", () => {
		render(
			<ModelTableSection
				models={[row("alpha", 1, 10), row("mystery", 0, 2_000, 2_000)]}
				labelFor={label}
			/>,
		);
		const badge = screen.getByText("no rate");
		expect(badge.getAttribute("title")).toBe(
			"2.0k tokens had no published rate",
		);
		expect(badge.closest("tr")?.textContent).toContain("mystery");
		expect(screen.getAllByText("no rate")).toHaveLength(1);
	});

	it("an all-unpriced window shows '-' for share rather than dividing by zero", () => {
		render(
			<ModelTableSection models={[row("mystery", 0, 5, 5)]} labelFor={label} />,
		);
		expect(screen.getByRole("table").textContent).toContain("-$0.00");
	});

	it("no models -> an empty-state line, no table", () => {
		render(<ModelTableSection models={[]} labelFor={label} />);
		expect(screen.getByText("No usage recorded in this window.")).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});
});
