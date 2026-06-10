# DEADCOAST

A web-based DayZ-like: multiplayer survival on a procedurally generated island.
Loot towns, manage hunger/thirst/temperature, fight zombies and other players.
Persistent authoritative server on a Cloudflare Durable Object; React Three
Fiber client with client-side prediction. No 3D assets — everything is
low-poly primitives generated in code.

## Run

```sh
npm install
npm run dev        # vite + workerd locally — open http://localhost:5173
npm run typecheck  # client + server tsc projects
npm run deploy     # vite build && wrangler deploy
```

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for module contracts and conventions.
