-- Site stats for the owner's Stats page: daily counters only, no cookies and no IP addresses.
CREATE TABLE stats_daily (
  day TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  kind TEXT NOT NULL,  -- view, visitor, ref, country, download, cli, signin
  key TEXT NOT NULL,   -- page path, referrer host, country code, OS, SDK version, "all"
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, key)
);

-- Unique visitors: a hash of a random daily salt + IP + browser. Rows and salts older than a day are
-- deleted, so a visitor can't be followed across days or traced back to an address.
CREATE TABLE stats_visitors (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
CREATE TABLE stats_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
