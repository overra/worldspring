-- Worldspring directory schema (scaffold). apps/web OWNS the schema/migrations;
-- apps/prober binds the same D1 read/write. The full doc 02 §3 schema (server
-- tokens, probes, hourly stats, ranking) lands when the directory is built.
-- All *_at columns are epoch milliseconds.
CREATE TABLE IF NOT EXISTS servers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  players       INTEGER NOT NULL DEFAULT 0,
  motd          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_probe_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_servers_last_probe ON servers (last_probe_at);
