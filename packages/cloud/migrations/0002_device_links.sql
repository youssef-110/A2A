-- Desktop app sign-in: the app shows a short code, the person approves it in their browser,
-- and the app collects a session and an agent invite for the chosen workspace.
CREATE TABLE IF NOT EXISTS device_links (
  device_hash TEXT PRIMARY KEY,          -- sha256 of the secret the app polls with
  user_code TEXT NOT NULL UNIQUE,        -- what the person sees and confirms, e.g. KQ7M-4XTB
  host TEXT NOT NULL,                    -- the computer's name, shown on the approval page
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_slug TEXT,
  invite_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_links_expiry ON device_links(expires_at);
