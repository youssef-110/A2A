-- Workspaces where a person has agents as a guest (they joined someone else's session), for "Shared with you".
CREATE TABLE IF NOT EXISTS account_relays (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
