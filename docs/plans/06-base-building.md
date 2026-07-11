# Base Building v1 — claim, build, store, defend

## Summary

Players place snap-to-grid structures (foundation, wall, doorway, window wall, door, gate, storage crate) in wood and scrap-metal tiers, anchored to a global 3m build grid. Placed pieces are **dynamic statics**: a new mutable `StructureIndex` inside the shared `World` object feeds the existing `queryStatics` / `raycastStatics` / `groundHeight` paths, so client prediction, zombie pathing, melee occlusion and hitscan all work against player structures with **zero changes to movement.ts or the prediction loop**. The client receives the full structure set in batched `sFull` messages right after `welcome`, then global (never interest-filtered) `sAdd`/`sRemove`/`sState` deltas — collision data must be globally consistent or prediction diverges. Persistence is one new `world_state` row kind (`structures`, a single JSON blob) flowing through the existing `persistAll` transaction: +2 row-writes per save (the wipe-and-reinsert deletes then rewrites it), no schema bump, old saves load unchanged. Ownership is the placer's token hash; doors/gates take 4-digit code locks with an authorized list and a **per-door** (not per-identity — identities are free to mint) brute-force backoff; crates are open-access containers (walls are the security) using a small container protocol this doc owns (doc 05's searchable containers use a different, spill-based model — see Open questions). Raiding v1 is melee-vs-structure with per-tier damage multipliers (wood falls to a patient axe, scrap effectively requires future explosives), gated by a ServerConfig `offlineRaidMult` — a field doc 04's `BuildingConfig` now carries (amendment applied to doc 04 §1; see Migration). Decay removes pieces whose owner hasn't been seen for `decayHours` wall-clock. Resources are doc 05's `wood` and `scrap` material items (wood flows from doc 05's tree-gather faucet); placement requires an equipped `hammer` (new item, this doc).

Key decisions, up front: global snap grid with foundation-anchored edge sockets (no free placement); structures merged INTO the existing statics queries rather than a parallel collision path; full-set sync + global deltas (no interest filtering for structures); single-blob persistence; one shared entity id space; crates non-colliding in v1; no roofs/upper floors/clans/explosives in v1.

## Goals / Non-goals

**Goals**
- A persistence-driven reason to keep playing: a base that survives logouts and server restarts.
- Placement that feels solid: client-side ghost preview with identical validation to the server (shared `canPlace`), server-authoritative placement.
- Structures that are *real* in the sim on both sides: block movement, block bullets and melee, are stand-on-able, occlude identically for prediction.
- Honest raiding loop for v1: wood is breachable by melee with effort, doors are the weak point, offline owners get a configurable damage shield, abandoned bases decay away.
- Storage crates behind a small generic container protocol (`cOpen`/`cMove`/`cont`) owned by this doc. Doc 05's searchable containers deliberately use a spill-loot model with no per-slot state, so there is no shared protocol today — the shape is designed so doc 05 *could* adopt it later, nothing more.
- Hard limits with verified math: per-player cap, world cap, density cap, welcome-sync size, DO memory, rows-written cost.

**Non-goals (v1)**
- No upper floors, ceilings, roofs, stairs, ramps. Bases are open-topped single-story; walls (2.6m) are above the jump apex (0.846m at `JUMP_VELOCITY` 4.6 / `GRAVITY` 12.5, constants.ts:39-40) so open tops are not an entry vector.
- No crafting UI, workbenches, or building upgrades-in-place. You place a tier directly; replacing wood with scrap = demolish + rebuild.
- No clan/team system. Sharing = sharing the door code.
- No explosives, no raid tools beyond existing weapons. Stated consequence: scrap-metal is close to raid-proof in v1 (see Implications → Threatens).
- No free-form placement or rotation; everything snaps to the global grid / edge sockets.
- Foundations do NOT count as rain shelter (survival.ts shelter = building footprint or campfire); there is no roof, so they shouldn't.
- No structure repair in v1 (damaged pieces stay damaged until destroyed or decayed).

## Current state

What exists today, verified against source:

- **Statics pipeline.** `createWorld` builds a closed-over spatial grid (`GRID_CELL = 16`, world.ts:123, grid build world.ts:739-777) of wall `Aabb`s + tree circles. `world.queryStatics(x,z,r)` (world.ts:780-797) returns nearby walls/trees; `world.raycastStatics(origin,dir,maxDist,includeTerrain?)` (world.ts:812-863) marches the grid and returns nearest hit distance (a `number | null` — it does NOT identify what was hit). `world.groundHeight` (world.ts:806-810) = max(terrain, building floor inside footprint via `buildingFloorAt` world.ts:799-804).
- **Movement is y-aware and shared.** `resolveStatics` (movement.ts:24-53) ignores walls with `wall.y1 <= y + STEP_UP_MAX || wall.y0 >= y + PLAYER_HEIGHT` (movement.ts:36). This is what makes door headers (2.2) walk-under-able and below-floor skirts harmless (world.ts:206-215). **Caution on windows:** the worldgen window opening (sill 0.75, head 1.85) is NOT passable. To slip through, the below-sill box must be ignored (`y >= floor + 0.15`) *simultaneously* with the above-head box (`y <= floor + 0.05`) — contradictory, because the 1.1m opening is smaller than `PLAYER_HEIGHT - STEP_UP_MAX` = 1.2m (constants.ts:35,41). The comment at world.ts:206-208 claiming the sill is "not a jump-vault" blocker is wrong about its own shipped code (verified by running `stepPlayer` against the 4-box window layout across jump timings — nothing crosses). Windows are shoot/see-through only. `stepPlayer`/`stepZombie` run identically on client (prediction.ts:28-32, reconcile prediction.ts:58-83) and server (players.ts:245).
- **Combat occlusion.** Melee uses `raycastStatics(..., false)` walls-only (combat.ts:53-73); ranged caps every pellet at the nearest static hit (combat.ts:332-333). Neither can attribute damage to what blocked the ray.
- **Determinism contract.** Worldgen rng streams are frozen (world.ts:342-866, burn at :866); new world features must use new hash-salted streams (precedent world.ts:232). Structures add ZERO rng draws — the index starts empty — so this design has no worldgen-determinism surface at all.
- **Placement precedent.** Campfires: `useItem` kind `"placeable"` places at `CAMPFIRE_PLACE_DIST` in front of the player, no validation beyond a world cap (players.ts:370-384). Campfires have no collision and live in `game.fires`.
- **Entity ids.** One shared counter `game.nextEntityId` (state.ts:246-247) spans zombies/loot/corpses/fires/drops/deer; the single `pickup` message resolves loot→corpse→airdrop by id (players.ts:408-457). Research flags adding a second id space as a landmine.
- **Persistence.** ALL saves go through `GameRoom.persistAll` (GameRoom.ts:598-606), one `transactionSync` wrapping `saveWorld` (wipe + reinsert `world_state` JSON rows, persistence.ts:128-165) + `saveCharacter` per player. `loadWorld`'s switch silently skips unknown kinds (persistence.ts:190-219) — additive row kinds need no `SCHEMA_VERSION` bump (currently 2, persistence.ts:34). `characters.updated_at` is maintained on every save (persistence.ts:275) and `pruneStaleCharacters` deletes rows idle 30 days (persistence.ts:173-179).
- **Wire.** `welcome` carries `{id, seed, time, you, inv, selected, resumed, recap}` (protocol.ts:193-206); the client builds its world from `welcome.seed` (connection.ts:260). `parseClientMsg` is the trust boundary (protocol.ts:245-315). No `PROTOCOL_VERSION` exists yet (doc 03 — the server-info contract — creates it in its M1). Client `handleMessage` switch ignores unknown message types (connection.ts:200-241) — additive server messages are safe for stale clients.
- **Render precedents.** Buildings.tsx merges ~300 static boxes into 8 draw calls (Buildings.tsx:1-110); BuildingTrim.tsx does `InstancedMesh` per piece kind with matrices written once (BuildingTrim.tsx:225-257). Structures change at runtime, so the instancing pattern (not the merge pattern) is the right precedent.
- **No-build zone data already exists.** `world.towns` (cx,cz,radius), `world.military` (cx,cz,radius), `world.buildings` (footprints), `world.spawnPoints` (beach ring), and all `world.lootSpawns` sit inside buildings (world.ts:494-509). No new world data is needed — no-build is derivable. Scope confirmed, nothing to generate.
- **Costs context** (research/cf-costs.md): persistAll's wipe-and-reinsert row count is the free-plan killer; any new persistence must not multiply row writes. Single-blob rows are the sanctioned mitigation.

## Design

### Build grid and piece set

Global world-aligned square grid, pitch `BUILD_CELL = 3` m, cell coords `gx = floor(x / BUILD_CELL)`, `gz = floor(z / BUILD_CELL)` (range ±133 inside `WORLD_SIZE` 800). Foundations occupy **cells**; walls/doorways/windows/gates occupy **edges** (a cell + side 0..3, canonicalized so the edge between two cells has one address); doors are **attachments** to a doorway's edge; crates are free-positioned within a cell but validated against the same zones.

