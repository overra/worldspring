# DEADCOAST — Shared Sim & Gameplay Data Layer (Research Map)

Audience: design agents extending the game. Everything below is grounded in the code as of
this worktree; file:line references are to the worktree root. ARCHITECTURE.md at repo root
is the binding contract — this doc maps the implementation underneath it.

The single most important invariant in this codebase:

> **DETERMINISM IS SACRED.** `createWorld(WORLD_SEED)` runs on both the client
> (`src/client/net/connection.ts:260`) and the server (`src/server/GameRoom.ts:354`) and MUST
> produce bit-identical results — client movement prediction collides against the locally
> generated world. Every existing seeded rng stream's draw order is frozen forever. New
> generation features get NEW hash-salted streams.

---

## 1. File map

| File | Role |
|---|---|
| `src/shared/constants.ts` | ALL gameplay tunables (single source of truth, 180 lines) |
| `src/shared/rng.ts` | `hashString` + `createRng` (mulberry32-style seeded rng) |
| `src/shared/math.ts` | Vec3, Aabb, circle/AABB pushes, ray tests, melee cone, yaw conventions |
| `src/shared/world.ts` | `createWorld(seed)` — terrain, buildings, military zone, loot spawns, trees, props, statics grid, raycast |
| `src/shared/movement.ts` | `stepPlayer` / `stepZombie` / `resolveStatics` — identical on client & server |
| `src/shared/protocol.ts` | Wire types (`ClientMsg`/`ServerMsg`), `parseClientMsg` validation, `gameHours` |
| `src/shared/items.ts` | `ItemDef`/`RangedConfig`, `ITEM_DEFS`, loot tables |
| `src/server/GameRoom.ts` | DO: sockets, join/welcome, 15Hz tick orchestration, snapshots, persistence triggers |
| `src/server/systems/state.ts` | `GameState` + all server entity shapes, outbox/event queues, lag-comp history |
| `src/server/systems/players.ts` | join/spawn/respawn, input application, inventory ops |
| `src/server/systems/combat.ts` | melee cone + ranged hitscan, lag compensation rewind |
| `src/server/systems/survival.ts` | vitals decay, temperature, damage/death pipeline |
| `src/server/systems/zombies.ts` | zombie spawn/AI/respawn/separation |
| `src/server/systems/wildlife.ts` | deer (flee/wander, venison drops) |
| `src/server/systems/weather.ts` | two-state rain machine |
| `src/server/systems/airdrops.ts` | airdrop scheduling/lifecycle |
| `src/server/systems/loot.ts` | loot stocking/respawn timers, corpse spawning |
| `src/server/persistence.ts` | DO SQLite: world snapshot, characters, leaderboard, schema versioning |
| `src/client/render/world/*` | render-only consumers of the `World` object (Terrain, Buildings, Trees, Grass, Scatter, WaterPlane…) |

---

## 2. The RNG primitives (`src/shared/rng.ts`)

- `hashString(str)` (`rng.ts:4-13`) — 32-bit string hash, used to derive *salted* seeds
  (e.g. `hashString(\`win|${seed}|${id}\`)`).
- `createRng(seed)` (`rng.ts:23-39`) — returns `Rng` with `next()` ∈ [0,1), `range(min,max)`,
  `int(min,max)` (inclusive), `pick(arr)`, `chance(p)`. Mulberry32 variant; stable across
  runtimes (only `Math.imul`, shifts, float division).
- The file header (`rng.ts:1-2`) states the contract: everything must be stable across runs
  and runtimes; **no `Math.random()` anywhere in shared code** (`world.ts:3`).

Server-only randomness (loot rolls, zombie wander, pellet spread) intentionally uses
`Math.random()` — it never needs to match the client (`loot.ts:1-2`, `combat.ts:322-324`).

---

## 3. World generation (`src/shared/world.ts`)

### 3.1 Seed flow

- `WORLD_SEED = 1337` (`constants.ts:4`).
- Server: `ensureGame()` calls `createWorld(WORLD_SEED)` (`GameRoom.ts:354`).
- Client: the `welcome` message carries `seed: game.world.seed` (`GameRoom.ts:517`);
  `onWelcome` calls `createWorld(msg.seed)` (`src/client/net/connection.ts:260`). **The welcome
  message is the only channel by which world-gen config reaches the client today.** Any new
  config that affects generation must ride the welcome message (or shared constants) or the
  two sides diverge.
- Persistence guards the seed: `initSchema` wipes characters + world_state (keeps leaderboard)
  when the stored `world_seed` or `schema_version` meta rows mismatch (`persistence.ts:107-117`).
  Worldgen-breaking changes bump `SCHEMA_VERSION` (currently 2, `persistence.ts:34` — v2 was the
  military-compound worldgen change).

### 3.2 Every rng stream, in creation order (`createWorld`, `world.ts:342`)

| # | Variable | Seed expression | Used for | Lines |
|---|---|---|---|---|
| 1 | `rng` | `createRng(seed >>> 0)` | **One burned draw only** (`rng.next()` at `world.ts:866`, "Burn a value so future additions don't shift existing rng streams") | 343, 866 |
| 2 | `noise` | `createNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0).next)` | simplex heightfield | 344 |
| 3 | `milRng` | `seed ^ 0x3f1c7` | military compound site (600 fixed-iteration candidates, `world.ts:356-367`) **and** military interior building placement (`world.ts:465-471`) | 350 |
| 4 | `townRng` | `seed ^ 0x7041` | town placement (≤4000 attempts) + town radius | 372 |
| 5 | `bRng` | `seed ^ 0xb17d` | town buildings (count/angle/dist/spec) + wilderness cabins | 388 |
| 6 | `lRng` | `seed ^ 0x100c` | loot spawn point positions inside buildings | 496 |
| 7 | `tRng` | `seed ^ 0x7ee5` | trees (position, height 6–11, conifer 65% / oak) | 513 |
| 8 | `rockRng` | `seed ^ 0x6a09e6` | island-wide rocks (NEW-stream precedent cited in CLAUDE-context) | 645 |
| 9 | `propRng` | `seed ^ 0x1d872b` | military set-dressing yaw jitter | 676 |

