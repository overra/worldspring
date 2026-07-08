// D1 loaders for the browse surfaces (doc 02 M5 §8/§11). The PURE ranking,
// filtering, and view-shaping live in @worldspring/shared/browse where vitest
// covers them; this module is only the web-specific SQL that feeds them. Shared
// by GET /api/v1/servers (then edge-cached, servers.ts) and the SSR /servers +
// /servers/:id pages, so the query + shaping can never drift between the JSON
// API and the HTML.

import {
  LIST_MAX_ROWS,
  shapeListedServer,
  shapeServerDetail,
  type ListedServer,
  type ListRow,
  type ServerDetailRow,
  type ServerDetailView,
} from "@worldspring/shared/browse";

export type { ListedServer, ServerDetailView } from "@worldspring/shared/browse";

const UPTIME_WINDOW_MS = 20 * 86400_000; // doc 02 §8: 20-day probe window
// LIST_MAX_ROWS (doc 02 §4/§11 hard cap, asserted loudly below) is imported from
// @worldspring/shared/browse so the SELECT cap and the page-clamp ceiling stay in lockstep.

/**
 * Load every `live` server, shaped + scored and pre-sorted official-first /
 * score-desc (doc 02 §8). Callers pass the result through applyBrowse for the
 * requested filter/sort/page. The 20-day uptime ratio EXCLUDES unauthenticated
 * `verify` probes (see migration 0002 / /api/v1/servers).
 *
 * THROWS on a D1 failure — it deliberately does NOT swallow to []: the list
 * endpoint must distinguish "no live servers" from "the read failed" so it
 * never edge-caches an error as an empty success (doc 02 §11). Callers decide
 * how to degrade (the SSR page renders empty; the API returns uncached empty).
 */
export async function loadRankedList(
  db: D1Database,
  now: number,
  latestProtocol: number,
): Promise<ListedServer[]> {
  const uptimeBy = new Map<string, number>();
  const [serversRes, uptimeRes] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT id, url, name, motd, preset, version, protocol, players, players_max,
              colo, source, created_at, last_heartbeat_at
       FROM servers WHERE status = 'live' LIMIT ?`,
    ).bind(LIST_MAX_ROWS),
    db.prepare(
      "SELECT server_id, AVG(ok) AS ratio FROM probes WHERE at > ? AND source != 'verify' GROUP BY server_id",
    ).bind(now - UPTIME_WINDOW_MS),
  ]);
  const rows = serversRes.results as unknown as ListRow[];
  for (const r of uptimeRes.results as Array<{ server_id: string; ratio: number }>) {
    uptimeBy.set(r.server_id, Number(r.ratio ?? 0));
  }
  if (rows.length >= LIST_MAX_ROWS) {
    // Doc 02 §11: the 500-row cap is asserted with a loud comment — if the
    // directory ever approaches it, revisit (keyset pagination + per-page cache).
    console.warn(`[listing] hit the ${LIST_MAX_ROWS}-row list cap — revisit pagination (doc 02 §11).`);
  }
  return rows
    .map((r) => shapeListedServer(r, uptimeBy.get(r.id), now, latestProtocol))
    .sort((a, b) => (a.official !== b.official ? (a.official ? -1 : 1) : b.score - a.score));
}

/** A single day's uptime cell for the detail-page 20-day strip (doc 02 §8). */
export interface DailyUptime {
  /** unix day = floor(at / 86400000). */
  day: number;
  /** 0..1 fraction of passing probes that day. */
  ratio: number;
}

export interface ServerDetail {
  view: ServerDetailView;
  /** Newest→oldest daily uptime cells over the 20-day window (may be empty). */
  dailyUptime: DailyUptime[];
}

/**
 * Load one PUBLIC server detail (doc 02 §8). Returns null for unknown or
 * non-`live` ids so the page renders a real 404 — the same no-existence-oracle
 * posture as /join/:id and the report page (hidden/banned/pending/unreachable
 * rows are not browsable). Selects only non-secret columns; token_hash /
 * challenge_hash / ip_hash NEVER leave the DB (doc 02 §7). THROWS on a D1
 * failure — the page catches it and renders 404 like /join and /report do.
 */
export async function loadServerDetail(
  db: D1Database,
  id: string,
  now: number,
  latestProtocol: number,
): Promise<ServerDetail | null> {
  const row = await db
    .prepare(
      `SELECT id, url, name, motd, preset, version, protocol, players, players_max,
              colo, source, created_at, last_heartbeat_at, verified_at, last_probe_at
       FROM servers WHERE id = ? AND status = 'live'`,
    )
    .bind(id)
    .first<ServerDetailRow>();
  if (!row) return null;

  const windowStart = now - UPTIME_WINDOW_MS;
  const [uptimeRes, dailyRes] = await db.batch<Record<string, unknown>>([
    db.prepare(
      "SELECT AVG(ok) AS ratio FROM probes WHERE server_id = ? AND at > ? AND source != 'verify'",
    ).bind(id, windowStart),
    db.prepare(
      `SELECT CAST(at / 86400000 AS INTEGER) AS day, AVG(ok) AS ratio
       FROM probes WHERE server_id = ? AND at > ? AND source != 'verify'
       GROUP BY day ORDER BY day DESC`,
    ).bind(id, windowStart),
  ]);

  const ratioRow = (uptimeRes.results[0] ?? {}) as { ratio: number | null };
  const uptimeRatio20d = ratioRow.ratio ?? null;
  const dailyUptime = (dailyRes.results as Array<{ day: number; ratio: number | null }>).map(
    (d) => ({ day: Number(d.day), ratio: Number(d.ratio ?? 0) }),
  );

  return {
    view: shapeServerDetail(row, uptimeRatio20d, now, latestProtocol),
    dailyUptime,
  };
}
