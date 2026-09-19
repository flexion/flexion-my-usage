import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NormalizedUsageRow, SourceHandle, UsageSource } from "./types.js";

// opencode adapter: reads the local opencode SQLite database read-only (WAL-aware).
//
// Schema (github.com/anomalyco/opencode, tag v1.18.31): one row per chat message in the
// `message` table. `id` and `session_id` are columns; everything else lives in the JSON
// `data` column. An assistant response has role "assistant", providerID, modelID,
// time.completed (epoch ms, set when the response finishes) and tokens { input, output,
// reasoning, cache: { read, write } }. Only those fields are selected: message text,
// prompts, and tool output (the `part` table) are never read.

const SOURCE = "opencode";

// Same data-dir rule opencode uses (xdg-basedir): XDG_DATA_HOME if set and non-empty,
// otherwise ~/.local/share.
function databasePath(): string {
	const dataHome =
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataHome, "opencode", "opencode.db");
}

// `json_extract` raises on malformed JSON, which would abort the whole query. The CASE
// guarantees it only runs on valid JSON, so one bad row cannot hide every other row.
// Rows that survive the WHERE clause are therefore valid JSON, and the SELECT-list
// extractions below cannot throw.
const QUERY = `
	SELECT
		m.id AS message_id,
		m.session_id AS session_id,
		json_extract(m.data, '$.providerID') AS provider,
		json_extract(m.data, '$.modelID') AS model,
		json_extract(m.data, '$.time.completed') AS completed,
		json_extract(m.data, '$.tokens.input') AS input,
		json_extract(m.data, '$.tokens.output') AS output,
		json_extract(m.data, '$.tokens.reasoning') AS reasoning,
		json_extract(m.data, '$.tokens.cache.read') AS cache_read,
		json_extract(m.data, '$.tokens.cache.write') AS cache_write
	FROM message AS m
	WHERE (CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END) = 'assistant'
`;

type SqliteModule = typeof import("node:sqlite");

// node:sqlite prints an ExperimentalWarning on import in Node 22.x. Suppress exactly that
// warning while importing, leave every other warning alone, and import once so concurrent
// reads never nest the temporary patch. Loaded lazily so users who never touch opencode
// never load it.
let sqlite: Promise<SqliteModule> | undefined;

function isSqliteExperimentalWarning(
	warning: string | Error,
	args: unknown[],
): boolean {
	const message = typeof warning === "string" ? warning : warning.message;
	const options = args[0];
	const type =
		typeof options === "string"
			? options
			: typeof options === "object" && options !== null
				? (options as { type?: string }).type
				: typeof warning === "string"
					? undefined
					: warning.name;
	return (
		type === "ExperimentalWarning" &&
		message.startsWith("SQLite is an experimental feature")
	);
}

function loadSqlite(): Promise<SqliteModule> {
	sqlite ??= (async () => {
		const original = process.emitWarning;
		process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
			if (isSqliteExperimentalWarning(warning, args)) return;
			return (original as (...a: unknown[]) => void).call(
				process,
				warning,
				...args,
			);
		}) as typeof process.emitWarning;
		try {
			return await import("node:sqlite");
		} finally {
			process.emitWarning = original;
		}
	})();
	return sqlite;
}

// SQLite integers come back as bigint (so an out-of-range value cannot throw); floats as
// number. A usable bucket is a finite, positive number; anything else counts as 0.
function toNumber(value: unknown): number | undefined {
	const n = typeof value === "bigint" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function bucket(value: unknown): number {
	const n = toNumber(value);
	return n !== undefined && n > 0 ? n : 0;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function toRow(raw: Record<string, unknown>): NormalizedUsageRow | undefined {
	const messageId = text(raw.message_id);
	const sessionId = text(raw.session_id);
	const provider = text(raw.provider);
	const model = text(raw.model);
	const completed = toNumber(raw.completed);
	if (!messageId || !sessionId || !provider || !model) return undefined;
	// time.completed is only set once the response finishes; without it the row is incomplete.
	if (completed === undefined || completed <= 0) return undefined;
	const timestamp = new Date(completed);
	if (Number.isNaN(timestamp.getTime())) return undefined;

	const tokens = {
		input: bucket(raw.input),
		output: bucket(raw.output),
		reasoning: bucket(raw.reasoning),
		cacheRead: bucket(raw.cache_read),
		cacheWrite: bucket(raw.cache_write),
	};
	// A response that reported no usage at all carries nothing to aggregate.
	if (Object.values(tokens).every((n) => n === 0)) return undefined;

	return {
		source: SOURCE,
		provider,
		model,
		timestamp,
		sessionId,
		messageId,
		tokens,
	};
}

function compareRows(a: NormalizedUsageRow, b: NormalizedUsageRow): number {
	const byTime = a.timestamp.getTime() - b.timestamp.getTime();
	if (byTime !== 0) return byTime;
	// Plain code-unit comparison: deterministic regardless of locale.
	return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

export const opencodeSource: UsageSource = {
	name: SOURCE,

	async discover(): Promise<SourceHandle[]> {
		const path = databasePath();
		try {
			if (!(await stat(path)).isFile()) return [];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return [];
			throw error;
		}
		return [{ source: SOURCE, path }];
	},

	async read(handle: SourceHandle): Promise<NormalizedUsageRow[]> {
		const { DatabaseSync } = await loadSqlite();
		// readOnly maps to SQLITE_OPEN_READONLY: never creates, writes, checkpoints, or
		// changes journal mode. A WAL database is still read correctly, including
		// committed rows that have not been checkpointed into the main file yet.
		// Side effect: with no other connection open, SQLite creates empty -wal/-shm
		// sidecar files next to the database (it needs them to read a WAL database).
		// The database file itself is never modified.
		const db = new DatabaseSync(handle.path, { readOnly: true });
		try {
			// A writer or a closing connection can briefly hold a lock (SQLite WAL docs).
			db.exec("PRAGMA busy_timeout = 2000");
			const hasMessageTable = db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'",
				)
				.get();
			if (!hasMessageTable) {
				throw new Error(
					`Unsupported opencode database: no "message" table in ${handle.path}`,
				);
			}
			const statement = db.prepare(QUERY);
			statement.setReadBigInts(true);
			return statement
				.all()
				.map((raw) => toRow(raw))
				.filter((row): row is NormalizedUsageRow => row !== undefined)
				.sort(compareRows);
		} finally {
			db.close();
		}
	},
};
