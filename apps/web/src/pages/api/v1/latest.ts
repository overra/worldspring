// SSR JSON endpoint (runs on the Worker). Honors doc 02's documented contract:
// `GET /api/v1/latest` → `{ version, protocol }` of the current release (build-
// time constants), used by clients/servers for an "update available" hint.
//
// Values are the build-time constants (doc 02 §3 "latest release is NOT a
// table"): releasing the game = redeploy apps/web too. Reads D1 for a
// registered count, kept as a non-contractual extra field.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { GAME_VERSION } from "@worldspring/shared/version";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";

export const prerender = false;

const VERSION = GAME_VERSION;
const PROTOCOL = PROTOCOL_VERSION;

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
