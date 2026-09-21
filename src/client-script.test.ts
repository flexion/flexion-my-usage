import { describe, expect, it } from "vitest";
import {
	type DayDetail,
	type DomContainerLike,
	type DomDocumentLike,
	type DomElementLike,
	type DomGetElementByIdLike,
	findDayDetail,
	measureToggleState,
	readJson,
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
		// readJson (below, embedded in CLIENT_SCRIPT) has three paths that return null: a missing
		// panel-cost-data/panel-tokens-data element, empty textContent, or a JSON.parse throw on
		// corrupt content - so a null payload is reachable once the HTML is written and opened
		// (myusage-4xu.7), not merely a hypothetical - CLIENT_SCRIPT runs in no real browser
		// today. That makes this test load-bearing on its own terms regardless: it pins
		// measureToggleState's own documented general contract - its `payload` parameter is
		// typed `Record<Measure, DayDetailPayload | null>`, and `MeasureToggleState.title`'s own
		// doc comment calls out the null case by name. This module is deliberately its own
		// independently-testable unit (see this file's header comment), not a mirror restricted
		// to what render.ts's exact call sites can reach (myusage-4xu.43).
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

	// render.ts's own wiring can never call findDayDetail with a day that has no match, or
	// with an empty list: the cost and tokens panels always share the same day.day values
	// (both come from stackByModel on the same input days), and a bar can only be clicked -
	// dispatching a real day.day - when at least one exists to click. The next two tests
	// instead guard findDayDetail's own documented general contract ("or undefined if there
	// is none") - this module is deliberately its own independently-testable unit (see this
	// file's header comment), not a mirror restricted to what render.ts's exact call sites
	// can reach (myusage-4xu.43).
	it("returns undefined when no day matches", () => {
		expect(findDayDetail(days, "2026-09-09")).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(findDayDetail([], "2026-09-07")).toBeUndefined();
	});
});

/**
 * A minimal `document` fake whose `getElementById` returns `el` only when the requested id
 * matches `expectedId`, `null` otherwise - so a call site that hardcodes the wrong element id
 * fails these tests instead of silently getting the right element back anyway.
 */
function fakeGetElementByIdDoc(
	expectedId: string,
	el: { textContent: string } | null,
): DomGetElementByIdLike {
	return { getElementById: (id) => (id === expectedId ? el : null) };
}

describe("readJson", () => {
	it("parses and returns the JSON payload from the element's textContent", () => {
		const doc = fakeGetElementByIdDoc("panel-cost-data", {
			textContent: '{"title":"Daily cost","days":[]}',
		});

		expect(readJson(doc, "panel-cost-data")).toEqual({
			title: "Daily cost",
			days: [],
		});
	});

	// The three null-return paths below are real branches, not humble DOM-wiring: each is a
	// distinct way render.ts's embedded payload can fail to reach measureToggleState as parsed
	// data once the HTML is written and opened (myusage-4xu.7) - a page saved or served without
	// its data script, a script tag present but emptied, or a payload truncated mid-write. None
	// throws past readJson. Their kill sets overlap - most mutations to the shared `JSON.parse`/
	// catch machinery are caught by both "missing element" and "empty textContent" alike - but
	// neither is a strict subset of the other: widening the empty-string fallback (e.g. `?? "0"`)
	// is caught by "missing element" but missed by "empty textContent", while narrowing what's
	// read off `textContent` before that fallback (e.g. reading `.length` instead of the string)
	// is caught by "empty textContent" but missed by "missing element". So "empty textContent" is
	// coverage-redundant on its own (deleting it keeps 100% coverage) but still earns its keep on
	// mutation-kill grounds. They're kept as three tests because each also documents a distinct
	// real-world input a reader might otherwise assume readJson mishandles, not only because each
	// is an independent proof point.
	it("returns null when no element with that id exists", () => {
		const doc = fakeGetElementByIdDoc("panel-cost-data", null);

		expect(readJson(doc, "panel-cost-data")).toBeNull();
	});

	it("returns null when the element's textContent is empty", () => {
		const doc = fakeGetElementByIdDoc("panel-cost-data", { textContent: "" });

		expect(readJson(doc, "panel-cost-data")).toBeNull();
	});

	it("returns null, not a thrown error, when textContent is truncated/corrupt JSON", () => {
		const doc = fakeGetElementByIdDoc("panel-cost-data", {
			textContent: '{"title": "Daily cost", "days": [',
		});

		expect(readJson(doc, "panel-cost-data")).toBeNull();
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
