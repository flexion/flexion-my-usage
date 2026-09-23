// @vitest-environment jsdom
// The small presentational pieces' remaining branches - the ones no section test reaches.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KpiCard } from "./KpiCard";
import { MeasureToggle } from "./MeasureToggle";
import { SectionHeader } from "./SectionHeader";

afterEach(cleanup);

describe("KpiCard", () => {
	it("omits the sub-line when there isn't one", () => {
		render(<KpiCard label="Responses" value="3" />);
		const card = screen.getByRole("region", { name: "Responses" });
		expect(card.textContent).toBe("Responses3");
	});
});

describe("SectionHeader", () => {
	it("renders the title alone when there's no caption", () => {
		render(<SectionHeader title="By Model" />);
		expect(
			screen.getByRole("heading", { name: "By Model" }).parentElement
				?.childElementCount,
		).toBe(1);
	});
});

describe("MeasureToggle", () => {
	it("marks the current option pressed and reports a click on another", () => {
		const onChange = vi.fn();
		render(
			<MeasureToggle
				label="Measure"
				value="cost"
				onChange={onChange}
				options={[
					{ value: "cost", label: "Cost" },
					{ value: "tokens", label: "Tokens" },
				]}
			/>,
		);
		expect(screen.getByRole("group", { name: "Measure" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Cost" }).getAttribute("aria-pressed"),
		).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
		expect(onChange).toHaveBeenCalledWith("tokens");
	});
});
