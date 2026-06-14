# Map & Cartography — a top-down map, a minimap, and server-authoritative fog-of-war

Status: design. Companion docs: 04 (`ServerConfig` — owns the schema/PRESETS/validation/
`summarizeRules` this doc extends with a `MapConfig` group; the reveal/minimap/acquire dials
are LIVE-class and ride `welcome.config`), 05 (items — owns `ItemType`/`ItemDef`/`LOOT_TABLES`
and the `startingInventory()` grant call this doc adds the `map` item to), 03
(`PROTOCOL_VERSION` + the two-sided `proto` gate + `RulesSummary`; this doc raises the one
bump question and adds an additive `RulesSummary` badge), 07 (world + wildlife — owns the
`standard`/`large`/`huge` size tiers + river carve that reshape the world a map projects; the
map core is written size-parameterized so doc 07 is a drop-in), 08 (rendering performance —
owns the client frame budget the map's 2D-canvas layer must not regress). Research grounding:
`docs/plans/research/codebase-sim.md`, `docs/plans/research/codebase-server.md`,
`docs/plans/research/cf-costs.md` (the persistAll rows-written ceiling the fog grid must respect).

## Summary

The map is nearly free, and that single fact shapes the whole design. The world is a pure
deterministic function `createWorld(seed)` (`packages/shared/src/world.ts:342`) that the
**client already runs on join** — `clientWorld.world = createWorld(msg.seed)`
(`apps/game/src/client/net/connection.ts:311`). The resulting `World`
(`world.ts:93-118`) carries everything a top-down renderer needs as plain data — `heightAt(x,z)`,
`towns[]` (with names that are stored but rendered nowhere today, `world.ts:53-58,132`),
`buildings[]` (footprints + `area`/`kind`), the `military` compound, `trees`, `props`,
`lootSpawns`, `spawnPoints`. So a **full-reveal map is a pure client read: zero new wire data,
zero server cost, no protocol bump.** Everything genuinely new in this doc is concentrated in
two places: a **shared, three.js-free raster core** (so the in-game map and an offline render
script draw the identical island), and **server-authoritative fog-of-war** (per-character
"explored" state, which exists nowhere today).

This doc owns ONE shared primitive — a `packages/shared/src/map/` raster core (a coordinate
projection, the biome palette lifted out of `Terrain.tsx`, and a `rasterizeBase` + `mapPOIs`
pair) consumed identically by an offline `pnpm map:render` script and the in-game canvas — plus
the in-game `<MapPanel>` (full-screen, opened by the `map` item) and `<Minimap>` (always-on
corner). It adds a `MapConfig` group to `ServerConfig` carrying Adam's three operator dials
(minimap on/off; the `map` item is `spawn`-with / `loot`-found / `none`; reveal `full` /
`explored`), a `map` `ItemType`, and a per-character **explored grid** persisted as an additive
`CharacterState` JSON field (no `SCHEMA_VERSION` bump) and shipped as additive-optional
`welcome.explored` + `snap.fog` wire fields. The fog mode is **honest about what server
authority buys**: it cannot hide static terrain (the seed is public and the client regenerates
the whole island), so its value is persistence + a consistent server-blessed explored set, not
anti-cheat for terrain.

The only contested wire decision is whether adding the `map` `ItemType` bumps `PROTOCOL_VERSION`
(currently **2**) to 3, or ships additively now that `UNKNOWN_DEF` (`items.ts:371`) guards
unknown types — see Open Q1. The fog fields never force a bump on their own.

## Goals / Non-goals

**Goals**

- **A faithful top-down map of the live world**, drawn from `clientWorld.world` with biome
  colors matching `Terrain.tsx`, town/POI markers, and the player's position + heading.
- **One render codepath** shared by the in-game canvas and an offline `pnpm map:render` script,
  so the design/admin PNG and the in-game map are the same island.
- **Three operator dials**, server-set and directory-badged: a corner minimap on/off; the
  full-screen `map` item acquired by `spawn` / `loot` / `none`; reveal `full` / `explored`.
- **Server-authoritative, persisted fog-of-war** for `explored` mode — survives relog, accrues
  across a character's life, dies with the character on a sanctioned/world wipe.
- **Zero new runtime dependencies** and **no measurable frame regression** — the map is a
  separate 2D canvas, baked once per seed, redrawn off the rAF critical path.

**Non-goals**

- **No in-game admin/world-design overlay and no `apps/web` map page in this doc** — Adam
  deferred them; only the offline render script ships now. The shared core is built so both land
  cheaply later (the `apps/web` page imports the same core; the in-game admin overlay reuses the
  same bake).
- **No anti-cheat claim for terrain.** Fog gates the *map UI*, not knowledge a modded client can
  regenerate from the public seed.
- **No map markings/waypoints/pings** (a new `ClientMsg`) — deferred (Open Q6).
- **No gating of live entities by explored cells** — the explored set is designed so a future
  `markersInExploredOnly` consumer can read it, but live entities stay interest-radius-bound.
- **No new world geometry** — the map is strictly read-only against `createWorld`; it never adds
  an RNG draw or perturbs the worldgen fingerprint.

## Current state

All verified against source in this worktree (HEAD `1e61671`).

- The world is deterministic and **already client-side**: `createWorld(seed)` (`world.ts:342`)
  returns the full `World` (`world.ts:93-118`); the client builds it on welcome at
  `connection.ts:311` and keeps it at `clientWorld.world` (`runtime.ts:177`). The seed is public
  (`welcome.seed` `protocol.ts:223-247`; `serverInfo.worldSeed`). **No world geometry is on the
  wire.**
- World data a map needs, all on `World`: `heightAt`/`groundHeight` (`world.ts:95-97`), `towns`
  `{cx,cz,radius,name}` (`world.ts:53-58`), `buildings` `{cx,cz,halfW,halfD,area,kind,...}`
  (`world.ts:23-42`), `military` `{cx,cz,radius}` + `militaryWalls` (`world.ts:71-75,102-103`),
  `props` (`world.ts:80-86`), `trees` (`world.ts:44-51`), `lootSpawns` `{x,z,tier}`
  (`world.ts:62-69`), `spawnPoints` (`world.ts:109`). Town names `Staroye/Kamensk/Vybor/Polana/
  Gorka/Zeleno` exist (`world.ts:132`) and render **nowhere** today — free labels.
- Coordinates: XZ ground plane, +Y up, square **centered on the origin**, x,z ∈
  `[-WORLD_SIZE/2, +WORLD_SIZE/2]`; `WORLD_SIZE=800`, `WATER_LEVEL=0`, `TERRAIN_MAX_HEIGHT=22`
  (`constants.ts:7-13`). Yaw 0 faces `-Z`; the forward vector helper lives in
  `math.ts` (`yawToDir`, around `math.ts:197-210`) — a heading arrow must use it, not a naive
  `atan2`.
- The biome palette is **inline and unexported** in `Terrain.tsx:16-58` (sand `#c2b280` < 1.5m;
  grass low/high; rock by slope/height; central-difference slope at ±2m). Water is rendered as a
  flat plane at `WATER_LEVEL` (`WaterPlane.tsx`). The map must reproduce this to read like the
  terrain.
- Config: `ServerConfig` (`config.ts:143-151`, nine groups ending at `session`) with
  `DEFAULT_CONFIG` (`config.ts:165`) asserted field-by-field against imported constants
  (`config.test.ts:43-100`), `PRESETS` (`config.ts:229-304`), closed-union validators like
  `wipeSchedule()` (`config.ts:620-635`), `clampInto` (`config.ts:461-618`), the client trust
  guard `clampConfig` (`config.ts:446-452`), `worldFingerprintOf` (the WIPE-class identity,
  `config.ts:834`), and `summarizeRules → RulesSummary` (`config.ts:913`; `RulesSummary` at
  `serverInfo.ts:20`, additive within `SERVER_INFO_SCHEMA_VERSION` `serverInfo.ts:11`). Config
  rides `welcome.config?` additively and is re-clamped client-side — **no protocol bump**.
- Items: `ItemType` is a 30-member closed union (`items.ts:1-32`); `ItemDef` behaviors are
  optional config objects (`items.ts:95-124`); `ITEM_DEFS` is exhaustive (`items.ts:126-270`);
  `ItemKind` already has `tool` (`items.ts:34-44`); `LOOT_TABLES` (`items.ts:301-359`).
  `startingInventory()` **exists** and already grants flashlight + bandage (`players.ts:106`,
  called from `createPlayer` `players.ts:126` and respawn `players.ts:206`). `UNKNOWN_DEF`
  **exists** (`items.ts:371`) and is applied as `ITEM_DEFS[type] ?? UNKNOWN_DEF` at
  `HUD.tsx:124/131/231` and `NetSystem.tsx:121` — but a few sites are still **unguarded**
  (`connection.ts:170` `.kind`, `CharacterRig.ts:107/197`, `LootItems.tsx:39`).
- Protocol: `PROTOCOL_VERSION = 2` (`protocol.ts:29`; the bump rule naming `ItemType` enum
  growth is `protocol.ts:19-23`). `welcome` carries `seed`/`proto`/`config?`
  (`protocol.ts:223-247`); `snap` carries `you`/`players[]`/`time`/`count`
  (`protocol.ts:248-266`); `you` is `YouState` `{x,y,z,...}` (`protocol.ts:197-204`). Other
  entities are interest-filtered to `INTEREST_RADIUS=220` (`constants.ts:20`); airdrops
  (`snap.drops`) are island-wide unfiltered (`protocol.ts:259-260`) — the precedent for an
  always-visible marker. `parseClientMsg` is the only inbound trust boundary, 8192-byte cap
  (`protocol.ts:286-373`).
- Server: the tick (`GameRoom.ts:904-984`) runs `applyQueuedInputs` (~`:944`); `buildSnapshot`
  reads `player.core.x/z` (`GameRoom.ts:999-1132`); `youState` rounds to 2 dp
  (`GameRoom.ts:1134-1148`); `sendWelcome` emits seed/proto/inv/config (`GameRoom.ts:774-796`);
  `persistAll` saves world + every character in **one** `transactionSync`, ~`1+N` rows, every
  `WORLD_SAVE_INTERVAL_S=20`s (`GameRoom.ts:876-884`). `ServerPlayer.core` is the unrounded
  authoritative position (`state.ts:30-88`, core at `:35`).
- Persistence: `SCHEMA_VERSION = 2` (`persistence.ts:44`) — a separate, server-private axis; a
  bump **unconditionally wipes** characters + world_state (`persistence.ts:157-160`).
  `CharacterState` (`persistence.ts:47-57`) is `JSON.stringify`'d into `state_json`
  (`saveCharacter` `persistence.ts:466-492`); `loadCharacter` (`persistence.ts:495-525`)
  tolerates missing fields, so an **additive JSON field needs no schema bump**. A world-
  fingerprint mismatch also wipes characters + world_state (`persistence.ts:179-224`); the
  leaderboard survives every wipe.
- Client UI: `useUIStore` (`store.ts`) is the only UI-rate state; `invOpen` is the full-screen
  overlay pattern — a store flag (`store.ts:~46`), a keybind toggling it (`InputController.tsx
  Tab ~:39`, pointer-lock subscribe `~:210`), and a component that returns `null` when closed
  (`HUD.tsx InventoryPanel ~:263`, mounted in the HUD root `~:316`). `DebugOverlay.tsx` polls
  `clientWorld` imperatively at 250 ms (`~:103`) — the read-runtime-at-UI-rate precedent. UI
  **never touches three.js** (ARCHITECTURE.md). `GameCanvas.tsx` already gates mounts on config
  (e.g. `cfg.threats.zombies`) — the precedent for gating `<Minimap>` on `cfg.map.minimap`.
- The determinism gate `packages/shared/scripts/fingerprint.mjs` esbuild-bundles `world.ts` from
  a `data:` URL and calls `createWorld` — the exact pattern the offline render script mirrors.
  `heightAt` is ULP-divergent macOS↔Linux (per project memory), so a rendered image is cosmetic,
  never hashed.

### Drift from the brief (resolved here)

- The first design pass was run against the **main checkout** (`/Users/asnodgrass/github/
  survival-game` at `53b2f33`), two PRs behind this worktree, and reported a stale tree (14
  items, `PROTOCOL_VERSION=1`, no `startingInventory`, no `UNKNOWN_DEF`, "doc 11 doesn't
  exist"). All of that is **false here.** Corrected, verified facts: `PROTOCOL_VERSION` is
  already **2** (the `1→2` bump shipped in #19 with the `14→30` catalog), `startingInventory()`
  and `UNKNOWN_DEF` both exist, and this is **doc 12**. The bump question is therefore
  `2→3`-or-additive, not `1→2` — see §7 and Open Q1.
- The config field is `acquire` (not `acquisition`); the reveal field is one `reveal` governing
  both surfaces.
- World extents are still a hardcoded `WORLD_SIZE` constant — `World` has **no `size` field**
  yet (doc 07 adds it). The core takes `size` as a parameter (defaulting to `WORLD_SIZE`) so it
  is correct the day doc 07's tiers land; today the tier path is exercised only at 800 m
  (`clampConfig` coerces non-`standard` tiers to `standard`).

## Design

### 1. The shared map-raster core — `packages/shared/src/map/`

A new, **render-target-agnostic, three.js-free** module under `packages/shared` so both Node
(the offline script) and the browser (the in-game canvas) import one codepath. It emits palette
colors and vector POI primitives; the *caller* paints them onto whatever surface it holds
(`CanvasRenderingContext2D` in the browser, a raw pixel buffer / SVG string in Node). This is the
single source of truth for the world→image transform, the biome palette, and the POI layer.

**1a. Projection (`map/projection.ts`)** — an origin-centered square, **north = `-Z` is image-up**:

```ts
export interface MapProjection {
  readonly half: number;   // size / 2 (world meters)
  readonly px: number;     // square image dimension
  readonly mpp: number;    // meters per pixel = size / px
  worldToImage(x: number, z: number): { ix: number; iy: number };
  imageToWorld(ix: number, iy: number): { x: number; z: number };
}
export function makeProjection(size: number, px: number): MapProjection;
```

`ix = (x + half) / size * px`, `iy = (half - z) / size * px` (the `z` flip puts `-Z` north at the
top). `size` is **always passed in** (default `WORLD_SIZE` at the call site) — the core never
imports the constant, so doc 07's tiers and a future `World.size` are a one-line caller change.

**1b. Palette (`map/palette.ts`)** — lift the four colors + thresholds out of `Terrain.tsx:16-58`
into exported constants and pure functions `biomeColorAt(h, slope)` / `waterColorAt(depth)`,
replicating the Terrain math exactly (grass low→high lerp, sand band, rock by slope/height). The
map works in authored sRGB hex (it is a flat 2D image; no linear-space conversion). **Refactor
`Terrain.tsx` to import these same literals in the same PR** so the two never drift; Terrain keeps
its `THREE.Color` linear conversion — only the literals are shared.

**1c. Base raster (`map/raster.ts`) — `rasterizeBase(heightAt, size, px, waterLevel)`** returns an
RGBA `Uint8ClampedArray` (top row = north). Per pixel: `imageToWorld` → `h = heightAt`; `h <
waterLevel` → `waterColorAt(waterLevel - h)` (shallow→deep ramp so coastlines read); else
central-difference slope (±2 m, identical to `Terrain.tsx:40`) → `biomeColorAt`. Optimization:
sample a `(px+1)²` height grid first and reuse neighbors for slope (one `heightAt` per cell, not
five). `heightAt` is the hottest sim function — this runs offline or **once** in-browser, never on
the server tick.

**1d. POI layer (`map/raster.ts`) — `mapPOIs(world, opts) → MapShape[]`** returns world-space
vector primitives (`disc`/`rect`/`ring`/`label`) the caller projects and strokes: translucent
town discs + name labels; the military compound disc + wall/tower rects from `militaryWalls`;
building footprint rects colored by `area` (`town`/`wild`/`military`) with `kind` modulating
outline weight; the beach spawn ring (`opts.showSpawns`, default on); loot-tier zones
(`opts.showLoot`, default off — clutter). Live player/entity markers are **not** in `mapPOIs` —
those are dynamic and live in the client layer (§6).

### 2. The offline renderer — `pnpm map:render`

`packages/shared/scripts/map-render.mjs`, mirroring `fingerprint.mjs`: esbuild-bundle `world.ts`
from a `data:` URL, `createWorld(seed)`, then call the **same** `rasterizeBase` + `mapPOIs`. Add
`"map:render": "node scripts/map-render.mjs"` to `packages/shared/package.json`. Invocation:
`pnpm --filter @worldspring/shared map:render -- --seed 1337 --px 1024 --out island.svg`.

**Output: SVG by default** (vector POIs + crisp labels, the best world-design/admin artifact),
with the base raster embedded as one `<image href="data:image/png;base64,…">`. Encode the pixel
buffer to PNG with a **~40-line zero-dep writer** using Node's built-in `zlib.deflateSync` (real
compression, no `pako`/`sharp`/`node-canvas`). `--out *.png` writes the flat raster only. Because
`heightAt` is ULP-divergent across OSes, the image is cosmetic — **never hash it or gate CI on its
bytes**, and don't promise the offline PNG is pixel-identical to the in-game baked map across a
dev's OS.

### 3. `MapConfig` — the server dial (`config.ts`)

Two closed unions + a group, added after `session` (`config.ts:151`), all **LIVE-class** (never
in `worldFingerprintOf`):

```ts
export type MapAcquire = "spawn" | "loot" | "none";
export type MapReveal = "full" | "explored";
export interface MapConfig {
  minimap: boolean;     // always-on corner minimap
  acquire: MapAcquire;  // how the full-screen map item is obtained ("none" = no full map)
  reveal: MapReveal;    // "explored" engages fog-of-war on both surfaces
}
```

- **`DEFAULT_CONFIG.map`** = `{ minimap: true, acquire: "spawn", reveal: "full" }` — the generous,
  zero-wire-cost baseline. Back each field with a `constants.ts` export (typed at definition,
  e.g. `export const MAP_ACQUIRE_DEFAULT: MapAcquire = "spawn"`, importing the type from
  `config.ts` — resolve the import direction to avoid a cycle) so the `config.test.ts:43-100`
  field-by-field asserts stay non-circular.
- **Validators** `mapAcquire()` / `mapReveal()` copied verbatim from `wipeSchedule()`
  (`config.ts:620-635`); wired into `clampInto` (`config.ts:461-618`) with an `rm = isObject(r.map)
  ? r.map : {}` destructure and a `map` block in the returned literal. No `RANGES` row (enums/bool
  only). `mergeConfig`/`clampConfig`/preset-merge all validate `map` through this one path for
  free.
- **Preset overrides** (`config.ts:229-304`): `ironcoast` → `{ acquire: "loot", reveal:
  "explored" }`; `warpath` → `{ reveal: "explored" }`; `nightfall` → `{ reveal: "explored" }`;
  the rest inherit the default. (Open Q3.)
- **Badge**: add `map: "full" | "fog" | "find" | "off"` to `RulesSummary` (`serverInfo.ts:20`,
  additive — no `SERVER_INFO_SCHEMA_VERSION` bump) and derive it in `summarizeRules`
  (`config.ts:913`): `off` if `!minimap && acquire==="none"`, else `fog` if `reveal==="explored"`,
  else `find` if `acquire==="loot"`, else `full`. (`fog` dominates `find`.)

`MapConfig` rides `welcome.config?` additively → **no protocol bump from config**. All three
fields are admin-live-whitelistable when doc 04 §7's `ADMIN_LIVE_FIELDS` surface lands (Open Q5).

### 4. The `map` ItemType (`items.ts`) + acquisition

Add `| "map"` to `ItemType` (→ 31 members) and an `ITEM_DEFS` entry
`{ type:"map", name:"Island Map", kind:"tool", stack:1, color:"#d8c9a0", power:0 }`. `kind:"tool"`
means `useItem`'s switch hits its `default: return` no-op (~`players.ts:503`) — opening the map is
a **pure client action** (a keybind / client-side `use`), never a server round-trip. Granting is
driven by `cfg.map.acquire`:

- **`spawn`** → fold a conditional `addToInventory(inv, "map", 1)` into the **existing**
  `startingInventory()` (`players.ts:106`) by giving it a `cfg: ServerConfig` param and threading
  `state.config` from its two call sites (`createPlayer` `players.ts:126`, respawn
  `players.ts:206`).
- **`loot`** → add low-weight `map` rows to `LOOT_TABLES` `coastal` + `inland` (`items.ts:301-359`)
  — newspawn-reachable, **not** `military` (don't gate core navigation behind the hardest zone).
  This shifts coastal/inland roll outcomes (a visible content change, not a wipe; call it out in
  Migration).
- **`none`** → no grant anywhere; the client treats "no `map` item held" as "full map
  unavailable" (the minimap is still governed by `cfg.map.minimap`).

Possession gates the **panel**, not the explored **data** (§5): with full-loot PvP you can lose
the map item but keep your server-side explored set, so re-looting a map shows your accrued fog.

### 5. Server-authoritative fog-of-war (the explored grid)

**Honest scope.** Server authority **cannot hide static terrain** — the client runs
`createWorld(msg.seed)` (`connection.ts:311`) and the seed is public, so a modded client
regenerates the whole island regardless of fog. What it *does* buy: (1) a persisted, server-blessed
explored set that survives relog, (2) cross-session/device consistency, (3) a foundation for the
optional future gating of *dynamic* entities the seed does not reveal. The doc designs for those
three; it does not pretend fog is terrain anti-cheat.

**5a. Grid + encoding (`packages/shared/src/fog.ts`, new).** An `ExploredGrid` over the
origin-centered square at `FOG_CELL_M = 32` m (a new `constants.ts` value, **independent** of
`world.ts`'s internal `GRID_CELL = 16` statics hash): `gridDim = ceil(size / FOG_CELL_M)`, a
`Uint8Array(ceil(gridDim² / 8))` bitset, with `markCell`/`has`/`encodeB64`/`decodeB64` helpers in
shared so client and server share one index scheme. Extent is derived from
`tierParamsOf(config.world.sizeTier).worldSize` (today coerced to 800). Memory: 800 m → 25×25 = 625
bits ≈ 79 B; huge 3200 m → 100×100 = 10 000 bits ≈ 1.25 KB. The decoder defensively rejects a
base64 whose length ≠ `ceil(gridDim²/8)` and falls back to all-unexplored (mirrors `loadCharacter`'s
corrupt-row guard) — a tier change can't leave a mis-sized bitset because `sizeTier` is WIPE-class.

**5b. Storage + persistence.** Add `explored: ExploredGrid` to `ServerPlayer` (`state.ts`) and an
**additive optional** `explored?: string` (base64) to `CharacterState` (`persistence.ts:47-57`).
`loadCharacter` (`persistence.ts:495-525`) tolerates the missing field → a pre-feature row loads as
all-unexplored → **no `SCHEMA_VERSION` bump** (a bump would unconditionally wipe,
`persistence.ts:157-160`). It rides the existing single `persistAll` `transactionSync` for free —
**zero new rows** (respecting the rows-written ceiling), only a few hundred bytes of extra
`state_json`. Init in `createPlayer`, decode in `restorePlayer`. Wipe coupling is automatic: any
path that clears `characters` (schema bump, world-fingerprint mismatch `persistence.ts:179-224`,
scheduled wipe) clears explored too — a different seed/size/water makes old cells meaningless.

**5c. Marking.** In the tick after `applyQueuedInputs` (`GameRoom.ts:~944`), per alive online
player, quantize `player.core` (unrounded) to a center cell; **skip if unchanged since last tick**
(a `lastFogCell` shortcut). On a cross, stamp a `FOG_REVEAL_RADIUS_M ≈ 96` m disk (~7×7 cells),
pushing each newly-set index to a transient per-player `fogDelta: number[]`. Pure XZ→cell
arithmetic — **no `heightAt`**. Worst case ~50 byte-ORs per crossing × ~24 players is trivial
against the 66.7 ms tick (measured ~0.5 ms EMA).

**5d. Wire (additive-optional — no bump on its own).** `welcome.explored?: string` (the full base64
set, emitted in `sendWelcome` on **all three** join paths — new, restore, **and reconnect/takeover**
— see Open Q4 / the reconnect hazard) and `snap.fog?: number[]` (newly-revealed indices this tick,
**omitted when empty**, cleared after broadcast like `game.events`). Server→client only, so
`parseClientMsg` is untouched. At ~1–5 cells/tick the delta JSON is tiny; absolute indices beat
packing at this rate.

### 6. Client render — bake once, redraw the dynamic layer

**6a. Bake (`client/render/map/mapBake.ts`).** On `clientWorld.ready`, lazily (in a
`requestIdleCallback`, or on first map-open if the minimap is off) bake the base raster + POIs to an
`OffscreenCanvas` (fallback to a detached `HTMLCanvasElement` for Safari < 16.4) at `BAKE_PX = 1024`,
memoized on the `world` reference and disposed in `resetClientWorld` (`runtime.ts:243`). One-time
cost ~70–130 ms of `heightAt` (with grid reuse), kept off the join frame. The minimap reuses the
same baked canvas (a scaled sub-rect blit) — no second bake.

**6b. `<MapPanel>` (full-screen).** A pure DOM/canvas component mounted next to `<HUD>`, `null`
unless the `mapOpen` store flag is set. A calm 10 Hz `setInterval` loop (the `DebugOverlay`
pattern, **not** rAF) does: `drawImage(baked.base)` scaled (static, never recomputed) → project
`clientWorld.me` and draw the **you-marker triangle** oriented by `yawToDir` → other players /
zombies / loot within 220 m + island-wide `clientWorld.drops` → the reveal mask (6d). The blit +
~80 dots is < 1 ms and adds nothing to the 3D rAF frame (separate 2D canvas).

**6c. `<Minimap>` (corner).** Mounted only when `clientWorld.config.map.minimap` (gate like
`GameCanvas.tsx`). A small fixed-corner `<canvas>`, `pointer-events:none` (never steals input or
pointer lock), player-centered window blit of the baked canvas at 15 Hz, north-up (Open Q2 leaves
rotate-to-heading deferred).

**6d. Reveal mask.** `full` → no mask. `explored` → composite the upscaled `clientWorld.explored`
bitset as a `destination-in` alpha mask over a copy of the base, plus a soft radial
`destination-out` punch for the live radius around `me`; POIs/labels for unexplored regions are
masked (draw POIs *before* the mask), live entities drawn *after* (you always see your 220 m
bubble). If `clientWorld.explored` is absent, `explored` **degrades to `full`** (never a black
screen).

**6e. Wiring.** `store.ts`: `mapOpen` + `setMapOpen`, added to the `canMove` guard so the open
full map freezes movement. `InputController.tsx`: a `KeyM` edge case (after Tab) that toggles
`mapOpen` only when the player holds a `map` item (and a `map`-kind `doUse` also toggles it);
add `mapOpen` to the pointer-lock release/re-lock subscribe block (`~:210`) **and** the
`onPointerLockChange` escape-menu suppression. `App.tsx`: mount `<MapPanel/>` + `<Minimap/>` next
to `<HUD/>` (DOM, not inside the Canvas). The corner minimap touches no pointer-lock wiring.

### 7. Protocol additions (complete list) + the bump decision

Additive, server→client, all optional:

```
welcome.explored?: string      // base64 ExploredGrid, full set (all three join paths)
snap.fog?: number[]            // newly-revealed cell indices this tick; omitted when empty
RulesSummary.map: "full"|"fog"|"find"|"off"   // additive badge, no SERVER_INFO bump
ServerConfig.map: MapConfig                    // rides welcome.config?, no bump
```

None of these force a `PROTOCOL_VERSION` bump. The **only** bump question is the new `map`
`ItemType` (`protocol.ts:19-23` names enum growth as a trigger). Because the catalog already paid
the `1→2` bump in #19 and `UNKNOWN_DEF` now guards most lookups, there are two honest paths
(Open Q1): **(a) no bump** — harden the 4 remaining unguarded `ITEM_DEFS[type]` sites to `??
UNKNOWN_DEF` and ship `map` additively (old clients see a generic unknown item, lack the map
feature); requires a one-line doc-03 amendment that `UNKNOWN_DEF`-guarded `ItemType` growth is
additive-safe. **(b) bump to 3** — clean version line, every connected client is kicked to reload.
Whichever is chosen, it lands in **one** wire PR with the `ARCHITECTURE.md` amendment.

## Implications

- **Opens up:** a real cartography product (full map / fog / find / off as a directory-badged
  operator choice); the first surface to render town names; a single render core that an
  `apps/web` server-preview page and an in-game admin overlay can both reuse later; an explored
  grid a future "live entities only in explored cells" mode can read.
- **Complicates:** the loot economy (a `map` row shifts coastal/inland rolls); `startingInventory()`
  gains a `cfg` param; the reconnect/welcome path must now also carry `explored`; an admin live
  flip `full→explored` needs a forced full-set re-send (Open Q4).
- **Breaks:** under path (b), v2 clients at the join gate (intentionally, on reload). Under path
  (a), nothing — old clients keep playing with a generic unknown item.
- **Threatens:** nothing world-deterministic — `MapConfig` is LIVE-class and outside the
  fingerprint, the explored grid is mutable per-character state never fed to `movement.ts`/
  `world.ts`, and the map core is read-only against `createWorld`. The one watch-item is the
  client frame budget (doc 08): the map is a separate 2D canvas, baked once and redrawn off the
  rAF path, so the acceptance criteria measure frame-ms/main-thread-ms, not the 3D draw count.

## Migration & compatibility

`SCHEMA_VERSION` stays **2** (the explored field is additive `CharacterState` JSON; a bump would
wipe). `MapConfig` is additive on `welcome.config?` and LIVE-class — it never enters
`worldFingerprintOf`, never triggers the fail-closed world wipe. `RulesSummary.map` is additive
within `SERVER_INFO_SCHEMA_VERSION`. Adding a `map` `LOOT` row is a content change (visible,
reversible), not a wipe. `PROTOCOL_VERSION` per Open Q1 (additive-no-bump, or `2→3`); the bump (if
any) and all new wire fields land in **one** PR with the `ARCHITECTURE.md` amendment (the map
`ItemType`, `MapConfig` as LIVE-class, the explored grid as additive JSON, the final PROTOCOL
decision). Rollback: drop `map` from the union/tables/grant and the wire fields; `MapConfig` may
remain (ignored by clients lacking the feature). Determinism CI (`fingerprint.mjs`) is untouched —
the map is read-only against worldgen; run it anyway on the M1 PR since it imports `world.ts`.

## Implementation plan

Order: M1 → M2 → M3 → M4 → M5 → M6. M1 (offline + core) and M2 (config) have no dependencies and
can run in parallel; M1 is the **buildable-now, zero-dependency, visually-demonstrable MVP**. Each
milestone ends with `pnpm -w typecheck` clean; wire/persistence milestones add a two-client smoke
test via `pnpm dev` and a `loadtest.mjs` tick-EMA check.

1. **M1 — Shared map-raster core + offline `pnpm map:render`** *(Sonnet — mechanical; the palette
   lift is a read-only refactor)*.
   Files: `packages/shared/src/map/projection.ts`, `map/palette.ts`, `map/raster.ts` (new);
   `apps/game/src/client/render/world/Terrain.tsx` (import the lifted palette literals — no
   behavior change); `packages/shared/scripts/map-render.mjs` (+ the zero-dep `zlib.deflateSync`
   PNG writer); `packages/shared/package.json` (`map:render`). A Vitest renders seed 1337 to a
   small grid and asserts a few known pixels (coast = sand, center = compound).
   Depends: none. Scope: shared + offline only, **no wire, no deps**.
   Accept: `pnpm --filter @worldspring/shared map:render -- --seed 1337` writes a valid SVG/PNG
   that opens and visibly matches the island; `Terrain.tsx` still imports the shared literals;
   `fingerprint.mjs` unchanged; typecheck clean.
2. **M2 — `MapConfig` server dial** *(Opus — touches the config validation core + the field-by-
   field and round-trip tests)*.
   Files: `packages/shared/src/config.ts` (`MapAcquire`/`MapReveal`, `MapConfig`,
   `DEFAULT_CONFIG.map`, preset overrides, `clampInto` block, `mapAcquire`/`mapReveal` validators,
   `summarizeRules` badge), `packages/shared/src/constants.ts` (`MAP_*_DEFAULT`),
   `packages/shared/src/serverInfo.ts` (`RulesSummary.map`), `packages/shared/src/config.test.ts`
   (default asserts + out-of-enum clamp guards).
   Depends: none. Scope: shared-only, **no wire**.
   Accept: `pnpm vitest config.test` green incl. the unchanged round-trip loop;
   `clampConfig({map:{reveal:"xray"}}).map.reveal` → default; badge bands correctly.
3. **M3 — The `map` ItemType + acquisition** *(Opus — the bump decision + the grant seam)*.
   Files: `packages/shared/src/items.ts` (`| "map"`, `ITEM_DEFS` entry, `LOOT_TABLES`
   coastal/inland rows), `apps/game/src/server/systems/players.ts` (`startingInventory(cfg)`;
   thread `state.config` at `players.ts:126` + `:206`). Resolve Open Q1: either harden the 4
   unguarded `ITEM_DEFS[type]` sites + ship additively, or bump `PROTOCOL_VERSION` to 3 (with the
   `ARCHITECTURE.md` amend in this PR if bumping).
   Depends: M2 (reads `cfg.map.acquire`). Scope: shared + server.
   Accept: each `acquire` mode behaves (spawn grants 1 map at join, loot seeds the tables, none
   grants nothing); `tsc` exhaustiveness passes; under path (a) an old client doesn't throw on a
   `map` stack.
4. **M4 — In-game full-reveal `<MapPanel>` + `<Minimap>`** *(Opus — canvas/perf, lazy-bake timing,
   input/pointer-lock wiring)*.
   Files: `apps/game/src/client/render/map/mapBake.ts`, `ui/MapPanel.tsx`, `ui/Minimap.tsx`,
   `ui/map.css` (new); `state/store.ts` (`mapOpen`), `render/entities/InputController.tsx` (KeyM +
   `canMove` + pointer-lock), `client/App.tsx` (mount), `runtime.ts` (dispose bake),
   `constants.ts` (`BAKE_PX`, `MINIMAP_WORLD_RADIUS`). Full reveal only.
   Depends: M1 (core), M2 (config gate), M3 (item + possession gate). Scope: client, **no wire**.
   Accept: `M` opens a map of the island with towns + a correctly-oriented you-arrow; the minimap
   appears only when `cfg.map.minimap` and pans with the player; movement freezes + pointer
   releases while the full map is open; < 1 ms/redraw, no 3D-frame regression on a mid-tier device.
5. **M5 — Fog server core (grid + persistence + marking)** *(Opus — persistence safety + the
   per-tick hot path)*.
   Files: `packages/shared/src/fog.ts` (new, `ExploredGrid`), `packages/shared/src/constants.ts`
   (`FOG_CELL_M`, `FOG_REVEAL_RADIUS_M`), `apps/game/src/server/systems/state.ts` (`explored` +
   transient `fogDelta`/`lastFogCell`), `apps/game/src/server/persistence.ts` (additive
   `explored?`), `apps/game/src/server/systems/players.ts` (init/decode), `GameRoom.ts` (per-tick
   marking). **`SCHEMA_VERSION` stays 2.** Confirm the persistence owner signs off on the
   `CharacterState` edit.
   Depends: M3. Scope: server + shared, **no wire**.
   Accept: a character round-trips an explored set byte-identically; pre-feature rows load
   all-unexplored; a player walking a line reveals a contiguous corridor; tick EMA < 1 ms with 24
   bots (`/api/health`).
6. **M6 — Fog wire + client explored mask** *(Opus — additive wire across the gate + compositing;
   the one wire PR)*.
   Files: `packages/shared/src/protocol.ts` (`welcome.explored?`, `snap.fog?`),
   `apps/game/src/server/GameRoom.ts` (emit full set in `sendWelcome` on all three join paths;
   emit `fog` delta in `buildSnapshot` only when non-empty; clear after broadcast),
   `apps/game/src/client/net/connection.ts` (decode `explored`, apply `fog`),
   `apps/game/src/client/runtime.ts` (`explored` field + reset), `MapPanel`/`Minimap` (the mask
   path), `ARCHITECTURE.md` (amend in this PR). Fog fields are additive-optional; no bump beyond
   Open Q1's M3 decision.
   Depends: M4, M5. Scope: wire + client.
   Accept: with `reveal:"explored"` the unexplored island is fogged, the current radius + visited
   regions reveal, town names hide until found; a refresh re-reveals the persisted set; an old
   client (if path (b)) is cleanly refused; live entities in the 220 m bubble always show.

## Open questions

1. **Does the `map` `ItemType` bump `PROTOCOL_VERSION` to 3, or ship additively?** **Recommendation:
   additive, no bump** — harden the 4 unguarded `ITEM_DEFS[type]` sites (`connection.ts:170`,
   `CharacterRig.ts:107/197`, `LootItems.tsx:39`) to `?? UNKNOWN_DEF` and amend doc 03's rule to
   state `UNKNOWN_DEF`-guarded `ItemType` growth is additive-safe. The catalog already paid the
   `1→2` bump; forcing every connected player to reload for a content/feature add is heavy, and
   `UNKNOWN_DEF` exists precisely to make this safe. Fall back to **bump-to-3** if doc 03's owner
   prefers a strict version line over avoiding the reload. (The fog wire fields never bump either
   way.) This is the one decision that should be settled before M3.
2. **Minimap orientation — north-up or rotate-to-heading?** **Recommendation: north-up**, matching
   the full map and the offline render (a simple axis-aligned blit; no motion-sickness). Make
   rotate-to-heading a deferred per-player setting.
3. **Per-preset map regimes.** **Recommendation:** `ironcoast` → `loot`+`explored`, `warpath` →
   `explored`, `nightfall` → `explored`; all others default (`minimap on`, `spawn`, `full`). Keep
   `nightfall`'s minimap **on** — a fogged minimap that fills in is a better night loop than no
   minimap. Cheap to retune; weights are content, not contract.
4. **Per-life vs per-token explored persistence, and the live-flip / reconnect hazards.**
   **Recommendation: per-token** — map knowledge is meta-knowledge of the island, not a per-life
   resource; do **not** clear `explored` in `respawnPlayer`, only on a character/world wipe. Expose
   per-life as a future `fog.persistAcrossDeath` knob if a hardcore server asks. Two coupled hazards
   to handle in M6: an admin LIVE flip `full→explored` must **force a full `explored` re-send** (a
   standing player has a near-empty set and would otherwise see a near-black map), and the
   reconnect/takeover branch of `handleJoin` must carry `explored` on its welcome (it currently
   sends a "reconnected" notice — verify it re-emits a welcome).
5. **Whitelist `map.*` into `ADMIN_LIVE_FIELDS` (doc 04 §7) when that surface lands?**
   **Recommendation: yes** for all three (`minimap`, `reveal`, `acquire`) — all LIVE-class with no
   wipe implication; `acquire` only affects future grants. Confirm with the doc 04 §7 owner.
6. **Map markings / waypoints (a new `{t:"mapMark"}` `ClientMsg`)?** **Recommendation: defer** — it
   adds an inbound message (parse + a real `PROTOCOL_VERSION` bump) and per-character persistence;
   not MVP. The explored grid and panel ship first.
7. **`acquire:"none"` + `reveal:"explored"` (fog computed but no surface to view it).**
   **Recommendation:** accept it (validators already do; the badge reads `off` when the minimap is
   also off) but emit a `resolveServerConfig` warning so an operator notices the dead combination.
8. **Offline render output — SVG or PNG default?** **Recommendation: SVG** (vector POIs + embedded
   PNG raster, zero-dep), `--png` for a flat raster — SVG is the better world-design/admin artifact
   and is what the deferred `apps/web` page will want.
