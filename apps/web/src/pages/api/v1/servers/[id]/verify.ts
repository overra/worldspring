// POST /api/v1/servers/:id/verify — trigger an immediate verification probe
// instead of waiting for cron (doc 02 §4/§5). No auth; rate-limited 10/h/IP
// via the attempts ledger. Returns the probe outcome.
//
// Deliberately NEVER increments consecutive_failures: this endpoint is
// unauthenticated, so letting it count toward live→unreachable would let
// anyone probe-spam a temporarily-slow server off the list. Only the cron
// prober moves the failure counter.
import type { APIRoute } from "astro";
import { probeServerInfo } from "@worldspring/shared/directory";
import {
  attemptAndCheckLimit,
  directoryEnv,
  emptyResponse,
  hashIp,
  jsonResponse,
} from "../../../../../lib/db";

export const prerender = false;

const VERIFY_LIMIT_PER_HOUR = 10; // doc 02 §4

export const POST: APIRoute = async ({ request, params }) => {
  const { DB, REPORT_SALT } = directoryEnv();
  const now = Date.now();

  const ipHash = await hashIp(request, REPORT_SALT);
  if (await attemptAndCheckLimit(DB, ipHash, "verify", VERIFY_LIMIT_PER_HOUR, now)) {
    return emptyResponse(429, { "retry-after": "3600" });
  }

  const id = params.id ?? "";
  const row = await DB.prepare(
    "SELECT id, url, challenge_hash, challenge_hash_next, status FROM servers WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      url: string;
      challenge_hash: string;
      challenge_hash_next: string | null;
      status: string;
    }>();
  if (!row) return jsonResponse({ error: "not-found" }, 404);
  if (row.status === "banned") return emptyResponse(410);

  // The doc 02 §5 verification probe: doc-03 shape AND directoryChallenge
  // equal to a stored challenge hash (either of the two during a doc 01 §7
  // rotation window — a verify against the freshly-baked token must pass).
  const expected = [row.challenge_hash, row.challenge_hash_next].filter(
    (h): h is string => h !== null,
  );
  const probe = await probeServerInfo(row.url, { expectedChallenges: expected });

  // source='verify': EXCLUDED from uptimeRatio20d — this endpoint is
  // unauthenticated, so its rows counting toward the ranked list's uptime
  // term would let owners self-boost (spam ok=1) or rivals pile on ok=0.
  await DB.prepare(
    "INSERT INTO probes (server_id, at, ok, rtt_ms, players, error, source) VALUES (?, ?, ?, ?, ?, ?, 'verify')",
  )
    .bind(row.id, now, probe.ok ? 1 : 0, probe.rttMs, probe.info?.players ?? null, probe.error)
    .run();

  if (probe.ok) {
    // pending→live on a passing probe; also revives unreachable (doc 02 §6).
    await DB.prepare(
      `UPDATE servers SET
         status = 'live',
         verified_at = COALESCE(verified_at, ?),
         consecutive_failures = 0, unreachable_since = NULL,
         last_probe_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'live', 'unreachable')`,
    )
      .bind(now, now, now, row.id)
      .run();
  }

  return jsonResponse(
    { ok: probe.ok, error: probe.error, rttMs: probe.rttMs },
    probe.ok ? 200 : 422,
  );
};
