-- Directory core (doc 02 §3), replacing the 0001 scaffold `servers` table.
-- Destructive rebuild is deliberate: the remotely-applied 0001 table is empty
-- (nothing has ever registered), so DROP+recreate beats a column-by-column
-- ALTER dance and gets the CHECK constraints right.
--
-- All *_at / at columns are epoch MILLISECONDS (Date.now()); stats_hourly.hour
-- is floor(Date.now()/3_600_000). Load-bearing: rank.ts divides age by
-- 86400_000 — store seconds anywhere and the age term rounds to ~0 forever.
--
-- Deltas from the doc 02 §3 sketch, all doc-driven:
--   * token_hash_next / challenge_hash_next / rotation_started_at — doc 01 §7:
--     a site-driven redeploy rotates the token; BOTH hashes must authenticate
--     during the job window or a mid-job crash silently delists the server
--     (heartbeat 401 disarms the sender). The challenge pair-rotates with the
--     token so a mid-window verify probe can pass.
--   * last_heartbeat_sent_at — sender-clock monotonicity floor (doc 03 §6
--     "non-monotonic vs newest accepted beat"); last_heartbeat_at alone
--     conflates receive time with sender time.
--   * hb_bucket_tokens / hb_bucket_at — the doc 03 §9 intake token bucket
--     (capacity 3, refill 1/15 s) persisted per listing.
--   * last_event — the last accepted heartbeat event; drives the prober's
--     quiet-suspension schedule (doc 03 §7: after `quiet`, ≤1 probe per 6 h;
--     ANY accepted beat ends the suspension).
--   * uptime_s — latest self-reported occupied-session uptime (display only).

DROP TABLE IF EXISTS servers;

CREATE TABLE owners (
  id          TEXT PRIMARY KEY,            -- ulid
  cf_sub      TEXT UNIQUE,                 -- Cloudflare OAuth sub (doc 02 §3)
  created_at  INTEGER NOT NULL
);

CREATE TABLE servers (
  id          TEXT PRIMARY KEY,            -- ulid; public handle, also in the token
  url         TEXT NOT NULL UNIQUE,        -- normalized https origin, no path/port
  token_hash  TEXT NOT NULL,               -- sha256(secretHex); heartbeat/DELETE auth
  challenge_hash TEXT NOT NULL,            -- sha256("worldspring-directory-challenge:" + token)
  token_hash_next     TEXT,                -- doc 01 §7 rotation window (see header)
  challenge_hash_next TEXT,
  rotation_started_at INTEGER,
  owner_id    TEXT REFERENCES owners(id),  -- NULL = token-only registration
  source      TEXT NOT NULL CHECK (source IN ('deploy','manual','official')),
  -- listing content, refreshed from heartbeats/probes, sanitized on every write:
  name        TEXT NOT NULL,
  motd        TEXT NOT NULL DEFAULT '',
  preset      TEXT,
  version     TEXT,
  protocol    INTEGER,
  players     INTEGER NOT NULL DEFAULT 0,
  players_max INTEGER NOT NULL DEFAULT 24,
  uptime_s    INTEGER NOT NULL DEFAULT 0,
  colo        TEXT,
  -- lifecycle:
  status      TEXT NOT NULL CHECK (status IN ('pending','live','unreachable','hidden','banned')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  verified_at        INTEGER,
  last_heartbeat_at  INTEGER,
  last_heartbeat_sent_at INTEGER,
  last_event         TEXT,
  last_probe_at      INTEGER NOT NULL DEFAULT 0,
  unreachable_since  INTEGER,
  flagged            INTEGER NOT NULL DEFAULT 0,  -- needs human review
  hb_bucket_tokens   REAL NOT NULL DEFAULT 3,
  hb_bucket_at       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_servers_status ON servers(status);
CREATE INDEX idx_servers_last_probe ON servers(last_probe_at);

CREATE TABLE probes (                       -- pruned to PROBE_HISTORY_DAYS = 20
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  rtt_ms     INTEGER,
  players    INTEGER,
  error      TEXT                           -- 'timeout'|'bad-status'|'bad-shape'|'challenge-mismatch'
);
CREATE INDEX idx_probes_server_at ON probes(server_id, at);

CREATE TABLE stats_hourly (                 -- rolled hourly from observed players; powers charts
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  hour         INTEGER NOT NULL,            -- unix hour
  peak_players INTEGER NOT NULL,
  PRIMARY KEY (server_id, hour)
);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN
                ('fake-counts','offensive-content','malware-phishing','impersonation','broken','other')),
  detail      TEXT NOT NULL DEFAULT '',     -- sanitized, <=500 code points
  ip_hash     TEXT NOT NULL,                -- sha256(ip + daily salt); rate-limit + dedupe key
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE moderation_actions (           -- append-only audit log
  id         TEXT PRIMARY KEY,
  server_id  TEXT,
  action     TEXT NOT NULL,                 -- 'hide','unhide','ban','unban','delete','resolve-report'
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE banned_hosts (                 -- blocks re-registration after a ban
  host       TEXT PRIMARY KEY,              -- exact hostname
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE attempts (                     -- rate-limit ledger for unauthenticated POSTs
  ip_hash    TEXT NOT NULL,                 -- sha256(ip + daily salt), same recipe as reports
  route      TEXT NOT NULL CHECK (route IN ('register','verify')),
  at         INTEGER NOT NULL
);
CREATE INDEX idx_attempts_ip_route_at ON attempts(ip_hash, route, at);
