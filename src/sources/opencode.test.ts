import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	compareRows,
	handleDiscoverError,
	opencodeSource,
} from "./opencode.js";
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

// Discovery order across multiple files is not part of the contract (it can depend on the
// filesystem's directory-entry order), so multi-handle assertions below sort both sides by
// path before comparing.
function sortByPath<T extends { path: string }>(handles: T[]): T[] {
	return [...handles].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("opencodeSource.discover", () => {
	async function isolatedHome(): Promise<string> {
		const home = await sandbox();
		// Point every home lookup at the sandbox so a bug can never reach the real home. This
		// includes OPENCODE_DB: once discover() honors it, an ambient value on the developer's
		// or CI's own machine would otherwise leak into every scan test here and point discover()
		// at a real opencode database (the same leak sandboxEnv() below already guards against
		// explicitly). Tests that exercise the override stub OPENCODE_DB again afterward.
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("OPENCODE_DB", undefined);
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

	// Skipped on Windows: creating a symlink there needs the SeCreateSymbolicLinkPrivilege,
	// which a non-elevated account only has with Developer Mode on; without it `symlink()`
	// rejects with EPERM instead of producing the ELOOP this test needs, so it would fail
	// rather than skip (nodejs/node issue #47783 tracks the same privilege requirement). Not
	// load-bearing for coverage there either: handleDiscoverError's own tests below cover the
	// ELOOP decision directly, and skipping every filesystem test in this describe block still
	// leaves the suite at 100%. CI is ubuntu-latest only, so this guard only matters on a
	// developer's Windows machine.
	it.skipIf(process.platform === "win32")(
		"returns no handles when the data directory is unreadable because of a symlink loop (ELOOP)",
		async () => {
			const home = await isolatedHome();
			await mkdir(join(home, "xdg"), { recursive: true });
			// A symlink pointing at itself makes stat fail with ELOOP while resolving the path,
			// the same as a permissions problem: there is no readable opencode data here.
			await symlink("opencode", join(home, "xdg", "opencode"));
			vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

			await expect(opencodeSource.discover()).resolves.toEqual([]);
		},
	);

	// A chmod-based EACCES filesystem test was tried here and removed: it skips as root (so it
	// can never fail in a root CI container, exactly where a regression would matter) and skips
	// on Windows, and forcing both skips still left the suite at 100% - the ELOOP test above
	// already exercises the same ignorable arm end to end, and handleDiscoverError's own tests
	// below cover the EACCES decision directly, without depending on the OS or which user runs
	// the suite.

	// Proves discover()'s catch is actually wired to handleDiscoverError, not just that the
	// pure function decides correctly in isolation: the `stat` seam is injected (see
	// `DiscoverOptions`) so this reaches the real path end to end with no vendor mock (no
	// `vi.mock` on node:fs/promises), no chmod, and no platform dependence. Decision record:
	// bead myusage-pqm.
	it("propagates a genuinely unexpected stat error through the real discover() path (injected stat, EIO)", async () => {
		// Sandboxed like every other test here even though the injected stat should make the
		// real filesystem irrelevant: if a future regression stops discover() from honoring the
		// injected dependency, the fallback must land on a throwaway path, never the real home
		// or opencode database.
		const home = await isolatedHome();
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		const error = Object.assign(new Error("EIO"), {
			code: "EIO",
		}) as NodeJS.ErrnoException;
		const injectedStat = vi.fn().mockRejectedValue(error);

		await expect(
			opencodeSource.discover({ stat: injectedStat }),
		).rejects.toThrow(error);
	});

	describe("multiple database files", () => {
		it("discovers a channel-suffixed database when no default opencode.db is present", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			const channelPath = join(opencodeDir, "opencode-beta-canary.db");
			await writeFile(channelPath, "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);

			expect(await opencodeSource.discover()).toEqual([
				{ source: "opencode", path: channelPath },
			]);
		});

		// This is also the bead's "alongside the default one" acceptance criterion: the fixture
		// here is a superset of that narrower case (same two files, plus sidecars and decoys that
		// must NOT be discovered), and the expectation is identical, so a separate test asserting
		// only the narrower fixture would fail exactly when this one does and pass whenever this
		// one does. No implementation can tell them apart, so they are not both kept.
		it("discovers the default and channel databases as two handles, ignoring WAL/SHM sidecars and lookalike files", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			const defaultPath = join(opencodeDir, "opencode.db");
			const channelPath = join(opencodeDir, "opencode-nightly.db");
			await writeFile(defaultPath, "");
			// SQLite's own sidecars for the default database - never separate handles.
			await writeFile(`${defaultPath}-wal`, "");
			await writeFile(`${defaultPath}-shm`, "");
			await writeFile(channelPath, "");
			// Decoys, each missing the match on exactly one axis. opencode.db.backup and
			// opencode.sqlite have the right prefix but the wrong extension (".db.backup" and
			// ".sqlite" are not ".db"); myopencode.db has the right extension but the wrong
			// prefix (it doesn't start with "opencode"). None is a name discover() should match.
			await writeFile(join(opencodeDir, "opencode.db.backup"), "");
			await writeFile(join(opencodeDir, "opencode.sqlite"), "");
			await writeFile(join(opencodeDir, "myopencode.db"), "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);

			expect(sortByPath(await opencodeSource.discover())).toEqual(
				sortByPath([
					{ source: "opencode", path: defaultPath },
					{ source: "opencode", path: channelPath },
				]),
			);
		});
	});

	// Upstream semantics (public repo, released tag v1.18.31, commit 014614d35b39,
	// packages/core/src/database/database.ts, function `path()`):
	//
	//   export function path() {
	//     if (Flag.OPENCODE_DB) {
	//       if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
	//       return join(Global.Path.data, Flag.OPENCODE_DB)
	//     }
	//     ...channel-based default...
	//   }
	//
	// `Flag.OPENCODE_DB` is a direct, unprocessed `process.env["OPENCODE_DB"]` read
	// (packages/core/src/flag/flag.ts) and `Global.Path.data` is opencode's own data directory -
	// the same directory this reader already calls the "data directory" (XDG_DATA_HOME, or
	// ~/.local/share, plus "opencode"). So: ":memory:" or an absolute path is used as-is; any
	// other value is resolved against that data directory, never the process's cwd. The check is
	// an early return upstream, so a set OPENCODE_DB replaces the channel-file scan entirely
	// rather than adding to it. (":memory:" itself is out of scope for this bead - no behavioral
	// test here needs it.)
	describe("OPENCODE_DB override", () => {
		it("uses an absolute OPENCODE_DB path as-is, instead of scanning the data directory", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			// Present in the data directory and would normally be discovered - proves the
			// override replaces the scan instead of adding to it.
			await writeFile(join(opencodeDir, "opencode.db"), "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);

			const elsewhere = await sandbox();
			const overridePath = join(elsewhere, "override.db");
			await writeFile(overridePath, "");
			vi.stubEnv("OPENCODE_DB", overridePath);

			expect(await opencodeSource.discover()).toEqual([
				{ source: "opencode", path: overridePath },
			]);
		});

		it("resolves a relative OPENCODE_DB path against the data directory, not the process cwd", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			const relativePath = "custom-channel.db";
			const resolvedPath = join(opencodeDir, relativePath);
			await writeFile(resolvedPath, "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);
			vi.stubEnv("OPENCODE_DB", relativePath);

			expect(await opencodeSource.discover()).toEqual([
				{ source: "opencode", path: resolvedPath },
			]);
		});
	});
});

describe("handleDiscoverError", () => {
	// Plain error objects, not a real stat() failure: the ignore-or-surface decision is pure
	// logic (an errno in, a return-or-throw out) and must be provable without depending on
	// which errno the OS or the calling user's permissions actually produce. discover()'s catch
	// delegates the whole decision to this function (`return handleDiscoverError(error)`), so
	// these are the only tests the decision needs — no filesystem test has to reach the
	// "unexpected" arm.
	function errnoError(code: string): NodeJS.ErrnoException {
		const error = new Error(code) as NodeJS.ErrnoException;
		error.code = code;
		return error;
	}

	it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"])(
		"treats %s as ignorable: no readable opencode data at this path",
		(code) => {
			expect(handleDiscoverError(errnoError(code))).toEqual([]);
		},
	);

	it("treats EIO as unexpected, so discover() still surfaces it", () => {
		const error = errnoError("EIO");
		expect(() => handleDiscoverError(error)).toThrow(error);
	});

	// No .code at all (a bare Error, or a throw that never went through Node's fs/promises
	// layer) must land on the same side as EIO, not be swallowed just because the lookup found
	// nothing to match.
	it("treats an error with no .code as unexpected, so discover() still surfaces it", () => {
		const error = new Error("boom") as NodeJS.ErrnoException;
		expect(() => handleDiscoverError(error)).toThrow(error);
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

		// SQLite's own "no such table: message" would also match /message/, so assert the
		// reader's own error.
		await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
			/Unsupported opencode database/,
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
		const SQLITE_WARNING =
			"SQLite is an experimental feature and might change at any time";

		// Point every path that opencode or the OS could resolve at throwaway fixtures, so
		// nothing here can reach the real home or the real database. opencode itself lets
		// OPENCODE_DB override the database path (anomalyco/opencode v1.18.31,
		// packages/core/src/database/database.ts), so an ambient value must not leak in either.
		function sandboxEnv(dir: string, dbPath: string): Record<string, string> {
			return {
				HOME: dir,
				USERPROFILE: dir,
				XDG_DATA_HOME: dir,
				XDG_CACHE_HOME: dir,
				OPENCODE_DB: dbPath,
			};
		}

		// A reader over a one-message database, in a fresh module instance so its lazy
		// node:sqlite import happens inside the test instead of being cached by an earlier one.
		async function freshReader() {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			for (const [name, value] of Object.entries(sandboxEnv(dir, path))) {
				vi.stubEnv(name, value);
			}
			const db = createDb(path);
			insertMessage(db, "msg_fixture_a", assistantData());
			db.close();
			vi.resetModules();
			const { opencodeSource: fresh } = await import("./opencode.js");
			return { fresh, handle: handleFor(path) };
		}

		// Stands a recorder in for process.emitWarning so nothing a test raises reaches the real
		// process; restore() always puts the real one back.
		function recordWarnings() {
			const real = process.emitWarning;
			const seen: unknown[][] = [];
			const recorder = ((...args: unknown[]) => {
				seen.push(args);
			}) as unknown as typeof process.emitWarning;
			process.emitWarning = recorder;
			return {
				recorder,
				seen,
				restore: () => {
					process.emitWarning = real;
				},
			};
		}

		// Node 24.15+ and 25.7+ never emit the warning, so this test raises it itself, inside the
		// window in which the reader is loading node:sqlite.
		it("drops the SQLite warning while it loads node:sqlite, forwards the rest and restores emitWarning", async () => {
			const { fresh, handle } = await freshReader();
			const { recorder, seen, restore } = recordWarnings();
			let rows: NormalizedUsageRow[];
			let restored: typeof process.emitWarning;
			try {
				const pending = fresh.read(handle);
				// Give the reader a bounded number of ticks to swap its suppressor in, so the test does
				// not depend on how many it takes. Nothing yields between this check and the two
				// emissions below, so the load is still in flight when they fire.
				for (
					let tick = 0;
					tick < 100 && process.emitWarning === recorder;
					tick++
				) {
					await Promise.resolve();
				}
				expect(
					process.emitWarning,
					"read() never installed the SQLite warning suppressor",
				).not.toBe(recorder);
				process.emitWarning(SQLITE_WARNING, "ExperimentalWarning");
				process.emitWarning("unrelated", "DeprecationWarning", "DEP0001");
				rows = await pending;
				restored = process.emitWarning;
			} finally {
				restore();
			}

			expect(rows).toHaveLength(1);
			expect(seen).toEqual([["unrelated", "DeprecationWarning", "DEP0001"]]);
			expect(restored).toBe(recorder);
		});

		// The reader imports node:sqlite once and shares the result. Without that, two overlapping
		// reads would each patch emitWarning over the other's patch and restore in the wrong order,
		// leaving the process with a wrapper nobody owns.
		it("leaves emitWarning as it found it when two reads overlap", async () => {
			const { fresh, handle } = await freshReader();
			const { recorder, restore } = recordWarnings();
			let results: NormalizedUsageRow[][];
			let restored: typeof process.emitWarning;
			try {
				results = await Promise.all([fresh.read(handle), fresh.read(handle)]);
				restored = process.emitWarning;
			} finally {
				restore();
			}

			expect(results.map((rows) => rows.length)).toEqual([1, 1]);
			expect(restored).toBe(recorder);
		});

		// Node removed this warning in v24.15.0 and v25.7.0 (nodejs/node, lib/sqlite.js);
		// v22.x still emits it. Ask the runtime instead of hard-coding a version, so this check
		// runs exactly where the import really emits the warning and is skipped, with a reason,
		// everywhere else instead of passing vacuously. The in-process test above and
		// sqlite-warning.test.ts hold the contract on every runtime; this proves the real import
		// stays quiet in a fresh process.
		function runtimeWarnsOnSqliteImport(env: NodeJS.ProcessEnv): boolean {
			const probe = spawnSync(
				process.execPath,
				["--input-type=module", "-e", 'await import("node:sqlite")'],
				{ encoding: "utf8", env },
			);
			expect(probe.status).toBe(0);
			return /ExperimentalWarning/.test(probe.stderr);
		}

		it("does not leak the warning from a fresh process", async (ctx) => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			// NODE_OPTIONS=--no-warnings or NODE_NO_WARNINGS=1 in the ambient environment would
			// hide the warning from the probe and skip this check. Undefined values are not
			// passed to the child.
			const env = {
				...process.env,
				...sandboxEnv(dir, path),
				NODE_OPTIONS: undefined,
				NODE_NO_WARNINGS: undefined,
			};
			if (!runtimeWarnsOnSqliteImport(env)) {
				ctx.skip(
					"this Node version does not emit the node:sqlite ExperimentalWarning, so there is nothing to suppress",
				);
			}
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
				{ cwd: REPO_ROOT, encoding: "utf8", env },
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
