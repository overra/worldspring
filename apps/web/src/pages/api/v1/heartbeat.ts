// POST /api/v1/heartbeat — the intake half of doc 03 §6/§9 (route row: doc 02
// §4). Auth is the full server token in `Authorization: Bearer
// dcd1.<serverId>.<secretHex>` — never in the body. Responses: 204 accepted,
// 400 bad body, 401 bad token (the sender DISARMS on this — never return it
// spuriously, hence the doc 01 §7 two-hash window below), 410 banned (stop
// sending), 429 + Retry-After when the token bucket is empty.
import type { APIRoute } from "astro";
import {
  HEARTBEAT_BUCKET_CAPACITY,
  HEARTBEAT_BUCKET_REFILL_MS,
  HEARTBEAT_MAX_AGE_MS,
  parseHeartbeatBody,
  parseServerToken,
  probeServerInfo,
  sha256Hex,
} from "@worldspring/shared/directory";
import { sanitizeListingText, SERVER_MOTD_MAX } from "@worldspring/shared/text";
import {
  directoryEnv,
  emptyResponse,
  getServerAuthRow,
  jsonResponse,
  readJsonBody,
} from "../../../lib/db";
import { listingNameOf } from "../../../lib/sanitize";

export const prerender = false;

/** Heartbeat bodies get 8 KB (doc 03 §9 owns the contract; the general
 * /api/v1 cap stays 4 KB — Open decision #4). */
const HEARTBEAT_BODY_MAX_BYTES = 8 * 1024;

export const POST: APIRoute = async ({ request }) => {
  const { DB } = directoryEnv();
  const now = Date.now();

  // --- Bearer auth (before body parsing: cheapest rejection first) ---
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const parsedToken = parseServerToken(bearer);
  if (!parsedToken) return emptyResponse(401);

  const row = await getServerAuthRow(DB, parsedToken.serverId);
  if (!row) return emptyResponse(401);

  const presentedHash = await sha256Hex(parsedToken.secretHex);
  const matchesCurrent = presentedHash === row.token_hash;
  const matchesNext = row.token_hash_next !== null && presentedHash === row.token_hash_next;
  // doc 01 §7: during a rotation window old OR new authenticates — a token
  // rotated on the worker before the deploy job settles must never 401.
  if (!matchesCurrent && !matchesNext) return emptyResponse(401);

  if (row.status === "banned") return emptyResponse(410);

  // --- Rate limit: per-token bucket, capacity 3, refill 1/15 s (doc 03 §9) ---
  const refilled = Math.min(
    HEARTBEAT_BUCKET_CAPACITY,
    row.hb_bucket_tokens + (now - row.hb_bucket_at) / HEARTBEAT_BUCKET_REFILL_MS,
  );
  if (refilled < 1) {
    const retryAfterS = Math.ceil(((1 - refilled) * HEARTBEAT_BUCKET_REFILL_MS) / 1000);
    return emptyResponse(429, { "retry-after": String(retryAfterS) });
  }
  const bucketAfter = refilled - 1;

  // --- Body (strict on read fields, tolerant of unknown ones) ---
  const raw = await readJsonBody(request, HEARTBEAT_BODY_MAX_BYTES);
  const body = parseHeartbeatBody(raw);
  if (!body) return jsonResponse({ error: "bad-body" }, 400);

  // sentAt: reject >5 min old or non-monotonic vs the newest accepted beat.
  if (now - body.sentAt > HEARTBEAT_MAX_AGE_MS) return jsonResponse({ error: "stale" }, 400);
  if (row.last_heartbeat_sent_at !== null && body.sentAt <= row.last_heartbeat_sent_at) {
    return jsonResponse({ error: "non-monotonic" }, 400);
  }

  const info = body.info;
  // Directory reads name/motd/players/maxPlayers/protocolVersion/gameVersion/
  // rules.preset/uptimeS out of info; joinUrl is PINNED at registration and
  // IGNORED from beats (doc 03 §7/§9); colo is advisory — prefer what the
  // edge observed on this request. Re-sanitize on receipt: sender-side
  // sanitization is never trusted (doc 03 §9).
  const observedColo = (request as Request & { cf?: { colo?: string } }).cf?.colo;
  const colo =
    typeof observedColo === "string"
      ? observedColo
      : typeof info.colo === "string"
        ? sanitizeListingText(info.colo, 8)
        : null;

  // Winner-settles for the rotation window (doc 01 §7, Open decision #2): a
  // beat authenticating with the NEXT hash proves the new token is live on
  // the worker — promote it to sole and drop the old pair. A beat on the OLD
  // hash mid-window leaves both valid (the deploy job may still land).
  const settleNext = matchesNext
    ? `token_hash = token_hash_next, challenge_hash = challenge_hash_next,
       token_hash_next = NULL, challenge_hash_next = NULL, rotation_started_at = NULL,`
    : "";

  await DB.prepare(
    `UPDATE servers SET
       ${settleNext}
       name = ?, motd = ?, preset = ?, version = ?, protocol = ?,
       players = ?, players_max = ?, uptime_s = ?, colo = ?,
       last_heartbeat_at = ?, last_heartbeat_sent_at = ?, last_event = ?,
       hb_bucket_tokens = ?, hb_bucket_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      listingNameOf(info.name, row.url),
      sanitizeListingText(info.motd, SERVER_MOTD_MAX),
      sanitizeListingText(String(info.rules.preset), 24),
      sanitizeListingText(info.gameVersion, 32),
      Math.floor(info.protocolVersion),
      Math.max(0, Math.floor(info.players)),
      Math.max(0, Math.floor(info.maxPlayers)),
      Math.max(0, Math.floor(info.uptimeS)),
      colo,
      now,
      body.sentAt,
      body.event,
      bucketAfter,
      now,
      now,
      row.id,
    )
    .run();

  // A beat from a PENDING listing proves token possession but NOT URL control
  // — pending→live stays probe-gated (doc 02 §6, Luanti precedent; Open
  // decision #6). Run the connect-back immediately (awaited: beats are
  // fire-and-forget on the sender, latency is free) so a correctly-configured
  // server goes live on its first beat instead of waiting for cron.
  if (row.status === "pending") {
    const expected = [row.challenge_hash, row.challenge_hash_next].filter(
      (h): h is string => h !== null,
    );
    const probe = await probeServerInfo(row.url, { expectedChallenges: expected });
    await DB.prepare(
      "INSERT INTO probes (server_id, at, ok, rtt_ms, players, error) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(row.id, now, probe.ok ? 1 : 0, probe.rttMs, probe.info?.players ?? null, probe.error)
      .run();
    if (probe.ok) {
      await DB.prepare(
        "UPDATE servers SET status = 'live', verified_at = ?, last_probe_at = ?, consecutive_failures = 0, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
        .bind(now, now, now, row.id)
        .run();
    }
  }

  return emptyResponse(204);
};