Hash-salted per-feature streams (NOT part of the sequential streams above — the safe pattern
for new features):

- Windows: `createRng(hashString(\`win|${seed}|${id}\`))` per building (`world.ts:224-248`),
  with the explicit comment "keyed off a hash, never the shared worldgen streams, so
  adding/changing windows can't shift towns, loot or trees for existing worlds" (`world.ts:221-223`).
- Client-only cosmetic streams follow the same pattern: grass `hashString(\`grass|${world.seed}|${cx}|${cz}\`)`
  (`src/client/render/world/Grass.tsx:164`), building trim `hashString(\`trim|${seed}|${b.id}\`)`
  (`src/client/render/world/BuildingTrim.tsx:123`).

Two structural rules that keep streams stable:

1. **Fixed iteration counts** where acceptance varies: the military site loop runs exactly 600
   candidates, consuming rng every iteration regardless of acceptance (`world.ts:355-367`).
   Rejection-sampled loops (towns, buildings, trees, rocks) draw per attempt with a fixed max
   attempt count — adding a new rejection *condition* changes which draws are accepted and
   therefore the world (acceptable only with a SCHEMA_VERSION bump), but never desyncs client
   vs server since both run the same code.
2. **No draws in deterministic fix-ups**: the door-side floor clamp explicitly notes "No RNG
   draws here — existing worldgen streams are unaffected" (`world.ts:435-437`).

### 3.3 The heightfield (`makeHeightFn`, `world.ts:178-190`)

```
n = 0.6*noise(x*0.008, z*0.008) + 0.3*noise(x*0.02+100, z*0.02+100) + 0.1*noise(x*0.06+200, z*0.06+200)
h01 = n*0.5 + 0.5
d = dist from origin / (WORLD_SIZE*0.5)
mask = smoothstep(clamp(1.15 - 1.6*d², 0, 1))
height = (h01*0.75 + 0.35) * TERRAIN_MAX_HEIGHT * mask - 4
```

- `WORLD_SIZE = 800` m square centered on origin (`constants.ts:7`); `TERRAIN_MAX_HEIGHT = 22`
  (`constants.ts:10`); `WATER_LEVEL = 0` (`constants.ts:8`). The `-4` term sinks the map edge
  underwater — it is an island by construction.
- `heightAt` is **analytic and continuous** — collision, AI, spawning, raycasts all evaluate it
  directly. There is no heightmap array.
- Depends on the `simplex-noise` npm package (`world.ts:5`). **Upgrading that package to a
  version with different output breaks every existing world AND client/server agreement** —
  treat it as pinned.

### 3.4 Generation pipeline order (dependencies matter)

1. Military compound site — picked FIRST; everything else avoids it (`world.ts:347-368`).
   `military: MilitaryZone = {cx, cz, radius: MIL_HALF + 14}` = radius 54 (`world.ts:351`,
   `MIL_HALF = 40` at `world.ts:153`). Sited on the highest acceptable ground within 130m of
   the island center.
2. Towns — up to `TOWN_COUNT = 4`, ring 70–270m from center, terrain h ∈ [2.5, 9.5], slope ≤ 3,
   ≥150m apart, ≥(radius+70)m from military (`world.ts:371-384`). Names from
   `TOWN_NAMES = ["Staroye","Kamensk","Vybor","Polana","Gorka","Zeleno"]` (`world.ts:132`).
3. Buildings via `tryPlace` (`world.ts:391-462`): slope ≤ 1.6, h ≥ 1.5, no footprint overlap
   (+2.5m margin). Floor = highest-corner terrain +0.18, then clamped to
   `doorGround + STEP_UP_MAX - 0.15` so the door is always climbable (`world.ts:431-439`).
   Door goes on the side with the smallest step-up (`world.ts:416-430`). Order: 4 military
   interior buildings (2 barracks, 1 hangar, 1 shed, `world.ts:465-471`), then 5–8 per town
   (`world.ts:473-484`), then `CABIN_COUNT = 6` wilderness houses (`world.ts:486-492`).
4. Loot spawn points — `lootPoints` per building spec, random inside footprint at floor height
   (`world.ts:495-509`). Tier from `building.area`: military→`"military"`, town→`"coastal"`,
   wild→`"inland"` (`world.ts:499`).
5. Trees — `TREE_COUNT = 700`, h ≥ 1.2, outside towns/military/building footprints
   (`world.ts:512-530`). Trunk collision radius fixed 0.35.
6. Spawn points — **no rng**: 48 evenly spaced angles, march inward from `WORLD_SIZE*0.49`
   until terrain h ∈ (0.4, 1.6) = dry beach; up to 24 points (`world.ts:533-548`).
7. Military perimeter walls — 4 walls (N/S have centered 4.5m gates) + 4 corner towers,
   as terrain-following Aabbs in `militaryWalls` (`world.ts:551-604`).
8. Set-dressing props — rocks island-wide (`rockRng`) + authored military props with seeded
   yaw jitter (`propRng`) (`world.ts:606-737`). Conflicting authored props are *dropped*, never
   nudged (deterministic, `world.ts:679-682`). `rock_a` is walk-through; everything else gets a
   collision Aabb (`PROP_FOOTPRINTS`, `world.ts:163-169`).