Edge canonical form: store `(gx, gz, edge)` with `edge ∈ {0: +Z, 2: +X}` only — a placement aimed at side 1/-Z of cell (gx,gz) is stored as edge 0 of (gx, gz-1), side 3/-X as edge 2 of (gx-1, gz). One wall-class piece per edge; one attachment (door) per edge.

| Kind | Socket | Collision boxes | Notes |
|---|---|---|---|
| `foundation` | cell | 1 slab: top = `floorY`, skirt 3m below (FOUNDATION_DEPTH precedent world.ts:130) | contributes `floorAt` to `groundHeight` |
| `wall` | edge (needs adjacent foundation) | 1 full box, `floorY..floorY+2.6`, thickness 0.25 | |
| `doorway` | edge (needs adjacent foundation) | 3 boxes: two 0.7m side strips + header 2.2..2.6 | mirrors worldgen `DOOR_WIDTH` 1.6 / `DOOR_HEIGHT` 2.2 (world.ts:122,213) |
| `window` | edge (needs adjacent foundation) | 4 boxes: side strips + below-sill (..0.75) + above-head (1.85..) | worldgen opening geometry (world.ts:209-215): shoot/see-through, **NOT passable** — the 1.1m opening is under `PLAYER_HEIGHT - STEP_UP_MAX` (1.2m), so movement.ts:36 always keeps one box solid. Deliberate: a vaultable window would be a free, zero-damage raid entry into every base |
| `door` | attachment on a doorway edge | closed: 1 thin box filling the 1.6m opening; open: **none** | lockable, open/close state on the wire |
| `gate` | edge (needs adjacent foundation) | closed: 1 full-edge box; open: none | a 3m-wide lockable door, no doorway needed |
| `crate` | free inside a cell, on foundation or terrain | **none (v1)** | container, 12 slots, open-access |

All collision boxes are plain `Aabb`s with below-floor skirts, exactly like building walls — the y-aware filter in movement.ts:36 then gives stepping onto foundations and walking under doorway headers for free (windows stay impassable, per the table). Geometry is derived **deterministically from the piece record** by shared code (`pieceAabbs(piece)` in `packages/shared/src/structures.ts`); AABBs never travel on the wire or into storage.

`floorY` for a foundation = `max(heightAt at 4 cell corners) + 0.18`, quantized to 0.05m (`Math.round(y * 20) / 20`) to kill any float-representation doubt, computed **once at placement on the server** and carried in the piece record from then on (wire + persistence). Edge pieces inherit `floorY` from their anchoring foundation (the higher one when both sides have foundations).

### Piece data (shared types)

```ts
// packages/shared/src/structures.ts — new file, imported by world.ts, server systems, client
export type PieceKind =
  | "foundation" | "wall" | "doorway" | "window" | "door" | "gate" | "crate";
export type PieceTier = 0 | 1; // 0 = wood, 1 = scrap

export interface StructurePiece {
  id: number;            // from game.nextEntityId — the ONE shared id space
  kind: PieceKind;
  tier: PieceTier;
  gx: number;
  gz: number;
  /** Canonical edge (0 = +Z, 2 = +X) for edge/attachment pieces; absent for cells. */
  edge?: 0 | 2;
  /** Free position within the cell — crates only. */
  x?: number;
  z?: number;
  floorY: number;        // computed at placement, authoritative thereafter
  hp: number;
  open?: boolean;        // door/gate
}

/** Server-only extension — never sent to clients. */
export interface ServerPiece extends StructurePiece {
  ownerHash: string;             // placer's tokenHash (persistence key, like characters)
  code: string | null;           // 4 digits, door/gate only
  /** Crates only: fixed-length CRATE_SLOTS array. Slot indices are STABLE
   * identifiers — removal nulls a slot, never compacts — which is what makes
   * server-serialized concurrent cMove loss-free (a slot address can't shift
   * under a racing move). */
  contents: (ItemStack | null)[] | null;
  authorized: string[];          // tokenHashes granted via tryCode (cap 16)
  placedAtMs: number;            // Date.now() — decay uses wall-clock
}
```

The wire/client type is `StructurePiece` exactly (plus a derived `locked: boolean` for doors/gates so the client can prompt for a code). `ownerHash` never leaves the server — clients don't need ownership for collision, and interactions are server-validated. **The only path from index to wire is an explicit projection** — `toWirePiece(piece: ServerPiece): WirePiece` in `apps/game/src/server/systems/structures.ts` — that copies the `StructurePiece` fields and derives `locked`. `sFull`/`sAdd` MUST build payloads through it; serializing index objects directly would broadcast every door code, authorized list, crate inventory and `ownerHash` to all clients. Milestone 2 carries an acceptance check for this.

Piece stats are data, mirroring the `ITEM_DEFS` precedent (items.ts:56):

```ts
export interface PieceDef {
  kind: PieceKind;
  /** wood units / scrap units consumed (same count both tiers). */
  cost: number;
  /** Base hp per tier: [wood, scrap]. */
  hp: [number, number];
}
export const PIECE_DEFS: Record<PieceKind, PieceDef> = {
  foundation: { kind: "foundation", cost: 8, hp: [600, 1800] },
  wall:       { kind: "wall",       cost: 6, hp: [400, 1200] },
  doorway:    { kind: "doorway",    cost: 6, hp: [400, 1200] },
  window:     { kind: "window",     cost: 6, hp: [350, 1050] },
  door:       { kind: "door",       cost: 4, hp: [250, 750]  },
  gate:       { kind: "gate",       cost: 8, hp: [450, 1350] },
  crate:      { kind: "crate",      cost: 6, hp: [200, 200]  }, // wood-only in v1
};
/** Incoming structure damage multiplier per tier: [melee, bullet]. */
export const TIER_DMG_MULT: Record<PieceTier, [number, number]> = {
  0: [1.0, 0.5],
  1: [0.25, 0.25],
};
```

Scalar tunables go to `packages/shared/src/constants.ts` per house rules: `BUILD_CELL = 3`, `BUILD_RANGE = 6`, `BUILD_WALL_HEIGHT = 2.6`, `BUILD_WALL_THICKNESS = 0.25`, `BUILD_FOUNDATION_MAX_SLOPE = 1.1` (max corner-height spread), `BUILD_MIN_TERRAIN_H = 0.5`, `NO_BUILD_TOWN_MARGIN = 12`, `NO_BUILD_MILITARY_MARGIN = 16`, `NO_BUILD_BUILDING_MARGIN = 6`, `NO_BUILD_SPAWN_RADIUS = 24`, `WORLD_PIECE_CAP = 3000`, `BUILD_DENSITY_RADIUS = 12`, `BUILD_DENSITY_CAP = 120`, `CRATE_SLOTS = 12`, `FIST_STRUCT_DMG = 1`, `RAID_OFFLINE_GRACE_S = 300`, `DOOR_CODE_TRY_COOLDOWN_S = 1` (per-identity UX throttle, NOT a security control), `DOOR_CODE_FAILS_PER_LOCKOUT = 5`, `DOOR_CODE_BACKOFF_BASE_S = 30`, `DOOR_CODE_BACKOFF_MAX_S = 3600` (per-door global backoff — see Ownership).

### The StructureIndex — dynamic statics on both sides (the hard part)

New mutable index, one instance owned by every `World` object, created **empty** inside `createWorld` (zero rng draws, zero determinism surface):

```ts
// packages/shared/src/structures.ts
export interface StructureIndex {
  pieces: Map<number, StructurePiece>;
  /** Derives AABBs via pieceAabbs(), inserts into an own spatial grid (GRID_CELL 16). */
  add(piece: StructurePiece): void;
  remove(id: number): void;
  /** Door/gate toggles swap collision boxes in/out of the grid. */
  setOpen(id: number, open: boolean): void;
  /** Walls near a point — merged into World.queryStatics results. */
  queryWalls(x: number, z: number, r: number): Aabb[];
  /** Highest foundation top whose cell contains (x,z), or null. */
  floorAt(x: number, z: number): number | null;
  /** Nearest piece hit WITH attribution — combat damage needs to know what it hit. */
  raycastPiece(origin: Vec3, dir: Vec3, maxDist: number): { t: number; id: number } | null;
  /** canPlace support. */
  cellPiece(gx: number, gz: number): StructurePiece | null;
  edgePieces(gx: number, gz: number, edge: 0 | 2): { wall: StructurePiece | null; door: StructurePiece | null };
  countNear(x: number, z: number, r: number): number;
  clear(): void;
}
```

`World` integration (world.ts):

- `World` gains `structures: StructureIndex`.
- `queryStatics` appends `structures.queryWalls(x,z,r)` to its `walls` array. **Movement code does not change at all** — structure walls obey the same y-aware filter, so foundations are step-on-able and door headers pass under (and windows stay reliably solid to movement, as intended).
- `raycastStatics` takes `min(existing best, structures.raycastPiece(...)?.t)`. Melee occlusion (walls-only flag) and hitscan capping then work against player structures with no combat changes for *occlusion*. Combat additionally calls `structures.raycastPiece` directly when it wants *attribution* (see Raiding).
- `groundHeight` becomes `max(terrain, buildingFloorAt, structures.floorAt)` with the same "floor only if above terrain" guard.

