import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { DB_PATH } from "./paths.ts";

/**
 * The schema already carries the Task and worktree tables even though the
 * current stage only uses `project` and `pty`. Reason: migrating a schema in
 * an app you use every day is painful, and these columns are the spine of the
 * product. Better to exist empty than to be added later with real data on top.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  opened_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  prompt      TEXT,
  state       TEXT NOT NULL,           -- running | needsYou | review | failed | merged
  worktree    TEXT,                    -- NULL when the task is not isolated
  base_ref    TEXT,
  session_id  TEXT,                    -- Agent SDK session id, for resume
  layout      TEXT,                    -- serialised PaneNode
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The attention queue is literally a query over this index.
CREATE INDEX IF NOT EXISTS task_by_state ON task(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS pty (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES task(id) ON DELETE CASCADE,
  cwd         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

/*
 * THE EVENT LOG — the timeline's data model.
 *
 * This is not telemetry: it is the interface's primary structure. The screen's
 * X axis is the at column and each band is a lane. Persisting it means you
 * can close the app, come back later, and SEE what the agents did while you
 * were not looking — exactly the information a conventional IDE throws away.
 */
CREATE TABLE IF NOT EXISTS event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  project  TEXT NOT NULL,          -- project root
  lane     TEXT NOT NULL,          -- you | agent:<task> | term:<pty> | cons:<task>:<v>
  at       INTEGER NOT NULL,       -- epoch ms
  kind     TEXT NOT NULL,
  label    TEXT NOT NULL DEFAULT '',
  detail   TEXT,                   -- json, on demand
  ref      TEXT                    -- related id (tool_use, path, requestId)
);
CREATE INDEX IF NOT EXISTS event_by_project_at ON event(project, at);
CREATE INDEX IF NOT EXISTS event_by_lane ON event(lane, at);

-- "always allow pytest in this project" has to stick across sessions,
-- otherwise the permission gate becomes friction instead of safety.
-- a simple cache for connectors (Linear issues, Notion pages)
CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_rule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  pattern     TEXT,
  decision    TEXT NOT NULL,           -- allow | deny
  created_at  INTEGER NOT NULL,
  UNIQUE(project_id, tool, pattern)
);
`;

export type Db = Database.Database;

const SCHEMA_VERSION = 3;

export function openDb(): Db {
  const db = new Database(DB_PATH);
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);

  const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as { v: string } | undefined;
  const have = row ? Number(row.v) : 1;

  if (have < SCHEMA_VERSION) {
    // v1 wrote colliding project ids (truncated base64). There is no way to
    // retroactively tell which row belonged to which path, so these tables
    // start over. Only the recents list and empty tasks are lost.
    db.exec(`DELETE FROM pty; DELETE FROM task; DELETE FROM permission_rule; DELETE FROM project;`);
    if (have < 3) db.exec(`DELETE FROM event`);
    db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?)
                ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(SCHEMA_VERSION));
  }
  return db;
}

/**
 * Project id = a hash of the FULL path.
 *
 * The previous version used base64 of the path truncated to 16 chars. Paths
 * share long prefixes (`/Users/me/Documents/…`), so EVERY project under the
 * same parent folder collided on the same id — and the PRIMARY KEY collision
 * took the whole daemon down. Truncating a hash without looking at the input
 * distribution is a landmine; with paths, it is the worst case possible.
 */
export function projectId(path: string): string {
  return `p_${createHash("sha256").update(path).digest("hex").slice(0, 20)}`;
}

export type EventKind =
  | "lane-start" | "lane-end"
  | "tool" | "tool-done" | "text"
  | "gate" | "gate-done"
  | "edit" | "test" | "output" | "diff" | "note";

/**
 * What gets WRITTEN. No id: SQLite assigns it.
 *
 * This used to be one type with `id?: number`, serving as both input and
 * output — which is why what came out of the database did not satisfy the
 * protocol schema (which requires an id). Splitting the two shapes describes
 * reality: on the way back the id always exists, and `detail`/`ref` arrive as
 * NULL, not as undefined.
 */
export interface LogEvent {
  project: string; lane: string; at: number;
  kind: EventKind; label: string; detail?: string; ref?: string;
}

/** What gets READ from the table. */
export type StoredEvent =
  Omit<LogEvent, "detail" | "ref"> & { id: number; detail: string | null; ref: string | null };

export function appendEvent(db: Db, e: LogEvent): number {
  const r = db.prepare(
    `INSERT INTO event (project, lane, at, kind, label, detail, ref) VALUES (?,?,?,?,?,?,?)`,
  ).run(e.project, e.lane, e.at, e.kind, e.label, e.detail ?? null, e.ref ?? null);
  return Number(r.lastInsertRowid);
}

/** A window of events. The timeline asks by time range, like a video editor. */
export function readEvents(db: Db, project: string, sinceId = 0, limit = 5000): StoredEvent[] {
  return db.prepare(
    `SELECT id, project, lane, at, kind, label, detail, ref FROM event
     WHERE project = ? AND id > ? ORDER BY at ASC, id ASC LIMIT ?`,
  ).all(project, sinceId, limit) as StoredEvent[];
}

export function kvGet(db: Db, k: string): { v: string; updatedAt: number } | null {
  const r = db.prepare(`SELECT v, updated_at AS updatedAt FROM kv WHERE k = ?`).get(k) as
    { v: string; updatedAt: number } | undefined;
  return r ?? null;
}
export function kvSet(db: Db, k: string, v: string): void {
  db.prepare(`INSERT INTO kv (k, v, updated_at) VALUES (?,?,?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`)
    .run(k, v, Date.now());
}

export function upsertProject(db: Db, path: string, name: string): string {
  const id = projectId(path);
  db.prepare(
    `INSERT INTO project (id, path, name, opened_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at`,
  ).run(id, path, name, Date.now());
  return id;
}
