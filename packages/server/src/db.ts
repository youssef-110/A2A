import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  address      TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  display_name TEXT,
  description  TEXT,
  host         TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  version    INTEGER PRIMARY KEY AUTOINCREMENT,
  yaml       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  max_hop       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id TEXT NOT NULL,
  address   TEXT NOT NULL,
  PRIMARY KEY (thread_id, address)
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  in_reply_to    TEXT,
  from_addr      TEXT NOT NULL,
  to_addr        TEXT NOT NULL,
  scope          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  expects_reply  INTEGER NOT NULL,
  hop            INTEGER NOT NULL,
  envelope       TEXT NOT NULL,
  body_sha256    TEXT NOT NULL,
  preview        TEXT NOT NULL,
  delivered_text TEXT,
  redacted       INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,
  decision       TEXT,
  reason_code    TEXT,
  reason         TEXT,
  categories     TEXT,
  findings       TEXT,
  policy_version INTEGER,
  guard_ms       INTEGER,
  created_at     TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT,
  delivered_at   TEXT
);
CREATE INDEX IF NOT EXISTS messages_to_state ON messages (to_addr, state);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, received_at);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_addr, received_at);
CREATE INDEX IF NOT EXISTS messages_state ON messages (state, received_at);

CREATE TABLE IF NOT EXISTS verdict_stages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  stage      TEXT NOT NULL,
  decision   TEXT NOT NULL,
  categories TEXT NOT NULL,
  confidence REAL,
  model      TEXT,
  reason     TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  error      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdict_stages_msg ON verdict_stages (message_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  sent_at    TEXT NOT NULL,
  acked_at   TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_msg ON deliveries (message_id);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  reviewer   TEXT NOT NULL,
  decision   TEXT NOT NULL,
  note       TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface AgentRow {
  address: string;
  public_key: string;
  display_name: string | null;
  description: string | null;
  host: string | null;
  status: "pending" | "active" | "disabled";
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  from_addr: string;
  to_addr: string;
  scope: string;
  kind: string;
  expects_reply: number;
  hop: number;
  envelope: string;
  body_sha256: string;
  preview: string;
  delivered_text: string | null;
  redacted: number;
  state: string;
  decision: string | null;
  reason_code: string | null;
  reason: string | null;
  categories: string | null;
  findings: string | null;
  policy_version: number | null;
  guard_ms: number | null;
  created_at: string;
  received_at: string;
  updated_at: string;
  expires_at: string | null;
  delivered_at: string | null;
}

export interface ThreadRow {
  id: string;
  scope: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  max_hop: number;
}