**Why merge into World instead of a parallel path:** `stepPlayer(state, cmd, world)` is called from prediction.ts:29, players.ts:245, and `stepZombie` from zombies — changing those signatures ripples through every consumer and invites drift. One object, one truth.

**Client sync.** Both sides run identical `add/remove/setOpen` code; the server is the only originator of mutations.

1. On join, right after `welcome`, the server sends the full set in `sFull` batches (500 pieces/message, ~45KB each; sent synchronously in `handleJoin` so socket ordering guarantees they precede any subsequent delta or snapshot). The client (in `onWelcome`-adjacent handling) clears and repopulates `clientWorld.world.structures`.
2. Every mutation broadcasts globally: `sAdd` (piece), `sRemove` (id), `sState` (id + open/locked/hp). **Never interest-filtered** — prediction needs the complete collision set everywhere; an interest-filtered client walking into an unseen base would mispredict every step and, worse, disagree about `groundHeight`. Delta rates are human-scale (a player places ~1 piece per few seconds), so global broadcast costs are negligible next to 15Hz snapshots.
3. Misprediction window: a piece placed/toggled at server tick T reaches clients one RTT later; a client moving through that exact spot mispredicts for a tick or two and is snapped by the existing `reconcile` (prediction.ts:58-83). Same class of correction as any collision disagreement; doors are NOT client-side predicted (the ~100-150ms latency on a door opening is acceptable and DayZ-familiar).
4. `welcome` resets: client rebuilds the index from scratch on every welcome (`resetClientWorld` + fresh `createWorld`, connection.ts:256-266 — index arrives empty, then `sFull` fills it).

### Placement mechanics

Snap-to-grid with foundation-anchored sockets — chosen over free placement because the server validates a *discrete address* (cell/edge occupancy lookup) instead of arbitrary-OBB overlap math, the ghost can never disagree with the server about position, and persistence/wire records are 5 small integers.

Shared validation, used by the client ghost (green/red) and the server verbatim:

```ts
// packages/shared/src/structures.ts
export type PlaceTarget = { kind: PieceKind; tier: PieceTier; gx: number; gz: number; edge?: 0 | 2; x?: number; z?: number };
export type PlaceRejection =
  | "occupied" | "no-foundation" | "no-doorway" | "slope" | "water" | "zone"
  | "overlap" | "blocked" | "density" | "bounds";
export function canPlace(
  world: World,
  t: PlaceTarget,
  occupants?: Iterable<{ x: number; y: number; z: number }>,
): PlaceRejection | null;
```

