// Worldspring directory prober — the standalone cron Worker (doc 02 §6).
//
// Astro is request-driven and exposes no scheduled() entrypoint, so the
// periodic liveness sweep lives here. It binds the SAME D1 as apps/web and
// runs no migrations. The probe client itself (SSRF guard, shape validation,
// challenge re-check) is @worldspring/shared/directory's probeServerInfo —
// the exact code the site's /verify endpoint runs.
//
// Platform discipline (doc 09 / doc 02 §6, binding): a cron invocation is
// capped at 50 subrequests and 6 open connections. So: SELECT a bounded
// due-set (LIMIT 45, oldest-probed first → round-robin across 5-min runs),
// probe with a worker POOL of 6 (probeServerInfo cancels non-2xx bodies to
// free connections), and fold ALL writeback into ONE env.DB.batch([...]).
//
// Probe schedule (doc 03 §7, binding):
//   - pending: every run (until verified; deleted after 7 days unverified).
//   - live with fresh beats (<5 min): skipped — heartbeats are the freshness
//     — EXCEPT one audit probe per 6 h (AUDIT_PROBE_INTERVAL_MS) so the
//     fake-count heuristic can observe servers that never let beats lapse.
//   - live, last accepted beat was `quiet`: suspended to ≤1 reachability
//     check per 6 h (idle DOs must not be woken every 5 minutes). ANY
//     accepted beat ends the suspension (the intake overwrites last_event).
//   - live, beats stale/absent: probed each run.
//   - unreachable: backed off to every 60 min; deleted after 30 days.

import {
  FAKE_COUNT_PROBE_STREAK,
  isFakeCountObservation,
  probeServerInfo,
  PROBE_HISTORY_DAYS,
  type ProbeResult,
} from "@worldspring/shared/directory";
import { sanitizeListingText, SERVER_MOTD_MAX, SERVER_NAME_MAX } from "@worldspring/shared/text";

interface Env {
  DB: D1Database;
}

const DUE_LIMIT = 45;
const POOL_SIZE = 6;
const FRESH_BEAT_MS = 5 * 60_000; // ~3 missed beats → stale (doc 03 §7)
const QUIET_PROBE_INTERVAL_MS = 6 * 3_600_000;
/** Slow audit cadence for live rows with continuously-fresh beats. Without
 * it a server that beats forever is NEVER cron-probed, so the doc 02 §7
 * fake-count heuristic is dead code for exactly the servers that lie (a
 * fabricated `players` claim refreshed every 60 s keeps last_heartbeat_at
 * permanently fresh) and "probe values overwrite heartbeat values" never
 * fires for them. One spot-check per 6 h keeps the claim honest at
 * negligible probe cost — the DO is already awake (it's beating). */
const AUDIT_PROBE_INTERVAL_MS = 6 * 3_600_000;
const UNREACHABLE_PROBE_INTERVAL_MS = 60 * 60_000;
const PENDING_TTL_MS = 7 * 86_400_000;
const UNREACHABLE_TTL_MS = 30 * 86_400_000;
const FAILURES_TO_UNREACHABLE = 3;
/** Abandoned doc 01 §7 rotations expire: past this window the *_next hashes
 * are cleared so a leaked/never-settled next token is not a standing
 * credential (winner-settles only fires if the new token ever beats). */
const ROTATION_WINDOW_MS = 24 * 3_600_000;

interface DueRow {
  id: string;
  url: string;
  status: "pending" | "live" | "unreachable";
  challenge_hash: string;
  challenge_hash_next: string | null;
  consecutive_failures: number;
  created_at: number;
  last_probe_at: number;
  last_heartbeat_at: number | null;
  last_event: string | null;
  unreachable_since: number | null;
  /** Stored claim — a heartbeat's when last_heartbeat_at > last_probe_at. */
  players: number;
  flagged: number;
}

function isDue(row: DueRow, now: number): boolean {
  if (row.status === "pending") return true;
  if (row.status === "unreachable") {
    return now - row.last_probe_at >= UNREACHABLE_PROBE_INTERVAL_MS;
  }
  // live:
  if (row.last_event === "quiet") {
    return now - row.last_probe_at >= QUIET_PROBE_INTERVAL_MS;
  }
  if (row.last_heartbeat_at !== null && now - row.last_heartbeat_at < FRESH_BEAT_MS) {
    // Occupied with fresh beats — heartbeats carry freshness, but the claim
    // still gets a spot-check probe every AUDIT_PROBE_INTERVAL_MS.
    return now - row.last_probe_at >= AUDIT_PROBE_INTERVAL_MS;
  }
  return true;
}

