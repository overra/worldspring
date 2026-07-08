// /api/v1/servers — POST = begin registration (doc 02 §5 Path B), GET = the
// public ranked list (doc 02 §4/§8).
import type { APIRoute } from "astro";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import {
  mintServerToken,
  normalizeServerUrl,
  probeServerInfo,
  score,
} from "@worldspring/shared/directory";
import { sanitizeListingText, SERVER_MOTD_MAX } from "@worldspring/shared/text";
import {
  attemptAndCheckLimit,
  directoryEnv,
  emptyResponse,
  hashIp,
  jsonResponse,
  readJsonBody,
} from "../../../lib/db";
import { listingNameOf } from "../../../lib/sanitize";

export const prerender = false;

const REGISTER_LIMIT_PER_HOUR = 5; // doc 02 §4
const BODY_MAX_BYTES = 4 * 1024; // doc 02 §4 general cap
const LIST_MAX_ROWS = 500; // doc 02 §4

/**
 * Begin registration: body `{ url }`, no auth, 5/h/IP via the `attempts`
 * ledger (every attempt inserts; the handler counts first). Validates +
 * normalizes the URL (doc 02 §7), checks banned_hosts, connect-back probes
 * the origin for a doc-03-shaped /api/server-info (shape only — the owner
 * has not set the token yet, so the challenge CANNOT match here; the
 * challenge gate is verify/cron), mints `dcd1.<serverId>.<secretHex>`, and
 * returns the plaintext token EXACTLY ONCE. Row lands as status='pending'.
 */
export const POST: APIRoute = async ({ request }) => {
  const { DB, REPORT_SALT } = directoryEnv();
  const now = Date.now();

  const ipHash = await hashIp(request, REPORT_SALT);
  if (await attemptAndCheckLimit(DB, ipHash, "register", REGISTER_LIMIT_PER_HOUR, now)) {
    return emptyResponse(429, { "retry-after": "3600" });
  }

  const body = await readJsonBody(request, BODY_MAX_BYTES);
  const rawUrl =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).url
      : undefined;
  if (typeof rawUrl !== "string") return jsonResponse({ error: "bad-body" }, 400);

  const url = normalizeServerUrl(rawUrl);
  if (!url) return jsonResponse({ error: "invalid-url" }, 400);

  const host = new URL(url).hostname;
  const banned = await DB.prepare("SELECT host FROM banned_hosts WHERE host = ?")
    .bind(host)
    .first();
  if (banned) return jsonResponse({ error: "banned-host" }, 403);

  const existing = await DB.prepare("SELECT id FROM servers WHERE url = ?").bind(url).first();
  if (existing) return jsonResponse({ error: "already-registered" }, 409);

  // Connect-back shape probe (SSRF-guarded: manual redirects, 5 s timeout,
  // 16 KB cap, JSON only). Confirms the URL actually answers as a Worldspring
  // server before a listing row exists; seeds the initial listing fields.
  const probe = await probeServerInfo(url);
  if (!probe.ok || !probe.info) {
    return jsonResponse({ error: "unreachable", detail: probe.error }, 422);
  }
  const info = probe.info;

  const minted = await mintServerToken(now);
  await DB.prepare(
    `INSERT INTO servers
       (id, url, token_hash, challenge_hash, source, name, motd, preset, version,
        protocol, players, players_max, uptime_s, colo, status, last_probe_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      minted.serverId,
      url,
      minted.tokenHash,
      minted.challengeHash,
      listingNameOf(info.name, url),
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
      now,
    )
    .run();

  const origin = new URL(request.url).origin;
  return jsonResponse(
    {
      serverId: minted.serverId,
      // Shown exactly once — only hashes persist (doc 02 §2/§4).
      token: minted.token,
      verifyUrl: `${origin}/api/v1/servers/${minted.serverId}/verify`,
    },
    201,
  );
};

interface ListRow {
  id: string;
  url: string;
  name: string;
  motd: string;
  preset: string | null;
  version: string | null;
  protocol: number | null;
  players: number;
  players_max: number;
  colo: string | null;
  source: string;
  created_at: number;
  last_heartbeat_at: number | null;
}

/** The list: all `live` servers, ranked by the doc 02 §8 score, ≤500 rows.
 * Official row pinned first and excluded from ranking. */
export const GET: APIRoute = async () => {
  const { DB } = directoryEnv();
  const now = Date.now();

  const [serversRes, uptimeRes] = await DB.batch<Record<string, unknown>>([
    DB.prepare(
      `SELECT id, url, name, motd, preset, version, protocol, players, players_max,
              colo, source, created_at, last_heartbeat_at
       FROM servers WHERE status = 'live' LIMIT ?`,
    ).bind(LIST_MAX_ROWS),
    DB.prepare(
      // 20-day uptime ratio from probe history (doc 02 §8).
      "SELECT server_id, AVG(ok) AS ratio FROM probes WHERE at > ? GROUP BY server_id",
    ).bind(now - 20 * 86400_000),
  ]);

  const uptimeBy = new Map<string, number>();
  for (const r of uptimeRes.results as Array<{ server_id: string; ratio: number }>) {
    uptimeBy.set(r.server_id, Number(r.ratio ?? 0));
  }

  const rows = serversRes.results as unknown as ListRow[];
  const listed = rows.map((r) => {
    const uptimeRatio20d = uptimeBy.get(r.id) ?? 0;
    return {
      id: r.id,
      name: r.name,
      motd: r.motd,
      joinUrl: r.url, // normalized https origin, pinned at registration
      preset: r.preset,
      version: r.version,
      protocol: r.protocol,
      // Displayed players clamped to players_max (doc 02 §7).
      players: Math.min(r.players, r.players_max),
      maxPlayers: r.players_max,
      colo: r.colo,
      official: r.source === "official",
      // "active now" vs "idle — wakes on join" (doc 02 §6/§8).
      activeNow: r.last_heartbeat_at !== null && now - r.last_heartbeat_at < 5 * 60_000,
      uptimeRatio20d,
      createdAt: r.created_at,
      score: score(
        {
          players: Math.min(r.players, r.players_max),
          players_max: r.players_max,
          protocol: r.protocol,
          created_at: r.created_at,
          uptimeRatio20d,
        },
        PROTOCOL_VERSION,
        now,
      ),
    };
  });

  listed.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1; // pinned
    return b.score - a.score;
  });

  return jsonResponse(
    { generatedAt: now, servers: listed },
    200,
    // Doc 02 §11: 30 s cache with stale-while-revalidate. (caches.default
    // per-colo wiring is the M5 browse milestone; headers suffice for M3.)
    { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  );
};
