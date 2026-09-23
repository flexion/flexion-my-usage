// Drives loadUsage with real Response objects - the same type a real fetch resolves to.
import { describe, expect, it } from "vitest";
import { DATA_PATH, type UsagePayload } from "../usage-payload";
import { loadUsage } from "./api";

const PAYLOAD: UsagePayload = { days: [], skipped: { skipped: 0, total: 1 } };

describe("loadUsage", () => {
	it("fetches the data route and returns the parsed payload", async () => {
		const requested: string[] = [];
		const payload = await loadUsage(async (url) => {
			requested.push(url);
			return new Response(JSON.stringify(PAYLOAD));
		});
		expect(requested).toEqual([DATA_PATH]);
		expect(payload).toEqual(PAYLOAD);
	});

	it("rejects on a non-2xx status, naming it", async () => {
		await expect(
			loadUsage(async () => new Response("Not found\n", { status: 404 })),
		).rejects.toThrow("couldn't load usage data (HTTP 404)");
	});
});