9. Statics spatial grid — `GRID_CELL = 16` m cells (`world.ts:123`); building walls, military
   walls and solid prop boxes all go into the same `walls` lists; trees into `trees`
   (`world.ts:739-778`).

### 3.5 Building geometry (relevant to combat/movement design)

A `Building` (`world.ts:23-42`) is: `id, kind, area, lootPoints, cx, cz, halfW, halfD, floorY,
wallHeight, doorSide (0:+Z 1:-Z 2:+X 3:-X), windows[{side, offset}], walls: Aabb[], roof: Aabb`.

- `BuildingKind = "house" | "shed" | "barn" | "barracks" | "hangar"` (`world.ts:18`);
  `BuildingArea = "town" | "wild" | "military"` (`world.ts:21`).
- Specs: house 3.5×4.5 (2 loot), shed 2.2×2.2 (1), barn 5×7 (3) (`world.ts:141-145`); military:
  barracks 2.8×5.5 (3), hangar 4.5×6.5 (4), shed 2.2×2.2 (2) (`world.ts:147-151`).
- Walls are Aabbs built by `buildWalls` (`world.ts:250-340`): thickness 0.35, height 3.0, plus a
  `FOUNDATION_DEPTH = 3.6` skirt below the floor (y-aware collision ignores it). Doors: 1.6m
  wide gap with a below-floor sill box and a header box above `DOOR_HEIGHT = 2.2`. Windows:
  1.0m wide openings, sill at floor+0.75 (blocks walking, `STEP_UP_MAX` is 0.6, but a jump-vault
  at apex ~0.85 clears it), head at floor+1.85 — sight and shots pass through the opening
  (`world.ts:206-219, 277-307`). Wide kinds (barn/hangar/barracks) get two windows per wall.
- The roof is a flat Aabb slab at wall top +0.3 (`world.ts:331-338`).

### 3.6 The `World` object (`world.ts:93-118`)

```ts
interface World {
  seed: number;
  heightAt(x, z): number;                       // raw terrain
  groundHeight(x, z): number;                   // terrain OR building floor, whichever you stand on (world.ts:806-810)
  towns: Town[];                                // {cx, cz, radius, name}
  buildings: Building[];
  military: MilitaryZone;                       // {cx, cz, radius}
  militaryWalls: Aabb[];                        // exposed for rendering; already in the grid
  props: WorldProp[];                           // {kind, x, z, yaw, scale} — set dressing
  trees: Tree[];                                // {x, z, groundY, r, height, kind}
  lootSpawns: LootSpawn[];                      // {id, x, y, z, tier}
  spawnPoints: Array<{x, z}>;
  queryStatics(x, z, r): StaticsQuery;          // {walls: Aabb[], trees: Tree[]} near a point
  raycastStatics(origin, dir, maxDist, includeTerrain?): number | null;
}
```