async function runProbeSweep(controller: ScheduledController, env: Env): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  // Bounded due-set, oldest-probed first (round-robin backlog draining).
  // Due-ness MUST live in the WHERE clause, mirroring isDue(): rows skipped by
  // an in-memory filter never advance last_probe_at, so with >LIMIT fresh-beat
  // live rows the window would fill with permanently-skipped rows and starve
  // pending verification, unreachable rechecks, and every expiry — forever.
  const due = await env.DB.prepare(
    `SELECT id, url, status, challenge_hash, challenge_hash_next,
            consecutive_failures, created_at, last_probe_at,
            last_heartbeat_at, last_event, unreachable_since,
            players, flagged
     FROM servers
     WHERE status = 'pending'
        OR (status = 'unreachable' AND (last_probe_at <= ? OR unreachable_since <= ?))
        OR (status = 'live' AND CASE
              WHEN last_event = 'quiet' THEN last_probe_at <= ?
              ELSE (last_heartbeat_at IS NULL OR last_heartbeat_at <= ? OR last_probe_at <= ?)
            END)
     ORDER BY last_probe_at ASC
     LIMIT ?`,
  )
    .bind(
      now - UNREACHABLE_PROBE_INTERVAL_MS,
      now - UNREACHABLE_TTL_MS, // past-TTL rows must surface for the expiry DELETE
      now - QUIET_PROBE_INTERVAL_MS,
      now - FRESH_BEAT_MS,
      now - AUDIT_PROBE_INTERVAL_MS, // fresh-beat rows still get the slow audit probe
      DUE_LIMIT,
    )
    .all<DueRow>();

  const targets: DueRow[] = [];
  for (const row of due.results) {
    // Expiries first — they don't cost a probe.
    if (row.status === "pending" && now - row.created_at > PENDING_TTL_MS) {
      stmts.push(env.DB.prepare("DELETE FROM servers WHERE id = ? AND status = 'pending'").bind(row.id));
      continue;
    }
    if (
      row.status === "unreachable" &&
      row.unreachable_since !== null &&
      now - row.unreachable_since > UNREACHABLE_TTL_MS
    ) {
      stmts.push(
        env.DB.prepare("DELETE FROM servers WHERE id = ? AND status = 'unreachable'").bind(row.id),
      );
      continue;
    }
    if (isDue(row, now)) targets.push(row);
  }

  // Worker pool of POOL_SIZE — never more than 6 connections in flight.
  const results = new Array<ProbeResult>(targets.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL_SIZE, targets.length) }, async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const row = targets[i];
        const expected = [row.challenge_hash, row.challenge_hash_next].filter(
          (h): h is string => h !== null,
        );
        results[i] = await probeServerInfo(row.url, { expectedChallenges: expected });
      }
    }),
  );

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const probe = results[i];
    stmts.push(
      env.DB.prepare(
        "INSERT INTO probes (server_id, at, ok, rtt_ms, players, error, source) VALUES (?, ?, ?, ?, ?, ?, 'cron')",
      ).bind(row.id, now, probe.ok ? 1 : 0, probe.rttMs, probe.info?.players ?? null, probe.error),
    );
    if (probe.ok && probe.info) {
      const info = probe.info;
      // Success: refresh listing content (re-sanitized — never trust the
      // origin's sanitization), reset failures, and step the state machine.
      // The status guard mirrors the /verify + heartbeat inline-probe paths:
      // an admin hide/ban issued while this sweep's batch was open must NOT
      // be reverted to 'live' by the writeback (the sweep can stay open for
      // tens of seconds across 45 probes).
      // pending→live on first passing probe; unreachable→live on any passing
      // probe. Probe values overwrite heartbeat values on conflict (doc 02
      // §7); probe bodies never move joinUrl (pinned at registration).
      // A probe that OBSERVES status:"idle" engages the quiet suspension
      // itself (last_event = 'quiet'): a lost/blocked quiet beat — or a server
      // registered while idle that has never beat at all — must not leave the
      // DO woken every 5 minutes forever. Any accepted beat still ends the
      // suspension (intake overwrites last_event).
      const name = sanitizeListingText(info.name, SERVER_NAME_MAX) || new URL(row.url).hostname;
      stmts.push(
        env.DB.prepare(
          `UPDATE servers SET
             status = 'live',
             verified_at = COALESCE(verified_at, ?),
             consecutive_failures = 0, unreachable_since = NULL,
             last_event = CASE WHEN ? THEN 'quiet' ELSE last_event END,
             name = ?, motd = ?, preset = ?, version = ?, protocol = ?,
             players = ?, players_max = ?, uptime_s = ?,
             colo = COALESCE(?, colo),
             last_probe_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'live', 'unreachable')`,
        ).bind(
          now,
          info.status === "idle" ? 1 : 0,
          name,
          sanitizeListingText(info.motd, SERVER_MOTD_MAX),
          sanitizeListingText(String(info.rules.preset), 24),
          sanitizeListingText(info.gameVersion, 32),
          Math.floor(info.protocolVersion),
          Math.max(0, Math.floor(info.players)),
          Math.max(0, Math.floor(info.maxPlayers)),
          Math.max(0, Math.floor(info.uptimeS)),
          typeof info.colo === "string" ? sanitizeListingText(info.colo, 8) : null,
          now,
          now,
          row.id,
        ),
      );
      // Fake-count flag heuristic (doc 02 §7, M7): three consecutive probes
      // each reporting < half the latest heartbeat claim ⇒ flagged=1 for
      // human review (never auto-hide/auto-ban). The stored `players` is a
      // genuine heartbeat CLAIM only when the last write was a beat
      // (last_heartbeat_at > last_probe_at) — after our own success UPDATE
      // above overwrites it, the next beat must re-claim before the next
      // probe can count again, which is exactly the doc's "latest
      // heartbeat's claim" cadence. The streak is confirmed in SQL over the
      // last 3 non-verify probe rows (this run's INSERT precedes this
      // statement in the same ordered batch): all 3 must be ok=1 with
      // players under half the claim — a failed probe reports nothing and
      // breaks the streak.
      //
      // Known false-positive mode (accepted): the window's older probe rows
      // predate the CURRENT claim, so a legitimate spike (claim jumps, crowd
      // leaves) can complete the streak off observations taken under earlier
      // smaller claims. Requiring the rows to postdate last_heartbeat_at
      // would instead make the streak impossible (each success UPDATE below
      // overwrites the stored claim, so pre-claim rows are structural). The
      // flag is review-only and /admin's clear-flag action is the recovery
      // path.
      if (
        row.flagged === 0 &&
        row.last_heartbeat_at !== null &&
        row.last_heartbeat_at > row.last_probe_at &&
        isFakeCountObservation(info.players, row.players)
      ) {
        stmts.push(
          env.DB.prepare(
            `UPDATE servers SET flagged = 1, updated_at = ?2
             WHERE id = ?1 AND flagged = 0
               AND (SELECT COUNT(*) FROM (
                      SELECT ok, players FROM probes
                      WHERE server_id = ?1 AND source != 'verify'
                      ORDER BY at DESC LIMIT ?3)
                    WHERE ok = 1 AND players IS NOT NULL AND players * 2 < ?4) = ?3`,
          ).bind(row.id, now, FAKE_COUNT_PROBE_STREAK, row.players),
        );
      }
    } else {
      // Failure (timeout / non-200 / >16 KB / bad shape / challenge-mismatch):
      // count it; live→unreachable at 3 consecutive (~15 min). Pending rows
      // just keep failing until verified or the 7-day expiry above. Same
      // status guard as the success UPDATE: never flip a mid-sweep ban/hide
      // to 'unreachable'.
      const failures = row.consecutive_failures + 1;
      const goesUnreachable = row.status === "live" && failures >= FAILURES_TO_UNREACHABLE;
      stmts.push(
        env.DB.prepare(
          `UPDATE servers SET
             consecutive_failures = ?,
             status = CASE WHEN ? THEN 'unreachable' ELSE status END,
             unreachable_since = CASE WHEN ? THEN ? ELSE unreachable_since END,
             last_probe_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'live', 'unreachable')`,
        ).bind(failures, goesUnreachable ? 1 : 0, goesUnreachable ? 1 : 0, now, now, now, row.id),
      );
    }
  }

  // Housekeeping rides the cron (doc 02 §6): hourly stats roll on the first
  // run of each hour; daily pruning on the 00:xx run.
  const at = new Date(controller.scheduledTime);
  if (at.getUTCMinutes() < 5) {
    // Expire abandoned rotation windows (doc 01 §7): without this, a rotation
    // whose deploy job died leaves TWO permanently-valid tokens.
    stmts.push(
      env.DB.prepare(
        `UPDATE servers SET
           token_hash_next = NULL, challenge_hash_next = NULL, rotation_started_at = NULL
         WHERE rotation_started_at IS NOT NULL AND rotation_started_at < ?`,
      ).bind(now - ROTATION_WINDOW_MS),
    );
    const hour = Math.floor(controller.scheduledTime / 3_600_000) - 1; // completed hour
    stmts.push(
      env.DB.prepare(
        `INSERT INTO stats_hourly (server_id, hour, peak_players)
         SELECT server_id, ?, MAX(players) FROM probes
         WHERE at >= ? AND at < ? AND ok = 1 AND players IS NOT NULL
         GROUP BY server_id
         ON CONFLICT (server_id, hour) DO UPDATE SET
           peak_players = MAX(peak_players, excluded.peak_players)`,
      ).bind(hour, hour * 3_600_000, (hour + 1) * 3_600_000),
    );
    if (at.getUTCHours() === 0) {
      stmts.push(
        env.DB.prepare("DELETE FROM probes WHERE at < ?").bind(
          now - PROBE_HISTORY_DAYS * 86_400_000,
        ),
        env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(now - 86_400_000),
        env.DB.prepare(
          "DELETE FROM reports WHERE resolved_at IS NOT NULL AND resolved_at < ?",
        ).bind(now - 90 * 86_400_000),
      );
    }
  }

  // ALL writeback in ONE atomic batch — a single subrequest, never
  // per-server UPDATEs (which blow the 50-subrequest cap at ~16 servers).
  if (stmts.length > 0) await env.DB.batch(stmts);
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runProbeSweep(controller, env));
  },
} satisfies ExportedHandler<Env>;
