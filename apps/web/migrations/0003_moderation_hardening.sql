-- Moderation hardening (doc 02 M6-M7 adversarial-review follow-ups).

-- 1) reports indexes. fileReport's rate-limit COUNT (ip_hash), the dedupe +
--    flag-threshold lookups (server_id, resolved_at), the /admin flag-clear
--    NOT EXISTS, and the servers ON DELETE CASCADE all full-scanned the
--    reports table on every unauthenticated report POST.
CREATE INDEX idx_reports_ip ON reports(ip_hash);
CREATE INDEX idx_reports_server_open ON reports(server_id, resolved_at);

-- 2) Widen attempts.route so /admin login POSTs can use the same ledger as
--    register/verify (the single most sensitive unauthenticated POST had no
--    rate limit at all). SQLite cannot ALTER a CHECK constraint; the table
--    holds only transient rate-limit rows (counted over 1 h, pruned daily),
--    so a rebuild loses nothing that matters.
DROP TABLE attempts;
CREATE TABLE attempts (
  ip_hash    TEXT NOT NULL,                 -- sha256(ip + daily salt), same recipe as reports
  route      TEXT NOT NULL CHECK (route IN ('register','verify','admin')),
  at         INTEGER NOT NULL
);
CREATE INDEX idx_attempts_ip_route_at ON attempts(ip_hash, route, at);
