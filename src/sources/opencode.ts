import type { NormalizedUsageRow, SourceHandle, UsageSource } from "./types.js";

// opencode adapter: reads ~/.local/share/opencode/opencode.db read-only (WAL-aware,
// honors XDG_DATA_HOME). Implementation tracked under myusage-4xu.3.
export const opencodeSource: UsageSource = {
	name: "opencode",

	async discover(): Promise<SourceHandle[]> {
		// TODO(myusage-4xu.3): locate opencode.db under XDG_DATA_HOME or ~/.local/share/opencode.
		return [];
	},

	async read(_handle: SourceHandle): Promise<NormalizedUsageRow[]> {
		// TODO(myusage-4xu.3): query assistant responses, emit one NormalizedUsageRow each.
		return [];
	},
};
