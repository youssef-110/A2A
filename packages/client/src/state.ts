import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, envelope TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sent (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, scope TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, scope TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
  kind TEXT NOT NULL, in_reply_to TEXT, expects_reply INTEGER NOT NULL, text TEXT NOT NULL, redacted INTEGER NOT NULL,
  delivery TEXT NOT NULL, received_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_agent ON inbox (to_addr, handled, received_at);
CREATE TABLE IF NOT EXISTS sessions (
  agent TEXT NOT NULL, thread_id TEXT NOT NULL, runtime TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (agent, thread_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, runtime TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, replied INTEGER NOT NULL DEFAULT 0,
  error TEXT, output TEXT, cost_usd REAL
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0
);
`;

export type State = DatabaseSync;

export function openState(home: string): State {
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}
