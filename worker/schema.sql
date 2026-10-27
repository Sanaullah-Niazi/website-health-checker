-- D1 tables for the Website Health & Security Checker.
-- Apply with: npx wrangler d1 execute site-checker --remote --file=schema.sql

-- One row per scan. Rows (including the scanned address) are deleted by the daily cron job once `expires` passes.
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  core TEXT,
  psi_mobile TEXT,
  psi_desktop TEXT,
  links0 TEXT,
  links1 TEXT,
  ssl TEXT,
  ssl_polls INTEGER NOT NULL DEFAULT 0,
  shot_mobile TEXT,
  shot_desktop TEXT
);
CREATE INDEX IF NOT EXISTS scans_url ON scans (url, created);
CREATE INDEX IF NOT EXISTS scans_expires ON scans (expires);

-- Rate limit counters. Visitors are counted by a salted hash of their IP address, never the address itself.
CREATE TABLE IF NOT EXISTS hits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
