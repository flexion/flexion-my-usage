import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	readFileSync,
	statSync,
} from "node:fs";
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
  CREATE TABLE \`session_message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
  );
  CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`, \`time_created\`, \`id\`);
`;

// V1-only shape (no session_message table at all) - the database predates opencode's V2
// migration (see myusage-4xu.12's finding). createDb() above always creates session_message
// (empty), which covers the "table exists but is empty" half of acceptance criterion 3; this
// DDL covers the "table doesn't exist" half.
const V1_ONLY_DDL = `
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

// opencode's V2 (2.0-preview) assistant-message shape, per the bead's own fixture (myusage-f87):
// model is a nested { id, providerID } object (not the V1 columns' flat modelID/providerID), and
// there is no "role" field - "type" is a column on session_message itself (see the DDL above),
// not part of the JSON payload.
function v2AssistantData(overrides: Record<string, unknown> = {}) {
	return {
		agent: "build",
		model: { id: "m", providerID: "p" },
		content: [],
		finish: "stop",
		cost: 0,
		tokens: {
			input: 10,
			output: 5,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
		time: { created: 1, completed: 2 },
		...overrides,
	};
}

function insertSessionMessage(
	db: DatabaseSync,
	id: string,
	type: string,
	data: unknown,
	sessionId = "ses_fixture_a",
): void {
	db.prepare(
		"INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_fixture', 'slug', '/work/fixture', 'title', '1.0.0', ?, ?)",
	).run(sessionId, CREATED, CREATED);
	db.prepare(
		"INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		id,
		sessionId,
		type,
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

	// discover()'s scan-arm catch delegates to handleDiscoverError, same as the override arm
	// above - but unlike the override arm, nothing here proved that wiring end to end before
	// this test: the only test reaching this catch (the ELOOP test below) only proves the
	// *ignorable* outcome, which looks identical under a mutation that swallows every error
	// unconditionally. `readdir` is injected the same way `stat` is (see `DiscoverOptions`),
	// so this reaches the real scan-arm catch with no vendor mock and no platform dependence.
	it("propagates a genuinely unexpected readdir error through the real discover() path (injected readdir, EIO)", async () => {
		const home = await isolatedHome();
		vi.stubEnv("XDG_DATA_HOME", join(home, "xdg"));

		const error = Object.assign(new Error("EIO"), {
			code: "EIO",
		}) as NodeJS.ErrnoException;
		const injectedReaddir = vi.fn().mockRejectedValue(error);

		await expect(
			opencodeSource.discover({ readdir: injectedReaddir }),
		).rejects.toThrow(error);
	});

	// Skipped on Windows: creating a symlink there needs the SeCreateSymbolicLinkPrivilege,
	// which a non-elevated account only has with Developer Mode on; without it `symlink()`
	// rejects with EPERM instead of producing the ELOOP this test needs, so it would fail
	// rather than skip (nodejs/node issue #47783 tracks the same privilege requirement). Not
	// load-bearing for coverage on its own: handleDiscoverError's own tests below cover the
	// ELOOP decision directly. That is NOT true of the three "symlinked databases" tests just
	// below, though - those skipIf(win32) tests are load-bearing for coverage: force-skipping
	// them (as a real Windows run would) drops src/sources/opencode.ts to roughly 95%
	// statements/branches/lines and fails the yarn test coverage gate. CI itself is unaffected
	// (ubuntu-latest only), so this only bites a developer running the suite on Windows.
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

	// Same care about Windows as the ELOOP test above: creating a symlink needs
	// SeCreateSymbolicLinkPrivilege there.
	describe("symlinked databases", () => {
		it.skipIf(process.platform === "win32")(
			"discovers a database reached only through a symlink",
			async () => {
				const home = await isolatedHome();
				const dataDir = join(home, "xdg");
				const opencodeDir = join(dataDir, "opencode");
				await mkdir(opencodeDir, { recursive: true });
				const elsewhere = await sandbox();
				const realDbPath = join(elsewhere, "real.db");
				await writeFile(realDbPath, "");
				const symlinkPath = join(opencodeDir, "opencode.db");
				await symlink(realDbPath, symlinkPath);
				vi.stubEnv("XDG_DATA_HOME", dataDir);

				expect(await opencodeSource.discover()).toEqual([
					{ source: "opencode", path: symlinkPath },
				]);
			},
		);

		it.skipIf(process.platform === "win32")(
			"excludes a symlink whose target does not exist, without failing the whole scan",
			async () => {
				const home = await isolatedHome();
				const dataDir = join(home, "xdg");
				const opencodeDir = join(dataDir, "opencode");
				await mkdir(opencodeDir, { recursive: true });
				const realPath = join(opencodeDir, "opencode.db");
				await writeFile(realPath, "");
				const brokenSymlinkPath = join(opencodeDir, "opencode-broken.db");
				await symlink(join(opencodeDir, "does-not-exist"), brokenSymlinkPath);
				vi.stubEnv("XDG_DATA_HOME", dataDir);

				expect(await opencodeSource.discover()).toEqual([
					{ source: "opencode", path: realPath },
				]);
			},
		);

		it.skipIf(process.platform === "win32")(
			"excludes a symlink that resolves to a directory, not a file",
			async () => {
				const home = await isolatedHome();
				const dataDir = join(home, "xdg");
				const opencodeDir = join(dataDir, "opencode");
				await mkdir(opencodeDir, { recursive: true });
				const realPath = join(opencodeDir, "opencode.db");
				await writeFile(realPath, "");
				const targetDir = await sandbox();
				const dirSymlinkPath = join(opencodeDir, "opencode-dir.db");
				await symlink(targetDir, dirSymlinkPath);
				vi.stubEnv("XDG_DATA_HOME", dataDir);

				expect(await opencodeSource.discover()).toEqual([
					{ source: "opencode", path: realPath },
				]);
			},
		);
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
			// prefix (it doesn't start with "opencode"); opencodeX.db has both right, but is
			// missing the "-" separator a channel suffix requires. None is a name discover()
			// should match.
			await writeFile(join(opencodeDir, "opencode.db.backup"), "");
			await writeFile(join(opencodeDir, "opencode.sqlite"), "");
			await writeFile(join(opencodeDir, "myopencode.db"), "");
			await writeFile(join(opencodeDir, "opencodeX.db"), "");
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
	//
	// Upstream's guard is `if (Flag.OPENCODE_DB)`, not an undefined check, so an empty string is
	// falsy and falls through to the channel-based default exactly like an unset variable -
	// mirrored below the same way the sibling XDG_DATA_HOME variable already is (see "treats an
	// empty XDG_DATA_HOME as unset" above).
	//
	// Decision recorded here rather than left for the coverage gate to pick: upstream's path()
	// returns the override string unconditionally, with no existence check, and a bad value only
	// surfaces later as a read() failure. This reader keeps the existence check - a handle
	// names a real, readable file, the same contract every other discover() result holds - but
	// unlike the scan arm, a bad OPENCODE_DB does not fail silently. Decision myusage-chj
	// (option C, Brice, live, 2026-09-20): the scan arm's "nothing here" and an explicitly
	// configured, wrong OPENCODE_DB are different situations - the user never said where to
	// look in the scan case, but did here - so a missing path or a directory throws a named,
	// actionable error ("OPENCODE_DB is set to <path> but that file does not exist" / "...but
	// that path is a directory") instead of reproducing the exact silent-empty-chart bug this
	// reader exists to fix, just one level down.
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

		it("treats an empty OPENCODE_DB as unset", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			const dbPath = join(opencodeDir, "opencode.db");
			await writeFile(dbPath, "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);
			vi.stubEnv("OPENCODE_DB", "");

			expect(await opencodeSource.discover()).toEqual([
				{ source: "opencode", path: dbPath },
			]);
		});

		it("throws a named error when OPENCODE_DB points at a path that does not exist", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			// Present in the data directory and would normally be discovered - proves a missing
			// override throws instead of silently falling back to the scan.
			await writeFile(join(opencodeDir, "opencode.db"), "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);

			const elsewhere = await sandbox();
			const missingPath = join(elsewhere, "missing.db");
			vi.stubEnv("OPENCODE_DB", missingPath);

			await expect(opencodeSource.discover()).rejects.toThrow(
				`OPENCODE_DB is set to ${missingPath} but that file does not exist`,
			);
		});

		it("throws a named error when OPENCODE_DB points at a directory", async () => {
			const home = await isolatedHome();
			const dataDir = join(home, "xdg");
			const opencodeDir = join(dataDir, "opencode");
			await mkdir(opencodeDir, { recursive: true });
			await writeFile(join(opencodeDir, "opencode.db"), "");
			vi.stubEnv("XDG_DATA_HOME", dataDir);

			const elsewhere = await sandbox();
			const overrideDir = join(elsewhere, "override.db");
			await mkdir(overrideDir, { recursive: true });
			vi.stubEnv("OPENCODE_DB", overrideDir);

			await expect(opencodeSource.discover()).rejects.toThrow(
				`OPENCODE_DB is set to ${overrideDir} but that path is a directory`,
			);
		});

		// Proves discover()'s catch actually reaches the named-error path below, not just that
		// some pure function decides correctly in isolation: the `stat` seam is injected (see
		// `DiscoverOptions`) so this reaches the real path end to end with no vendor mock (no
		// `vi.mock` on node:fs/promises), no chmod, and no platform dependence. Anchored on the
		// override arm rather than the scan: the override's own existence check (see the two
		// "returns no handles" tests above) calls `stat` unconditionally, every time, so
		// injecting a failure there is guaranteed to land on it regardless of what's on disk.
		// (The scan arm calls the same seam too, but only for symlink-named candidates - see
		// "symlinked databases" above - so it is not the simplest place to prove this.)
		//
		// The user named this exact path, so every stat() failure other than ENOENT - not just
		// EIO, but also codes like EACCES and ENOTDIR that the scan arm below treats as merely
		// ignorable (see IGNORABLE_DISCOVER_CODES) - must become this same named, actionable
		// error instead of silently returning [] via handleDiscoverError: an explicitly
		// configured OPENCODE_DB that cannot be read is never "opencode just isn't installed".
		// Decision record: bead myusage-pqm (EIO surfaces), extended by myusage-4xu.35 (every
		// other non-ENOENT code is treated the same way, not just EIO).
		it.each(["EIO", "EACCES", "ENOTDIR"])(
			"throws a named error identifying OPENCODE_DB and the resolved path when stat fails with %s",
			async (code) => {
				// Sandboxed like every other test here even though the injected stat should make
				// the real filesystem irrelevant: if a future regression stops discover() from
				// honoring the injected dependency, the fallback must land on a throwaway path,
				// never the real home or opencode database.
				await isolatedHome();
				const elsewhere = await sandbox();
				const overridePath = join(elsewhere, "override.db");
				vi.stubEnv("OPENCODE_DB", overridePath);

				const error = Object.assign(new Error(code), {
					code,
				}) as NodeJS.ErrnoException;
				const injectedStat = vi.fn().mockRejectedValue(error);

				await expect(
					opencodeSource.discover({ stat: injectedStat }),
				).rejects.toThrow(
					`OPENCODE_DB is set to ${overridePath} but it could not be read: ${code}`,
				);
			},
		);

		// Same shape as the WAL-readonly-directory .cause assertion in the read() describe block
		// below: the original stat() failure must be chained, not dropped, so whatever actually
		// broke (permissions, a stale mount, ...) stays inspectable from the rewritten error.
		it("chains the original stat() failure as .cause when OPENCODE_DB cannot be read", async () => {
			await isolatedHome();
			const elsewhere = await sandbox();
			const overridePath = join(elsewhere, "override.db");
			vi.stubEnv("OPENCODE_DB", overridePath);

			const error = Object.assign(new Error("EIO"), {
				code: "EIO",
			}) as NodeJS.ErrnoException;
			const injectedStat = vi.fn().mockRejectedValue(error);

			let caught: unknown;
			try {
				await opencodeSource.discover({ stat: injectedStat });
			} catch (thrown) {
				caught = thrown;
			}

			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).cause).toBe(error);
		});

		// The it.each fixtures above build their error as `Object.assign(new Error(code), {
		// code })`, so `.message` is literally the bare code - every one of those cases would
		// pass just as well under the old "code ?? message" fallback. A real errno's message is
		// normally a strict superset of its code (confirmed directly against Node's own
		// fs.promises.stat() rejections, e.g. "ENOTDIR: not a directory, stat '/x'"), so this
		// fixture shapes .message the same way: different from .code, to prove the full message
		// is used rather than the bare code alone.
		it("uses the errno's real message, not just its bare code, when OPENCODE_DB cannot be read", async () => {
			await isolatedHome();
			const elsewhere = await sandbox();
			const overridePath = join(elsewhere, "override.db");
			vi.stubEnv("OPENCODE_DB", overridePath);

			const message = `ENOTDIR: not a directory, stat '${overridePath}'`;
			const error = Object.assign(new Error(message), {
				code: "ENOTDIR",
			}) as NodeJS.ErrnoException;
			const injectedStat = vi.fn().mockRejectedValue(error);

			await expect(
				opencodeSource.discover({ stat: injectedStat }),
			).rejects.toThrow(
				`OPENCODE_DB is set to ${overridePath} but it could not be read: ${message}`,
			);
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

	// opencode's V2 (2.0-preview) schema (myusage-f87, myusage-4xu.12's finding): released
	// builds can write assistant usage to session_message with no corresponding row in message,
	// when a V2 API client or the preview CLI drives the runner (OPENCODE_SIDECAR_V2=1 on
	// desktop). Before this bead's fix, read() silently returned [] for a V2-only database and
	// silently dropped V2 rows from a mixed one - these tests are written against that
	// (unfixed) behavior first; see the bead comment for the failing-first confirmation.
	describe("V2 session_message reporting", () => {
		it("rejects when message is empty but session_message has V2 assistant usage rows", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertSessionMessage(db, "sm_fixture_a", "assistant", v2AssistantData());
			db.close();

			await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
				/session_message/,
			);
			await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(/V2/);
		});

		// myusage-4xu.92: every other fixture in this file uses exactly one V2 row, so a mutation
		// clamping the reported count to 1 (e.g. Math.min(count, 1)) or hardcoding a wrong number
		// in the reject message would survive every test above untouched. Three distinct rows,
		// none of them fixture row #1, pins the count as real rather than assumed.
		it("names the exact V2 usage row count in the reject error, not just 1", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertSessionMessage(db, "sm_fixture_a", "assistant", v2AssistantData());
			insertSessionMessage(db, "sm_fixture_b", "assistant", v2AssistantData());
			insertSessionMessage(db, "sm_fixture_c", "assistant", v2AssistantData());
			db.close();

			await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
				/found 3 assistant usage/,
			);
		});

		// myusage-4xu.100: statement.setReadBigInts(true) on the V2 candidates query is load-
		// bearing - without it, node:sqlite tries to convert this row's out-of-range token value to
		// a JS number and throws a raw "Value is too large to be represented as a JavaScript
		// number" error instead of the deliberate reject below. Mirrors V1's own "does not throw on
		// integers outside the safe JavaScript range" test above, applied to the V2 query. message
		// stays empty on purpose, same as the reject-count tests above: a crash here propagates as
		// a rejection whose message does not match /session_message/ or /V2/ (a raw bigint-
		// conversion error, not this reject), so this test fails loudly rather than passing
		// vacuously if setReadBigInts(true) is ever removed.
		it("rejects with the V2 message, not a raw bigint-conversion error, when a V2 row's token value is outside the safe JavaScript integer range", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertSessionMessage(
				db,
				"sm_fixture_huge",
				"assistant",
				'{"tokens":{"input":9223372036854775807,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}',
			);
			db.close();

			await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
				/session_message/,
			);
			await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(/V2/);
		});

		it("returns the V1 row and reports exactly 1 skipped V2 row for a mixed database", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_001", assistantData());
			insertSessionMessage(db, "sm_fixture_a", "assistant", v2AssistantData());
			db.close();

			const warnings: string[] = [];
			const rows = await opencodeSource.read(handleFor(path), {
				warn: (message) => warnings.push(message),
			});

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/\b1\b/);
			expect(warnings[0]).toMatch(/session_message/);
		});

		// myusage-4xu.92: same reasoning as the reject-error test above, applied to the warning -
		// a count clamped to 1 or a hardcoded wrong number would survive the single-row test above.
		// A distinct count (4, not 1 or 3) also proves this isn't the reject path's count leaking
		// through some shared, miscounted state.
		it("names the exact V2 usage row count in the warning, not just 1", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_001", assistantData());
			insertSessionMessage(db, "sm_fixture_a", "assistant", v2AssistantData());
			insertSessionMessage(db, "sm_fixture_b", "assistant", v2AssistantData());
			insertSessionMessage(db, "sm_fixture_c", "assistant", v2AssistantData());
			insertSessionMessage(db, "sm_fixture_d", "assistant", v2AssistantData());
			db.close();

			const warnings: string[] = [];
			const rows = await opencodeSource.read(handleFor(path), {
				warn: (message) => warnings.push(message),
			});

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/\bskipped 4\b/);
		});

		it("emits no warning for a V1-only database with an empty session_message table", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_001", assistantData());
			db.close();

			const warn = vi.fn();
			const rows = await opencodeSource.read(handleFor(path), { warn });

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
			expect(warn).not.toHaveBeenCalled();
		});

		it("emits no warning for a V1-only database with no session_message table at all", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = new DatabaseSync(path);
			openDbs.push(db);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec(V1_ONLY_DDL);
			insertMessage(db, "msg_fixture_001", assistantData());
			db.close();

			const warn = vi.fn();
			const rows = await opencodeSource.read(handleFor(path), { warn });

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
			expect(warn).not.toHaveBeenCalled();
		});

		it("uses the default warn (a single stderr line) when no warn option is given", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_001", assistantData());
			insertSessionMessage(db, "sm_fixture_a", "assistant", v2AssistantData());
			db.close();

			const writeSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				const rows = await opencodeSource.read(handleFor(path));
				expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
				expect(writeSpy).toHaveBeenCalledTimes(1);
				expect(writeSpy.mock.calls[0]?.[0]).toMatch(/session_message/);
				// myusage-4xu.92: pins the trailing newline that makes this "a single stderr line"
				// (this test's own title), not a bare string with no line terminator - a mutation
				// dropping the "\n" in defaultWarn's template literal survived every assertion above.
				expect(writeSpy.mock.calls[0]?.[0]).toMatch(/\n$/);
			} finally {
				// mockRestore() also clears recorded calls, so assertions above must run first.
				writeSpy.mockRestore();
			}
		});

		describe("does not count session_message rows that are not real V2 assistant usage", () => {
			const cases: Array<[string, string, unknown]> = [
				["a user row", "user", v2AssistantData()],
				["a compaction row", "compaction", v2AssistantData()],
				[
					"an assistant row with no tokens object",
					"assistant",
					(() => {
						const { tokens: _tokens, ...rest } = v2AssistantData();
						return rest;
					})(),
				],
				[
					"an assistant row with malformed JSON data",
					"assistant",
					'{"tokens":',
				],
				// myusage-4xu.93: mirrors toRow's own all-zero-tokens exclusion for V1 rows (see
				// "an assistant message with an empty tokens object" / "...all-zero tokens" above) -
				// an in-flight or aborted V2 assistant row looks exactly like this before it has any
				// real usage to report, and must not trip the reject path any more than V1 does.
				[
					"an assistant row with an empty tokens object",
					"assistant",
					v2AssistantData({ tokens: {} }),
				],
				[
					"an assistant row with all-zero tokens",
					"assistant",
					v2AssistantData({
						tokens: {
							input: 0,
							output: 0,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
					}),
				],
			];

			it.each(cases)("%s", async (_name, type, data) => {
				const dir = await sandbox();
				const path = join(dir, "opencode.db");
				const db = createDb(path);
				// message stays empty on purpose: if the session_message row above were
				// miscounted as V2 usage, read() would reject instead of resolving to [].
				insertSessionMessage(db, "sm_fixture_skip", type, data);
				db.close();

				const warn = vi.fn();
				await expect(
					opencodeSource.read(handleFor(path), { warn }),
				).resolves.toEqual([]);
				expect(warn).not.toHaveBeenCalled();
			});
		});

		// myusage-4xu.99: every V2 fixture used elsewhere in this file shares one shape (input and
		// output both non-zero, reasoning and both cache fields zero), so no assertion anywhere else
		// isolates whether hasZeroUsage's other four sub-field checks, or the V2 query's cache_read/
		// cache_write column aliases, are independently wired - only input is pinned on its own.
		// Each case below is a V2 row with exactly one of the five token sub-fields non-zero and the
		// rest zero; message stays empty on purpose, same as the "does not count..." cases above: a
		// correctly-counted row rejects with "found 1 assistant usage", while a miscounted one (that
		// sub-field's zero-check broken, or - for cache.read/cache.write - the SQL alias renamed so
		// the JSON value never reaches hasZeroUsage at all) resolves to [] instead.
		describe("isolates each hasZeroUsage sub-field and the V2 cache_read/cache_write aliases", () => {
			const allZeroTokens = {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			};
			const cases: Array<[string, Record<string, unknown>]> = [
				["input", { ...allZeroTokens, input: 7 }],
				["output", { ...allZeroTokens, output: 7 }],
				["reasoning", { ...allZeroTokens, reasoning: 7 }],
				["cache.read", { ...allZeroTokens, cache: { read: 7, write: 0 } }],
				["cache.write", { ...allZeroTokens, cache: { read: 0, write: 7 } }],
			];

			it.each(cases)(
				"counts a V2 row with only %s non-zero as real usage",
				async (_field, tokens) => {
					const dir = await sandbox();
					const path = join(dir, "opencode.db");
					const db = createDb(path);
					insertSessionMessage(
						db,
						"sm_fixture_isolated",
						"assistant",
						v2AssistantData({ tokens }),
					);
					db.close();

					await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
						/found 1 assistant usage/,
					);
				},
			);
		});

		// myusage-4xu.93: the reject-path cases above prove empty/all-zero V2 tokens don't count
		// when message is empty; this proves the same exclusion holds on the warn path too - a
		// mixed database where the only V2 assistant rows have no real usage must stay silent,
		// not warn about "usage" that never happened. The V1 row's own retrieval is unaffected.
		it("does not warn when a mixed database's only V2 assistant rows have empty or all-zero tokens", async () => {
			const dir = await sandbox();
			const path = join(dir, "opencode.db");
			const db = createDb(path);
			insertMessage(db, "msg_fixture_001", assistantData());
			insertSessionMessage(
				db,
				"sm_fixture_empty",
				"assistant",
				v2AssistantData({ tokens: {} }),
			);
			insertSessionMessage(
				db,
				"sm_fixture_zero",
				"assistant",
				v2AssistantData({
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
				}),
			);
			db.close();

			const warn = vi.fn();
			const rows = await opencodeSource.read(handleFor(path), { warn });

			expect(rows.map((r) => r.messageId)).toEqual(["msg_fixture_001"]);
			expect(warn).not.toHaveBeenCalled();
		});
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
		// reader's own error - and, since the message template embeds ${path}, that it names
		// the offending file too, not just the generic "unsupported" shape.
		let caught: unknown;
		try {
			await opencodeSource.read(handleFor(path));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).toMatch(/Unsupported opencode database/);
		expect(message).toContain(path);
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

		// A different failure mode than the discover()-time ELOOP/EACCES cases above: this one
		// happens at read() time, on a database that discover() already found. Opening a
		// WAL-mode database read-only still needs to create its -wal/-shm sidecars when they
		// are not already there (SQLite has to set up the shared wal-index), so a cleanly
		// closed database - no pre-existing sidecar - in a read-only directory fails with the
		// raw, unhelpful "attempt to write a readonly database" unless read() names the cause.
		//
		// An immutable=1 URI open was tried here first and reverted: node:sqlite's DatabaseSync
		// did not accept file: URI locations at all on this repo's Node floor (22.13.0, added:
		// v22.5.0 per Node's own docs at that tag - even a bare file: URI with no query string
		// fails there with "unable to open database file"). A fix the floor CI job cannot pass
		// is not a fix, so read() surfaces a clear, actionable error instead.
		//
		// Unlike the discover()-time chmod test that was tried and removed (see the comment
		// above "multiple database files"), this one is not incidental coverage of an already-
		// proven pure function: it is the bead's own acceptance criterion, and the only way to
		// reproduce "no pre-existing sidecar, directory not writable" is a real read-only
		// directory. skipIf(win32): chmod bits don't model POSIX permissions on Windows.
		it.skipIf(process.platform === "win32")(
			"throws a named error when a cleanly closed WAL database sits in a read-only directory",
			async (ctx) => {
				if (process.getuid?.() === 0) {
					// Root ignores directory permission bits, so chmod 555 would not reproduce a
					// read-only directory and this test would pass vacuously (open would just
					// succeed the normal way). Same reasoning as the ELOOP test's Windows skip
					// above: skip with a stated reason rather than assert nothing.
					ctx.skip(
						"root bypasses directory permission bits; chmod 555 cannot make a directory unwritable for root",
					);
				}
				const dir = await sandbox();
				const path = join(dir, "opencode.db");
				const db = createDb(path);
				insertMessage(db, "msg_fixture_a", assistantData());
				db.close();

				chmodSync(dir, 0o555);
				try {
					await expect(opencodeSource.read(handleFor(path))).rejects.toThrow(
						/its directory is not writable/,
					);
				} finally {
					// Restore before afterEach's rm(): deleting entries from a read-only
					// directory would fail, and force:true does not swallow EACCES/EPERM.
					chmodSync(dir, 0o755);
				}
			},
		);
		// The check in read()'s catch (`if (!isReadonlyDirectoryError(error)) throw error;`)
		// must discriminate a genuine SQLITE_READONLY_DIRECTORY failure from any other read
		// failure - only the former should be rewritten into the named error above; everything
		// else must propagate as-is. The chmod test above proves the real end-to-end behavior;
		// these prove the discrimination directly, via an injected DatabaseSyncCtor, so the
		// property holds independent of chmod, root, or platform.
		describe("classifies read failures correctly (injected DatabaseSyncCtor)", () => {
			// A fake DatabaseSync-shaped constructor whose open throws the given error. The
			// constructor always throws before any instance method would be called, so the fake
			// declares none - readRows()'s call site only ever needs the constructor itself here.
			function fakeDatabaseSyncCtor(error: Error) {
				class FakeDatabaseSync {
					constructor(_location: string, _options: unknown) {
						throw error;
					}
				}
				return FakeDatabaseSync as unknown as typeof DatabaseSync;
			}

			it("propagates the original error, unrewritten, when the open failure is not SQLITE_READONLY_DIRECTORY", async () => {
				const dir = await sandbox();
				const path = join(dir, "opencode.db");
				// A made-up errcode, deliberately not 1544 (SQLITE_READONLY_DIRECTORY): any other
				// value must pass through untouched, not become the named readonly-directory error.
				const otherError = Object.assign(new Error("disk I/O error"), {
					errcode: 10,
				});

				await expect(
					opencodeSource.read(handleFor(path), {
						DatabaseSyncCtor: fakeDatabaseSyncCtor(otherError),
					}),
				).rejects.toBe(otherError);
			});

			it("rewrites the failure into a named error, naming the path and the remedy, and chains the original error as .cause, when it is genuinely SQLITE_READONLY_DIRECTORY", async () => {
				const dir = await sandbox();
				const path = join(dir, "opencode.db");
				const readonlyDirectoryError = Object.assign(
					new Error("attempt to write a readonly database"),
					{ errcode: 1544 },
				);

				// Two halves, both pinned: the cause ("its directory is not writable...") and the
				// remedy ("Copy the database..."). A source change that drops the remedy sentence
				// (the whole reason this is a named error and not just a rethrow) must fail here,
				// not just the cause half.
				let caught: unknown;
				try {
					await opencodeSource.read(handleFor(path), {
						DatabaseSyncCtor: fakeDatabaseSyncCtor(readonlyDirectoryError),
					});
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(Error);
				const message = (caught as Error).message;
				expect(message).toContain(
					`Cannot read ${path}: its directory is not writable`,
				);
				expect(message).toContain(
					"Copy the database (and any -wal/-shm files beside it) to a writable location and read from there.",
				);
				// The original low-level SQLite error is chained, not dropped.
				expect((caught as Error).cause).toBe(readonlyDirectoryError);
			});
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

	// Pure-time ordering (independent of message id) is already covered end to end by
	// "orders rows by completion time, then message id, regardless of insert order" above,
	// which reads real rows out of SQLite (verified: an always-0 compareRows mutation fails
	// that test). A duplicate unit case here would add no incremental coverage.

	it("breaks a time tie by message id, comparing code units rather than locale order", () => {
		expect(compareRows(row(1, "a"), row(1, "b"))).toBe(-1);
		expect(compareRows(row(1, "b"), row(1, "a"))).toBe(1);
		// Code-unit order puts "B" before "a"; a locale-aware compare would not.
		expect(compareRows(row(1, "B"), row(1, "a"))).toBe(-1);
	});
});
