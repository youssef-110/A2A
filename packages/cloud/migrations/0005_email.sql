-- Password resets by email, and the newsletter list.

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,   -- sha256 of the token in the emailed link; the token itself is never stored
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX password_resets_user ON password_resets (user_id);

CREATE TABLE subscribers (
  email        TEXT PRIMARY KEY,
  unsub_token  TEXT NOT NULL UNIQUE, -- in every newsletter's unsubscribe link
  source       TEXT,                 -- where they signed up: "home", "signup", ...
  created_at   TEXT NOT NULL,
  unsubscribed_at TEXT
);
