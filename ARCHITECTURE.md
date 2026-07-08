# Worldspring — multiplayer survival sandbox (web)

Multiplayer survival: spawn on the coast of an island, loot towns, manage
hunger/thirst/health/temperature, fight zombies and other players. Authoritative
server on a Cloudflare Durable Object; React Three Fiber client with prediction.

## Stack

- Client: Vite + React 19 + @react-three/fiber 9 + drei + zustand. Low-poly
  procedural look — **no external 3D assets**, primitives + flat colors + fog.
- Server: Cloudflare Worker + `GameRoom` Durable Object (one global room,
  `env.GAME.getByName("main")`), WebSocket at `/ws`, 15Hz tick.
- Shared deterministic sim in `packages/shared/` (`@worldspring/shared`) — world
  gen + movement run identically on both sides. **V8 on both ends; results match.**
- **Monorepo (pnpm workspace):** `apps/game` (this client + server/DO, Vite),
  `apps/web` (Astro landing + Starlight docs + server directory SSR/D1),
  `apps/prober` (cron Worker), `packages/shared` (the sim). Paths below that read
  `src/...` now live under `apps/game/src/...`; the sim moved to
  `packages/shared/src/`. See [docs/plans/09](docs/plans/09-monorepo-migration.md).

## Hard rules

- TypeScript strict. No `any`. Named exports only. Early returns.
- Import alias `@/` = `apps/game/src/` (game-local); the shared sim is the
  workspace package `@worldspring/shared` (e.g.
  `import { WALK_SPEED } from "@worldspring/shared/constants"`).
- `constants.ts` holds the DEFAULTS; `packages/shared/src/config.ts` holds the deploy-time `ServerConfig` layered on top at each system's point of use — never inline magic gameplay numbers.
- Yaw convention: yaw 0 faces **-Z**, forward = `(-sin(yaw), -cos(yaw))`
  (three.js Object3D rotation.y convention). Helpers in `@worldspring/shared/math`.
- High-frequency state lives in `src/client/runtime.ts` mutable objects, NOT
  React state. zustand (`src/client/state/store.ts`) is for UI-rate data only.
- Render components read `clientWorld` / `inputState`; only the net layer
  writes `clientWorld`; only the input controller writes `inputState`.
- Do not edit files outside your ownership area. If a contract is missing
  something you need, work around it locally and call it out in your report.

## File ownership map

Already written (read, do not modify):

- `packages/shared/src/*` (`@worldspring/shared`) — constants, rng, math, items, protocol, world, movement
- `src/client/runtime.ts` — `inputState`, `clientWorld`, `drainEvents`, `resetClientWorld`
- `src/client/state/store.ts` — `useUIStore` (zustand)
- `src/client/App.tsx`, `src/client/main.tsx`, `src/client/styles.css`
- `src/server/worker.ts` — routes `/ws` to the DO

To be built (one owner each):

- **SERVER** — `src/server/GameRoom.ts` + `src/server/systems/*`
- **NET** — `src/client/net/*` (connection, prediction, interpolation, NetSystem)
- **WORLD-RENDER** — `src/client/render/world/*`
- **ENTITY-RENDER** — `src/client/render/entities/*`
- **UI** — `src/client/ui/*`

## Component/API contracts

`App.tsx` already imports these — names and paths are fixed:

### NET (`src/client/net/`)

- `NetSystem.tsx` → `export function NetSystem(): null` — mounted inside
  `<Canvas>`; `useFrame` drives: input cmd sampling from `inputState`
  (consume edge flags), local prediction via `stepPlayer`, send batching
  (`INPUT_SEND_MS`), reconciliation against `snap.ack`/`snap.you`,
  interpolation of remote entities into `clientWorld` (delay
  `INTERP_DELAY_MS`), prompt computation (`promptLootId` + store prompt),
  ping measurement. `snap.you.action` (doc 11 M2 — the in-progress
  `{kind: ChannelKind; remainingS; totalS}` cast) is **render-only**: `connection.ts`
  pushes it to the store (`setAction`) for the HUD cast bar, and reconcile/prediction
  ignore it entirely (it is not a predicted field).
