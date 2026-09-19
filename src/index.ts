#!/usr/bin/env node
import { aggregateDaily } from "./aggregate.js";
import { price } from "./pricing.js";
import { renderHtml } from "./render.js";
import { opencodeSource } from "./sources/opencode.js";

// Entry point: scan local sources -> price -> aggregate -> render -> write + open.
// Full delivery tracked under myusage-4xu.7.
async function main(): Promise<void> {
	const handles = await opencodeSource.discover();
	const rows = (
		await Promise.all(handles.map((h) => opencodeSource.read(h)))
	).flat();
	const priced = await price(rows);
	const days = aggregateDaily(priced);
	const html = renderHtml(days);

	// TODO(myusage-4xu.7): write index.html to a temp/output path and open it in the browser.
	void html;
	process.stdout.write(
		`my-usage: ${rows.length} responses across ${days.length} days (scaffold)\n`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
