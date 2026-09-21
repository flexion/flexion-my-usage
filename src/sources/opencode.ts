import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { withSqliteWarningSuppressed } from "./sqlite-warning.js";
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
function dataDir(): string {
	const dataHome =
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataHome, "opencode");
}

// Matches opencode.db and opencode-<channel>.db, any channel (including one containing its
// own dashes, e.g. "beta-canary") but never SQLite's own sidecars (opencode.db-wal,
// opencode.db-shm) or a lookalike (opencode.db.backup, opencode.sqlite, myopencode.db) - see
// the "lookalike files" test in opencode.test.ts for the exact decoy shapes this rejects.
const DB_NAME_PATTERN = /^opencode(-.+)?\.db$/;

// Upstream (anomalyco/opencode, packages/core/src/database/database.ts, v1.18.31) uses an
// absolute OPENCODE_DB as-is and resolves anything else against the data directory, never the
// process cwd. (":memory:" is out of scope - nothing here needs it, so it takes the relative
// branch like any other non-absolute string, same as upstream's own isAbsolute() check would.)
function resolveOverridePath(override: string, dir: string): string {
	return isAbsolute(override) ? override : join(dir, override);
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
// warning while importing (see sqlite-warning.ts), leave every other warning alone, and
// import once so concurrent reads never nest the temporary patch. Loaded lazily so users who
// never touch opencode never load it.
let sqlite: Promise<SqliteModule> | undefined;

function loadSqlite(): Promise<SqliteModule> {
	sqlite ??= withSqliteWarningSuppressed(() => import("node:sqlite"));
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

// Exported for a direct unit test of the code-unit tie-break (locale-independent ordering).
// Message ids are a primary key, so two distinct rows can never tie on both timestamp and
// message id - once a time tie reaches the message-id compare, exactly one of them is smaller.
export function compareRows(
	a: NormalizedUsageRow,
	b: NormalizedUsageRow,
): number {
	const byTime = a.timestamp.getTime() - b.timestamp.getTime();
	if (byTime !== 0) return byTime;
	// Plain code-unit comparison: deterministic regardless of locale.
	return a.messageId < b.messageId ? -1 : 1;
}

// discover() takes two injectable seams, `stat` and `readdir`, the same seam shape as the
// price table's injected `fetch`: named fields on an options object, each defaulting to its
// real dependency when omitted. These live on opencode's own type, not on the shared
// `UsageSource.discover()` signature in types.ts, so every other source's `discover()` stays
// zero-arg.
export interface DiscoverOptions {
	stat?: typeof stat;
	readdir?: typeof readdir;
}

// read() takes an injectable DatabaseSync constructor, the same seam shape as DiscoverOptions'
// `stat` above: a named field on an options object, defaulting to the real node:sqlite export
// (loaded lazily via loadSqlite()) when omitted. This is what lets the readonly-directory
// error-classification below be tested directly - a fake open failure with a chosen `.errcode`
// - without a chmod fixture. Lives on opencode's own type, not on the shared `UsageSource.read()`
// signature in types.ts, so every other source's `read()` stays one-arg.
export interface ReadOptions {
	DatabaseSyncCtor?: SqliteModule["DatabaseSync"];
}

// Codes that mean "no readable opencode data at this path", not "something is wrong":
// absent (ENOENT), a path segment that isn't a directory (ENOTDIR), permission denied
// (EACCES/EPERM), or a symlink loop (ELOOP). Anything else - EIO, or an error with no
// .code at all - is genuinely unexpected and must still surface so it doesn't get
// treated as "opencode just isn't installed".
//
// Typed as a set of `unknown` (not `Set<string>`) so `.has(code)` accepts `code`'s real
// type (`string | undefined`) directly: `Set.has` on an unknown-typed set never needs the
// argument narrowed first, and `.has(undefined)` is simply false since undefined was never
// added, which is exactly the "no .code at all" case below.
const IGNORABLE_DISCOVER_CODES: ReadonlySet<unknown> = new Set([
	"ENOENT",
	"ENOTDIR",
	"EACCES",
	"EPERM",
	"ELOOP",
]);

// The ignore-or-surface decision, extracted as pure logic (an errno in, a return-or-throw
// out) so it is provable without depending on the OS or the calling user's permissions.
// discover()'s catch delegates to this directly.
export function handleDiscoverError(error: unknown): SourceHandle[] {
	const code = (error as NodeJS.ErrnoException).code;
	if (IGNORABLE_DISCOVER_CODES.has(code)) return [];
	throw error;
}

// node:sqlite's own extended SQLite result code for "cannot create a file the operation
// needs because the containing directory is not writable" (SQLITE_READONLY_DIRECTORY).
// Surfaced as `.errcode` on the thrown Error; not typed by @types/node, so it's read through
// a narrow cast, the same pattern handleDiscoverError already uses for `.code`.
const SQLITE_READONLY_DIRECTORY = 1544;

function isReadonlyDirectoryError(error: unknown): boolean {
	return (error as { errcode?: unknown }).errcode === SQLITE_READONLY_DIRECTORY;
}

function readRows(
	DatabaseSyncCtor: SqliteModule["DatabaseSync"],
	path: string,
): NormalizedUsageRow[] {
	// readOnly maps to SQLITE_OPEN_READONLY: never creates, writes, checkpoints, or
	// changes journal mode. A WAL database is still read correctly, including
	// committed rows that have not been checkpointed into the main file yet.
	// Side effect: with no other connection open, SQLite creates empty -wal/-shm
	// sidecar files next to the database (it needs them to read a WAL database).
	// The database file itself is never modified.
	const db = new DatabaseSyncCtor(path, { readOnly: true });
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
				`Unsupported opencode database: no "message" table in ${path}`,
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
}

export const opencodeSource = {
	name: SOURCE,

	async discover(options: DiscoverOptions = {}): Promise<SourceHandle[]> {
		const statFn = options.stat ?? stat;
		const readdirFn = options.readdir ?? readdir;
		const dir = dataDir();
		const override = process.env.OPENCODE_DB;
		if (override) {
			const overridePath = resolveOverridePath(override, dir);
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await statFn(overridePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error(
						`OPENCODE_DB is set to ${overridePath} but that file does not exist`,
					);
				}
				// Unlike the scan arm below, the user named this exact path, so every other
				// stat() failure (EACCES on the file itself, ENOTDIR from a parent path
				// component that is actually a file, EIO, ...) means this override is broken,
				// not "opencode isn't installed" - it must surface as a named, actionable error
				// too, never fall through to handleDiscoverError's silent []. A real errno
				// error's own message already embeds its code (e.g. "EACCES: permission
				// denied, stat '/x'"), so no separate `.code` fallback is needed here.
				throw new Error(
					`OPENCODE_DB is set to ${overridePath} but it could not be read: ${
						(error as Error).message
					}`,
					{ cause: error },
				);
			}
			if (info.isDirectory()) {
				throw new Error(
					`OPENCODE_DB is set to ${overridePath} but that path is a directory`,
				);
			}
			return [{ source: SOURCE, path: overridePath }];
		}
		// No OPENCODE_DB: scan the data directory for every opencode.db / opencode-<channel>.db
		// file. readdir's Dirent is lstat-based and never follows a symlink, so a symlinked
		// database would report isFile() === false even though its target is a real, readable
		// file - the exact silent-empty-chart failure myusage-4xu.10 and myusage-chj exist to
		// eliminate. A plain file entry needs no further check (Dirent already answered it), but
		// a symlink entry is confirmed with `statFn`, which does follow symlinks, before it
		// becomes a handle. A candidate whose stat fails (a broken symlink, typically ENOENT) is
		// simply excluded, not surfaced - one bad entry must not fail discovery of the rest, unlike
		// the OPENCODE_DB override arm's stat above, where a bad path is the only thing being asked
		// about and failing it loudly is correct.
		try {
			const entries = await readdirFn(dir, { withFileTypes: true });
			const candidates = entries.filter((entry) =>
				DB_NAME_PATTERN.test(entry.name),
			);
			const handles = await Promise.all(
				candidates.map(async (entry): Promise<SourceHandle | undefined> => {
					const path = join(dir, entry.name);
					if (entry.isFile()) return { source: SOURCE, path };
					if (!entry.isSymbolicLink()) return undefined;
					try {
						const info = await statFn(path);
						return info.isFile() ? { source: SOURCE, path } : undefined;
					} catch {
						return undefined;
					}
				}),
			);
			return handles.filter(
				(handle): handle is SourceHandle => handle !== undefined,
			);
		} catch (error) {
			return handleDiscoverError(error);
		}
	},

	async read(
		handle: SourceHandle,
		options: ReadOptions = {},
	): Promise<NormalizedUsageRow[]> {
		const DatabaseSyncCtor =
			options.DatabaseSyncCtor ?? (await loadSqlite()).DatabaseSync;
		try {
			return readRows(DatabaseSyncCtor, handle.path);
		} catch (error) {
			if (!isReadonlyDirectoryError(error)) throw error;
			// Opening a WAL database read-only still needs to create its -wal/-shm sidecars
			// when they are not already sitting next to it; in a read-only directory that
			// create fails as SQLITE_READONLY_DIRECTORY, surfaced above as a bare "attempt to
			// write a readonly database" with no indication of the cause or the remedy.
			//
			// An immutable=1 URI open was tried here and reverted: it works on newer Node, but
			// node:sqlite's DatabaseSync did not accept file: URI locations at all until after
			// this repo's Node floor (22.13.0, where even a bare file: URI with no query string
			// fails with "unable to open database file" - confirmed directly against that
			// engine). A fix this repo's own CI Node-floor job cannot pass is not a fix; name
			// the cause and the remedy instead.
			throw new Error(
				`Cannot read ${handle.path}: its directory is not writable, and this WAL-mode ` +
					"database has no pre-existing -wal/-shm sidecar files for SQLite to reuse. " +
					"Copy the database (and any -wal/-shm files beside it) to a writable location " +
					"and read from there.",
				{ cause: error },
			);
		}
	},
} satisfies UsageSource;
