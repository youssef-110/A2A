-- Accounts for the A2A website: people, their sign-in sessions, and the workspaces they own.
-- Each workspace is one relay (one Durable Object) with its own agents, policy and sessions.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT,            -- pbkdf2$<iterations>$<salt b64>$<hash b64>; null for Google-only accounts
  google_sub    TEXT UNIQUE,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,   -- sha256 of the cookie value; the cookie itself is never stored
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE, -- also the agent org: agent://<slug>/<name>
  name       TEXT NOT NULL,
  do_name    TEXT NOT NULL UNIQUE, -- which relay Durable Object holds this workspace
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE auth_attempts (
  key        TEXT NOT NULL,      -- "email:<address>" or "ip:<address>"
  at         TEXT NOT NULL
);
CREATE INDEX auth_attempts_key ON auth_attempts (key, at);