- `connection.ts` →
  - `export function connect(name: string): void` — opens
    `wss?://${location.host}/ws`, sends `join`, drives `useUIStore` phase.
  - `export function disconnect(): void`
  - `export function sendMsg(msg: ClientMsg): void` — no-op if socket not open.
  - Action helpers (thin wrappers over `sendMsg`): `doAttack()`,
    `doUse(slot)`, `doEquip(slot)`, `doPickup(id)`, `doDrop(slot)`,
    `doRespawn()`.
- On `welcome`: build `createWorld(seed)`, set `clientWorld.world`, `ready`,
  `myId`, seed `me` from `you`, store inventory, phase `playing`. Also clamp the
  additive optional `config` field (`clampConfig(msg.config)`, never the raw
  object) into `clientWorld.config`. (Doc 04 M6 later amends this to
  `createWorld(worldParamsOf(config.world))` for non-standard world tiers.)
- On `death`: phase `dead`, `setDeathCause`. On `inv`: update store. On
  `notice`: `pushNotice`. Keep socket open while dead (respawn reuses it).

### ENTITY-RENDER (`src/client/render/entities/`)

- `InputController.tsx` → `export function InputController(): null` — keyboard
  (WASD/shift/space), pointer lock on canvas click, mouse-look writes
  `inputState.yaw/pitch` (pitch clamped ±1.45 rad), edge flags (jump, attack on
  mouse down, interact E, drop G, slot keys 1-8 → `slotSelect`), V toggles
  `firstPerson`, Tab toggles `useUIStore.invOpen`. While `invOpen` or not
  pointer-locked: movement keys release & no attack.
  Calls net action helpers on edges: attack → `doAttack()`, interact →
  `doPickup(clientWorld.promptLootId)` when set, drop → `doDrop(selectedSlot)`,
  slot key → `doEquip(slot)` (+ optimistic `setSelectedSlot`).
- `PlayerCamera.tsx` → `export function PlayerCamera(): null` — third-person
  shoulder cam (default) / first-person on `inputState.firstPerson`, follows
  `clientWorld.me` + `inputState.yaw/pitch`. Eye height `PLAYER_EYE_HEIGHT`.
  Third person: ~3.5m behind, 0.45m right, camera collision optional.
- `RemotePlayers.tsx` / `Zombies.tsx` / `LootItems.tsx` / `Corpses.tsx` /
  `Campfires.tsx` / `EffectsLayer.tsx` — all `(): React.ReactElement | null`,
  read `clientWorld`
  maps/arrays per frame (imperatively position a pooled set of group refs —
  do NOT re-render React per snapshot). Low-poly humanoids from boxes;
  item-in-hand colored via `ITEM_DEFS[type].color`; zombies tinted green,
  lunge anim in `attack` state; loot = small bobbing/spinning colored boxes
  (bag = dark duffel); campfire = logs + emissive flame + `pointLight`;
  EffectsLayer drains `drainEvents()` → tracer lines for `shot`, hit flashes,
  brief muzzle flash; `hurt` events are handled by HUD (UI owner) — ignore here.

### WORLD-RENDER (`src/client/render/world/`)

All `(): React.ReactElement | null`. Wait for `clientWorld.world` (subscribe
via `useUIStore` phase or poll in useFrame; simplest: read once — components
mount only after `ready` since App renders Canvas post-welcome... NOT true:
Canvas mounts at phase `playing` which is set on welcome, so `clientWorld.world`
is non-null at mount. You may read it synchronously and keep a local ref).

- `Terrain.tsx` — one segmented plane geometry (~200x200 verts over
  `WORLD_SIZE`), displaced by `world.heightAt`, vertex colors by
  height/slope (sand < 1.5, grass, rock on steep/high), `flatShading`.
- `WaterPlane.tsx` — large translucent plane at `WATER_LEVEL`, slight
  opacity animation.
