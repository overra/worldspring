// Worker entry: static assets are served by the platform; /ws upgrades and
// the leaderboard API go to the single global GameRoom Durable Object.

import { SERVER_INFO_CACHE_TTL_S } from "@worldspring/shared/constants";

export { GameRoom } from "./GameRoom";

// Per-isolate micro-cache for GET /api/server-info (doc 03 §5, option A). Keyed
// by origin; each isolate refreshes at most once per TTL, so a poll costs 1
// Worker request + at most 1 DO request per SERVER_INFO_CACHE_TTL_S per isolate.
// Deliberately module-scope (per-isolate, per-origin), NOT global/cross-colo:
// live fields need the DO, so this is a burst absorber, not pure-Worker serving.
interface InfoCacheEntry {
  body: string;
  expiresAt: number;
}
const infoCache = new Map<string, InfoCacheEntry>();

const SERVER_INFO_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=15, stale-while-revalidate=30",
};

/**
 * Serve GET /api/server-info from the per-isolate micro-cache, falling back to
 * the DO. Correctness invariants (doc 03 §3/§5):
 *  - cache ONLY res.ok GET responses;
 *  - HEAD (and any non-GET) passes through UNCACHED — if the platform strips
 *    bodies for HEAD at the DO-stub boundary, caching it would poison the
 *    shared origin-keyed entry with an empty body for every GET consumer;
 *  - a non-200 passes through with its real status, NEVER cached — replaying an
 *    error as a fresh 200 would lie to directory probes for a full TTL.
 */
async function serveServerInfo(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    // HEAD and anything else: pass through to the DO, never populate the cache.
    return env.GAME.getByName("main").fetch(request);
  }
  const origin = new URL(request.url).origin;
  const cached = infoCache.get(origin);
  if (cached && Date.now() < cached.expiresAt) {
    return new Response(cached.body, { headers: SERVER_INFO_HEADERS }); // only 200s are ever cached
  }
  const stub = env.GAME.getByName("main");
  const res = await stub.fetch(request);
  const body = await res.text();
  if (!res.ok) {
    // Never cache or mask a failure (§3/§7): consumers read non-200 as
    // unreachability; a cached error replayed as 200 would lie for the TTL.
    return new Response(body, { status: res.status, headers: SERVER_INFO_HEADERS });
  }
  infoCache.set(origin, {
    body,
    expiresAt: Date.now() + SERVER_INFO_CACHE_TTL_S * 1000,
  });
  return new Response(body, { headers: SERVER_INFO_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.GAME.getByName("main");
      return stub.fetch(request);
    }
    if (url.pathname === "/api/leaderboard" || url.pathname === "/api/health") {
      const stub = env.GAME.getByName("main");
      return stub.fetch(request);
    }
    if (url.pathname === "/api/server-info") {
      // Answer the (never-required) preflight cheaply in the Worker, without
      // touching the DO (doc 03 §3).
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET",
          },
        });
      }
      // Own branch (not the pass-through above) because it has the micro-cache.
      return serveServerInfo(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
