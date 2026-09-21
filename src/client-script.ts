import type { Measure } from "./chart-model.js";

// The cost/token toggle and day drill-down decisions render.ts's CLIENT_SCRIPT runs in the
// browser, factored out so they're covered by real tests instead of living only in a template-
// literal string v8 counts as "covered" without ever executing (myusage-4xu.34). render.ts embeds
// each exported function's own compiled source (via `.toString()`) straight into CLIENT_SCRIPT,
// so the code this file's tests exercise is byte-for-byte the code that ships to the browser -
// there is no hand-copied second implementation that could drift out of sync. That embedding
// constrains every exported function here to be self-contained (only its own parameters and
// locals, no closing over this module's other imports or exports) and DOM-free at its own call
// boundary except where a DOM-like object is explicitly passed in as an argument.

/** One model/Other entry in a day's drill-down breakdown, pre-formatted by render.ts. */
export interface DayDetailEntry {
	label: string;
	color: string;
	value: string;
}

/** One day's drill-down breakdown: entries plus the day's own pre-formatted total. */
export interface DayDetail {
	day: string;
	total: string;
	entries: DayDetailEntry[];
}

/** The `<script type="application/json">` payload render.ts embeds for one measure. */
export interface DayDetailPayload {
	title: string;
	days: DayDetail[];
}

/**
 * Everything the cost/token toggle changes when `measure` becomes active: which panel is
 * hidden, which button reads as active (class + `aria-pressed`), and the chart title to show
 * (`undefined` when that measure's payload never loaded). Pure and DOM-free so it's testable
 * with plain data - the browser-side glue that applies this to real elements is genuinely humble
 * (property assignment only, no decisions of its own).
 */
export interface MeasureToggleState {
	panelHidden: Record<Measure, boolean>;
	buttonActive: Record<Measure, boolean>;
	buttonAriaPressed: Record<Measure, "true" | "false">;
	title: string | undefined;
}

/** Decides `MeasureToggleState` for switching to `measure`. See that type's own doc comment. */
export function measureToggleState(
	measure: Measure,
	payload: Record<Measure, DayDetailPayload | null>,
): MeasureToggleState {
	return {
		panelHidden: { cost: measure !== "cost", tokens: measure !== "tokens" },
		buttonActive: { cost: measure === "cost", tokens: measure === "tokens" },
		buttonAriaPressed: {
			cost: measure === "cost" ? "true" : "false",
			tokens: measure === "tokens" ? "true" : "false",
		},
		title: payload[measure]?.title,
	};
}

/** The day within `days` whose `day` field matches `day`, or `undefined` if there is none. */
export function findDayDetail(
	days: readonly DayDetail[],
	day: string,
): DayDetail | undefined {
	for (const candidate of days) {
		if (candidate.day === day) return candidate;
	}
	return undefined;
}

/**
 * The minimal DOM surface `readJson` needs: a document-like object exposing `getElementById`,
 * returning an element-like object exposing `textContent` (or `null` when no element with that
 * id exists), satisfied by the real `document` in the browser and by a plain-object fake in
 * tests (see client-script.test.ts).
 */
export interface DomGetElementByIdLike {
	getElementById(id: string): { textContent: string } | null;
}

/**
 * Reads and `JSON.parse`s the payload embedded in the element with id `id` (see render.ts's
 * `embedJson`). Returns `null` - never throws - on any of three distinct paths: no element with
 * that id, an element whose `textContent` is empty, or content that fails `JSON.parse` (a
 * truncated or corrupt embedded payload). All three reach `null` through `JSON.parse`'s own
 * throw, caught below, rather than a separate presence guard - one path to `null` to keep
 * correct, not two.
 */
export function readJson(doc: DomGetElementByIdLike, id: string): unknown {
	const el = doc.getElementById(id);
	try {
		return JSON.parse(el?.textContent ?? "");
	} catch {
		return null;
	}
}

/**
 * The minimal DOM surface `renderDayDetail` needs, satisfied by a real `Element` in the browser
 * and by a plain-object fake in tests (see client-script.test.ts) - never jsdom, per this repo's
 * zero-dependency convention.
 */
export interface DomElementLike {
	className: string;
	textContent: string;
	style: { background: string };
	appendChild(child: DomElementLike): void;
}

export interface DomDocumentLike {
	createElement(tag: string): DomElementLike;
}

export interface DomContainerLike {
	firstChild: DomElementLike | null;
	hidden: boolean;
	removeChild(child: DomElementLike): void;
	appendChild(child: DomElementLike): void;
}

/**
 * Renders one day's drill-down breakdown into `container`: clears whatever was there, then a
 * title row ("`day` - `detail.total`") and one row per entry (color swatch, label, value).
 * `entry.label` comes from local session data this file doesn't control and is deliberately
 * embedded unescaped in the JSON payload render.ts writes (see render.ts's `embedJson`) - the
 * ONLY thing keeping a hostile label (e.g. containing "</script>" or "<img onerror=...>") inert
 * is that every write here goes through `textContent`, never `innerHTML`. Swapping that in this
 * function is exactly the regression client-script.test.ts's hostile-label tests pin.
 */
export function renderDayDetail(
	doc: DomDocumentLike,
	container: DomContainerLike,
	day: string,
	detail: DayDetail,
): void {
	while (container.firstChild) container.removeChild(container.firstChild);

	const title = doc.createElement("div");
	title.className = "day-detail-title";
	title.textContent = `${day} - ${detail.total}`;
	container.appendChild(title);

	for (const entry of detail.entries) {
		const row = doc.createElement("div");
		row.className = "day-detail-row";

		const swatch = doc.createElement("span");
		swatch.className = "swatch";
		swatch.style.background = entry.color;
		row.appendChild(swatch);

		const label = doc.createElement("span");
		label.textContent = entry.label;
		row.appendChild(label);

		const value = doc.createElement("span");
		value.className = "day-detail-value";
		value.textContent = entry.value;
		row.appendChild(value);

		container.appendChild(row);
	}

	container.hidden = false;
}
