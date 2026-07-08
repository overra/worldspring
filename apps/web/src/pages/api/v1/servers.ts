// /api/v1/servers — POST = begin registration (doc 02 §5 Path B), GET = the
// public ranked list (doc 02 §4/§8).
import type { APIRoute } from "astro";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import {
  mintServerToken,
  normalizeServerUrl,
  probeServerInfo,
} from "@worldspring/shared/directory";
import {
  applyBrowse,
  canonicalListCacheUrl,
  parseBrowseParams,
} from "@worldspring/shared/browse";
import { sanitizeListingText, SERVER_MOTD_MAX } from "@worldspring/shared/text";
import {
  attemptAndCheckLimit,
  directoryEnv,
  emptyResponse,
  hashIp,
  jsonResponse,
  readJsonBody,
} from "../../../lib/db";
import { loadRankedList } from "../../../lib/listing";
import { listingNameOf } from "../../../lib/sanitize";

export const prerender = false;

const REGISTER_LIMIT_PER_HOUR = 5; // doc 02 §4
const BODY_MAX_BYTES = 4 * 1024; // doc 02 §4 general cap
// doc 02 §11: 30 s edge TTL. `max-age` doubles as the caches.default freshness
// window (the Cache API honors Cache-Control). `stale-while-revalidate=120` is
// ADVISORY-ONLY here: caches.default performs NO background revalidation, so once
// max-age lapses a hit is a plain MISS that rebuilds from D1 — the SWR token only
// informs browsers / downstream shared caches, none of which this Worker revalidates.
const LIST_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";

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

/**
 * The public ranked list (doc 02 §4/§8/§11): all `live` servers, official
 * pinned first, filtered/sorted/paginated PURELY by query params
 * (`preset`/`sort`/`page`/`pageSize`) so every view is a cacheable URL.
 *
 * Edge caching (doc 02 §11): the response is stored in `caches.default` keyed
 * on a CANONICAL per-query URL — param order and junk params don't fragment the
 * cache, but different filters get different entries. A cache HIT within the
 * 30 s TTL returns the SAME `generatedAt` (the acceptance assertion). Only the
 * 200 success path is ever cached; a D1 failure returns an uncached empty list
 * so a blip can't freeze an empty list at the edge for the full TTL.
 *
 * `caches.default` is per-colo (not replicated), so this costs ~2 D1 reads per
 * 30 s per colo-with-traffic, not globally.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const { DB } = directoryEnv();
  const now = Date.now();

  // Canonical cache key (query params included). String key is coerced to a
  // Request by the Cache API — the adapter's own image endpoint keys the same way.
  const cacheKey = canonicalListCacheUrl(request.url);
  // `caches.default` is a Workers extension; under Astro's DOM lib the global
  // `CacheStorage` type lacks it, so reach it through a cast (repo idiom for
  // env, too). Guarded so any non-workerd context degrades to a direct read.
  const cache =
    typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit; // same generatedAt for every hit within TTL
  }

  let list;
  try {
    list = await loadRankedList(DB, now, PROTOCOL_VERSION);
  } catch (err) {
    // Never cache a failure (would replay an empty list as fresh for the TTL).
    console.error("[servers] list build failed — uncached empty response:", err);
    return jsonResponse({ generatedAt: now, total: 0, page: 1, pageCount: 1, pageSize: 0, servers: [] });
  }

  const params = parseBrowseParams(new URL(request.url).searchParams);
  const paged = applyBrowse(list, params);

  const response = jsonResponse(
    {
      // Response-BUILD time (identical for every cache hit within the TTL — the M5
      // acceptance assertion). NOTE: this is NOT a data-freshness watermark and
      // cannot detect a dead cron/prober — it is always ~now even if probes stopped
      // hours ago. The §Threatens cron-staleness monitor needs a real data watermark
      // (e.g. MAX(last_probe_at) over live rows), deferred to launch wiring (M8).
      generatedAt: now,
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      servers: paged.rows,
    },
    200,
    { "cache-control": LIST_CACHE_CONTROL },
  );

  if (cache) {
    // Populate the cache off the response path (doc/CF best practice:
    // ctx.waitUntil does not block the response). No cfContext (some dev
    // contexts) → fire-and-forget; a missed put is just a future cache miss.
    const put = cache.put(cacheKey, response.clone());
    const cfContext = (locals as { cfContext?: ExecutionContext }).cfContext;
    if (cfContext) cfContext.waitUntil(put);
    else void put.catch((err: unknown) => console.error("[servers] cache put failed:", err));
  }
  return response;
};
