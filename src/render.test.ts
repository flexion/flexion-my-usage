import { describe, expect, it } from "vitest";
import { renderHtml } from "./render.js";

describe("renderHtml", () => {
	it("returns a self-contained HTML document (scaffold placeholder)", () => {
		const html = renderHtml([]);
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("<title>my-usage</title>");
	});
});
