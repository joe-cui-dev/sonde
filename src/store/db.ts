import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS pages (
  url          TEXT PRIMARY KEY,
  title        TEXT,
  text         TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  bytes        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  question       TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  stopped_by     TEXT,
  usd            REAL,
  total_tokens   INTEGER,
  search_credits INTEGER,
  report_json    TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS sources (
  run_id         TEXT NOT NULL,
  sid            TEXT NOT NULL,
  url            TEXT NOT NULL,
  title          TEXT,
  score          REAL,
  published_date TEXT,
  was_read       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, sid)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS leaves established installations untouched.
  // Keep this explicit first migration so their research history remains usable.
  const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "kind")) {
    db.exec(
      "ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'research'",
    );
  }
  return db;
}
