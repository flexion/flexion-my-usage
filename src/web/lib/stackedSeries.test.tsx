// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OTHER_KEY } from "./modelStacks";
import {
	OTHER_COLOR,
	STACK_COLORS,
	StackedSeriesLegend,
	StackedTooltip,
	stackColorFor,
} from "./stackedSeries";

afterEach(cleanup);

const label = (key: string) => (key === OTHER_KEY ? "Other" : `label:${key}`);
const money = (n: number) => `$${n.toFixed(2)}`;

describe("stackColorFor", () => {
	it("gives Other its own gray, and named keys a hue by rank, wrapping after 8", () => {
		const named = Array.from({ length: 9 }, (_, i) => `k${i}`);
		expect(stackColorFor(OTHER_KEY, named)).toBe(OTHER_COLOR);
		expect(stackColorFor("k0", named)).toBe(STACK_COLORS[0]);
		expect(stackColorFor("k7", named)).toBe(STACK_COLORS[7]);
		expect(stackColorFor("k8", named)).toBe(STACK_COLORS[0]);
		expect(new Set(STACK_COLORS).size).toBe(8);
		expect(STACK_COLORS).not.toContain(OTHER_COLOR);
	});
});

describe("StackedTooltip", () => {
	const payload = [
		{ dataKey: "a", value: 1.5, color: "#111111" },
		{ dataKey: "b", value: 0, color: "#222222" },
		{ dataKey: OTHER_KEY, value: 2, color: "#333333" },
	];

	it("renders nothing while recharts says the tooltip is inactive", () => {
		const { container } = render(
			<StackedTooltip
				payload={payload}
				label="2026-09-01"
				displayKey={label}
				hoveredKey="a"
				formatValue={money}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("shows the hovered segment only: its label, its formatted value, its color", () => {
		const { container } = render(
			<StackedTooltip
				active
				payload={payload}
				label="2026-09-01"
				displayKey={label}
				hoveredKey="a"
				formatValue={money}
			/>,
		);
		expect(screen.getByText("2026-09-01")).toBeTruthy();
		expect(screen.getByText("label:a")).toBeTruthy();
		expect(screen.getByText("$1.50")).toBeTruthy();
		expect(screen.queryByText("Other")).toBeNull();
		const box = container.firstElementChild as HTMLElement;
		expect(box.style.opacity).toBe("1");
		expect(container.innerHTML).toContain("rgb(17, 17, 17)");
	});

	it("labels the Other segment in the sans font, named ones in mono", () => {
		render(
			<StackedTooltip
				active
				payload={payload}
				label="d"
				displayKey={label}
				hoveredKey={OTHER_KEY}
				formatValue={money}
			/>,
		);
		expect(screen.getByText("Other").style.fontFamily).toBe("var(--font-sans)");
	});

	it("stays mounted but invisible with no hover, a zero segment, or no payload", () => {
		for (const [hoveredKey, entries] of [
			[null, payload],
			["b", payload],
			["a", undefined],
		] as const) {
			const { container, unmount } = render(
				<StackedTooltip
					active
					payload={entries}
					label="d"
					displayKey={label}
					hoveredKey={hoveredKey}
					formatValue={money}
				/>,
			);
			const box = container.firstElementChild as HTMLElement;
			expect(box.style.opacity).toBe("0");
			expect(container.textContent).toBe("d");
			unmount();
		}
	});
});

describe("StackedSeriesLegend", () => {
	it("lists each key with its label and the bar's own color, Other in gray", () => {
		render(
			<StackedSeriesLegend
				stackKeys={["a", "b", OTHER_KEY]}
				displayKey={label}
			/>,
		);
		const items = screen.getAllByRole("listitem");
		expect(items.map((li) => li.textContent)).toEqual([
			"label:a",
			"label:b",
			"Other",
		]);
		const swatches = items.map((li) =>
			li.querySelector("[data-swatch]")?.getAttribute("data-swatch"),
		);
		expect(swatches).toEqual([STACK_COLORS[0], STACK_COLORS[1], OTHER_COLOR]);
		expect(screen.getByText("label:a").style.fontFamily).toBe(
			"var(--font-mono)",
		);
		expect(screen.getByText("Other").style.fontFamily).toBe("var(--font-sans)");
	});
});