`raycastStatics` (`world.ts:812-863`): marches the grid at half-cell steps checking a 3×3 cell
ring (so diagonal rays can't skip cells), tests every wall Aabb plus every building roof, then
optionally terrain (coarse 2m march + 8-iteration bisection refine). `includeTerrain=false` is
used for melee/zombie-swipe occlusion so terrain bumps don't eat point-blank swings
(`world.ts:113-117`, `combat.ts:69-72`, `zombies.ts:168-174`).

### 3.7 Terrain mesh resolution (client, render-only)

`src/client/render/world/Terrain.tsx:11,25` — one `PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 200, 200)`
(`SEGMENTS = 200` → **4m vertex spacing**), displaced per-vertex by `world.heightAt`, vertex
colored by height/slope (sand < 1.5, grass, rock on slope ≥ 0.32 or h ≥ 14). The mesh is purely
cosmetic — all gameplay queries hit the analytic `heightAt`, which is finer than the mesh
(visual ground and collision ground can differ by a few cm between vertices).

Water: `src/client/render/world/WaterPlane.tsx` — translucent plane at `WATER_LEVEL` sized
`WORLD_SIZE * 1.6`, sine-wave displaced in the shader. Render-only; the sim's water rule is
the `WATER_WALK_MIN` terrain-height check (section 6).

Other consumers of `World` data (all read-only, all deterministic): `Buildings.tsx` (merges all
wall/roof/floor/military boxes into ~8 draw calls), `BuildingTrim.tsx` (door/window frames,
mirrors the unexported `DOOR_WIDTH = 1.6` — note the duplicated constant at
`BuildingTrim.tsx:29-30`), `Trees.tsx` (variant picked by bit-mixing the tree's array index,
golden-angle yaw), `Scatter.tsx` (`world.props` → instanced GLB), `Grass.tsx` (per-16m-cell
hash-seeded blades; density scaling iterates a *prefix* of the same seeded sequence so quality
settings don't change placement, `Grass.tsx:178-180`).

---

## 4. Item system (`src/shared/items.ts`)

### 4.1 Shapes

```ts
type ItemType = "beans" | "water_bottle" | "bandage" | "pistol" | "rifle" | "shotgun"
  | "ammo_9mm" | "ammo_762" | "shells" | "axe" | "campfire_kit" | "flashlight"
  | "raw_venison" | "cooked_venison";                       // items.ts:1-15

type ItemKind = "food" | "drink" | "heal" | "melee" | "ranged" | "ammo" | "placeable" | "tool"; // items.ts:17-25

interface RangedConfig {        // items.ts:28-40 — weapons-as-data
  range: number;                // hitscan meters
  cooldownS: number;
  pellets: number;              // rays per trigger pull (shotgun = 6)
  spreadRad: number;            // per-pellet random cone half-angle
  ammo: ItemType;               // one round consumed per pull, regardless of pellets
  sound: "pistol" | "rifle" | "shotgun";  // picks wire sound/tracer
}

interface ItemDef {             // items.ts:42-54
  type: ItemType; name: string; kind: ItemKind;
  stack: number;                // max per inventory slot
  color: string;                // hex, used by low-poly renderer + UI swatches
  power: number;                // restore amount (consumables) or damage per pellet (weapons)
  ranged?: RangedConfig;        // present iff kind === "ranged"
}
```

`ITEM_DEFS: Record<ItemType, ItemDef>` (`items.ts:56-97`) is the complete database. Current
weapons: pistol "Makarov" (30 dmg, 90m, 0.35s), rifle "Mosin" (65 dmg, 180m, 1.15s), shotgun
"Izh-43" (13 dmg/pellet × 6 pellets, 28m, 0.085 rad spread). `axe` is melee 35 dmg; fists are
`FIST_DMG = 12` (`constants.ts:98`).

### 4.2 The weapons-as-data pattern

`combat.ts` never branches on weapon identity. `performAttack` (`combat.ts:169-183`) looks up
`ITEM_DEFS[stack.type]`; `kind === "ranged"` → `fireRanged` driven entirely by `def.ranged`
(`combat.ts:289-433`): finds a stack of `ranged.ammo` anywhere in the inventory, consumes one,
casts `pellets` rays each perturbed by ±`spreadRad` on yaw and pitch, `def.power` damage per
pellet hit, one `"shot"` event per pellet (the tracer fan IS the shotgun visual). Anything else
→ `meleeAttack` (cone `MELEE_RANGE = 2.3`, `MELEE_HALF_ANGLE_RAD = π/3.2`, nearest target wins,
walls-only occlusion). **A new gun is a new `ITEM_DEFS` entry + a sound/tracer mapping on the
client; zero combat-code changes** unless the `sound` union needs a new member (it's also in
the `GameEvent` shot type, `protocol.ts:179`).

### 4.3 Loot tables

`LootTier = "coastal" | "inland" | "military"` (`items.ts:128`);
`LootTableEntry = {type, weight, min, max}` (`items.ts:130-135`).

- `LOOT_TABLES: Record<LootTier, LootTableEntry[]>` (`items.ts:142-174`) — the island's risk
  gradient: coastal towns feed newspawns (pistol weight 6, no rifles), inland cabins bridge,
  **military is the only source of rifles and shotguns**.
- `ZOMBIE_LOOT_TABLE` (`items.ts:120-126`) — rolled at `ZOMBIE_LOOT_CHANCE = 0.55` per corpse.
- `AIRDROP_TABLE` + `AIRDROP_ROLLS = 5` (`items.ts:103-112`) — crates roll 5 stacks.
- `LOOT_TABLE = LOOT_TABLES.coastal` is a back-compat alias (`items.ts:177`).

Rolling: `rollFromTable` (`loot.ts:27-42`) — weighted pick, `Math.random()` count in [min, max].
Spawn-point stocking picks by the spawn's tier (`loot.ts:45-62`).

Special-case item logic lives in `useItem` (`players.ts:333-390`): `raw_venison` near a campfire
(within `FIRE_WARMTH_RADIUS = 5`) cooks 1→1 `cooked_venison` instead of being eaten; eaten raw
it costs `RAW_VENISON_HP_PENALTY = 8` hp (floored at 1 hp, `players.ts:344-358`). `placeable`
places a campfire `CAMPFIRE_PLACE_DIST = 1.6` in front; past `MAX_CAMPFIRES = 32` the oldest is
snuffed. `tool` (flashlight) and weapons/ammo are not usable via `use`.

### 4.4 Adding a new item — checklist

1. Add to the `ItemType` union and `ITEM_DEFS` (`items.ts`). TypeScript then forces totality.
2. Add to whichever loot tables should drop it (or a new spawn path).
3. If it's a new `ItemKind`, handle it in `useItem`'s switch (`players.ts:360-387`) and, if it
   affects combat, in `performAttack`.
4. Client: the renderer keys held models/colors off `ItemType`/`def.color` — check
   `src/client/render/` for held-item visuals (UI swatches use `def.color` automatically).
5. No persistence work needed: inventories serialize `ItemStack = {type, count}` as JSON
   (`persistence.ts:37-47`). Old saves containing a removed/renamed type would deserialize to a
   dangling string — **never rename or remove an ItemType without bumping `SCHEMA_VERSION`**.

---

## 5. Protocol (`src/shared/protocol.ts`)

JSON text frames over WebSocket at `/ws`; all messages discriminated on `t` (`protocol.ts:1-3`).
Worker routes `/ws`, `/api/leaderboard`, `/api/health` to the single DO named `"main"`
(`src/server/worker.ts:9-19`).

### 5.1 Client → Server (`ClientMsg`, `protocol.ts:44-57`)

| Msg | Payload | Handling |
|---|---|---|
| `join` | `name, token` (32–64 hex chars, client-generated identity) | `GameRoom.handleJoin` (`GameRoom.ts:407-505`): token SHA-256 → persistence key; 3 paths: live-character takeover, persisted-living resume, fresh life |
| `input` | `cmds: InputCmd[]` | queued per player, capped at 60 (`players.ts:29,206-210`); batch truncated at 40 cmds in the parser (`protocol.ts:265`) |
| `attack` | `at?: number` (game-time the shooter's screen showed; lag-comp rewind hint) | deferred to the tick (`GameRoom.ts:272-281`) |
| `use` / `equip` / `drop` | `slot: number` | inventory ops (`players.ts`) |
| `pickup` | `id: number` | resolves loot → corpse → airdrop in one shared id space (`players.ts:408-457`) |
| `respawn` | — | gated on `RESPAWN_DELAY_S = 4` after death (`GameRoom.ts:295-302`) |
| `chat` | `text` (transport cap 512; server trims to `CHAT_MAX_LENGTH = 120`) | proximity delivery within `CHAT_RADIUS = 40`, rate-limited `CHAT_COOLDOWN_S = 0.8` (`GameRoom.ts:317-340`) |
| `ping` | `ts` | answered immediately with `pong`, never queued behind the tick (`GameRoom.ts:251-254`) |

`InputCmd` (`protocol.ts:19-28`): `{seq, dt, mx, mz, yaw, pitch, sprint, jump}` — `mx/mz` are
local-space, clamped to [-1,1] in the parser; `dt` clamped server-side to `MAX_INPUT_DT = 0.05`
and spent from a wall-clock-accruing budget (`INPUT_BUDGET_CAP_S = 0.4`) — the anti-speedhack
(`players.ts:220-258`, `constants.ts:22-29`).

`parseClientMsg` (`protocol.ts:245-315`) is the trust boundary: 8KB payload cap, type/shape
checks only; range clamping happens in the systems.

### 5.2 Server → Client (`ServerMsg`, `protocol.ts:193-232`)

**`welcome`** (`protocol.ts:194-206`, built at `GameRoom.ts:507-525`):
`{id, seed, time, you: YouState, inv: (ItemStack|null)[], selected, resumed, recap: DeathRecap|null}`.
`seed` drives client `createWorld`; `time` sets the client's game-clock base; `resumed` is true
when a persisted living character was restored; `recap` is set when the character died while
its owner was offline.

**`snap`** (`protocol.ts:207-225`, built per-recipient at `GameRoom.ts:721-854`):
`{tick, time, ack, you, players, zombies, loot, corpses, fires, drops, animals, weather, events, count}`.
- `ack` = last input seq applied for YOU (drives reconciliation).
- `you: YouState` = `Vitals & {x, y, z, vy, grounded}` (`protocol.ts:168-174`) — authoritative self.
- Interest filtering: entities beyond `INTEREST_RADIUS = 220` are dropped; loot and corpses use
  the tighter `LOOT_INTEREST_RADIUS = 120`; **airdrops are never filtered** (island-wide smoke,
  `GameRoom.ts:803-813`). Events filter by their queued position unless `onlyTo` targets one
  player (`GameRoom.ts:828-835`).
- Quantization: positions `round2` (cm), yaw `round3` (`GameRoom.ts:93-94`).
- Wire entity shapes: `WirePlayer {id, name, x, y, z, yaw, hp, item: ItemType|null, anim}` with
  anim bit flags `ANIM_MOVING|ANIM_SPRINTING|ANIM_ATTACKING` (`protocol.ts:38-40,61-71`);
  `WireZombie {…, state: "idle"|"wander"|"chase"|"attack", mil}`; `WireLoot {id, type, count, x, y, z}`;
  `WireCorpse {id, kind: "player"|"zombie", name, x, y, z, yaw, items}` (items = stack count
  remaining); `WireFire {id, x, y, z}`; `WireDrop {id, x, y, z, smoke, falling}`;
  `WireAnimal {id, x, y, z, yaw, state: "idle"|"wander"|"flee"}`.
- `weather` is a single 0..1 rain-intensity scalar (`protocol.ts:221-222`).
- `GameEvent` (`protocol.ts:176-191`): `shot` (weapon + start/end points), `swing` (player id),
  `hit` (impact point), `zdie` (zombie death point), `hurt` (victim-only damage vignette).

Other server msgs: `inv {slots, selected}` (sent after every inventory mutation), `chat`,
`death {by, recap}`, `notice {msg}` (joins/leaves/weather/airdrops), `pong`, `error`.

### 5.3 Versioning / compat — there is none on the wire

- No protocol version field exists in any message. Client and server are deployed together
  (one Worker serves both assets and the DO), so skew only exists for **already-open tabs**
  across a deploy. An old client receiving an unknown `t` or new fields will hit untyped paths.
- Persistence has versioning (`SCHEMA_VERSION` + `world_seed` meta, `persistence.ts:107-117`);
  the wire protocol does not. If a design needs graceful protocol evolution, additive optional
  fields are the only currently-safe move (the parser ignores unknown fields; the client switch
  ignores unknown `t` values silently — verify per-change).

---

## 6. Movement & collision (`src/shared/movement.ts`)

Header contract: "Client prediction and server authority run the exact same code so
reconciliation corrections stay tiny" (`movement.ts:1-2`).

- **`resolveStatics(world, x, z, y, r)`** (`movement.ts:24-53`): pushes a circle out of nearby
  wall Aabbs and tree trunks (2 iterations for corner cases). **Y-aware wall filter** at
  `movement.ts:36`: a wall is ignored if `wall.y1 <= y + STEP_UP_MAX` (low enough to step onto —
  door sills, foundations seen from above) or `wall.y0 >= y + PLAYER_HEIGHT` (entirely overhead —
  window heads, door headers). This is what makes windows vaultable and doorway headers real.
- **`stepPlayer(state, cmd, world)`** (`movement.ts:59-130`): mutates `PlayerCore`
  (`protocol.ts:9-17`: `{x, y, z, vy, yaw, pitch, grounded}`). Sequence: yaw/pitch from cmd →
  local intent rotated to world (yaw 0 faces −Z; forward = `(-sin yaw, -cos yaw)`,
  `math.ts:197-204`) → speed `WALK_SPEED = 4.2` / `SPRINT_SPEED = 6.8` (diagonals normalized) →
  **deep-water block**: target positions where `heightAt < WATER_WALK_MIN = -0.55` are rejected
  with axis-separated sliding (`movement.ts:86-95`) → `resolveStatics` → vertical: grounded
  players snap up ground rises ≤ `STEP_UP_MAX = 0.6`, jump at `JUMP_VELOCITY = 4.6`
  (jump checked before walked-off-edge — ordering bug fixed per comment at `movement.ts:108-110`),
  gravity `GRAVITY = 12.5` when airborne, land when `y <= ground && vy <= 0`.
- **`groundHeight`** = max(terrain, building floor if inside a footprint) (`world.ts:799-810`) —
  building floors are walkable surfaces, not colliders.
- **Swimming: ABSENT.** Water is a movement wall, not a medium. There is no swim state, no
  buoyancy, no water damage. Players can wade where terrain ∈ [−0.55, 0]; deeper is impassable.
  Any swimming feature must touch `stepPlayer` on both sides simultaneously (it's shared code,
  so one edit — but it changes prediction for ALL existing clients mid-session on deploy).
- **`stepZombie(zombie, tx, tz, speed, dt, world)`** (`movement.ts:143-167`): seeks a target
  point, same water rule (no sliding — just stops), same `resolveStatics` with
  `ZOMBIE_RADIUS = 0.45`, hard-snaps `y` to `groundHeight` (zombies never jump/fall). Deer
  reuse it — `Deer` is structurally a `ZombieCore` (`wildlife.ts:4-6`).
- Hit detection geometry: vertical cylinder of radius `HIT_CAPSULE_RADIUS = 0.55`, height
  `PLAYER_HEIGHT = 1.8` (`math.ts:140-172`, `combat.ts:341-396`); eye/muzzle at
  `PLAYER_EYE_HEIGHT = 1.62`.

---

## 7. Server systems (data shapes + behavior)

Tick order in `GameRoom.tick()` (`GameRoom.ts:626-706`), at `TICK_RATE = 15` Hz via
`setInterval` while sockets exist or offline bodies linger:

```
expire logout-lingers → close dead sockets → applyQueuedInputs → resolve attacks (lag comp)
→ tickZombies → tickZombieRespawns → tickSurvival → tickWeather → tickAirdrops
→ tickWildlife → tickDeerRespawns → tickFires → tickLootRespawns → tickCorpses
→ tickDroppedLoot → time += dt; tick++ → capturePosHistory → periodic persistAll
→ flushOutbox → broadcastSnapshots → events.length = 0
```

All systems are functions over `GameState` (`state.ts:221-254`): `world, time, tick, players,
zombies, loot, corpses, fires, drops, animals, weather, weatherNextAt, weatherRaining,
airdropNextAt, lootRespawns, zombieRespawns, deerRespawns, events, outbox, nextEntityId,
posHistory`. Outbound traffic is queued, never sent directly: VFX → `events` (interest-filtered
per recipient at snapshot time), direct/broadcast → `outbox` (drained after each handled
message and each tick) (`state.ts:1-5,319-335`).

**`nextEntityId` is one shared counter** across zombies, loot, corpses, fires, drops and deer
(`state.ts:246-247`) — that's what lets the single `pickup` message resolve loot vs corpse vs
crate by id.

### 7.1 Zombies (`zombies.ts`)

`Zombie` (`state.ts:85-104`): `{id, x, y, z, yaw, hp, mil, state, homeX, homeZ, targetId,
wanderX, wanderZ, wanderWait, attackCooldown}`. State machine `idle/wander/chase/attack`
(`zombies.ts:177-225`). Populations at boot (`zombies.ts:96-117`): `MILITARY_ZOMBIES = 14`
(spawned FIRST so the cap can't starve the garrison) within 30m of compound center, then
`ZOMBIES_PER_TOWN = 8` × towns, then `ZOMBIE_ROAMERS = 16` inland; global `ZOMBIE_MAX = 60`.
Military variant: 120 hp / 20 dmg / 5.6 m/s vs 60/12/5.4 (`constants.ts:73-93`). Aggro 28m,
de-aggro 55m, attack range 1.7m with a walls-only occlusion ray (`zombies.ts:162-175`). Respawns
preserve the variant, `ZOMBIE_RESPAWN_S = 30`, gated on no player within 45m (60m military), held
and retried while blocked (`zombies.ts:329-346`). Post-movement soft separation pass keeps packs
from stacking; pushed zombies re-resolve against statics/water (`zombies.ts:240-294`). **Zombies
are never persisted** — fresh spawn on every room boot (`GameRoom.ts:359-361`).

### 7.2 Survival (`survival.ts`)

`Vitals = {hp, food, water, temp}` (`protocol.ts:30-35`). Per tick (`survival.ts:121-167`):
food/water decay (`FOOD_DECAY_PER_S` ≈ empty in 25 min, water 18 min; ×`SPRINT_FOOD_MULT = 2.2`
while sprinting); body temp pulled up toward `TEMP_NORMAL = 37` during warm hours (7–20) or near
a campfire (radius 5), down otherwise; **rain** cools exposed players (not inside a building
footprint, not near fire) even in warm hours, scaled by intensity (`RAIN_TEMP_FALL_PER_S`,
`survival.ts:140-151`). Drains: hp −1/s at 0 food or water, −0.6/s below `TEMP_SHIVER = 35`.
Regen +1 hp/s when food > 60 AND water > 60. Centralized `damagePlayer`/`killPlayer`
(`survival.ts:55-97`): death drops a corpse with the whole inventory, sends `death` + broadcast
notice, and invokes the registered `DeathSink` callback (GameRoom writes leaderboard + character
row synchronously, `survival.ts:34-48`, `GameRoom.ts:575-592`).

### 7.3 Weather (`weather.ts`)

Two-state machine on game time: clear 4–9 min ↔ rain 2–4 min, intensity ramped at
1/`WEATHER_RAMP_S` (20s) per second toward 0 or 1 (`weather.ts:29-54`). `weatherNextAt === 0` is
the uninitialized marker (restored worlds carry real timestamps). Transitions broadcast a
`notice` exactly once. The wire carries only the ramped scalar.

### 7.4 Airdrops (`airdrops.ts`)

`Airdrop` (`state.ts:133-144`): `{id, x, y, z, landsAt, expiresAt, contents: ItemStack[]}`.
Schedule: first drop 3–6 min after boot (local constants, flagged "contract gap" at
`airdrops.ts:20-25`), then every 15–25 game-minutes. Landing point: random within the central
80%, terrain ≥ `AIRDROP_MIN_TERRAIN_H = 3` (inland), **outside the military compound** —
deliberate anti-double-stacking of risk/reward (`airdrops.ts:31-49`). Crate falls
`AIRDROP_FALL_DELAY_S = 30` (rendered chute, no pickup), smokes `AIRDROP_SMOKE_S = 5 min`,
despawns after `AIRDROP_TTL_S = 10 min` or when looted empty. `smoke`/`falling` wire flags are
derived from game time in the snapshot builder (`GameRoom.ts:810-811`). Drops ARE persisted
(game-time timestamps stay coherent because game time itself is persisted, `persistence.ts:150-154`).

### 7.5 Wildlife (`wildlife.ts`)

`Deer` (`state.ts:148-161`): structurally a `ZombieCore` + `{hp, state, home/wander fields}`.
`DEER_COUNT = 10` inland (terrain ≥ 2, outside towns/military), never persisted. Flee from every
living player within 22m by blending normalized away-vectors (closer threats push harder;
exactly-opposed threats → bolt along current facing), at `DEER_FLEE_SPEED = 8.5` — faster than
sprint, "you need a gun" (`constants.ts:154`, `wildlife.ts:111-149`). Killing one drops 2–3
`raw_venison` as a timed loot entity (TTL 180s) where it fell and schedules a 120s respawn
(`wildlife.ts:92-109`).

### 7.6 Loot & corpses (`loot.ts`)

`LootEntity` (`state.ts:106-117`): `{id, type, count, x, y, z, spawnId, ttl}` — `spawnId`
non-null ties it to a world `LootSpawn` (respawn cycle); `ttl` non-null marks player-dropped
items (`DROPPED_LOOT_TTL_S = 600`). Spawn-point stock never expires. When a spawn's entity is
fully taken, a respawn timer starts (240–400s), held while a player is within 25m but **forced
once 180s overdue** so camping can't starve a town (`loot.ts:85-104`, `constants.ts:104-112`).
`Corpse` (`state.ts:119-131`): persists until TTL (player 300s, zombie 120s) even when picked
clean.

### 7.7 Combat & lag compensation (`combat.ts`, `state.ts:186-317`)

- `capturePosHistory` records end-of-tick positions of players/zombies/deer stamped with the
  snapshot's `time` — a ~9-frame ring bounded by `LAG_COMP_MAX_REWIND_S = 0.35` + 0.2s slack.
- `buildRewind` (`combat.ts:112-166`): clamps the client's `attack.at` to
  `[time − 0.35, time]`, LERPs the two bracketing frames. Targets are rewound; **the shooter
  never is**. Statics never move, so occlusion needs no rewind.
- Damage applies to CURRENT entities; detection uses rewound positions. Kill credit increments
  `stats.kills`/`stats.zombieKills`.

---

## 8. Inventory model

- **One flat array: `inventory: (ItemStack | null)[]` of `INVENTORY_SLOTS = 8`**
  (`constants.ts:114`, `players.ts:93-95`). The hotbar IS the inventory — `selectedSlot` is both
  the equipped item and the hotbar cursor (`equip` just sets it, `players.ts:393-398`). There is
  no separate backpack, no equipment slots, no weight.
- `ItemStack = {type: ItemType, count: number}` (`items.ts:114-117`); per-slot cap is
  `ITEM_DEFS[type].stack` (guns 1, bandages 4, 9mm 30…).
- `addToInventory` (`players.ts:274-296`): top up existing stacks first, then fill empty slots;
  returns leftover. Partial pickups leave the remainder in the world (`players.ts:412-424`);
  corpse/crate scavenging transfers as many stacks as fit and keeps the rest on the body/crate.
- The currently held item (rendered for other players) is `inventory[selectedSlot]`
  (`GameRoom.ts:736-738`).
- Every mutation is followed by a full-inventory `inv` message — no deltas (`players.ts:262-268`).
- Death moves the entire inventory onto a corpse entity (`loot.ts:111-130`).

---

## 9. Persistence (what survives a room restart)

All saves flow through `GameRoom.persistAll` — ONE `transactionSync` wrapping `saveWorld` + a
`saveCharacter` per player ("saving either alone opens duplication/destruction windows",
`GameRoom.ts:594-606`). Cadence: every `WORLD_SAVE_INTERVAL_S = 20` of game time, plus on join,
respawn, death, disconnect and final idle stop.

| Persisted | Not persisted (fresh every boot) |
|---|---|
| loot entities, corpses, fires, loot-respawn timers, airdrops (JSON rows in `world_state`, `persistence.ts:128-165`) | zombies, deer (`GameRoom.ts:359-361`, `persistence.ts:125-127,150-152`) |
| game time, tick, nextEntityId, weather phase + schedule, airdrop schedule (meta rows) | events/outbox/posHistory, cmd queues, cooldowns |
| characters keyed by SHA-256 token hash: `{core, vitals, inventory, selectedSlot, stats, savedAt}` + alive flag + pending recap (`persistence.ts:37-47,251-277`) | player sockets/ids (id reused if free) |
| leaderboard (survives even schema/seed wipes) | |

Offline-character mechanics worth knowing for design: a disconnecting living player's body
lingers defenseless for `LOGOUT_LINGER_S = 60` (combat-log deterrent, `GameRoom.ts:536-547`);
`stats.bornAt` is shifted forward by offline time on restore so leaderboard `survivedS` never
counts logged-out time (`players.ts:152-166`); stale character rows are pruned after 30 days
(`persistence.ts:173-179`).

---

## 10. Extension points and landmines

### Safe to extend (established patterns)

1. **New worldgen features → new hash-salted rng streams.** Either a fresh xor constant
   (`createRng((seed ^ 0xNEW) >>> 0)`, precedent `rockRng`/`propRng`, `world.ts:645,676`) or a
   string-hash stream (`createRng(hashString(\`feature|${seed}|${id}\`))`, precedent windows
   `world.ts:232`). Add the generation code AFTER existing streams' draws; never touch
   `rng/milRng/townRng/bRng/lRng/tRng/rockRng/propRng` (the warning block at `world.ts:607-609`
   names them).
2. **New items** — section 4.4. Pure data for most cases.
3. **New loot tiers/tables** — extend `LootTier` and `LOOT_TABLES`; `LootSpawn.tier` is assigned
   in one place (`world.ts:499`).
4. **New tunables** — `src/shared/constants.ts` only. Several systems flag local constants as
   "contract gap" (`zombies.ts:35-49`, `wildlife.ts:24-37`, `airdrops.ts:20-25`, `players.ts:28-31`,
   `combat.ts:43-50`) — promoting those to constants.ts is welcome, inventing new system-local
   gameplay tunables is not.
5. **New entity kinds** — follow the deer pattern: shape in `state.ts`, `spawnInitial*`/`tick*`
   functions, a `Wire*` type + snapshot loop + interest filter in `GameRoom.buildSnapshot`,
   allocate ids from `state.nextEntityId`. Reuse `stepZombie` for anything ground-bound.
6. **New messages** — add to the `ClientMsg`/`ServerMsg` unions, a `parseClientMsg` case
   (server trust boundary), a `GameRoom.webSocketMessage` case, and client handling. Additive
   optional fields on existing messages are the lowest-risk evolution.
7. **New persisted world entities** — a new `kind` row in `world_state` inside
   `saveWorld`/`loadWorld` (`persistence.ts:128-242`); additive meta rows are the precedent for
   scalars (see the weather/airdrop comment at `persistence.ts:233-235`).
8. **New GameEvents** — extend the union (`protocol.ts:176-191`), emit with
   `queueEvent(state, ev, x, z, onlyTo?)`; interest filtering is automatic.

### Landmines — do not touch without explicit intent

1. **`makeHeightFn` (`world.ts:178-190`) and every existing rng stream's draw order.** Any
   change to the height formula, octave offsets, the island mask, stream seeds, draw counts, or
   acceptance conditions in the loops of `createWorld` regenerates a different world: persisted
   character positions, building-relative loot, everything. If a worldgen change is genuinely
   wanted, bump `SCHEMA_VERSION` (`persistence.ts:34`) — that wipes characters + world state
   (leaderboard survives) and is the sanctioned path (v2 precedent).
2. **The `simplex-noise` package version** (`world.ts:5`). Different noise output = silently
   different worlds + client/server desync. Pinned in practice.
3. **`stepPlayer`/`resolveStatics`** — shared prediction code. Edits are deploy-atomic for new
   sessions but any change alters feel everywhere and invalidates persisted positions resting on
   old collision (e.g. a character saved standing on geometry that no longer collides).
4. **`WORLD_SEED`** — changing it wipes characters + world via the meta mismatch
   (`persistence.ts:107-117`). That's by design, but it's a full wipe, not a migration.
5. **The one-burned-draw on the base `rng`** (`world.ts:866`) — it exists precisely so the base
   stream has a stable state; don't consume from `rng` for new features anyway (use new streams).
6. **The shared entity id space** (`state.ts:246-247`) — never introduce a second id counter for
   anything pickup-able; `pickup` resolution and persistence id-resumption
   (`persistence.ts:184-231`) both assume one space.
7. **`persistAll` exclusivity** — never call `saveWorld` or `saveCharacter` outside a path that
   keeps world + characters transactionally coherent (`GameRoom.ts:594-606` explains the
   duplication/destruction windows).
8. **Welcome-message seed is the only worldgen config channel.** A feature like "configurable
   world size" or per-room seeds must add fields to `welcome` AND make the server use them in
   its own `createWorld` call — shared constants alone only work for values baked into both
   bundles at the same deploy.
9. **Wire protocol has no version field** (section 5.3). Open tabs straddle deploys; breaking
   message changes will throw in live clients until refresh.
10. **`ItemType` strings are persisted** in inventories/loot/corpse JSON — renames/removals
    corrupt saves unless `SCHEMA_VERSION` is bumped.

### Known minor inconsistencies (true as of this read)

- `items.ts` duplicates pistol numbers that also exist as constants: `PISTOL_COOLDOWN_S = 0.35`
  and `PISTOL_RANGE = 90` (`constants.ts:100-101`) match `ITEM_DEFS.pistol.ranged` but nothing
  enforces it; combat reads only the ItemDef (`combat.ts:289-307`). The constants appear to be
  legacy.
- `Scatter.tsx:28-30` carries a stale comment claiming `World.props` "is not on the shared
  interface yet" — it is (`world.ts:106`).
- `BuildingTrim.tsx:29-33` mirrors the unexported `DOOR_WIDTH`/opening dimensions from
  `world.ts:122,209-215`; changing window/door geometry requires touching both.
