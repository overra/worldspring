// SSR JSON endpoint (runs on the Worker). Honors doc 02's documented contract:
// `GET /api/v1/latest` → `{ version, protocol }` of the current release (build-
// time constants), used by clients/servers for an "update available" hint.
//
// The real values come from doc 03's GAME_VERSION + PROTOCOL_VERSION (not built
// yet) — placeholders until then. Proves the v13 `cloudflare:workers` env API
// (Astro.locals.runtime was removed) by reading D1 for a registered count, kept
// as a non-contractual extra field.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

// TODO(doc 03): import GAME_VERSION + PROTOCOL_VERSION from @worldspring/shared.
const VERSION = "0.0.0-scaffold";
const PROTOCOL = 0;

export const GET: APIRoute = async () => {
  let servers = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM servers").first<{
      n: number;
    }>();
    servers = Number(row?.n ?? 0);
  } catch {
    // D1 not migrated in local dev
  }
  return Response.json({ version: VERSION, protocol: PROTOCOL, servers });
};
