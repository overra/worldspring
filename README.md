# Worldspring

A browser-native multiplayer survival game on a procedurally generated island:
loot towns, manage hunger/thirst/temperature, and outlast zombies and other players.
DayZ-inspired at its core, and underneath it a platform for browser-native,
self-hostable multiplayer worlds — you fork it, point a coding agent at it, and deploy
the result to your own Cloudflare (see [docs/plans/00](docs/plans/00-agent-moddable-platform.md)).
Persistent authoritative server on a Cloudflare Durable Object; React Three Fiber client
with client-side prediction. The visual style mixes low-poly primitives with compact
authored/generated GLBs; procedural tree variants are baked offline and instanced at
runtime.

## Run your own · mod your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/overra/worldspring)

One click clones this repo into **your** GitHub account, provisions the `GameRoom`
Durable Object in **your** Cloudflare, and connects Workers Builds so your pushes
redeploy your server. You get a source fork, not a black box — no CLI, no bill from us,
pennies a month.

Then make it yours: `GAME_CONFIG` picks a preset (`deadcoast`, `ironcoast`, `driftwood`,
`homestead`, `warpath`, `arena`), and for anything deeper you point a coding agent at the
fork. `pnpm mod:check` is the guardrail — types, worldgen determinism, protocol
round-trip, sim + `GameMode` probes, build — run it before you deploy a mod, because the
break an agent is most likely to introduce (a stray `Math.random()` in the sim) is silent.

Full operator guide, including the CLI path and directory listing:
**[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**. The button flow is wired but not yet
click-tested against a fresh Cloudflare account — the monorepo build under Workers Builds
is the open risk (SELF_HOSTING has the workaround).

## Develop

This repo is a **pnpm workspace** (`apps/game`, `apps/web`, `apps/prober`,
`packages/shared`); see [docs/plans/09](docs/plans/09-monorepo-migration.md).

```sh
corepack enable     # pins pnpm 10 (per package.json "packageManager")
pnpm install
pnpm dev:game       # the game (Vite + workerd) — http://localhost:5173
pnpm dev:web        # the site + Starlight docs (Astro)
pnpm typecheck      # all packages (turbo)
pnpm build          # all packages (turbo)
pnpm deploy:game    # also: deploy:web, deploy:prober
```

Agent skills are restored from the committed `skills-lock.json`, not vendored —
on a fresh clone (or new git worktree) run `npx skills experimental_install`.
That fetches skill content into `.agents/skills/` (gitignored); the committed
`.claude/skills` → `../.agents/skills` symlink bridges it into the directory
Claude Code reads, so the one command is enough.

## Controls

WASD move · Shift sprint · Mouse look (click to lock) · LMB attack ·
E pick up · 1-8 hotbar · Tab inventory · G drop · V first/third person ·
Space jump

## How it works

- **One world per Durable Object** — `GameRoom` (`getByName("main")`) runs a
  15Hz tick: applies input commands, steps zombie AI, survival vitals,
  campfires/loot/day-night clock, then sends each client an interest-filtered
  snapshot. In-memory state only (v1): the world resets if the room restarts.
- **Deterministic shared sim** — `src/shared/` holds the seeded world gen
  (heightmap island, towns, buildings, trees, loot spawns) and the
  movement/collision step. Client and server both run it; the client predicts
  its own movement per frame, the server acks input sequence numbers, and the
  client replays unacked commands on each snapshot (reconciliation). Remote
  entities interpolate ~120ms behind.
- **Day/night** — 24h game day in 16 real minutes, server-clocked. Nights are
  dark and cold: body temp drops when exposed, campfires (and daytime) warm
  you back up. Shivering below 35°C drains HP.
- **Combat** — melee (fists/axe, server-side cone check) and a hitscan pistol
  (ray vs capsules with wall occlusion, consumes 9mm). Death drops your whole
  inventory as a lootable bag; you respawn fresh on a random beach.
- **Assets and physics** — `pnpm --filter @worldspring/game models:trees` bakes
  EZ-Tree variants into `trees.glb`; EZ-Tree never ships in the client. Rapier is
  the sole authoritative rigid-body engine. Three Pinata runs only in the lazy
  client scene to create bounded, cosmetic debris after a server-confirmed break.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module contracts and conventions.