Checks, in order (early returns): bounds (cell within ±`WORLD_SIZE*0.48`); occupancy (cell/edge/attachment free); support (edge pieces need an adjacent foundation; door needs a doorway with no door); terrain — every foundation corner `heightAt > BUILD_MIN_TERRAIN_H` (no shoreline/sea bases) and corner spread ≤ `BUILD_FOUNDATION_MAX_SLOPE`; no-build zones — distance to each town center < `radius + NO_BUILD_TOWN_MARGIN`, military `radius + NO_BUILD_MILITARY_MARGIN`, any worldgen building footprint inflated by `NO_BUILD_BUILDING_MARGIN`, any spawn point within `NO_BUILD_SPAWN_RADIUS` (loot spawns are covered transitively — all inside buildings, world.ts:494-509); physical overlap — `world.queryStatics` at the piece footprint must return no intersecting worldgen wall/tree/prop; occupants (`"blocked"`) — no capsule in the passed iterable may stand inside the new boxes (anti-trap). The server passes all `game.players` cores; the client ghost passes its own predicted position plus the interpolated `clientWorld.players` views (runtime.ts:146). Interpolated remote positions lag roughly one RTT, so this one check is an *approximation* on the client — a rare green-ghost server rejection is possible when someone sprints into the cell at the moment of placement (milestone 3's acceptance carves this case out). Density — `structures.countNear(center, BUILD_DENSITY_RADIUS) < BUILD_DENSITY_CAP`.

Server-only checks on top: requester within `BUILD_RANGE` of the target, hammer equipped, resources present (`wood`/`scrap` count ≥ `cost`), per-player cap (`config.building.pieceCapPerPlayer`, count by `ownerHash` — O(n) scan over ≤3000 pieces is fine at placement rate; note this cap is a fairness dial for honest players, NOT an anti-grief control — see Griefing policy), world cap `WORLD_PIECE_CAP`, `config.building.enabled`.

Placement flow:

1. Client: hammer equipped → build mode HUD. Crosshair ray (camera, client-only) finds target point → snapped to cell/edge → ghost mesh at derived AABBs, green when `canPlace === null` and local resources suffice, red otherwise with the rejection reason as HUD text.
2. Click → `{t:"place", kind, tier, gx, gz, edge?, x?, z?}`.
3. Server: full validation → deduct resources (`addToInventory`-style removal + `sendInventory`), `id = game.nextEntityId++`, compute `floorY`, `world.structures.add(piece)`, broadcast `sAdd`. No immediate persist — the next periodic `persistAll` snapshots piece + deducted inventory **atomically** (same transaction), so a crash in the gap loses both coherently, never duping resources.
4. Client receives its own `sAdd` like everyone else and adds to the index; the ghost revalidates (now `occupied`).

Demolish: owner aims at own piece with hammer, holds **X** (NOT E — E is the established interact/pickup key, ARCHITECTURE.md InputController contract, and overloading it collides with the pickup flow) → `{t:"demolish", id}` → server checks `ownerHash`, removes (cascading the door when a doorway dies), broadcasts `sRemove`. No refund in v1. Foundations can't be demolished/destroyed while edge pieces anchor to them (reject with notice) — avoids orphan-wall bookkeeping.

### Ownership, locks, access

- Owner = `ownerHash` (the placer's `tokenHash`), stable across sessions and restarts exactly like character rows. No transfer, no co-ownership in v1.
- Doors/gates: `{t:"door", id}` toggles open/close if the piece is unlocked OR the sender's tokenHash is owner/authorized. `{t:"setCode", id, code}` (owner only, `/^\d{4}$/`) sets/changes the code and **clears** `authorized` (changing the code revokes everyone). `{t:"tryCode", id, code}` — correct code appends the sender's tokenHash to `authorized` (cap 16, FIFO eviction) and opens the door; this is the "share the code with friends" mechanic.
- Brute-force guard — **per-door, never per-identity.** Identities are free and unlimited: `getToken()` mints a 16-byte random token entirely client-side (connection.ts:36-40), worker.ts has zero per-IP throttling (the whole file is 22 lines), and the message rate limit is keyed per socket (`rateBySocket`, GameRoom.ts:118-119, 226-241). Any per-identity cooldown or lockout is therefore Sybil-bypassable: an attacker pre-joins many sockets, each a fresh token with a clean bucket, and parallelizes the 10^4 code space in minutes. So the real guard is a **global per-door budget**: an in-memory transient map `doorId → { fails, lockedUntil, backoff }`; after `DOOR_CODE_FAILS_PER_LOCKOUT` (5) consecutive failed `tryCode`s on a door *from any identity combined*, the door rejects all `tryCode` for `DOOR_CODE_BACKOFF_BASE_S` (30s), doubling per subsequent lockout up to `DOOR_CODE_BACKOFF_MAX_S` (1h); a correct code resets the counter and backoff. Owner and already-authorized hashes never call `tryCode` (the door simply opens for them), so a griefer hammering a door can never lock the owner out — the keying must stay exactly this way. Honest math: expected ~5,000 guesses to crack; at 5 guesses per lockout window with backoff capped at 1h that is ~1,000 windows ≈ **weeks of continuous hammering on one door**, vs ~30s to axe through a wood door — the code stops being the cheapest entry. Two stated residuals: (1) `offlineRaidMult` scales structure damage only and does nothing for code-guessing — without the per-door budget, the code (not the wall tier) would bound offline security for *every* base including scrap; (2) a griefer can keep a door's `tryCode` locked out, blocking a not-yet-authorized friend from entering the shared code until the backoff lapses — accepted (the owner can let them in). The per-identity `DOOR_CODE_TRY_COOLDOWN_S` survives purely as UX anti-mash; it is not a security control.
- Crates: NOT lockable. Anyone in range can open one; walls and doors are the security perimeter (Rust-box precedent). Owner-only demolish; destroying or demolishing a crate spills its contents as dropped loot entities at its position (reusing `dropAtFeet`-style spawning, players.ts:317-330).

### Storage crates — container wire shape (owned by this doc)

Crates introduce a generic container protocol. To be plain about the cross-doc situation: **doc 05's searchable containers do NOT use this protocol** — they use a `{t:"search"}` spill-loot model that drops rolled loot on the ground precisely to avoid a container-panel protocol, with no per-slot container state at all (05-items-scavenging-crafting.md:312-329, :444). There is no shared implementation today; this doc owns `cOpen`/`cMove`/`cont` solo. The shape is generic enough that doc 05 could adopt it later *if* its container design ever changes to per-slot state — that would be a real design change to doc 05, to be negotiated then, not assumed now. Container = id + fixed slot array of `ItemStack | null` (slot indices are stable; removal nulls, never compacts):

```ts
// ClientMsg additions
| { t: "cOpen"; id: number }                 // request container view
| { t: "cMove"; id: number; from: number; to: number; dir: "in" | "out" }
// ServerMsg additions
| { t: "cont"; id: number; slots: (ItemStack | null)[] }  // full container state
```

`cOpen` validates range (`PICKUP_RANGE`-style, 2.6m vs crate position) and replies `cont`. `cMove` moves one whole stack between player inventory slot `from` and container slot `to` (`dir:"in"`) or vice versa (`dir:"out"`); server re-validates range per move, mutates both sides, replies with `cont` + the standard full-inventory `inv` message (the existing no-deltas inventory precedent, players.ts:262-268). The client closes the panel on movement away (client-side) and the server simply rejects out-of-range moves — no server-side "open session" state to track. Concurrent access by two players is safe because every `cMove` is validated against current contents and answered with authoritative `cont`.

Crate contents live inside the `ServerPiece.contents` array and persist with the structures blob — items moving between a player and a crate are snapshotted by the same `persistAll` transaction, preserving the no-dupe invariant (GameRoom.ts:594-597 comment).

### Raiding, protection, decay

**Damage sources.** `ItemDef` gains optional `structDmg?: number` (weapons-as-data precedent, items.ts:42-54): axe 6, pistol 1, rifle 2, shotgun 0.5/pellet. Fists cannot be ItemDef data — there is no fists item; `performAttack` resolves `def = stack ? ITEM_DEFS[stack.type] : null` and falls back to the `FIST_DMG` constant when null (combat.ts:176-177, :193). Structure damage mirrors that exact precedent: a new `FIST_STRUCT_DMG = 1` constant in constants.ts is the fallback when no item is equipped. Effective damage = `(def?.structDmg ?? FIST_STRUCT_DMG) × TIER_DMG_MULT[tier][melee|bullet] × (ownerOnline ? 1 : config.building.offlineRaidMult)`.

- Melee: after the existing target search finds no entity (combat.ts:209-256), cast `lookDir(yaw, pitch)` from chest height up to `MELEE_RANGE` via `structures.raycastPiece`; damage the piece iff its `t` ≤ the plain `raycastStatics` distance (a worldgen wall in front eats the swing, as today). Reuse the `hit` event for impact feedback.
- Ranged: `fireRanged` already computes `staticT` per pellet (combat.ts:332); also compute `pieceHit = structures.raycastPiece(...)`; if no entity was hit closer and `pieceHit.t ≈ staticT`, apply bullet `structDmg`. Ammo scarcity makes gun-raiding wasteful by design.
- Zombies/deer never damage structures (v1).

Resulting raid times (axe, cooldown 0.7s, owner online): wood door ≈ 30s, wood wall ≈ 47s, scrap door ≈ 6min, scrap wall ≈ 9min. With `offlineRaidMult 0.25`: 4× those. Wood = "a determined visitor gets in", scrap = "bring friends and time". Stated plainly: until explosives exist, scrap is near-unraidable — that is the v1 trade and it's listed under Threatens.

**Offline protection.** `ownerOnline` = any `game.players` entry with matching `tokenHash` — **regardless of `alive` or `offline`** — OR within `RAID_OFFLINE_GRACE_S` (300s) of the last moment such an entry existed (transient in-memory map `ownerHash → lastPresentGameTime`, maintained on the tick). Both relaxations are load-bearing, each killing a cheese in a different direction: (1) requiring `alive` would hand the defender the offline shield the instant a raider *kills* them — dead players stay in `game.players` until they respawn (GameRoom.ts:295-301, players.ts:185-203), and "sit on the death screen to shield the base" is player-controllable — so raiders would be mechanically punished for winning the fight; (2) requiring `offline === false` would make combat-logging an *instant* shield, since a logout flips the flag immediately (GameRoom.ts:542-543) even while the body lingers. Counting any entry (alive, dead, or lingering) plus the 5-minute grace means neither dying nor yanking the cable interrupts a raid in progress; the shield arrives only after the owner has genuinely been gone. `offlineRaidMult` is consumed from `ServerConfig` — doc 04's `BuildingConfig` now carries it (amendment applied; see Migration): default/deadcoast `0.25`, ironcoast `1.0`, driftwood/homestead `0` (structures invulnerable while owner away). Reminder from the lock section: this multiplier protects *structure hp* only — door codes are protected by the per-door backoff, not by this.

**Destruction.** hp ≤ 0 → remove from index, broadcast `sRemove`, cascade attached door if a doorway dies, spill crate contents. `sState` broadcasts hp on every structure hit (raid-rate traffic ≈ 1.4 msg/s broadcast during an active melee raid — negligible) so clients can render damage tiers (crack overlay ≥50%, heavy ≥80%).

**Decay.** Sweep on `ensureGame` boot and every 5 game-minutes during the tick: for each distinct `ownerHash`, read `characters.updated_at` (new persistence helper `lastSeenMs(sql, tokenHash)`); if `Date.now() - lastSeen > config.building.decayHours * 3600_000` — or the character row no longer exists (pruned after 30 days, persistence.ts:173-179) — remove all of that owner's pieces (`sRemove` broadcasts, crates spill nothing on decay — contents vanish with the base). Wall-clock (not game time) because game time freezes while the room idles. Default `decayHours = 168` (7 days); `0` disables decay. The boot sweep covers idle-server gaps: an abandoned base disappears the first time anyone wakes the room after the window.

### Resources and tools

Materials are **doc 05's items, consumed as-is** — an earlier draft of this doc invented conflicting definitions (wood stack 10, `scrap_metal`, +1 wood per axe swing); those are dead. Persisted `ItemType` strings are forever (research/codebase-sim.md:301-302), so the ids below are the contract:

- `wood` ("Wood Branches", kind `material`, **stack 8**) and `scrap` ("Scrap Metal", kind `material`, **stack 8**) — exactly doc 05's catalog rows (05-items-scavenging-crafting.md:176, :178). If this doc's milestone 2 lands before doc 05's item catalog, it adds these two entries with doc 05's exact ids/names/stacks so the catalogs converge regardless of landing order.
- `hammer` (kind `"tool"`, stack 1) is **this doc's one new item** (doc 05 has no hammer). Additive `ITEM_DEFS` entry; loot weight ~7 coastal/inland.
- Loot: `scrap` enters loot tables per doc 05's rebalance (toolboxes, lockers, military floor loot); airdrops add `scrap` (8-14) here.
- Wood faucet: **doc 05's tree-gather mechanic, unchanged** (05-items-scavenging-crafting.md:348-369): E-interact with an axe equipped on the nearest trunk within `GATHER_RANGE` (3.0) → `{t:"gather", k:"tree", id}` grants `WOOD_PER_GATHER_MIN..MAX` (2-3) wood, per-tree transient cooldown `TREE_GATHER_COOLDOWN_S` (180s). Doc 05 explicitly keeps the axe swing a pure weapon and rejected chop-by-swinging (its open question 3) — this doc defers; combat.ts stays untouched by resource gathering. Trees are not consumed — renewable by design.
- Pacing under the adopted faucet: a starter 1-cell box (foundation 8 + three walls 18 + doorway 6 + door 4 = 36 wood) ≈ 15 tree-gathers ≈ a few minutes walking a treeline. Bonus property: the per-tree cooldown is a natural rate limit on build-spam that the old per-swing faucet lacked.

### Wire protocol additions

```ts
// ClientMsg
| { t: "place"; kind: PieceKind; tier: PieceTier; gx: number; gz: number; edge?: 0 | 2; x?: number; z?: number }
| { t: "demolish"; id: number }
| { t: "door"; id: number }
| { t: "setCode"; id: number; code: string }
| { t: "tryCode"; id: number; code: string }
| { t: "cOpen"; id: number }
| { t: "cMove"; id: number; from: number; to: number; dir: "in" | "out" }

// ServerMsg
| { t: "sFull"; pieces: WirePiece[]; done: boolean }   // batched full sync after welcome
| { t: "sAdd"; piece: WirePiece }
| { t: "sRemove"; id: number }
| { t: "sState"; id: number; open?: boolean; locked?: boolean; hp?: number }
| { t: "cont"; id: number; slots: (ItemStack | null)[] }

// WirePiece = StructurePiece (shared shape) + { locked?: boolean },
// produced EXCLUSIVELY by toWirePiece() — see Piece data; raw index objects
// carry door codes and ownerHash and must never be serialized.
```

`parseClientMsg` additions follow the existing strict-shape style (protocol.ts:245-315): kind/tier whitelists, `gx/gz` integer-clamped to grid bounds, `edge ∈ {0,2}`, `code` matched against `/^\d{4}$/`, slot indices `| 0`. These are new message types that change predicted collision ⇒ **bump `PROTOCOL_VERSION`** in packages/shared/src/protocol.ts (doc 03 M1 creates it; if that hasn't landed yet, create it at `1` per doc 03's spec — including `join.proto`/`welcome.proto` — then bump). Stale clients across a deploy ignore unknown server messages (connection.ts switch has no default) — additive-safe.

### Persistence

One new `world_state` row kind written inside the existing `saveWorld` wipe-and-reinsert: kind `"structures"`, payload = `JSON.stringify([...world.structures pieces as ServerPiece])` — a **single row**. `loadWorld` gains a `case "structures"` that re-`add`s every piece into `game.world.structures` and folds piece ids into the `maxId` calculation (persistence.ts:184-231) so `nextEntityId` resumes above them. Unknown-kind skipping means old snapshots load as "no structures" and new snapshots degrade gracefully on rollback. **No `SCHEMA_VERSION` bump.**

Size/cost math at the 3000-piece world cap: blob ≈ 300KB (≈100B/piece with server fields) — far under the 2MB SQLite row cap. Rows written per `persistAll`: `saveWorld` is wipe-and-reinsert (`DELETE FROM world_state`, persistence.ts:130) and deletes are billed as rows written (cf-costs.md) — that is why the formula's `2W` term exists — so an always-present structures row costs **+2 row-writes per save** (one delete + one reinsert): ~2W+8+P becomes ~2(W+1)+8+P = ~2W+10+P. At 180 saves/h that is ≈4.3k extra rows/day against the 100k/day free cap — negligible, and exactly the single-blob pattern cf-costs.md prescribes. Byte churn ≈ 15KB/s at the every-20s cadence at full cap — acceptable.

### Limits & perf (math at the caps)

- `WORLD_PIECE_CAP = 3000`, `pieceCapPerPlayer = 120` default (ServerConfig), density ≤ 120 pieces within 12m. Be clear about what the per-player cap is: tokens are minted free client-side (connection.ts:36-40) with no per-IP throttle anywhere (worker.ts), so a cap counted by `ownerHash` is **unenforceable against a Sybil attacker** — it is a fairness dial for honest players, and the only hard limit is the global `WORLD_PIECE_CAP` (see Griefing policy for the monopolization consequence and mitigations).
- DO memory: 3000 pieces × ~500B (record + 1-4 derived AABBs in the grid) ≈ **1.5MB** — noise against the 128MB DO.
- Join sync: 3000 wire pieces × ~85B JSON ≈ **255KB**, sent as six 500-piece `sFull` messages (~45KB each, well under any WS frame concern) in the same breath as `welcome`. One-time per join; compare the 4.8MB client bundle.
- Snapshots: structures are NOT in snapshots — **zero recurring snapshot cost**. Tick cost unchanged: `queryStatics` stays grid-local; a dense base adds tens of AABBs to queries inside it, same order as standing in the military compound today.
- Render: one `InstancedMesh` per (kind × tier) ≈ ≤14 instanced meshes + door state handling; buffers allocated at a capacity high-water mark and rewritten on deltas (O(pieces) matrix writes at human placement rates). Frustum culling on; collision data stays global but rendering is free to cull.
- Rate limiting: `place`/`door`/`tryCode` ride the existing 600 msgs/5s socket budget (GameRoom.ts:118-119); `place` is additionally self-limiting via resources.

### Griefing policy (decided)

- **Blocking POIs/spawns/loot:** prevented structurally by the no-build zones above (towns, military, every building footprint, beach spawn ring).
- **Walling players in:** two-layer answer. (1) Placement rejects any piece whose boxes would contain a player capsule (the `occupants` check in `canPlace`; server passes all `game.players`). (2) Nothing is inescapable: bare fists deal `FIST_STRUCT_DMG` 1, so even a naked trapped player can break a wood wall (~5min of punching) — and `respawn` is always available. Scrap traps are theoretically nastier (fists × 0.25) but require the victim to stand still inside an 8-scrap-piece enclosure while it's built around the occupants check — accepted as residual risk, revisit if observed.
- **Terrain chokepoints:** open-terrain walls are legal (the island is 800m; routes around exist). Density cap prevents great-wall spam; decay removes abandoned griefs.
- **Global-cap monopolization (the honest one):** `pieceCapPerPlayer` does not stop a determined actor — identities are free (connection.ts:36-40, no per-IP throttle in worker.ts), so ~25 minted tokens × 120 pieces consume the entire `WORLD_PIECE_CAP = 3000` and lock every other player out of building (placements return world-cap/density rejections). The resource cost (~18k wood for 3000 wood pieces; the per-tree gather cooldown slows it further) is a natural rate-limit, not a defense — a patient griefer or small group exhausts it over sessions. v1 decision: **accept the risk explicitly**, with three named mitigations in priority order if it is observed on the official instance: (1) a secondary budget keyed on a hash of `CF-Connecting-IP` captured at WS upgrade and stamped onto each piece server-side (VPNs evade it, but it raises the cost from "free" to "effort"); (2) reserved headroom — reject placements past e.g. 80% of `WORLD_PIECE_CAP` for owners above a much smaller threshold; (3) an admin wipe/limit tool (delete-by-ownerHash). Decay (`decayHours`) remains the eventual backstop for abandoned spam.

### UI outline

- **Build mode** (hammer equipped): bottom-center piece selector (7 kinds × tier toggle, scroll/Q-E to cycle), resource counts, ghost with green/red tint + rejection reason text. Click = place. Hold X on own piece = demolish (with radial progress).
- **Door/gate prompt:** `E` open/close; locked + unauthorized → 4-digit code pad overlay (`tryCode`); owner: `hold F` → set/change code pad (`setCode`).
- **Crate panel:** `E` opens a 12-slot grid beside the 8-slot inventory; click-to-move stacks (`cMove`). Closes on walk-away.
- **HUD damage feedback:** structure hit markers reuse the existing `hit` event visuals; pieces render cracks at hp thresholds from `sState`.

## Implications

**Opens up**
- The retention loop the game lacks: persistent territory, stash-driven risk decisions, raid drama — all on top of persistence machinery that already exists (`persistAll`, token identity).
- The container protocol (`cOpen`/`cMove`/`cont`) is generic per-slot container plumbing. Today it serves crates alone — doc 05's world containers use a spill model with no per-slot state — but if doc 05 (or any future feature: vehicle trunks, lockboxes) ever wants real container panels, the shape is sitting here ready to adopt.
- `StructureIndex` is the general "dynamic statics" mechanism: future barricades, placed traps, vehicle wrecks, even server-admin-built arenas reuse it wholesale.
- `structDmg`-as-data slots future explosives in as a single `ITEM_DEFS` entry plus a use-handler — the raid meta deepens without touching combat architecture.

**Complicates**
- `World` is no longer immutable after creation. Every consumer that assumed worldgen-frozen statics (melee occlusion, hitscan, zombie movement) now sees a mutable set — by design, but reasoning about "what blocked this ray" now has a time dimension. Tests must cover add/remove mid-flight.
- Join cost grows with world build-out (up to ~255KB of `sFull`); slow connections feel it. Mitigation if it bites: gzip via a binary frame later, or raise nothing — the cap bounds it.
- `persistAll` payload grows (~300KB at cap every 20s). Row *count* stays flat (+1), but byte churn is real; watch tick max under save (`/api/health` instrumentation exists, GameRoom.ts:386-405).
- Two parallel-track doc dependencies, both now explicit: (1) doc 04's `BuildingConfig` amendment — its earlier shape `{ enabled, decayRate }` lacked three fields this doc needs and `decayRate` (0..3 multiplier) was semantically incompatible with `decayHours` (absolute) — **has been applied to doc 04 §1** (see Migration); (2) this doc consumes doc 05's `wood`/`scrap` items and tree-gather faucet verbatim, so any change to those in doc 05 ripples here.

**Breaks**
- Nothing in existing saves or worldgen: no rng-stream changes, no `SCHEMA_VERSION` bump, additive `world_state` kind, additive `ItemType`s, additive wire messages (stale clients ignore unknown `t`). `PROTOCOL_VERSION` bump is declarative, not breaking, until the directory enforces it.

**Threatens**
- **Zombie cheese:** zombies use `resolveStatics` and have no pathfinding or structure damage — a 3-wall enclosure is total zombie immunity. Accepted for v1 (DayZ-like), but it weakens night/zombie pressure for established players. Future: zombies damage wood doors.
- **Scrap stalemate:** with no explosives, scrap bases offline-protected at 0.25 are effectively permanent until decay. The raid meta is shallow-by-honesty in v1; this is the strongest argument for fast-following an explosive.
- **Free-plan economics:** more building → more WS messages and bigger saves on a plan whose caps already bind (cf-costs.md: ~26 player-hours/day request budget). Building changes neither order-of-magnitude, but the structures blob makes the "single-row world snapshot" optimization (cf-costs biggest lever) *more* urgent, not less.
- **Determinism drift risk** concentrates in `pieceAabbs` and `canPlace`: if client and server ever derive different boxes from the same record (float ordering, constant skew), prediction rubber-bands inside bases. The shared-module + carried-`floorY` design exists to kill this; milestone 1's parity test is the guard.
- **Sybil surface is structural, not incidental:** anonymous tokens cost nothing to mint (connection.ts:36-40) and nothing in the stack throttles per IP (worker.ts, per-socket rate limit GameRoom.ts:226-241). Every per-identity control in this design — `pieceCapPerPlayer`, the `tryCode` UX cooldown — is bypassable by minting identities. The two controls that actually hold are keyed on shared scarce things: the per-DOOR code backoff and the global `WORLD_PIECE_CAP`. The flip side of the latter is the monopolization grief named in Griefing policy; a real fix (accounts, IP reputation, proof-of-work joins) is out of scope for v1 and should be a directory/identity-doc concern.
- **Offline-shield gaming, residual:** the `ownerOnline` rule (any entry in `game.players` + 5-min grace) closes both the kill-the-owner instant shield and the combat-log instant shield. What remains: an owner who *stays connected* dead on the death screen keeps their base at 1× — which is the raider-favoring direction, i.e. not a defender cheese; and a raider who waits out the 5-min grace after the owner truly leaves pays the intended `offlineRaidMult` price. Acceptable.

## Migration & compatibility

- **Existing worlds/saves:** fully compatible. Old `world_state` snapshots simply lack the `structures` row → empty index. Rolling back a deploy drops structures (unknown kind skipped) but corrupts nothing.
- **Seed/worldgen:** untouched. No new rng draws; the burn at world.ts:866 stays exactly where it is.
- **Protocol:** additive messages; bump `PROTOCOL_VERSION`. Clients and server deploy together from one origin; the only skew window is sockets that survive a deploy, and unknown-message tolerance on both ends covers it (server: `parseClientMsg` returns null; client: switch falls through).
- **ItemType strings:** additions only, zero renames — persisted inventory JSON stays valid (the rename-needs-bump rule from research/codebase-sim.md:301-302 is not triggered). `hammer` is this doc's; `wood`/`scrap` are doc 05's catalog rows, added by whichever doc lands first using doc 05's exact ids/names/stacks (NOT `scrap_metal` — that id from an earlier draft of this doc is dead).
- **Deployed official instance:** ships as a normal `vite build + wrangler deploy`; first boot adds the row kind on the next `persistAll`. No wipe, no migration step.
- **ServerConfig — doc 04 amendment (contract gap, named honestly — now APPLIED):** doc 04's `BuildingConfig` originally read `{ enabled: boolean; decayRate: number /* 0..3 */ }`, both fields reserved/NO-OP — no `pieceCapPerPlayer`, no `offlineRaidMult`, and a `decayRate` multiplier semantically incompatible with the absolute `decayHours` this doc needs. The amendment has been applied to doc 04 §1: `BuildingConfig` is now `{ enabled: boolean; pieceCapPerPlayer: number /* 10..500 */; decayHours: number /* 0..2160, 0 = no decay */; offlineRaidMult: number /* 0..1 */ }`, `decayRate` dropped (was NO-OP everywhere, so the rename was free). Preset values in doc 04's matrix: deadcoast `{true, 120, 168, 0.25}`, ironcoast `{true, 120, 72, 1.0}`, homestead `{true, 200, 0, 0}`, driftwood `offlineRaidMult 0` — homestead/driftwood take `decayHours 0`/PvE shielding, aligning with doc 04's PvE intent rather than this doc's earlier 336h draft value. Until doc 04's config transport (its M1) lands in code, milestone 7 reads these from a temporary constants block flagged `// Contract gap` (the established precedent, zombies.ts:35 etc.).

## Implementation plan

Milestone 1 is the architecturally hard one — everything else hangs off it.

1. **Shared StructureIndex + World integration** — *Opus 4.8* (determinism-sensitive, cross-cutting). New `packages/shared/src/structures.ts`: types, `PIECE_DEFS`, `TIER_DMG_MULT`, `pieceAabbs`, `computeFoundationY`, `createStructureIndex` (own 16m grid, add/remove/setOpen/queryWalls/floorAt/raycastPiece/occupancy/countNear), `canPlace` with every zone/slope/overlap rule. Wire into world.ts: `World.structures`, merge into `queryStatics`/`raycastStatics`/`groundHeight`. Constants additions. **No protocol, no server systems, no UI.** Acceptance: vitest suite proving (a) identical AABB derivation for a corpus of piece records, (b) `stepPlayer` walks onto a foundation, is blocked by a wall, is **blocked by a window wall at every jump phase** (the 1.1m opening cannot pass a 1.8m capsule with 0.6m step-up — assert no crossing across a sweep of jump timings at dt=1/15 and 1/60) while a ray through the opening at sight height passes, passes a doorway, is blocked by a closed door and passes an open one, (c) `raycastStatics` occludes through a placed wall and `raycastPiece` attributes it, (d) `canPlace` rejects each `PlaceRejection` case incl. town/military/building/spawn zones at the official seed and the `occupants` capsule case, (e) add→remove→re-add leaves the grid clean. Files: `packages/shared/src/structures.ts` (new), `packages/shared/src/world.ts`, `packages/shared/src/constants.ts`, tests.
2. **Protocol + server placement + sync + persistence** — *Opus 4.8* (protocol + persistence-atomicity sensitive). Depends on 1. New messages (`place`/`demolish`/`sFull`/`sAdd`/`sRemove`/`sState`) in protocol.ts incl. `parseClientMsg` validation and `PROTOCOL_VERSION`; new `apps/game/src/server/systems/structures.ts` (handlePlace with resource deduction + caps, handleDemolish, decay sweep skeleton, **`toWirePiece(piece: ServerPiece): WirePiece`** — the mandatory projection that strips `ownerHash`/`code`/`authorized`/`contents`/`placedAtMs` and derives `locked`; all `sFull`/`sAdd` payloads go through it); GameRoom routing + `sFull` batching in `handleJoin`; `ITEM_DEFS` additions (`wood` and `scrap` per doc 05's exact catalog rows if not already landed, plus `hammer`) + loot table weights; persistence row kind `structures` in saveWorld/loadWorld with maxId folding; client net handling (`connection.ts` cases applying deltas to `clientWorld.world.structures`). Acceptance: two local clients see each other's placements collide-correctly (manual + loadtest-bot assertion); restart restores pieces with stable ids; placing then crashing before save loses piece AND refunds resources coherently; old save loads clean; **serialized `sFull`/`sAdd` payloads contain no `code`, `ownerHash`, `authorized` or `contents` keys** (assert on the JSON, not the type).
3. **Client build mode + rendering** — *Sonnet 4.8*. Depends on 2. `Structures.tsx` instanced rendering (kind × tier, low-poly boxes with tier palette, door open/closed transforms, damage-crack tint from `sState` hp), ghost preview component driven by shared `canPlace`, build-mode HUD (selector, resource counts, rejection text), input wiring (hammer-equipped mode, place/demolish). Acceptance: ghost green/red matches server accept/reject 1:1 in normal play, with one carved-out exception — player-occupancy races, where the client's `occupants` view is interpolated and ~one RTT stale (canPlace's documented approximation); ≤14 structure draw calls at cap; placement→render latency one RTT.
4. **Resource faucet: adopt doc 05's tree gather** — *Sonnet 4.8*. Depends on 2 (items exist). This is doc 05's mechanic, implemented once: if doc 05's gather milestone has landed, this milestone is a no-op beyond tuning; if not, implement `{t:"gather", k:"tree", id}` exactly per doc 05's spec (E-interact, axe equipped, `GATHER_RANGE` 3.0, `WOOD_PER_GATHER_MIN..MAX` 2-3, transient per-tree `TREE_GATHER_COOLDOWN_S` 180) so doc 05 inherits it unchanged. combat.ts is NOT touched — the axe swing stays a pure weapon (doc 05's explicit decision). Acceptance: gathering yields wood at the specced rate; per-tree cooldown enforced server-side; no yield without an axe equipped; prompt UI shows on nearest in-range trunk.
5. **Doors, gates, code locks** — *Sonnet 4.8*. Depends on 3. `door`/`setCode`/`tryCode` messages + server handlers (auth list, **per-door global backoff map** keyed by door id, not by identity), `setOpen` collision swap both sides, code-pad UI, locked-state prompts. Acceptance: unauthorized player blocked by locked door, authorized passes after one correct `tryCode` forever (persisted); code change revokes; backoff enforced *across* identities (two sockets with fresh tokens splitting guesses on one door still hit the shared lockout and exponential backoff); owner/authorized open the door normally during an active lockout; door state survives restart.
6. **Storage crates + container protocol** — *Sonnet 4.8*. Depends on 3. This doc owns the protocol (doc 05 does not use it — no coordination gate); just keep the message names generic (`cOpen`/`cMove`/`cont`, not crate-specific) so a future doc-05 adoption is a non-event. `cOpen`/`cMove`/`cont` end-to-end, crate panel UI, contents persistence inside the blob, destruction/demolish spill. Acceptance: stack moves are loss-free under concurrent access by two clients (server-serialized; fixed slot indices — removing a stack nulls its slot, never shifts neighbors); contents survive restart; range enforcement.
7. **Raiding, offline protection, decay, ServerConfig wiring** — *Opus 4.8* (touches combat lag-comp-adjacent code + cross-doc config). Depends on 2; config transport depends on doc 04's amended `BuildingConfig` (stub via flagged constants if needed). `structDmg` on ItemDefs + `FIST_STRUCT_DMG` fallback, melee/ranged structure attribution in combat.ts, `TIER_DMG_MULT` + `offlineRaidMult` application, `ownerOnline` presence map + `RAID_OFFLINE_GRACE_S`, hp `sState` broadcasts, destruction cascade + crate spill, decay sweep (boot + 5-min cadence, `lastSeenMs` persistence helper, orphan handling). Acceptance: raid-time table verified empirically (wood door ≈30s axe online); a dead-but-connected owner COUNTS as online (killing the defender must not grant the shield); a lingering logout body counts as online and the 1× multiplier holds through `RAID_OFFLINE_GRACE_S` after the entry leaves `game.players` (combat-logging buys nothing inside a raid window); decayed base disappears on first boot past the window; lag-comped shots THROUGH a destroyed-this-tick wall behave sanely (statics are tested at current state — same rule as worldgen walls today, document it).
8. **Load/limits validation** — *Sonnet 4.8*. Depends on 2 (others optional). Extend `apps/game/scripts/loadtest.mjs` with builder bots: drive to `WORLD_PIECE_CAP`, measure tick EMA/max, `persistAll` duration, join-time with full `sFull` sync, snapshot sizes. Acceptance: tick max < 10ms at cap with 20 bots; join sync < 1s on localhost; documented numbers appended to this doc.

### M8 results — measured 2026-07-08 on localhost (Node v24.16.0, miniflare dev)

Harness: **`apps/game/scripts/build-loadtest.mjs`** — a focused sibling of `loadtest.mjs` (that one validates the roaming-player tick / msg-rate caveats; this one the base-building limits, reusing the smoke-probe idioms — esbuild-bundled shared `canPlace`, `Bot`/`walk`/`place` — that `loadtest.mjs` deliberately avoids). `WORLD_PIECE_CAP` and every tunable are imported from `@worldspring/shared`, never hardcoded.

Method: 14 builder bots on raw WS cooperatively place foundations — the shared `canPlace` picks legal cells exactly like the client ghost. The testbed `building` kit is bounded to 5 foundations, so the fill refills by cycling fresh tokens (each a fresh path-3 life = fresh kit); one shared local `StructureIndex` is kept live off the GLOBAL `sAdd`/`sRemove` broadcasts (structures are never interest-filtered), giving both the ghost's `canPlace` truth and the authoritative piece count. `WORLD_PIECE_CAP` self-enforces the ceiling; "someone is in the way" (an unseen offline lingering body) is retried like `locks-smoke`. After the fill, the fill's logout-lingers are drained (so only the online bots remain) and **20 online bots** are held while `/api/health` (`tickMsEma` / `tickMsMax`, which the DO already tracks) is polled across several `WORLD_SAVE_INTERVAL_S` (20s) periodic saves. **No server or gameplay code was touched** — tick timing was already on `/api/health`; the persisted-blob size below is read post-run from the dev DO's SQLite (`world_state` snapshot row).

Run: `cd apps/game && pnpm dev` (`.dev.vars TESTBED=1`), then `node --experimental-strip-types scripts/build-loadtest.mjs ws://localhost:PORT/ws --fillers=14 --bots=20` — fill reached **3000 pieces in 1918s across 1281 builder lives**.

| metric | measured | budget | verdict |
|---|---|---|---|
| world reached | 3000 / 3000 = `WORLD_PIECE_CAP` | at cap | PASS |
| effective tick rate under 20 bots | 13.9 Hz | ~15 | ok |
| tick EMA (steady average) | 3.07 ms | — | — |
| **tick MAX (steady, no-save tick)** | **4.00 ms** | **< 10 ms** | **PASS** |
| tick MAX (save-tick peak, incl. `persistAll`) | 162 ms | — | — |
| **`persistAll` duration** (save spike, in-tick) | ~158 ms | — | — |
| **join sync** (fresh bot, open → full `sFull`) | 17 ms | < 1000 ms | **PASS** |
| `sFull` wire size @ cap | 234.3 KB (7 batches, 3000 pieces, 80 B/piece) | — | — |
| persisted snapshot blob @ cap | 564 KB total (structures 544.6 KB, 185.9 B/piece) | 2 MB SQLite row cap | PASS |

Reading the numbers:

- **Steady tick and `persistAll` are separate on purpose** (the milestone lists "tick EMA/max" and "persistAll duration" as distinct measurements). `persistAll` runs INSIDE the tick on the 20s save cadence, so a periodic save is a `tickMsMax` spike above the steady tick. The **steady tick max at cap with 20 online bots is 4 ms** (EMA 3 ms) — well under the 10 ms bar. This confirms the design claim: 3000 collision pieces cost **zero recurring snapshot work** and only add grid-local AABBs to `queryStatics`, so the per-tick sim cost is essentially unchanged from an empty world (an empty-world baseline tick read 0–2 ms).
- **`persistAll` at cap is the one number that grows.** The in-tick periodic save spiked to ~160 ms and the server logged 71 `tick overrun`s over the whole run — the 564 KB blob wipe-and-reinsert + 20 character rows in one `transactionSync` exceeds the 66.7 ms tick budget on localhost **miniflare**, so a save tick drops a beat. Caveats: (1) it is a miniflare-local, GC-sensitive figure — production workerd SQLite differs and is generally faster; (2) it is a single-tick hiccup every 20 s, not steady load, and the tick has no catch-up so the sim just resumes next tick. Still, this is the metric to watch as `WORLD_PIECE_CAP` or player count grows — the "single-row blob" choice keeps it to one row-write, but the byte cost is real; the scaling roadmap's quantized-binary/delta persistence is the lever if it bites in prod.
- **Join sync** against the cap-full world is 17 ms on localhost (open→welcome 14 ms, welcome→full `sFull` 3 ms) — the full `sFull` set (3000 pieces, 234 KB over 7 batches, 80 B/piece wire) plus `welcome`, dominated by the round trip, not the payload. Two orders of magnitude under the 1 s bar.
- **Persisted blob**: the doc's §Persistence estimate ("~100 B/piece ⇒ ≈300 KB") **under-counts by ~1.85×** — each `PersistedStructure` carries the placer's 64-char `ownerHash` (+ `placedAtMs`), so a foundation persists at ~186 B/piece and the full-cap structures blob is 545 KB (total snapshot row 564 KB, the remaining ~20 KB being loot/corpse/timer state). Still ONE row, still far under the 2 MB SQLite row cap and the free-plan row-write budget — the design is unchanged, only the byte estimate was low. A crate-heavy world persists larger still (each crate adds a 12-slot `contents` array); foundations here are the representative ~80 B **wire** piece.
- **Fill honesty**: reaching the cap by bot placement is intrinsically slow on miniflare (~32 min for 3000). Each fresh-token life triggers a `persistAll` on join AND on disconnect plus a full `sFull` build — all O(pieces) — so the fill cost is ~quadratic and join throughput falls as the world fills. This is a property of the load driver (fresh-token refill), NOT of normal play, where a base fills over days at ~1 piece / few seconds. The *measured server limits above* are what matter and all pass.

### M8 follow-up — split-row persistence (dirty-skipped structures/trees), measured 2026-07-10

The ~158 ms in-tick `persistAll` above was ~97% re-serialized **unchanged** structures (544.6 KB of the 564 KB blob; steady no-save ticks were 3–4 ms). Fix shipped in `perf/persist-off-hot-tick`: the one `world_state` snapshot row was split by write cadence —

- `snapshot` — everything that drifts every tick (loot/corpses/fires/timers/drops/bodies/vehicles + time/tick/ids/scheduling), rewritten every save (~20 KB at cap);
- `trees` — felled indices + planted records, rewritten only on a tree event (`game.treesDirty`);
- `structures:<b>` (b∈0..63) — fixed 48 m spatial buckets (`(gx>>4)&7 | ((gz>>4)&7)<<3`; avg ~8.5 KB/bucket at cap), rewriting **only buckets whose pieces changed** since the last committed save. Every structure mutation funnels through `systems/structures.ts touchPiece` (place/remove/door/hp/code/authorized/contents — pinned one-by-one by the `structures.mjs` dirty-coverage section).

`persistAll` stays exactly ONE `transactionSync` (the no-dupe invariant), wipes are untouched (`DELETE FROM world_state` covers every kind; `persist-wipe.mjs` passes unmodified), `SCHEMA_VERSION` stays 2. A legacy fat snapshot loads fully and migrates on its first save (all-buckets-dirty, one transaction); a rollback binary reads the slim snapshot, drops structures/trees (the sanctioned posture above), and its next save cleanly deletes the split rows. Per-phase save cost + bytes are now on `/api/health` as `lastSave`.

Re-measured with the extended harness (`--churn=N` adds door-toggling bots so periodic saves exercise the dirty-bucket path), miniflare dev, Node 22.21.1:

| metric | before (M8, 3000 pieces) | after | notes |
|---|---|---|---|
| steady save (idle bases) | ~158 ms, 564 KB rewritten | **0–1 ms, ~26 KB** (snapshot delete+insert only) | full harness run @197 pieces, 10 bots: `RESULT: PASS` incl. the new `persistAll < 10 ms` acceptance |
| dirty-bucket save (door churn) | same ~158 ms (any change forced the full blob) | **1 ms, +8.5 KB** (1 bucket) | churn bot toggling a door every 400 ms across 2 saves |
| save-tick peak (tickMsMax window) | 162 ms — 71 tick overruns | **39 ms** (< 66.7 ms budget, < 40 ms overrun-warn) | zero overrun logs in the measurement window |
| mid-fill spot check @~1200 pieces | — | world rows 1 ms (snapshot 1 / trees 0 / structures 0); 14 bucket rows on disk, 223 KB total, max 33 KB | fill-phase saves with ~93 lingering fill characters showed `charactersMs` 12 ms — character rows are the next lever (they cannot be dirty-skipped; vitals drift every tick) |

The steady-save cost is piece-count-independent **by construction**: clean buckets are never serialized or written (the only O(pieces) work on a save is the partition scan, and only when ≥1 bucket is dirty), so the at-cap steady save equals the measured ~26 KB snapshot write. The full 3000-piece fill was still in flight when this session's measurement window closed (the fill driver's O(pieces) `sFull`-per-join cost still makes it ~30 min of bot time — though visibly faster now that the per-join `persistAll` is no longer O(pieces)); re-run `build-loadtest.mjs --churn=3` at full cap to confirm before relying on the at-cap number, and per the verify-on-prod rule, watch `/api/health lastSave` + `tickMsMax` on the live world after deploy.

Residual risks (unchanged from the design review): a map-wide event dirtying all 64 buckets in one 20 s window (mass decay sweep) still writes the full ~545 KB once — rare, event-driven, accepted; a mega-base concentrated in one 48 m region fattens its bucket (density caps bound it); bucket keys are a STABILITY CONTRACT — changing the scheme post-deploy requires an all-buckets rewrite on first save (same mechanism as the legacy migration).

### M8 follow-up — full-cap re-run with split-row persistence, measured 2026-07-11

The at-cap confirmation run the section above asked for: `build-loadtest.mjs --churn=3` (defaults otherwise), miniflare dev, Node 22.21.1, main @ `14273cc` — i.e. a **protocol-13 world**, which now ticks physics props (doc 13 M3), vehicles (M4), fresh water (doc 07 M5), and the tree lifecycle (planting/growth/stumps/trunks) that did not exist at the 2026-07-08 baseline. Fill reached 3000 pieces in 2122 s across 1529 builder lives; 20 online bots + observer + 3 door-churn bots held for the 55 s measure window.

| metric | M8 baseline (2026-07-08) | this run | verdict |
|---|---|---|---|
| steady save (idle bases, dirtyBuckets 0) | ~158 ms, 564 KB | **1 ms, ~27.7 KB** | **PASS** — piece-count-independence confirmed at cap |
| dirty-bucket save (door churn) | same ~158 ms | 1–21 ms (median ~7 ms; worst: `structuresMs` 19 ms, 2 buckets, 41.7 KB) | worst sample **over the 10 ms gate** on miniflare |
| save-tick peak (`tickMsMax` window) | 162 ms, 71 overruns | 109 ms single peak (direct `lastSave` totals ≤ 21 ms — the delta is co-scheduled tick work/GC, local figure) | under pre-split peak; watch on prod |
| tick EMA (steady average) | 3.07 ms | **12.67 ms** | — (see reading) |
| tick MAX ("steady" per harness) | 4 ms | 48 ms | **FAIL** vs 10 ms gate, but metric contaminated (see reading) |
| effective tick rate under load | 13.9 Hz | 12.36 Hz | — |
| join sync @ cap | 17 ms | 14 ms (open→welcome 11, →`sFull` done 3) | PASS |
| `sFull` wire @ cap | 234.3 KB | 235.1 KB (7 batches, 80 B/piece) | unchanged |

Reading the numbers:

- **The persistence design goals all hold at cap.** Steady saves write only the ~27 KB snapshot row regardless of piece count; churn saves rewrite only the touched buckets. The one gate miss is the worst dirty sample (19 ms in the structures phase for 2 buckets / 41.7 KB) — a miniflare-local write-latency figure (sibling saves wrote the same 2 buckets in 1–9 ms). Compare against prod `lastSave.structuresMs` once real players build before treating it as a problem.
- **The steady-tick FAIL needs qualification — the comparison is not like-for-like.** Two things at once: (1) the harness's "steady = MIN across `tickMsMax` samples" assumes save-free windows exist on the 20 s cadence, but `persistAll` also fires on join/leave/respawn events — 6 saves landed in the 55 s window (gaps as short as 2 s) against a ~10 s `tickMsMax` memory, so the 48 ms "steady max" is an upper bound with save/join ticks folded in. (2) EMA is only negligibly save-inflated, so the **3.07 → 12.67 ms EMA increase is observed, not an artifact — but the workloads differ**: this measure window held an observer + 3 door-toggling churn bots alongside the 20 online bots (23 counted median vs the baseline's 20), the toggles broadcast piece updates throughout the window, the world carries the residue of 1,529 builder lives (vs 1,281), and the sim is protocol-13 (Rapier props/vehicles/trunks, wildlife + water, tree growth) where the baseline predates all of it. How much is extra in-window workload vs per-tick sim cost growth is exactly what a per-system tick profile has to isolate — until then treat this as an observed EMA increase under a heavier scenario, not a measured regression. (A cheap first cut: re-run the measure phase at cap with `--churn=0` for a closer-to-baseline scenario.) Either way it is a *rendering-agnostic server* number and unrelated to persistence (saves are event/interval work, and the dirty scan runs only on save ticks).
- **Harness debt:** the steady-max metric should exclude windows containing a save by checking `lastSave.at` against the sample window instead of assuming cadence.

## Open questions

1. **Should crates collide?** Recommendation: **no** in v1 (campfire precedent, keeps them out of the collision-sync surface and kills crate-stair exploits); revisit with a 0.55m-tall steppable collider if walk-through crates feel bad.
2. **Default `offlineRaidMult`.** Recommendation: **0.25** official — offline bases take 4× effort but are not invulnerable; `0` (full protection) trains players to never log out worried but makes wood pointless to raid at night.
3. **Default `decayHours`.** Recommendation: **168 (7 days)** — matches weekly play rhythm; pruneStaleCharacters' 30-day horizon stays the absolute backstop.
4. **Demolish refund.** Recommendation: **none** — refunds invite move-my-base churn and free storage; revisit alongside repair.
5. **Gate in v1?** It's in the assignment's set and costs little (a wide door), but without standalone fences (walls need foundations) gates only matter on foundation perimeters. Recommendation: **keep it** — compounds with courtyards are exactly what people build first.
6. **Wood faucet rate and loot weights** are pure tuning — the faucet is doc 05's gather (2-3 wood per tree per 180s), and its rate decides how fast the island fills with bases; if it needs to change, change it in doc 05's constants (`WOOD_PER_GATHER_MIN/MAX`, `TREE_GATHER_COOLDOWN_S`), not by forking a second faucet here. Start stingy.
7. **Single-owner decay:** a base decays on the OWNER's absence even if friends (authorized on doors) play daily. Acceptable v1 wart, or should any authorized player's activity refresh decay? Recommendation: owner-only for v1 (authorized lists are per-door, not per-base; deriving "base membership" from them is guessable-wrong), fix properly with a team system.
8. **Cross-doc conflict ledger (per ground rules):** an earlier revision of this doc claimed no contradictions existed; that was false. Three real conflicts were found and are resolved as follows. (a) **Doc 04:** its `BuildingConfig { enabled, decayRate }` lacked `pieceCapPerPlayer`/`decayHours`/`offlineRaidMult`, and `decayRate` (multiplier) vs `decayHours` (absolute) were incompatible — the amendment in Migration has been **applied to doc 04 §1** (pve-flavored presets converge on *no decay*, doc 04's intent). (b) **Doc 05 containers:** its searchable containers use a search-spill model with no per-slot state — there is no shared container protocol; this doc owns `cOpen`/`cMove`/`cont` solo and doc 05 needs no change. (c) **Doc 05 materials/faucet:** this doc previously redefined `wood` (stack 10, +1 per axe swing) and invented `scrap_metal`; doc 05's definitions win wholesale (`wood`/`scrap` stack 8, E-gather with per-tree cooldown, axe stays a pure weapon) — persisted ItemType ids are forever, so converging before milestone 2 was mandatory. One layout note stands: nothing here contradicts the site-as-second-worker layout.
