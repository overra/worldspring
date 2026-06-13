# CI/CD

## `ci.yml` — checks (every PR + push to `main`)

Runs the things CodeRabbit can't: `pnpm -w typecheck`, `pnpm -w test` (shared
vitest + the game persist/wipe/loot scripts), `pnpm -w build`, and the worldgen
**determinism fingerprint** (fails on any drift vs
`packages/shared/scripts/world.fingerprint.txt`). No secrets, runs on fork PRs.

## `preview.yml` — per-PR game preview

Each PR deploys its own throwaway Worker **`worldspring-pr-<N>`** with its own
Durable Object namespace — a **fresh, isolated world**. This is deliberate: a
preview must never share the production `GameRoom`/world, or a schema-changing PR
could trip the doc 04 M2 fail-closed wipe against live data. A bot comment posts
the `*.workers.dev` URL; it redeploys on every push and is **deleted when the PR
closes** (`wrangler delete … --force`, required because the Worker owns a DO).

Only the **game** is previewed today (web/prober are not). Fork PRs are skipped
(they can't access secrets).

### Required setup (one-time, by a maintainer)

1. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — an **"Edit Cloudflare Workers"** API token
     (covers script upload, the `workers.dev` subdomain route, DO migrations,
     and force-delete).
   - `CLOUDFLARE_ACCOUNT_ID` — the Worldspring account id.
2. **Workers Paid** is recommended — preview Workers are cheap per-request, but
   the free plan's script cap and CI build minutes get tight (matches the
   roadmap's "paid from day one" call).

These are independent of the doc 01 "deploy into the user's own account" flow —
previews deploy into the Worldspring account, not a visitor's.
