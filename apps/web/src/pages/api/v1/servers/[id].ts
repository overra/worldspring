// DELETE /api/v1/servers/:id — owner delist with the bearer token: immediate
// hard delete, cascades probes/stats/reports (doc 02 §4/§7). Token lost =
// delist via admin + re-register; no recovery in v1 (doc 02 §5).
//
// NOTE for API scripters: Astro's built-in CSRF origin check (security.
// checkOrigin, deliberately left ON for future cookie-authed admin routes)
// 403s cross-origin non-GET requests that lack a JSON content type — send
// `content-type: application/json` on DELETE/POST calls made outside a
// browser. Bearer auth itself is CSRF-immune; this is framework posture.
import type { APIRoute } from "astro";
import { parseServerToken, sha256Hex } from "@worldspring/shared/directory";
import { directoryEnv, emptyResponse } from "../../../../lib/db";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const { DB } = directoryEnv();

  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const parsed = parseServerToken(bearer);
  if (!parsed || parsed.serverId !== params.id) return emptyResponse(401);

  const row = await DB.prepare(
    "SELECT token_hash, token_hash_next, status FROM servers WHERE id = ?",
  )
    .bind(parsed.serverId)
    .first<{ token_hash: string; token_hash_next: string | null; status: string }>();
  if (!row) return emptyResponse(401);

  const presented = await sha256Hex(parsed.secretHex);
  // Either rotation-window hash authenticates (doc 01 §7).
  if (presented !== row.token_hash && presented !== row.token_hash_next) {
    return emptyResponse(401);
  }

  // Banned rows are frozen (mirrors heartbeat/verify): a hard delete would
  // cascade away the reports evidence AND free the URL for immediate
  // re-registration whenever moderation set status='banned' without a
  // matching banned_hosts row.
  if (row.status === "banned") return emptyResponse(410);

  // D1 runs with foreign_keys on: the CASCADEs in migration 0002 clear
  // probes/stats_hourly/reports.
  await DB.prepare("DELETE FROM servers WHERE id = ?").bind(parsed.serverId).run();
  return emptyResponse(204);
};
