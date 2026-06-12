// Worldspring directory prober — a standalone cron Worker.
//
// Astro is request-driven and exposes no scheduled() entrypoint, so the periodic
// liveness sweep lives here. It binds the SAME D1 as apps/web (reads `servers`,
// writes liveness) and runs no migrations. The full probe state machine — SSRF
// guard, ServerInfo shape validation, challenge re-check, ranking — lands with
// doc 02 §6; this is the scaffold.
//
// Platform discipline (doc 09): a cron invocation is capped at 50 subrequests
// and 6 open connections. So the real sweep must: SELECT a bounded due-set
// (LIMIT ~45, oldest-probed first → round-robin across 5-min runs), probe with a
// worker pool of 6 (cancel non-2xx bodies to free connections), and fold ALL
// liveness writes into a SINGLE env.DB.batch([...]) — never per-server UPDATEs.

interface Env {
  DB: D1Database;
}

const DUE_LIMIT = 45;

async function runProbeSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  // Bounded due-set, oldest-probed first.
  const due = await env.DB.prepare(
    "SELECT id, url FROM servers ORDER BY last_probe_at ASC LIMIT ?",
  )
    .bind(DUE_LIMIT)
    .all<{ id: string; url: string }>();

  // TODO(doc 02 §6): probe each row's GET /api/server-info with a pool of 6,
  // validate + challenge-check, then one env.DB.batch([...]) writeback. No-op scaffold.
  void due;
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
