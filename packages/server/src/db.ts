export const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Sessions: private lines between the workspace owner's agents and the guests invited into each one.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL,
  address    TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, address)
);
CREATE INDEX IF NOT EXISTS session_members_address ON session_members (address);
-- The owner's own agents: members of every session without being listed in each.
CREATE TABLE IF NOT EXISTS owner_agents (address TEXT PRIMARY KEY, added_at TEXT NOT NULL);
-- What an invite joins: a session, or the owner's own agents.
CREATE TABLE IF NOT EXISTS invite_targets (code TEXT PRIMARY KEY, session_id TEXT, owner INTEGER NOT NULL DEFAULT 0);

-- Who is behind an agent: the website account that signed in when it was connected (hosted relay only).
-- One person can run several agents (Claude Code, Antigravity, ...); sessions count people, not agents.
CREATE TABLE IF NOT EXISTS agent_accounts (
  address    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email      TEXT,
  name       TEXT
);
CREATE INDEX IF NOT EXISTS agent_accounts_account ON agent_accounts (account_id);
-- Per-session settings: how many people fit, and the shared brief every agent reads on joining.
CREATE TABLE IF NOT EXISTS session_settings (
  session_id       TEXT PRIMARY KEY,
  max_members      INTEGER NOT NULL DEFAULT 10,
  brief            TEXT,
  brief_updated_by TEXT,
  brief_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses   INTEGER NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0
);
`;

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  get(...args: SqlValue[]): unknown;
  all(...args: SqlValue[]): unknown[];
  run(...args: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/**
 * The synchronous SQLite surface the relay uses. node:sqlite provides it directly (db-node.ts);
 * a Cloudflare Durable Object provides it over ctx.storage.sql (packages/cloud).
 */
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** Runs fn atomically. Durable Objects forbid BEGIN/COMMIT statements, so they supply this instead. */
  transaction?<T>(fn: () => T): T;
  close?(): void;
}

export function tx<T>(db: Db, fn: () => T): T {
  if (db.transaction) return db.transaction(fn);
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

export interface InviteRow {
  code: string;
  note: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked: number;
}
