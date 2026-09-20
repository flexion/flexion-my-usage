import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compareRows, opencodeSource } from "./opencode.js";
import type { NormalizedUsageRow } from "./types.js";

// Fixtures are throwaway SQLite files that reproduce the upstream opencode schema.
// They never touch the real opencode database or anything under the home directory.
//
// Schema source (public repo, released tag v1.18.31, commit 014614d35b39):
//   github.com/anomalyco/opencode
//   packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts  (message DDL)
//   packages/core/src/session/sql.ts                                             (message table)
//   packages/schema/src/v1/session.ts                                            (Assistant message JSON)
//   packages/core/src/session/projector.ts                                       (message.data omits id/sessionID)
// The `part` table is intentionally absent: the reader must never depend on it.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_ROOT = join(
	REPO_ROOT,
	"node_modules",
	".cache",
	"my-usage-tests",
);

const DDL = `
  CREATE TABLE \`session\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`slug\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`title\` text NOT NULL,
    \`version\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  );
  CREATE TABLE \`message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
  );
  CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`, \`time_created\`, \`id\`);
`;

const CREATED = 1_700_000_000_000;

let sandboxes: string[] = [];
let openDbs: DatabaseSync[] = [];

beforeAll(async () => {
	await mkdir(FIXTURE_ROOT, { recursive: true });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const db of openDbs) {
		try {
			db.close();
		} catch {
			// already closed
		}
	}
	openDbs = [];
	for (const dir of sandboxes) {
		await rm(dir, { recursive: true, force: true });
	}
	sandboxes = [];
});

async function sandbox(): Promise<string> {
	const dir = await mkdtemp(join(FIXTURE_ROOT, "opencode-"));
	sandboxes.push(dir);
	return dir;
}

function createDb(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	openDbs.push(db);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(DDL);
	return db;
}

function assistantData(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		time: { created: CREATED, completed: CREATED + 5_000 },
		parentID: "msg_fixture_parent",
		modelID: "fixture-model-a",
		providerID: "anthropic",
		mode: "build",
		agent: "build",
		path: { cwd: "/work/fixture", root: "/work/fixture" },
		cost: 0,
		tokens: {
			input: 100,
			output: 50,
			reasoning: 10,
			cache: { read: 1000, write: 200 },
		},
		finish: "stop",
		...overrides,
	};
}

function insertMessage(
	db: DatabaseSync,
	id: string,
	data: unknown,
	sessionId = "ses_fixture_a",
): void {
	db.prepare(
		"INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_fixture', 'slug', '/work/fixture', 'title', '1.0.0', ?, ?)",
	).run(sessionId, CREATED, CREATED);
	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	).run(
		id,
		sessionId,
		CREATED,
		CREATED,
		typeof data === "string" ? data : JSON.stringify(data),
	);
}