- `Buildings.tsx` — for each `world.buildings`: boxes for the wall AABBs,
  roof slab, floor slab, simple gable optional; muted colors by kind.
- `Trees.tsx` — `InstancedMesh` (conifer: cone(s)+trunk, oak: sphere+trunk),
  matrices from `world.trees`, two instanced meshes per part.
- `SkyAndLighting.tsx` — reads `clientWorld.timeOfDay` per frame: sun
  direction (directionalLight), ambient + hemisphere intensity, sky color,
  `scene.fog` color/density, stars at night (drei `<Stars>` with fade).
  Night (21–5) is genuinely dark. Smooth dawn/dusk ramps.

### UI (`src/client/ui/`)

- `MainMenu.tsx` → `export function MainMenu(): React.ReactElement` — title
  screen, name input (max `MAX_NAME_LENGTH`), Join button → `connect(name)`,
  shows `error`, connecting spinner state, controls legend.
- `HUD.tsx` → `export function HUD(): React.ReactElement` — vitals bars
  (hp/food/water + temp readout with shiver warning < `TEMP_SHIVER`), 8-slot
  hotbar (icons = colored swatches from `ITEM_DEFS`, count badges, selected
  highlight), crosshair dot, pickup prompt ("E — Canned Beans"), notices feed,
  clock (from `clockHours`) + player count + ping, damage vignette on `hurt`
  GameEvents (subscribe by polling store vitals drop or listen via a tiny
  store field — simplest: flash when `vitals.hp` decreases), full inventory
  panel when `invOpen` (Tab) with click-to-use (`doUse`), drop buttons
  (`doDrop`).
- `DeathScreen.tsx` → `export function DeathScreen(): React.ReactElement` —
  "YOU DIED — killed by X", respawn button → `doRespawn()`.

UI never touches three.js. It calls net action helpers and reads the store.

### MAP & CARTOGRAPHY (`src/client/render/map/` + `src/client/ui/`, doc 12)

A 2D-canvas map (never three.js) drawn from the world the client already rebuilds
from the seed. The shared, render-target-agnostic core is `packages/shared/src/map/`
(`projection` north-up +Z-up, `palette` lifted from `Terrain.tsx`, `raster`); it
feeds both an offline `pnpm --filter @worldspring/shared map:render` and the in-game
`mapBake.ts` (bake the biome+POI base once per seed to a detached canvas). `<Minimap>`
(corner, gated on `cfg.map.minimap`) and `<MapPanel>` (full screen, opened by the
`map` item, gated on `cfg.map.acquire`) mount in `App.tsx` and redraw off the rAF
frame on a timer. The `map` ItemType is **additive** (no `PROTOCOL_VERSION` bump —
all `ITEM_DEFS[type]` reads use `?? UNKNOWN_DEF`). `ServerConfig.map` is LIVE-class
(never in `worldFingerprintOf`). `map.reveal === "explored"` engages
**server-authoritative fog-of-war**: a per-character `ExploredGrid`
(`@worldspring/shared/fog`) is marked from the authoritative position each tick,
persisted as an additive `CharacterState.explored` base64 field (SCHEMA stays 2),
shipped as additive-optional `welcome.explored` (full set) + `snap.fog` (per-tick
delta) — both no-bump. Honest scope: the public seed means fog cannot hide static
terrain, only persist a server-blessed explored set.

### RENDER QUALITY & DEVICE TIERS (`src/client/state/settings.ts`, doc 08)

