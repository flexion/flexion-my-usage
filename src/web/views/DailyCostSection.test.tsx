// @vitest-environment jsdom
// Renders the real chart - recharts included - in jsdom and drives it with real DOM events on
// the bars it draws. ResponsiveContainer's initialDimension gives it a size to lay out against,
// since jsdom has no layout engine to report one.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DayBucket, ModelTotals } from "../../usage-payload";
import { modelKey, modelLabeler } from "../lib/modelStacks";
import { OTHER_COLOR } from "../lib/stackedSeries";
import { DailyCostSection, RoundedBar } from "./DailyCostSection";

afterEach(cleanup);

function totals(
	model: string,
	notionalCost: number,
	tokens: number,
): ModelTotals {
	return { provider: "p", model, notionalCost, tokens, unpricedTokens: 0 };
}

function day(date: string, models: ModelTotals[]): DayBucket {
	return {
		day: date,
		byModel: Object.fromEntries(models.map((m) => [modelKey(m), m])),
		notionalCost: models.reduce((sum, m) => sum + m.notionalCost, 0),
		tokens: models.reduce((sum, m) => sum + m.tokens, 0),
		responses: models.length,
	};
}

// Three days: two models on the first, one on the second, nothing on the third.
const DAYS = [
	day("2026-09-01", [totals("alpha", 2, 100), totals("beta", 1, 900)]),
	day("2026-09-02", [totals("alpha", 3, 50)]),
	day("2026-09-03", []),
];

function renderSection(days: DayBucket[] = DAYS) {
	return render(<DailyCostSection days={days} labelFor={modelLabeler(days)} />);
}

/** Every drawn bar segment, in recharts' own order (series by series, day by day). */
function barShapes(container: HTMLElement): Element[] {
	return [...container.querySelectorAll(".recharts-bar-rectangle")];
}

/** The Total chart's drawn bar paths (RoundedBar's output). */
function roundedPaths(container: HTMLElement): Element[] {
	return [...container.querySelectorAll(".recharts-bar-rectangle path")];
}

function pressed(name: string): string | null {
	return screen.getByRole("button", { name }).getAttribute("aria-pressed");
}