function handleFor(path: string) {
	return { source: "opencode", path };
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("opencodeSource.discover", () => {
	async function isolatedHome(): Promise<string> {
		const home = await sandbox();
		// Point every home lookup at the sandbox so a bug can never reach the real home.
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		return home;
	}

	it("returns no handles when the database is absent", async () => {
		const home = await isolatedHome();
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		expect(await opencodeSource.discover()).toEqual([]);
	});

	it("honors XDG_DATA_HOME", async () => {
		const home = await isolatedHome();
		const dbPath = join(home, "xdg", "opencode", "opencode.db");
		await mkdir(join(home, "xdg", "opencode"), { recursive: true });
		await writeFile(dbPath, "");
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		expect(await opencodeSource.discover()).toEqual([
			{ source: "opencode", path: dbPath },
		]);
	});

	it("falls back to ~/.local/share/opencode/opencode.db when XDG_DATA_HOME is unset", async () => {
		const home = await isolatedHome();
		const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
		await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
		await writeFile(dbPath, "");
		vi.stubEnv("XDG_DATA_HOME", undefined);

		expect(homedir()).toBe(home);
		expect(await opencodeSource.discover()).toEqual([
			{ source: "opencode", path: dbPath },
		]);
	});

	it("treats an empty XDG_DATA_HOME as unset", async () => {
		const home = await isolatedHome();
		const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
		await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
		await writeFile(dbPath, "");
		vi.stubEnv("XDG_DATA_HOME", "");

		expect(await opencodeSource.discover()).toEqual([
			{ source: "opencode", path: dbPath },
		]);
	});

	it("does not fall back to the home path when XDG_DATA_HOME is set but has no database", async () => {
		const home = await isolatedHome();
		await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
		await writeFile(
			join(home, ".local", "share", "opencode", "opencode.db"),
			"",
		);
		vi.stubEnv("XDG_DATA_HOME", join(home, "elsewhere"));

		expect(await opencodeSource.discover()).toEqual([]);
	});

	it("ignores a directory named opencode.db", async () => {
		const home = await isolatedHome();
		await mkdir(join(home, "xdg", "opencode", "opencode.db"), {
			recursive: true,
		});
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		expect(await opencodeSource.discover()).toEqual([]);
	});

	it("rethrows a filesystem error that is neither 'absent' nor 'not a directory'", async () => {
		const home = await isolatedHome();
		await mkdir(join(home, "xdg"), { recursive: true });
		// A symlink pointing at itself makes stat fail with ELOOP.
		await symlink("opencode", join(home, "xdg", "opencode"));
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		await expect(opencodeSource.discover()).rejects.toMatchObject({
			code: "ELOOP",
		});
	});
});

describe("opencodeSource.read", () => {
	it("maps a completed assistant message to a normalized row", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(db, "msg_fixture_001", assistantData());
		db.close();

		const rows = await opencodeSource.read(handleFor(path));

		expect(rows).toEqual([
			{
				source: "opencode",
				provider: "anthropic",
				model: "fixture-model-a",
				timestamp: new Date(CREATED + 5_000),
				sessionId: "ses_fixture_a",
				messageId: "msg_fixture_001",
				tokens: {
					input: 100,
					output: 50,
					reasoning: 10,
					cacheRead: 1000,
					cacheWrite: 200,
				},
			},
		]);
	});

	it("uses the response completion time, not the creation time", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(
			db,
			"msg_fixture_001",
			assistantData({ time: { created: 1_000, completed: 9_000 } }),
		);
		db.close();

		const [row] = await opencodeSource.read(handleFor(path));

		expect(row?.timestamp.getTime()).toBe(9_000);
	});

	it("returns only the fields the pipeline needs", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(
			db,
			"msg_fixture_001",
			assistantData({
				path: { cwd: "/SENTINEL-CWD", root: "/SENTINEL-ROOT" },
				structured: { note: "SENTINEL-STRUCTURED" },
				error: { name: "APIError", data: { message: "SENTINEL-ERROR" } },
				summary: true,
			}),
		);
		db.close();

		const rows = await opencodeSource.read(handleFor(path));

		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
			"messageId",
			"model",
			"provider",
			"sessionId",
			"source",
			"timestamp",
			"tokens",
		]);
		expect(JSON.stringify(rows)).not.toContain("SENTINEL");
	});

	it("keeps completed responses that carry an error but did consume tokens", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(
			db,
			"msg_fixture_001",
			assistantData({ error: { name: "APIError", data: { message: "x" } } }),
		);
		db.close();

		const rows = await opencodeSource.read(handleFor(path));

		expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
	});

	describe("skips rows that are not usable responses, without throwing", () => {
		const cases: Array<[string, unknown]> = [
			[
				"a user message",
				{
					role: "user",
					time: { created: CREATED },
					agent: "build",
					model: { providerID: "anthropic", modelID: "fixture-model-a" },
				},
			],
			[
				"an incomplete assistant message (no time.completed)",
				assistantData({ time: { created: CREATED } }),
			],
			[
				"an assistant message with a non-numeric time.completed",
				assistantData({ time: { created: CREATED, completed: "soon" } }),
			],
			[
				"an assistant message whose time.completed is past the range of a Date",
				assistantData({ time: { created: CREATED, completed: 1e16 } }),
			],
			[
				"an assistant message with no tokens object",
				(() => {
					const { tokens: _tokens, ...rest } = assistantData();
					return rest;
				})(),
			],
			[
				"an assistant message with an empty tokens object",
				assistantData({ tokens: {} }),
			],
			[
				"an assistant message with all-zero tokens",
				assistantData({
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
				}),
			],
			[
				"an assistant message with no providerID",
				(() => {
					const { providerID: _p, ...rest } = assistantData();
					return rest;
				})(),
			],
			[
				"an assistant message with no modelID",
				(() => {
					const { modelID: _m, ...rest } = assistantData();
					return rest;
				})(),
			],
			[
				"an assistant message with a non-string modelID",
				assistantData({ modelID: 42 }),
			],
			["malformed JSON", '{"role":"assistant","time":{"completed":'],
			["an empty data string", ""],
			["a JSON array", "[]"],
			["a JSON null", "null"],
			["a bare JSON string", '"assistant"'],
		];

		it.each(cases)("%s", async (_name, data) => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_bad", data);
			insertMessage(db, "msg_fixture_good", assistantData());
			db.close();

			const rows = await opencodeSource.read(handleFor(path));

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_good"]);
		});
	});

	describe("counts missing or unusable token buckets as 0", () => {
		it("fills absent buckets", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(
				db,
				"msg_fixture_a",
				assistantData({ tokens: { input: 7 } }),
			);
			insertMessage(
				db,
				"msg_fixture_b",
				assistantData({ tokens: { input: 1, output: 2, cache: { read: 3 } } }),
			);
			db.close();

			const rows = await opencodeSource.read(handleFor(path));

			expect(rows.map((r) => [r.messageId, r.tokens])).toEqual([
				[
					"msg_fixture_a",
					{ input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
				],
				[
					"msg_fixture_b",
					{ input: 1, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 0 },
				],
			]);
		});

		it("zeroes buckets that are strings, nulls or negative", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(
				db,
				"msg_fixture_a",
				assistantData({
					tokens: {
						input: "12",
						output: null,
						reasoning: 4,
						cache: { read: -5, write: 6 },
					},
				}),
			);
			db.close();

			const [row] = await opencodeSource.read(handleFor(path));

			expect(row?.tokens).toEqual({
				input: 0,
				output: 0,
				reasoning: 4,
				cacheRead: 0,
				cacheWrite: 6,
			});
		});

		it("does not throw on integers outside the safe JavaScript range", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(
				db,
				"msg_fixture_huge",
				'{"role":"assistant","time":{"created":1,"completed":2},"modelID":"fixture-model-a","providerID":"anthropic","tokens":{"input":9223372036854775807,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}',
			);
			insertMessage(db, "msg_fixture_good", assistantData());
			db.close();

			const rows = await opencodeSource.read(handleFor(path));

			expect(rows.map((r) => r.messageId).sort()).toEqual([
				"msg_fixture_good",
				"msg_fixture_huge",
			]);
			const huge = rows.find((r) => r.messageId === "msg_fixture_huge");
			expect(Number.isFinite(huge?.tokens.input)).toBe(true);
			expect(huge?.tokens.output).toBe(1);
		});
	});

	it("orders rows by completion time, then message id, regardless of insert order", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		const at = (completed: number) =>
			assistantData({ time: { created: 1, completed } });
		insertMessage(db, "msg_fixture_b", at(2_000));
		insertMessage(db, "msg_fixture_c", at(1_000), "ses_fixture_b");
		insertMessage(db, "msg_fixture_a", at(2_000));
		db.close();

		const rows = await opencodeSource.read(handleFor(path));

		expect(rows.map((r) => r.messageId)).toEqual([
			"msg_fixture_c",
			"msg_fixture_a",
			"msg_fixture_b",
		]);
		expect(rows.map((r) => r.sessionId)).toEqual([
			"ses_fixture_b",
			"ses_fixture_a",
			"ses_fixture_a",
		]);
	});

	it("is repeatable: two reads return identical rows with unique message ids", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(db, "msg_fixture_a", assistantData());
		insertMessage(db, "msg_fixture_b", assistantData());
		db.close();

		const first = await opencodeSource.read(handleFor(path));
		const second = await opencodeSource.read(handleFor(path));

		expect(first).toHaveLength(2);
		expect(second).toEqual(first);
		expect(new Set(first.map((r) => r.messageId)).size).toBe(first.length);
	});

	it("returns no rows for a database with an empty message table", async () => {
		const dir = await sandbox();
		const path = join(dir, "opencode.db");
		const db = createDb(path);
		insertMessage(db, "msg_fixture_a", assistantData());
		db.exec("DELETE FROM message");
		db.close();

		expect(await opencodeSource.read(handleFor(path))).toEqual([]);
	});

	it("fails clearly, without creating a file, when the database is missing", async () => {
		const dir = await sandbox();
		const path = join(dir, "missing.db");

		await expect(opencodeSource.read(handleFor(path))).rejects.toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it("fails clearly when the database has no message table", async () => {
		const dir = await sandbox();
		const path = join(dir, "other.db");
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE unrelated (id integer)");
		db.close();

		await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
			/message/,
		);
	});

	describe("WAL and read-only safety", () => {
		it("sees un-checkpointed rows from a live writer and leaves every file byte-identical", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const walPath = `${path}-wal`;

			// Live writer: WAL mode, auto-checkpoint disabled, connection stays open.
			const writer = createDb(path);
			writer.exec("PRAGMA wal_autocheckpoint = 0");
			insertMessage(writer, "msg_fixture_a", assistantData());
			insertMessage(writer, "msg_fixture_b", assistantData());

			// Rows exist only in the WAL: nothing has been checkpointed into the main file.
			expect(statSync(walPath).size).toBeGreaterThan(0);

			const dbBefore = sha256(path);
			const walBefore = sha256(walPath);
			const walSizeBefore = statSync(walPath).size;
			const dbMtimeBefore = statSync(path).mtimeMs;

			const rows = await opencodeSource.read(handleFor(path));

			// WAL-aware: a reader that only looked at the main file would see nothing.
			expect(rows.map((r) => r.messageId)).toEqual([
				"msg_fixture_a",
				"msg_fixture_b",
			]);

			// Read-only: no write, no checkpoint, no truncation.
			expect(sha256(path)).toBe(dbBefore);
			expect(sha256(walPath)).toBe(walBefore);
			expect(statSync(walPath).size).toBe(walSizeBefore);
			expect(statSync(path).mtimeMs).toBe(dbMtimeBefore);

			// The reader did not block the writer, and the next read sees the new row.
			insertMessage(writer, "msg_fixture_c", assistantData());
			const again = await opencodeSource.read(handleFor(path));
			expect(again.map((r) => r.messageId)).toEqual([
				"msg_fixture_a",
				"msg_fixture_b",
				"msg_fixture_c",
			]);
		});

		it("reads committed rows from an orphaned WAL without checkpointing it", async () => {
			const dir = await sandbox();
			const liveDir = join(dir, "live");
			const orphanDir = join(dir, "orphan");
			await mkdir(liveDir);
			await mkdir(orphanDir);
			const writer = createDb(join(liveDir, "opencode.db"));
			writer.exec("PRAGMA wal_autocheckpoint = 0");
			insertMessage(writer, "msg_fixture_a", assistantData());
			insertMessage(writer, "msg_fixture_b", assistantData());

			// Snapshot what an app killed mid-run leaves behind: committed frames in the WAL,
			// no live connection, no shared-memory file. A read-write open would checkpoint
			// this into the main file on close; a read-only open must not.
			const path = join(orphanDir, "opencode.db");
			const walPath = `${path}-wal`;
			copyFileSync(join(liveDir, "opencode.db"), path);
			copyFileSync(join(liveDir, "opencode.db-wal"), walPath);
			const dbBefore = sha256(path);
			const walBefore = sha256(walPath);

			const rows = await opencodeSource.read(handleFor(path));

			expect(rows.map((r) => r.messageId)).toEqual([
				"msg_fixture_a",
				"msg_fixture_b",
			]);
			expect(sha256(path)).toBe(dbBefore);
			expect(existsSync(walPath)).toBe(true);
			expect(sha256(walPath)).toBe(walBefore);
		});

		it("leaves a cleanly closed database file byte-identical", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_a", assistantData());
			db.close();
			const before = sha256(path);

			const rows = await opencodeSource.read(handleFor(path));

			expect(rows).toHaveLength(1);
			expect(sha256(path)).toBe(before);
		});
	});

	describe("node:sqlite ExperimentalWarning", () => {
		it("does not leak the warning from a fresh process", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_a", assistantData());
			db.close();

			const script = `
				const seen = [];
				process.on("warning", (w) => seen.push(w.name + ": " + w.message));
				const { opencodeSource } = await import(${JSON.stringify(
					new URL("./opencode.js", import.meta.url).href,
				)});
				const rows = await opencodeSource.read({ source: "opencode", path: ${JSON.stringify(path)} });
				await new Promise((resolve) => setImmediate(resolve));
				process.stdout.write(JSON.stringify({ rows: rows.length, seen }));
			`;
			const result = spawnSync(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", script],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);

			expect(result.stderr).not.toMatch(/ExperimentalWarning/);
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ rows: 1, seen: [] });
		}, 30_000);
	});
});

describe("compareRows", () => {
	const row = (completed: number, messageId: string): NormalizedUsageRow => ({
		source: "opencode",
		provider: "anthropic",
		model: "fixture-model-a",
		timestamp: new Date(completed),
		sessionId: "ses_fixture_a",
		messageId,
		tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
	});

	it("orders by completion time before message id", () => {
		expect(compareRows(row(1, "z"), row(2, "a"))).toBeLessThan(0);
		expect(compareRows(row(2, "a"), row(1, "z"))).toBeGreaterThan(0);
	});

	it("breaks a time tie by message id, comparing code units rather than locale order", () => {
		expect(compareRows(row(1, "a"), row(1, "b"))).toBe(-1);
		expect(compareRows(row(1, "b"), row(1, "a"))).toBe(1);
		// Code-unit order puts "B" before "a"; a locale-aware compare would not.
		expect(compareRows(row(1, "B"), row(1, "a"))).toBe(-1);
	});

	it("compares identical keys as equal, so it is a total order", () => {
		expect(compareRows(row(1, "a"), row(1, "a"))).toBe(0);
	});
});