Client-only; no sim/wire surface. `QualityPreset = "mobile" | "low" | "medium"
| "high"`, each mapping to a `QualityConfig` (`maxDpr`, `postFx`, `shadows` +
`shadowMapSize`, `grassDensity`) consumed by `GameCanvas` (dpr cap), `PostFX`
(SMAA-only vs full chain — the composer always stays mounted; it is the
scene's only renderer), `SkyAndLighting` (sun shadows, live-reallocated map)
and `Grass` (blade density). `mobile` is the phone profile (dpr cap 1, no
post/shadows, minimal grass) — deliberately distinct from `low`, the desktop
fallback, so the two can diverge as knobs grow (doc 08 M5).

First load runs `detectTier()`: coarse pointer → `mobile`; else the
`WEBGL_debug_renderer_info` renderer string + dpr + cores + `deviceMemory` →
`low | medium | high`, with unknown/masked/blocked landing on `medium`. The
result persists as `tier` in the `ws_settings` blob and is never re-probed.
Any Esc-menu quality pick sets `userOverrodeQuality` — a manual choice is
sacred and detection never runs over it. `?tier=<preset>` forces a preset for
one session (QA) without touching the persisted choice; the F3 overlay shows
the active tier and its source (auto/manual/url). Three edit sites must stay
in sync when adding a preset: the union, `QUALITY_CONFIGS`, and `EscapeMenu`'s
`QUALITY_PRESETS` list.

### SERVER (`src/server/`)

- `GameRoom.ts` → `export class GameRoom extends DurableObject` —
  `fetch` accepts WebSocket pairs via `this.ctx.acceptWebSocket(server)`;
  `webSocketMessage` → `parseClientMsg`; `webSocketClose/Error` → despawn.
  Tick loop: `setInterval(TICK_MS)` started when first socket connects,
  stopped when empty (in-memory world state is fine for v1; no storage
  persistence). Connection state via `ws.serializeAttachment` or in-memory
  Map keyed by WebSocket (in-memory is fine since we never hibernate while
  players are connected — document it).
- Each tick: apply queued input cmds (clamp per `MAX_INPUT_DT`,
  `MAX_TICK_INPUT_DT`), zombie AI, combat cooldowns, survival vitals,
  campfire/loot/time systems, then per-player interest-filtered `snap`
  (include `you`, `ack`, events near the player, `hurt` only to victim).
- `systems/` split as pure-ish functions over a `GameState` you define:
  `zombies.ts`, `combat.ts`, `survival.ts`, `loot.ts` (tables from
  `@/shared/items`, spawn points from world, respawn timers, death bags),
  `players.ts` (join/spawn/respawn/inventory ops: use/equip/pickup/drop).
- Spawn: random `world.spawnPoints` (zombie-clear preferred); empty inventory;
  vitals full. Death: the body stays as a corpse entity carrying the whole
  inventory (`WireCorpse`, scavenged via the shared-id `pickup` message; the
  body persists until TTL even when emptied). Zombies leave corpses too, with
  a `ZOMBIE_LOOT_CHANCE` roll from `ZOMBIE_LOOT_TABLE`. Disconnecting while
  alive drops a corpse as well (combat-log deterrent). Notice + death msg,
  respawn on `respawn` request after the client shows the death screen.
- Items: `use` food/drink/heal consumes 1 (server clamps vitals); `use`
  campfire_kit places fire `CAMPFIRE_PLACE_DIST` in front; `attack` resolves
  fists/melee (`inMeleeCone`) or pistol (consumes `ammo_9mm` from inventory,
  `rayVerticalCylinder` vs zombies/players, `world.raycastStatics` occlusion,
  closest hit wins, `shot`/`hit` events). doc 11: `{t:"use"}` no longer resolves
  instantly — it now STARTS a server-driven channeled (timed) action that ticks
  in game-time and applies its effect on completion, interrupting with no effect
  on move/damage/slot-swap/death (cook also on leaving fire range). Cancel is
  server-driven (no client cancel verb). Progress rides `snap.you.action` for the
  HUD cast bar; this `{t:"use"}` semantics change is why `PROTOCOL_VERSION` bumped
  to 4 (doc 11 M2).
- Time: `time += TICK_MS/1000` per tick; hour via `gameHours(...)` from
  protocol helpers; ambient cold at night per constants.

## Definition of done (per owner)

Your slice compiles in isolation against the shared contracts (imports from
other build areas must match the signatures above — they may not exist on disk
yet; that's expected during parallel build). No placeholder TODOs in core
logic. Report: files written, exports, any contract deviations.
