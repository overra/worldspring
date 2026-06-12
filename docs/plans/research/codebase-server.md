# DEADCOAST server/infra map

Research doc for design agents. Every claim below was verified against the code in this
worktree (branch `claude/happy-pasteur-6efda4`) or against current Cloudflare docs (URLs
inline). File references are `path:line` against this repo.

The one-paragraph version: a single Cloudflare Worker (`src/server/worker.ts`) fronts a
single global `GameRoom` Durable Object (`env.GAME.getByName("main")`) that runs the whole
game — 15Hz `setInterval` tick while anyone is connected, WebSockets accepted via the
hibernation API but *never actually hibernating mid-session* (the interval pins it),
in-memory live sim, SQLite (`new_sqlite_classes`) for durable snapshots through exactly one
transaction shape (`persistAll`). Static assets are served by the Workers assets platform in
front of the Worker. There are zero vars and zero secrets today; the only binding is `GAME`.

---

## 1. Worker routes

`src/server/worker.ts` is 22 lines; read it before extending it. Routing today:

| Path | Behavior |
| --- | --- |
| `/ws` | Requires `Upgrade: websocket` else `426` (worker.ts:10-12); forwards to the DO via `env.GAME.getByName("main")` (worker.ts:13-14). |
| `/api/leaderboard` | Forwarded to the same DO stub (worker.ts:16-19). |
| `/api/health` | Same (worker.ts:16-19). |
| anything else reaching the worker | `404 Not found` (worker.ts:20). |

The DO's own `fetch` (GameRoom.ts:163-223) then handles:

- **`/api/leaderboard`** (GameRoom.ts:165-172): returns `topLeaderboard(sql, 10)` —
  a JSON array of up to 10 `LeaderboardEntry` rows
  `{ name, survivedS, kills, zombieKills, distanceM, by, endedAt }`
  (shape: src/shared/protocol.ts:156-165; query: src/server/persistence.ts:362-387,
  ordered `survived_s DESC, ended_at DESC`). Headers: `content-type: application/json`,
  `access-control-allow-origin: *`.
