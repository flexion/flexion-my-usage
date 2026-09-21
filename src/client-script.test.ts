import { describe, expect, it } from "vitest";
import {
	type DayDetail,
	type DomContainerLike,
	type DomDocumentLike,
	type DomElementLike,
	findDayDetail,
	measureToggleState,
	renderDayDetail,
} from "./client-script.js";

describe("measureToggleState", () => {
	it("marks cost active, tokens hidden, when switching to cost", () => {
		const state = measureToggleState("cost", {
			cost: { title: "Daily cost", days: [] },
			tokens: { title: "Daily cost (Tokens)", days: [] },
		});

		expect(state.panelHidden).toEqual({ cost: false, tokens: true });
		expect(state.buttonActive).toEqual({ cost: true, tokens: false });
		expect(state.buttonAriaPressed).toEqual({ cost: "true", tokens: "false" });
		expect(state.title).toBe("Daily cost");
	});

	it("marks tokens active, cost hidden, when switching to tokens", () => {
		const state = measureToggleState("tokens", {
			cost: { title: "Daily cost", days: [] },
			tokens: { title: "Daily cost (Tokens)", days: [] },
		});

		expect(state.panelHidden).toEqual({ cost: true, tokens: false });
		expect(state.buttonActive).toEqual({ cost: false, tokens: true });
		expect(state.buttonAriaPressed).toEqual({ cost: "false", tokens: "true" });
		expect(state.title).toBe("Daily cost (Tokens)");
	});

	it("leaves the title undefined when that measure's payload never loaded", () => {
		const state = measureToggleState("cost", { cost: null, tokens: null });

		expect(state.title).toBeUndefined();
	});
});

describe("findDayDetail", () => {
	const days: DayDetail[] = [
		{ day: "2026-09-07", total: "$24.00", entries: [] },
		{ day: "2026-09-08", total: "$9.00", entries: [] },
	];

	it("returns the day whose day field matches", () => {
		expect(findDayDetail(days, "2026-09-08")).toBe(days[1]);
	});

	it("returns undefined when no day matches", () => {
		expect(findDayDetail(days, "2026-09-09")).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(findDayDetail([], "2026-09-07")).toBeUndefined();
	});
});

/**
 * A hand-rolled fake DOM - plain objects only, no jsdom - just enough surface to satisfy
 * `DomDocumentLike`/`DomContainerLike`/`DomElementLike`. Every fake element also carries an
 * `innerHTML` field that production code never touches; asserting it stays empty is what proves
 * `renderDayDetail` writes through `textContent` alone; a swap to `innerHTML` leaves this
 * `""` and the intended `textContent` field never set, so a test asserting the latter fails.
 */
interface FakeElement extends DomElementLike {
	tagName: string;
	innerHTML: string;
	children: FakeElement[];
}

function fakeElement(tag: string): FakeElement {
	return {
		tagName: tag,
		className: "",
		textContent: "",
		innerHTML: "",
		style: { background: "" },
		children: [],
		appendChild(child) {
			this.children.push(child as FakeElement);
		},
	};
}

function fakeDoc(): DomDocumentLike {
	return { createElement: (tag: string) => fakeElement(tag) };
}

interface FakeContainer extends DomContainerLike {
	children: FakeElement[];
}

function fakeContainer(initialChildren: FakeElement[] = []): FakeContainer {
	const container: FakeContainer = {
		children: [...initialChildren],
		hidden: true,
		get firstChild() {
			return this.children[0] ?? null;
		},
		removeChild(child) {
			const i = this.children.indexOf(child as FakeElement);
			if (i >= 0) this.children.splice(i, 1);
		},
		appendChild(child) {
			this.children.push(child as FakeElement);
		},
	};
	return container;
}

describe("renderDayDetail", () => {
	it("renders a title row and one row per entry, unhiding the container", () => {
		const doc = fakeDoc();
		const container = fakeContainer();
		const detail: DayDetail = {
			day: "2026-09-07",
			total: "$24.00",
			entries: [
				{ label: "claude-opus-4-6", color: "var(--series-1)", value: "$12.00" },
				{
					label: "claude-sonnet-4-5",
					color: "var(--series-2)",
					value: "$8.00",
				},
			],
		};

		renderDayDetail(doc, container, detail.day, detail);

		expect(container.hidden).toBe(false);
		expect(container.children).toHaveLength(3); // title + 2 entry rows

		const title = container.children[0];
		expect(title?.className).toBe("day-detail-title");
		expect(title?.textContent).toBe("2026-09-07 - $24.00");

		const [, row1, row2] = container.children;
		for (const [row, entry] of [
			[row1, detail.entries[0]],
			[row2, detail.entries[1]],
		] as const) {
			expect(row?.className).toBe("day-detail-row");
			const [swatch, label, value] = row?.children ?? [];
			expect(swatch?.className).toBe("swatch");
			expect(swatch?.style.background).toBe(entry?.color);
			expect(label?.textContent).toBe(entry?.label);
			expect(value?.className).toBe("day-detail-value");
			expect(value?.textContent).toBe(entry?.value);
		}
	});

	it("clears whatever was already in the container before rendering", () => {
		const doc = fakeDoc();
		const stale = fakeElement("div");
		const container = fakeContainer([stale]);
		const detail: DayDetail = {
			day: "2026-09-09",
			total: "$0.00",
			entries: [],
		};

		renderDayDetail(doc, container, detail.day, detail);

		expect(container.children).not.toContain(stale);
		expect(container.children).toHaveLength(1); // just the title row
	});

	it("renders zero entry rows for a quiet day, only the title", () => {
		const doc = fakeDoc();
		const container = fakeContainer();
		const detail: DayDetail = {
			day: "2026-09-09",
			total: "$0.00",
			entries: [],
		};

		renderDayDetail(doc, container, detail.day, detail);

		expect(container.children).toHaveLength(1);
		expect(container.children[0]?.textContent).toBe("2026-09-09 - $0.00");
	});

	it("keeps a hostile label as inert textContent, never touching innerHTML", () => {
		// The exact regression myusage-4xu.34 flags: render.ts's server side deliberately
		// embeds a raw, unescaped label into the JSON payload (see render.ts's embedJson doc
		// comment and render.test.ts's escaping tests) - textContent here is the only thing
		// standing between that string and it becoming markup. A swap to innerHTML would
		// leave `label.textContent` unset (still "") while this hostile string vanished into
		// `label.innerHTML` instead - which this test's `innerHTML` assertion also pins.
		const doc = fakeDoc();
		const container = fakeContainer();
		const hostileLabel = "weird</script><script>evil()</script>";
		const hostileValue = '<img src=x onerror="alert(1)">';
		const detail: DayDetail = {
			day: "2026-09-07",
			total: hostileValue,
			entries: [
				{ label: hostileLabel, color: "var(--series-1)", value: hostileValue },
			],
		};

		renderDayDetail(doc, container, detail.day, detail);

		const title = container.children[0] as FakeElement;
		const row = container.children[1] as FakeElement;
		const [, label, value] = row.children as FakeElement[];

		// Every hostile string lands exactly, verbatim, as textContent...
		expect(title.textContent).toBe(`2026-09-07 - ${hostileValue}`);
		expect(label?.textContent).toBe(hostileLabel);
		expect(value?.textContent).toBe(hostileValue);
		// ...and never as innerHTML, on any element this function touched.
		expect(title.innerHTML).toBe("");
		expect(label?.innerHTML).toBe("");
		expect(value?.innerHTML).toBe("");
	});
});
