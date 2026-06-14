# CI/CD

## `ci.yml` — checks (every PR + push to `main`)

Runs the things CodeRabbit can't: `pnpm -w typecheck`, `pnpm -w test` (shared
vitest + the game persist/wipe/loot scripts), `pnpm -w build`, and the worldgen
**determinism fingerprint** (fails on any drift vs
`packages/shared/scripts/world.fingerprint.txt`). No secrets, runs on fork PRs.

Node is pinned exact via `.nvmrc` (currently `22.21.1`). The fingerprint is
**Linux-canonical** — it mixes exact Float64 height bytes, and V8 transcendentals
differ by an ULP across OSes (seed 0 diverges macOS↔Linux). Linux is the
deployment platform (workerd), so the baseline is the Linux value; regenerate it
**in CI / on Linux**, and expect `pnpm fingerprint` on a Mac to mismatch seed 0.
Bumping `.nvmrc` may shift hashes too — regenerate then.

### Production deploy (`deploy-prod` job, push to `main` only)

After `verify` passes on a push to `main` (a merged PR), `deploy-prod` builds and
ships the **game** Worker to production (`worldspring`) via the same
`cloudflare/wrangler-action` as the preview — minus the `--name` / `--var TESTBED`
overrides, so prod stays var-less (the testbed never reaches it) and
`keep_vars: true` (`apps/game/wrangler.jsonc`) preserves an operator-set
`GAME_CONFIG` across deploys. It uses the same `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` secrets (skips **green** if unset), runs only on `main`
(never on PRs/forks — secrets stay off untrusted code), and the file-level
concurrency cancels a superseded run so a burst of merges ships only the latest
`main`.

**Game only.** `apps/web` (site/directory) and `apps/prober` (cron) have no deploy
automation yet — ship them manually with `pnpm deploy:web` / `pnpm deploy:prober`.
There's no manual approval gate; add a GitHub **Environment** with required
reviewers to the `deploy-prod` job if you want one.

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