- **`/api/health`** (GameRoom.ts:175-197): returns
  `{ players, zombies, animals, drops, corpses, loot, tickMsEma, tickMsMax, tick, uptime }`.
  All counts read from the in-memory `game` and are `0`/absent-defaults while the room is
  idle — the route deliberately never calls `ensureGame()` ("we never wake the sim to
  answer", GameRoom.ts:173-174). `tickMsEma`/`tickMsMax` come from the tick instrumentation
  (section 5). Also CORS `*`. No auth on either route — they are read-only and public by
  design (the loadtest consumes `/api/health`).
- **Anything else** on the DO is treated as a WebSocket upgrade attempt: `426` without the
  Upgrade header (GameRoom.ts:198-200), `503 "Server full"` when
  `ctx.getWebSockets().length >= MAX_PLAYERS` (GameRoom.ts:201-203, `MAX_PLAYERS = 24`,
  src/shared/constants.ts:31).

### Static assets

`wrangler.jsonc:6-8` declares `assets: { not_found_handling: "single-page-application" }`
with no `binding` and no `run_worker_first`. The assets directory is injected at build time
by the Vite plugin (`"directory": "../client"` in the generated `dist/survival_game/wrangler.json`
— verified in the main repo's build output). Consequences, verified against
<https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>:

- Requests matching a built asset are served by the platform; the Worker never runs.
- **Navigation requests** (browser requests carrying `Sec-Fetch-Mode: navigate`) that don't
  match an asset are served `/index.html` directly **without invoking the Worker**. This
  means typing `https://…/api/health` into a browser address bar returns the game's HTML,
  not JSON. `curl` and in-page `fetch()` are non-navigation and reach the Worker normally.
  If a future route must win for browser navigations (e.g. an `/admin` page rendered by the
  worker), it needs `run_worker_first` route patterns — which disables the header-based
  detection for those patterns.
- Non-navigation requests not matching an asset invoke the Worker — this is how `/ws`
  (Upgrade request) and the `/api/*` fetches get through.

`public/` (icons, GLB models, sfx) is copied into the asset output verbatim; `index.html`
at the repo root is the Vite entry.

---

## 2. GameRoom lifecycle

`GameRoom extends DurableObject<Env>` (GameRoom.ts:134), declared with
`new_sqlite_classes: ["GameRoom"]` in the v1 migration (wrangler.jsonc:17-22), so
`ctx.storage.sql` (synchronous) and `ctx.storage.transactionSync` are available
(persistence.ts:1-4).

### Boot

Constructor (GameRoom.ts:153-161): `blockConcurrencyWhile` → `initSchema(sql)` +
`pruneStaleCharacters(sql)` (drops character rows untouched for 30 days,
persistence.ts:174-179), then registers the death sink callback. The *world* is built
lazily: `ensureGame()` (GameRoom.ts:352-365) runs `createWorld(WORLD_SEED)`
(`WORLD_SEED = 1337`, constants.ts:4), hydrates the dynamic world from SQLite via
`loadWorld` — or `stockInitialLoot` on a fresh DB — then spawns zombies and deer fresh
(they are intentionally never persisted, GameRoom.ts:359, persistence.ts:127).

### Tick start/stop

- `startTicking()` is called from `fetch` on every WebSocket upgrade (GameRoom.ts:209);
  it is a plain `setInterval(() => this.timedTick(), TICK_MS)` (GameRoom.ts:367-370),
  `TICK_MS = 1000/15` (constants.ts:16-17).
- The tick stops in two places, both gated on "no sockets AND no lingering offline bodies":
  `dropSocket` (GameRoom.ts:562-569 — note the filter excluding the socket whose close
  handler is currently running) and the top of `tick()` itself (GameRoom.ts:631-634). Both
  call `stopAndPersist` (GameRoom.ts:613-622) which force-saves any lingering offline
  players, runs `persistAll`, and clears the interval.
- While alive-but-disconnected bodies linger (`LOGOUT_LINGER_S = 60`, constants.ts:176)
  the tick keeps running with **zero sockets** so zombies can still kill them
  (GameRoom.ts:558-561, 629-634).

Tick body order (GameRoom.ts:626-706): expire lingers → close dirty disconnects silent past
`LIVENESS_TIMEOUT_MS = 15s` (GameRoom.ts:116, 654-664; the client pings every 2s,
connection.ts:23) → `applyQueuedInputs` → deferred attacks (with lag-comp aim time) →
zombies → survival → weather → airdrops → wildlife → fires → loot/corpse TTLs → advance
`game.time`/`game.tick` → `capturePosHistory` (lag-comp ring, ~9 frames at 15Hz,
state.ts:295-317) → periodic `persistAll` every `WORLD_SAVE_INTERVAL_S = 20`
(GameRoom.ts:698-701, constants.ts:178) → flush outbox → per-player snapshots.

### Hibernation: the precise answer

GameRoom uses the **WebSocket Hibernation API surface** — `this.ctx.acceptWebSocket(server)`
(GameRoom.ts:207) plus `webSocketMessage`/`webSocketClose`/`webSocketError` handler methods
(GameRoom.ts:243, 342, 346) — but it **never hibernates while a session is live**, because
hibernation requires (among other conditions) *no `setTimeout`/`setInterval` scheduled
callbacks* (Cloudflare DO lifecycle doc:
<https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>).
The 15Hz interval therefore pins the object in memory exactly as long as it matters, which
is why the connection-state maps are plain in-memory `Map`s keyed by WebSocket
(GameRoom.ts:136-142) and `ws.serializeAttachment` is not used anywhere. Once the last
socket drops and lingers expire, the interval is cleared and the object can hibernate/be
evicted normally; the next `/ws` or `/api/*` request cold-starts it and `ensureGame()`
rebuilds the world from `WORLD_SEED` + the SQLite snapshot.

**Known sharp edge for designers:** if the platform ever restarts the DO *while hibernation-
accepted sockets are still open* (deploy, host drain — not the normal idle path), the
constructor reruns with empty `playerBySocket` maps, and: (a) `join` is only sent by the
client in `ws.onopen` (connection.ts:71-75), so existing sockets never re-join; (b)
`startTicking()` is only called from `fetch` (GameRoom.ts:209), so the tick does not resume
for those sockets; (c) pings still get pongs (handled before the join gate,
GameRoom.ts:251-254) so the socket looks healthy while the world is frozen. Recovery today
is the user reconnecting. Any feature that depends on long-lived sessions across deploys
needs to address this (rejoin handshake or `startTicking` from `webSocketMessage`).

### In-memory vs SQLite

In-memory only (lost on restart, by design): the entire live `GameState`
(state.ts:221-254 — players, zombies, deer, loot/corpse/fire/drop entities, weather,
events/outbox queues, `posHistory` lag-comp ring), connection maps and rate-limit windows
(GameRoom.ts:136-142), and tick timing stats (GameRoom.ts:146-151). Zombies and deer are
*never* persisted — always respawned fresh (GameRoom.ts:359-360, persistence.ts:127, 151-152).

SQLite (durable), schema created in `initSchema` (persistence.ts:79-117):

| Table | Shape | Notes |
| --- | --- | --- |
| `meta` | `key TEXT PK, value TEXT` | `schema_version`, `world_seed`, `game_time`, `game_tick`, `next_entity_id`, `weather`, `weather_next_at`, `weather_raining`, `airdrop_next_at`, `world_saved` (persistence.ts:107-117, 155-163). |
| `characters` | `token_hash TEXT PK, id, name, alive INTEGER, state_json, pending_recap_json, updated_at` | `state_json` is `CharacterState` = core + vitals + inventory + selectedSlot + stats + savedAt (persistence.ts:37-47). Keyed by SHA-256 of the client token. |
| `world_state` | `kind TEXT, payload TEXT` | One JSON row per dynamic entity, kinds: `loot`, `corpse`, `fire`, `loot_timer`, `drop` (persistence.ts:128-165). Wholesale wipe+reinsert every save; <200 rows. |
| `leaderboard` | `name, survived_s, kills, zombie_kills, distance_m, died_to, ended_at` | Trimmed to `LEADERBOARD_MAX = 50` longest lives on every insert (persistence.ts:341-359, constants.ts:180). |

**Schema version: `SCHEMA_VERSION = 2`** (persistence.ts:34 — v2 was the military-compound
worldgen change). Versioning rule (persistence.ts:107-117): if `meta.schema_version` !=
current OR `meta.world_seed` != `WORLD_SEED`, **characters + world_state + meta are wiped,
leaderboard survives**. So: bump `SCHEMA_VERSION` whenever the persisted shape or worldgen
changes incompatibly; the leaderboard is the only thing that crosses wipes.

### The persistAll transaction pattern

`persistAll(game)` (GameRoom.ts:598-606) is **the only way anything gets saved**: one
`ctx.storage.transactionSync` wrapping `saveWorld` (itself transactional — nested
`transactionSync` is fine) plus `saveCharacter` for *every* player (online, lingering,
dead). Rationale in the comment at GameRoom.ts:594-597: world entities and inventories
trade items; saving either alone opens duplication/destruction windows across an unclean
restart. Call sites: respawn (GameRoom.ts:300), every join path (461, 487, 503), disconnect
linger start (547), death (591), linger expiry (650), the 20s periodic save (700), and
`stopAndPersist` (620). **New systems that move items between a player and the world must
trigger `persistAll`, not a bespoke partial save.** (`handleDeath` additionally writes the
leaderboard row + `markCharacterDead` outside the transaction, GameRoom.ts:575-592 — the
character/world coherence still comes from the trailing `persistAll`.)

---

## 3. Join flow

### Client side

- **Identity**: anonymous token, 16 random bytes hex-encoded (32 hex chars), persisted in
  `localStorage["dc_token"]` (connection.ts:32-58). `localStorage` throwing (private
  browsing) falls back to an in-memory session token. Validation regex on read:
  `/^[0-9a-f]{32,64}$/i` (connection.ts:46).
- `connect(name)` opens `wss?://${location.host}/ws` and, on open, sends
  `{ t: "join", name: name.slice(0, MAX_NAME_LENGTH), token }` (connection.ts:60-75;
  `MAX_NAME_LENGTH = 16`, constants.ts:30). Pings every 2s (connection.ts:23, 166-171).
- On `welcome` the client builds the world from **`msg.seed`** — not a local constant —
  via `createWorld(msg.seed)` (connection.ts:260). The welcome message is how the seed
  reaches clients (GameRoom.ts:514-524, `seed: game.world.seed`; protocol.ts:194-206).
  This is the determinism contract's transport: any config affecting worldgen must ride
  this message (or an equivalent) to stay client/server-identical.

### Server side

`parseClientMsg` (protocol.ts:245-315) is the trust boundary: 8KB payload cap, join token
must match `/^[0-9a-f]{32,64}$/i` (protocol.ts:259), input batches truncated to 40 cmds,
chat transport-capped at 512 chars. Per-socket rate limit: 600 messages per 5s window,
violators closed with 1008 (GameRoom.ts:118-119, 226-241). Sockets that never join are
closed after `JOIN_TIMEOUT_MS = 10s` (GameRoom.ts:113, 213-221).

`handleJoin` (GameRoom.ts:407-505) hashes the token (SHA-256 hex, GameRoom.ts:97-102) and
resolves in priority order:

1. **Token already in the live world** (GameRoom.ts:422-464): reconnect during logout
   linger or a second tab/device — the new socket adopts the character, the old socket is
   closed `1008 "session taken over"`, no capacity consumed. If the character is dead, the
   death message is re-sent so the new client lands on the death screen.
2. **Living character in SQLite** (GameRoom.ts:481-489): room restarted since they left —
   `restorePlayer` rebuilds it (players.ts:143-182; `bornAt` shifted by offline gap so
   leaderboard time never counts logout time). **The persisted name stays authoritative**
   — it is deliberately *not* re-deduplicated against online players (comment at
   GameRoom.ts:477-480).
3. **Dead row or no row** (GameRoom.ts:494-504): new life via `sanitizeName` +
   `createPlayer`; a pending offline-death recap is delivered exactly once and cleared.

Capacity is double-checked at join time against *connected* (non-offline) players
(GameRoom.ts:466-473) in addition to the socket-count check in `fetch`.

### Sanitization precedents (reuse these, don't invent new ones)

- `STRIP_TEXT_RE` (players.ts:41-43): strips C0/C1 controls, DEL, zero-width chars
  (U+200B-200F), bidi embeddings/overrides/isolates (U+202A-E, U+2066-2069), word-joiner
  block (U+2060-2064), BOM. Shared by names and chat. The comment explains why: zero-width
  chars defeat empty-string guards, bidi overrides reverse rendered text in other clients.
- **Names** (`sanitizeName`, players.ts:46-60): strip → trim → cap at `MAX_NAME_LENGTH`
  **by code points** (spread + slice — never splits surrogate pairs) → default `"Survivor"`
  → de-duplicate against online players with `-2`, `-3`… suffixes.
- **Chat** (`handleChat`, GameRoom.ts:317-340): strip to spaces → collapse whitespace →
  trim → code-point cap at `CHAT_MAX_LENGTH = 120` → re-trim. Rate limit
  `CHAT_COOLDOWN_S = 0.8` of game time per player; delivery only to online players within
  `CHAT_RADIUS = 40` 2D (constants.ts:167-169); sender gets their own echo as delivery
  confirmation; offline lingering bodies neither send nor receive.

---

## 4. Deploy story

### Pipeline

`npm run deploy` = `vite build && wrangler deploy` (package.json:10). Tooling:
`vite ^8.0.16`, `wrangler ^4.99.0`, `@cloudflare/vite-plugin ^1.40.1` (package.json:25-34).
Typecheck is two tsc projects: `tsconfig.client.json` (src/client + src/shared, DOM libs)
and `tsconfig.server.json` (src/server + src/shared + `worker-configuration.d.ts`, no DOM).

### What @cloudflare/vite-plugin does (verified against the main repo's build output)

`vite.config.ts:7` registers `cloudflare()`. `vite build` then emits:

- `dist/client/` — the SPA assets (hashed JS/CSS chunks, `index.html`, copied `public/`).
  `vite.config.ts:13-41` pins two Rolldown chunk groups (`vendor-react` eager,
  `vendor-three` lazy) — don't disturb these; the comments explain the menu-weight
  rationale.
- `dist/survival_game/` — the worker: a single bundled `index.js` plus a **generated
  `wrangler.json`** (resolved from the root `wrangler.jsonc`) with `main: "index.js"`,
  `assets.directory: "../client"`, `no_bundle: true`, and all bindings/migrations carried
  over.
- `.wrangler/deploy/config.json` — `{"configPath":"../../dist/survival_game/wrangler.json"}`.
  This redirect is why a plain `wrangler deploy` from the repo root uploads the *built*
  worker + assets rather than trying to bundle `src/server/worker.ts` itself.
  (Plugin docs: <https://developers.cloudflare.com/workers/vite-plugin/>.)

So `wrangler deploy` uploads: the worker bundle (server + shared code), the static asset
manifest/files from `dist/client`, the DO binding (`GAME` → `GameRoom`), the v1
`new_sqlite_classes` migration, and `observability: { enabled: true }` (wrangler.jsonc:23-25).
Deployed name `survival-game` (wrangler.jsonc:3) → `survival-game.adam-730.workers.dev`.

Local dev: `npm run dev` runs Vite with the plugin's workerd integration — client on
:5173, the worker + DO running in local workerd with local SQLite (README.md:12-14).
The loadtest header (scripts/loadtest.mjs:6-7) targets `ws://localhost:4173/ws`, i.e.
`vite preview` of a production build.

### Env/bindings surface and parameterizing a deployment

Today the `Env` interface contains exactly one binding:
`GAME: DurableObjectNamespace<GameRoom>` (worker-configuration.d.ts:4-5, regenerate with
`npm run cf-typegen`). `vars` is empty, there are no secrets, no KV/R2/D1.

To parameterize a fork/instance deployment you would need:

- **Name/domain**: change `name` in wrangler.jsonc:3 (one line; the generated config
  inherits it).
- **World seed**: `WORLD_SEED = 1337` is a compile-time constant (constants.ts:4). The
  *client never needs it at build time* — it builds from `welcome.seed`
  (connection.ts:260). Server-side it is consumed in exactly two places:
  `ensureGame()` (GameRoom.ts:354) and the seed-mismatch wipe check in `initSchema`
  (persistence.ts:17, 109, 116). A `vars.WORLD_SEED` read through `this.env` and threaded
  into those two call sites would make seed a deploy-time var with zero client changes —
  and the existing wipe-on-mismatch logic already handles seed changes safely (characters
  + world wiped, leaderboard kept). Caveat: keep the constant as the default so local dev
  and the deterministic shared-sim story stay intact.
- **Gameplay tunables** (MAX_PLAYERS etc.) are compile-time by contract — they live in
  `src/shared/constants.ts` and many are baked into the *client* bundle too. Making any of
  them per-deployment vars means they no longer match the client unless transported in
  `welcome` like the seed. Flag this honestly in any design that wants per-instance tuning.
- **Secrets**: none exist; anything new (admin token, directory registration key) is a
  `wrangler secret put` + an `Env` field.

### Determinism guardrail (binding, repeat of the contract)

World gen draws from ordered seeded rng streams; existing draw order must never change.
New generation features take NEW hash-salted streams (precedent: salts like `^0x6a09e6` in
src/shared/world.ts). Any worldgen-affecting config must reach client and server
identically — today that transport is the `welcome` message's `seed` field.

---

## 5. Perf envelope

### Measured (commit 914fd65, local workerd via `vite preview`)

`node scripts/loadtest.mjs ws://localhost:4173/ws 20 120` → 20 protocol-faithful bots,
120s: **100% joins, 0 unexpected closes, tick 0.51ms EMA / 3ms max (<1% of the 66.7ms
budget), ~52 KB/s snapshot bandwidth per bot, 9 deaths / 9 respawns** (commit message of
914fd65; harness: scripts/loadtest.mjs — zero-dep Node 22+ ESM, mirrors
constants/protocol/cadences and reports join success, KB/s, RTT p50/p95, close codes, and
the final `/api/health`). The harness exits non-zero on join failures or unexpected closes,
so it is CI-able.

### Instrumentation

`timedTick` (GameRoom.ts:386-405): EMA (alpha 0.1), windowed max (two rotating 5s windows,
so spikes age out in ~5-10s), warn log on ticks >40ms. Surfaced as
`tickMsEma`/`tickMsMax` on `/api/health`. **Caveat baked into the comment
(GameRoom.ts:382-385): deployed workerd only advances timers at I/O boundaries, so
pure-CPU ticks can read artificially low in production; local dev numbers are real.**

### Interest filtering (per-player snapshot, GameRoom.ts:721-854)

- Players/zombies/animals/fires/events: 2D radius `INTEREST_RADIUS = 220` (constants.ts:20).
- Loot/corpses: `LOOT_INTEREST_RADIUS = 120` (constants.ts:21).
- **Airdrops are never filtered** — island-wide smoke column (GameRoom.ts:801-803).
- Events can be targeted (`onlyTo`, e.g. `hurt` to the victim) or position-filtered
  (GameRoom.ts:828-835).
- Coordinates are rounded (2dp positions, 3dp yaw) to keep JSON small (GameRoom.ts:93-94).

### What actually limits room size

1. **Hard cap**: `MAX_PLAYERS = 24` enforced at upgrade (socket count, GameRoom.ts:201) and
   at join (connected count, GameRoom.ts:466-473).
2. **Snapshot cost**: per tick the server builds and `JSON.stringify`s one snapshot per
   connected player, each scanning every entity map (O(players × entities) per tick at
   15Hz). At 20 bots this is ~0.5ms; it grows roughly quadratically with co-located player
   density (interest overlap) and linearly with entity counts (zombie cap 60 + 14 military,
   loot <200 rows, deer 10).
3. **Bandwidth**: ~52 KB/s per client (JSON, uncompressed) at 20-bot density. The protocol
   header (protocol.ts:2-3) explicitly calls JSON "v1 — fast enough at this scale"; a
   binary/delta protocol is the known lever if this becomes the limit.
4. **Single DO = single thread = single room**: `getByName("main")` (worker.ts:13) is the
   only room. Horizontal scale means routing `/ws` to other DO names (e.g.
   `getByName(roomId)`) — the GameRoom code itself is already room-agnostic; the seed and
   persistence are per-DO-instance.
5. SQLite writes are not the bottleneck: `persistAll` is wholesale but tiny (<200 world
   rows + ≤24 character rows every 20s, plus event-driven saves).

---

## 6. Where a second Worker (official site/directory) could live

Recommendation: **a sibling top-level directory with its own wrangler config**, deployed
independently — zero disruption to the game worker.

```
site/
  wrangler.jsonc      # name: "deadcoast-site" (its own workers.dev name / domain)
  src/worker.ts
  (optionally its own package.json + vite project if it serves a built frontend)
```

Why this shape:

- The root build/deploy is wired through the Vite plugin's deploy redirect
  (`.wrangler/deploy/config.json` → `dist/survival_game/wrangler.json`); a second worker
  deployed with `wrangler deploy -c site/wrangler.jsonc` is completely independent of that
  machinery. Add a root script `"deploy:site": "wrangler deploy -c site/wrangler.jsonc"`.
- The existing `tsconfig.server.json` includes only `src/server` + `src/shared`
  (tsconfig.server.json:6) — a `site/` tree doesn't perturb typechecking; give it its own
  tsconfig if it grows.
- Don't add the site to the game worker: the SPA `not_found_handling` swallows browser
  navigations to non-asset paths (section 1), the release cadences differ, and the game
  worker's 404 fall-through (worker.ts:20) is currently a guarantee that nothing else
  lives there.

Integration options, cheapest first:

1. **Public HTTP**: the site/directory polls each instance's public `/api/health` and
   `/api/leaderboard` — both already send `access-control-allow-origin: *`
   (GameRoom.ts:168-170, 191-195), so even client-side fetches from another origin work
   today. For a community-instance directory this is the right interface: it works against
   *any* deployment with zero changes to the game worker.
2. **Cross-script DO binding**: a second worker in the same account can bind the existing
   namespace via `durable_objects.bindings` with `script_name: "survival-game"` — only
   needed if the site wants DO-internal access rather than the public API. Not recommended
   until a concrete need exists.
3. **Auxiliary workers via the Vite plugin** (the generated config shows
   `"auxiliaryWorkers": []`): supported, but it couples the site into the game's build and
   deploy; only worth it if the site must share the game's dev server.

New endpoints on the *game* worker (e.g. a directory heartbeat or richer `/api/info`)
slot into the `if` chain in worker.ts:16-19 and the DO `fetch` in GameRoom.ts:163-197;
follow the `/api/health` precedent: read-only, no auth, CORS `*`, never wake the sim.

---

## Appendix: constants designers will reach for

All in `src/shared/constants.ts` (the contract says every tunable lives here):
`TICK_RATE 15` (:16), `MAX_PLAYERS 24` (:31), `INTEREST_RADIUS 220` (:20),
`LOOT_INTEREST_RADIUS 120` (:21), `WORLD_SEED 1337` (:4), `LOGOUT_LINGER_S 60` (:176),
`WORLD_SAVE_INTERVAL_S 20` (:178), `LEADERBOARD_MAX 50` (:180), `MAX_NAME_LENGTH 16` (:30),
`CHAT_RADIUS 40` / `CHAT_MAX_LENGTH 120` / `CHAT_COOLDOWN_S 0.8` (:167-169),
`INPUT_BUDGET_CAP_S 0.4` (:26), `LAG_COMP_MAX_REWIND_S 0.35` (:164).

Two acknowledged contract gaps (constants defined locally, not shared):
`INPUT_QUEUE_CAP = 60` (players.ts:29) and `POS_HISTORY_SLACK_S = 0.2` (state.ts:288) —
both flagged as such in code comments; follow that precedent if you must add a
server-internal knob, but prefer `constants.ts`.