describe("DailyCostSection", () => {
	it("opens stacked by model, on cost, with a legend of the window's models", () => {
		const { container } = renderSection();
		expect(screen.getByRole("heading", { name: "Daily Cost" })).toBeTruthy();
		expect(pressed("By model")).toBe("true");
		expect(pressed("Cost")).toBe("true");
		expect(screen.getByText("Last 3 days")).toBeTruthy();
		const legend = screen.getByRole("list", { name: "Legend" });
		expect(
			within(legend)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["alpha", "beta"]);
		// alpha on two days, beta on one; recharts skips a zero-height segment's shape.
		expect(barShapes(container).length).toBeGreaterThanOrEqual(3);
	});

	it("past 8 models, the smallest fold into Other: last in the legend, drawn in gray", () => {
		const nine = [
			day(
				"2026-09-01",
				Array.from({ length: 9 }, (_, i) => totals(`m${i + 1}`, i + 1, 1)),
			),
		];
		const { container } = renderSection(nine);
		const legend = screen.getByRole("list", { name: "Legend" });
		const items = within(legend)
			.getAllByRole("listitem")
			.map((li) => li.textContent);
		expect(items).toHaveLength(9);
		expect(items[0]).toBe("m9");
		expect(items.at(-1)).toBe("Other");
		expect(items).not.toContain("m1");
		// Other stacks at the bottom, so it's the first series recharts draws.
		const firstBar = container.querySelector(".recharts-bar-rectangle path");
		expect(firstBar?.getAttribute("fill")).toBe(OTHER_COLOR);
	});

	it("switches the title, caption and ranking to tokens", () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
		expect(screen.getByRole("heading", { name: "Daily Tokens" })).toBeTruthy();
		expect(screen.getByText("Tokens are counted, not billed.")).toBeTruthy();
		expect(pressed("Tokens")).toBe("true");
		// beta has more tokens, so it now ranks first.
		const legend = screen.getByRole("list", { name: "Legend" });
		expect(within(legend).getAllByRole("listitem")[0]?.textContent).toBe(
			"beta",
		);
	});

	it("Total draws one rounded bar per day with usage, and drops the legend", () => {
		const { container } = renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Total" }));
		expect(pressed("Total")).toBe("true");
		expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
		// Two days with cost; the empty third day draws no path at all.
		const paths = roundedPaths(container);
		expect(paths).toHaveLength(2);
		expect(paths[0]?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+ L/);
	});

	it("clicking a bar opens that day's detail, and clicking it again closes it", () => {
		const { container } = renderSection();
		fireEvent.click(barShapes(container)[0] as Element);
		const detail = screen.getByRole("region", { name: "Usage on 2026-09-01" });
		expect(within(detail).getByText("alpha")).toBeTruthy();
		expect(screen.getByText(/click it again to close/)).toBeTruthy();
		fireEvent.click(barShapes(container)[0] as Element);
		expect(screen.queryByRole("region", { name: /Usage on/ })).toBeNull();
	});

	it("a Total bar opens its day too, and the open day's bar changes color", () => {
		const { container } = renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Total" }));
		const fills = () =>
			roundedPaths(container).map((p) => p.getAttribute("fill"));
		const [accent] = fills();
		expect(fills()).toEqual([accent, accent]);
		fireEvent.click(barShapes(container)[1] as Element);
		expect(
			screen.getByRole("region", { name: "Usage on 2026-09-02" }),
		).toBeTruthy();
		const [first, second] = fills();
		expect(first).toBe(accent);
		expect(second).not.toBe(accent);
	});

	it("the date input opens a day without a mouse, is bounded to the window, and clears", () => {
		renderSection();
		const input = screen.getByLabelText("Jump to day") as HTMLInputElement;
		expect(input.min).toBe("2026-09-01");
		expect(input.max).toBe("2026-09-03");
		fireEvent.change(input, { target: { value: "2026-09-03" } });
		const detail = screen.getByRole("region", { name: "Usage on 2026-09-03" });
		expect(within(detail).getByText("No usage on this day.")).toBeTruthy();
		expect(input.value).toBe("2026-09-03");
		fireEvent.change(input, { target: { value: "" } });
		expect(screen.queryByRole("region", { name: /Usage on/ })).toBeNull();
	});

	it("the detail's Close button closes it", () => {
		renderSection();
		fireEvent.change(screen.getByLabelText("Jump to day"), {
			target: { value: "2026-09-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("region", { name: /Usage on/ })).toBeNull();
	});

	it("hovering a segment and leaving the chart both update without error", () => {
		const { container } = renderSection();
		fireEvent.mouseEnter(barShapes(container)[0] as Element);
		fireEvent.mouseLeave(
			container.querySelector(".recharts-wrapper") as Element,
		);
		expect(barShapes(container).length).toBeGreaterThan(0);
	});

	it("a window with no usage says so instead of drawing an empty chart", () => {
		const { container } = renderSection([day("2026-09-01", [])]);
		expect(screen.getByText("No usage recorded in this window.")).toBeTruthy();
		expect(container.querySelector(".recharts-wrapper")).toBeNull();
	});
});

describe("RoundedBar", () => {
	it("draws a path with rounded top corners, radius capped at 3", () => {
		const { container } = render(
			<svg role="img" aria-label="bar">
				<RoundedBar x={10} y={20} width={8} height={40} fill="#fff" />
			</svg>,
		);
		const d = container.querySelector("path")?.getAttribute("d");
		expect(d).toBe("M10,60 L10,23 Q10,20 13,20 L15,20 Q18,20 18,23 L18,60 Z");
	});

	it("shrinks the radius for a bar shorter than 3", () => {
		const { container } = render(
			<svg role="img" aria-label="bar">
				<RoundedBar x={0} y={0} width={10} height={2} />
			</svg>,
		);
		expect(container.querySelector("path")?.getAttribute("d")).toContain(
			"L0,2 Q0,0 2,0",
		);
	});

	it("draws nothing for an empty (zero-height) or unsized bar", () => {
		const { container } = render(
			<svg role="img" aria-label="bar">
				<RoundedBar x={0} y={0} width={10} height={0} />
				<RoundedBar />
			</svg>,
		);
		expect(container.querySelector("path")).toBeNull();
	});
});
