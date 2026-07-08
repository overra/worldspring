// Report intake shared by POST /api/v1/servers/:id/report and the SSR form
// page at /servers/:id/report (doc 02 §7, M7). The validation itself
// (reason enum, detail sanitize/cap) is @worldspring/shared/directory's
// parseReportBody — vitest-covered there; this module is the D1 plumbing.
//
// Binding behavior (doc 02 §4/§7):
//   - 5 reports/day per ip_hash. NOT the `attempts` ledger — its route CHECK
//     only allows ('register','verify'), and the doc says reports need no
//     ledger: each report row IS the ledger. The day string inside the hash
//     recipe (lib/db.ts hashIp) makes a plain per-hash COUNT a today-count.
//   - Duplicates per (ip_hash, server_id) collapse: an existing UNRESOLVED
//     report from the same hash short-circuits to success WITHOUT inserting.
//     Callers must not reveal deduped-vs-stored (idempotent success only).
//   - Reports NEVER auto-hide. ≥ REPORT_FLAG_THRESHOLD distinct unresolved
//     ip_hashes set servers.flagged=1 for human review — the daily hash
//     rotation means one persistent IP across 3 days counts as 3 "unique"
//     reporters (doc-accepted privacy > sybil-resistance tradeoff; /admin
//     copy says so).

import {
  REPORT_FLAG_THRESHOLD,
  REPORT_LIMIT_PER_DAY,
  ulid,
  type ReportBody,
} from "@worldspring/shared/directory";

export type ReportOutcome = "accepted" | "rate-limited" | "not-found";

export async function fileReport(
  db: D1Database,
  serverId: string,
  body: ReportBody,
  ipHash: string,
  now: number,
): Promise<ReportOutcome> {
  // Any existing row is reportable regardless of status — hidden/banned rows
  // keep collecting evidence (their ids were public while listed).
  const server = await db
    .prepare("SELECT id FROM servers WHERE id = ?")
    .bind(serverId)
    .first<{ id: string }>();
  if (!server) return "not-found";

  const [countRes, dupRes] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ?").bind(ipHash),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND server_id = ? AND resolved_at IS NULL",
      )
      .bind(ipHash, serverId),
  ]);
  if (Number(countRes.results[0]?.n ?? 0) >= REPORT_LIMIT_PER_DAY) return "rate-limited";
  if (Number(dupRes.results[0]?.n ?? 0) > 0) return "accepted"; // collapsed duplicate

  await db.batch([
    db
      .prepare(
        "INSERT INTO reports (id, server_id, reason, detail, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(ulid(now), serverId, body.reason, body.detail, ipHash, now),
    // Flag check rides the same atomic batch, AFTER the insert. flagged is
    // sticky until a human resolves the reports (admin resolve-report clears
    // it when none remain unresolved).
    db
      .prepare(
        `UPDATE servers SET flagged = 1, updated_at = ?
         WHERE id = ? AND flagged = 0
           AND (SELECT COUNT(DISTINCT ip_hash) FROM reports
                WHERE server_id = ? AND resolved_at IS NULL) >= ?`,
      )
      .bind(now, serverId, serverId, REPORT_FLAG_THRESHOLD),
  ]);
  return "accepted";
}
