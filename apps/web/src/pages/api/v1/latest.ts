// SSR JSON endpoint (runs on the Worker). Proves the v13 adapter env API
// (`Astro.locals.runtime` was removed → `import { env } from "cloudflare:workers"`)
// and that the @worldspring/shared package boundary resolves inside Astro's SSR
// build (vite.ssr.noExternal). The real directory API — heartbeat/registration
// with ServerInfo types — lands with doc 02/03.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { WORLD_SIZE } from "@worldspring/shared/constants";

export const prerender = false;

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
  // `_shared` is a scaffold smoke-test that the shared package resolves in SSR.
  return Response.json({ ok: true, servers, _shared: WORLD_SIZE });
};
