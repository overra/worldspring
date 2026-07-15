# Server-side navmesh pathfinding: routing zombies and wildlife around obstacles (navcat)

## Summary

Zombies and wildlife move in a **dead-straight line at their target** today: `stepZombie`
(`packages/shared/src/movement.ts:143`) normalizes toward `(tx, tz)`, steps `speed·dt`,
slides along static AABBs via `resolveStatics`, and stops at deep water. There is no route
planning, so concave geometry traps them and — as doc 06 already flags at `:331` — **a
three-wall enclosure is total zombie immunity.** This doc adds the substrate that fixes it:
a **server-authoritative navmesh** built inside the `GameRoom` DO from the same deterministic
worldgen + static colliders the sim already trusts, queried each tick to steer AI along real
paths. A GO-with-conditions feasibility spike already ran (branch `spike/navcat`, navcat
0.4.1, 2026-07-10) — see the Spike findings section.

Decisions, up front:

1. **Server-authoritative path planning; clients never pathfind.** The DO computes paths and
   feeds the *next waypoint* into the existing mover. Clients interpolate zombie/animal
   positions from snapshots **exactly as they do today** — so there is **zero wire change**,
   no `PROTOCOL_VERSION` bump, and doc 08's mobile budget is untouched. Smarter server paths
   are invisible to the protocol because the entity's serialized shape (`id/x/y/z/yaw/state`)
   never changes.
2. **`stepZombie` / `movement.ts` stays byte-for-byte.** Pathfinding changes *only the
   `(tx, tz)` target* fed to the existing kinematic mover — from the raw goal to the current
   path waypoint. `stepZombie`'s water full-stop, `resolveStatics` slide, `ZOMBIE_RADIUS`,
   and per-call ground-snap are exactly the constraints a path-follower must still obey. The
   predicted + fingerprinted surface (`stepPlayer`, `world.ts`) is entirely out of the blast
   radius.
3. **navcat lives behind a swappable `Pathfinder` seam.** The library, its per-tile build
   pipeline, and its memory management sit behind one interface, so a fork can swap it for
   straight-line steering or another router without protocol or persistence churn (doc 00's
   zero-sync principle). A **LIVE-class on/off dial** ships with it so arena/creative/potato
   servers disable it.
4. **The navmesh is derived, server-private data.** Built from worldgen + the live
   `StructureIndex`, it is **never persisted** (rebuilt on DO wake), **never fingerprinted**,
   and **never client-shared.** Cross-OS byte-determinism is untested and does not need to
   hold: AI is already outside the determinism contract (it draws `Math.random` for
   spawns/wander today), and `mod:check`/the worldgen fingerprint never touch it.
5. **M0 is a GO/NO-GO gate, not a commitment.** The 2026-07-10 spike proved feasibility and
   cost **under Node**, with conditions. M0 confirms the same **inside real workerd/DO**
   before M1 commits — because "pure JS runs under Node" is not "runs in workerd" (doc 13's
   own M0 found workerd disallows WASM-from-bytes; navcat sidesteps that by being pure JS, but
   the runtime must still be proven, not assumed). If navcat can't run in the DO or the tick
   cost fails, the plan stops at straight-line + smarter local avoidance and this doc parks
   with findings.

## Goals / Non-goals

**Goals**

- One navmesh per room, built from the exact terrain heightfield + static AABBs the kinematic
  sim collides against, so navmesh reachability ⊇ sim reachability (no path routes to a cell
  the sim then refuses).
- Zombie chase routes **around** static obstacles (buildings, walls, the military compound,
  natural trees, player bases) — the doc 06 `:331` cheese fix — as the tracer feature, then
  wildlife (wolf stalk/chase).
- Incremental, tiled generation: the world tiles lazily/activity-scoped around live AI, and a
  single tile re-carves when a player structure or planted tree dirties it — amortized across
  ticks, never a synchronous whole-region build in one tick.
- An engine-portable substrate (navcat behind a `Pathfinder` seam) with a self-consistency
  check (generate-twice-assert-identical), matching `mod:check`'s worldgen discipline.

**Non-goals (v1)**

- **No wire or client change.** No path/waypoint debug data on the snapshot, no new
  `ZombieState` enum value. Path-follow is an internal steering detail under the existing
  `chase`/`wander` states.
- **No dynamic-body avoidance.** Barrels, vehicles, crates, and felled trunks are dynamic
  Rapier bodies the kinematic sim doesn't collide with today (`world.queryStatics` returns
  walls + trees only) — they are neither current obstacles nor navmesh-bakeable. Local
  separation (`separateZombies`) still handles agent-vs-agent crowding.
- **No deer-flee pathfinding.** Flee steers at a projected point recomputed every tick
  (`wildlife.ts:140`) — a poor A\* fit; it stays straight-line.
- **No persisted or client-shared navmesh, no fingerprint entry, no cross-OS determinism
  requirement.** It is a regenerable local DO cache.
- **No structure-damage / dig-through AI** (doc 06 "Future"). Zombies route around bases;
  raiding them is a separate design.

## Current state (verified against this tree)

- **Straight-line aggro.** `acquireTarget` picks the nearest living player by `distSq`, then
  the chase branch calls `stepZombie(zombie, target.core.x, target.core.z, speed, dt, world)`
  (`apps/game/src/server/systems/zombies.ts:207-212`). `stepZombie` (`movement.ts:143-167`)
  moves directly at the target, resolves the circle out of walls/tree-trunks via
  `resolveStatics` (slide-along, never route-around), full-stops at `heightAt < WATER_WALK_MIN`
  (`-0.55`), and re-snaps `y = groundHeight` every call.
- **Exactly four AI-mover call sites**, all through `stepZombie`: zombie chase
  (`zombies.ts:212`), zombie wander (`:233`), deer flee (`wildlife.ts:140`), deer wander
  (`:170`). Deer is structurally a `ZombieCore` (`state.ts:243`). Vehicles are driver-input;
  players use `stepPlayer`. No third AI species exists.
- **AI is purely server-authored + client-interpolated.** Zombies serialize `id/x/y/z/yaw/state/mil`
  (`snapCodec.ts:236-246`), animals the same minus `mil`; clients only `lerp` positions and
  `angleLerp` yaw (`client/net/interpolation.ts:327-346`) — they never import `stepZombie`,
  never predict, never reconcile AI. **So server-side routing is invisible to the wire.**
- **AI is already outside the determinism contract.** Spawn yaw, `wanderWait`, and wander
  targets draw `Math.random()` directly (`zombies.ts:57,66,80-81`), not the seeded `createRng`.
  The worldgen fingerprint (`packages/shared/scripts/fingerprint.mjs`) hashes only
  `createWorld` geometry — it never constructs `GameState` or runs AI — and `mod:check`'s
  determinism gate runs that fingerprint twice. Nothing about AI is fingerprinted; navcat's
  math cannot trip `mod:check` as long as pathfinding lives in server-only modules.
- **The engine ⟷ game seam is live.** The engine owns per-tick substrates: `game.physics.step(dt, game.time)`
  (`GameRoom.ts:1383`), attached async on the room (`:792`, buffered until the WASM engine is
  ready). Modes own gameplay — survival calls `tickZombies`/`tickWildlife` inside
  `simAfterPhysics` (`survivalMode.ts:57,64`). A navmesh service is **engine-owned like
  `PhysicsSystem`**, not a per-mode system, and its structural model (async attach, buffer
  until ready, engine-stepped, library hidden behind a seam) is `PhysicsSystem` itself.
- **No doc owns a nav substrate.** Zombie AI lives only in code + `ARCHITECTURE.md:211` (an
  engine SERVER responsibility). Doc 06 `:331` accepts "no pathfinding" as a v1 limitation;
  doc 07 owns wildlife *behaviors* (wolf pack stalk/chase, boar retaliation) but consumes
  `stepZombie` for movement and defines no nav layer.
- **The spike already ran** (branch `spike/navcat`, commit `dcda503`, `apps/game/scripts/navcat-spike.mjs`,
  navcat 0.4.1): built a 256 m region of the real standard world from PhysicsSystem's exact
  4 m heightfield + static AABBs, generated solo + tiled navmeshes, byte-compared two
  consecutive generations, ran 200 seeded `findPath` queries, and rebuilt the base tile 10×.
  GO-with-conditions — see Spike findings. It ran under Node only.
- **DO memory is ~128 MB.** A full 800 m (standard-tier) navmesh extrapolates to ~75–80 MB
  retained; large (4×) and huge (16×) tiers cannot hold a full mesh, so tiling **must** be
  activity-scoped.

## Design

### 1. The seam: `Pathfinder`

One server-only interface (`apps/game/src/server/nav/`), navcat hidden entirely behind it —
the client never imports it; the shared package never imports it (keeps navcat's math out of
the fingerprinted surface):

```ts
interface Pathfinder {
  /** Path from a to b for a ground agent; polyline of waypoints, or null if unreachable. */
  findPath(ax: number, az: number, bx: number, bz: number): { x: number; z: number }[] | null;
  /** Re-carve the tile(s) covering a world-space AABB after statics change (base/tree edit). */
  dirtyTile(minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Drain the dirty/pending worklist, at most `maxTiles` this call. Count-based, not
   *  ms-based: workerd under-reports pure-CPU time (`GameRoom.ts:820-822`), so a ms budget
   *  cannot actually bound the work — one tile is the unit. Called once per tick. */
  stepBuild(maxTiles: number): void;
}
```

navcat implements this via the spike's **ejected per-tile pipeline** (`navcat-spike.mjs:425-484`),
which mirrors `navcat/blocks`' non-exported `buildNavMeshTile` 1:1 (rasterize → filter →
compact → erode → regions → contours → polyMesh → detail → `removeTile` → `buildTile` →
`addTile`) and **throws away all build intermediates** — this is condition (1) below. A fork
can replace the implementation with straight-line steering or another router without touching
protocol, persistence, or the wire (doc 00 zero-sync; doc 13's seam idiom at `13:86-104`).

### 2. Mesh source & the walkability contract

The navmesh is baked from the **same collision authority the kinematic sim uses** — no second
source of truth. `PhysicsSystem` already exposes `PhysicsStaticsSource` (`PhysicsSystem.ts:36-50`),
the canonical "what the collider build needs from the World" subset; the navmesh baker consumes
the identical interface so it sees the same geometry zombies collide with. Consuming the same
AABBs is necessary but **not sufficient** for parity — navcat decides walkability by voxel
clearance while the sim decides by a per-box y-test, a genuinely different algorithm on the same
boxes (see the vertical-passability reconciliation below):

- **Terrain**: `world.heightAt(x, z)` sampled at PhysicsSystem's exact 4 m heightfield grid
  (`HEIGHTFIELD_CELL_M = 4`, `Math.fround`, two up-facing triangles per cell), voxelized to
  0.5 m nav cells — the spike does this exactly (`:140-262`).
- **Static AABBs**: town/wild building walls + roofs, military compound walls, one cuboid per
  natural tree, solid props (`rock_b/rock_c/sandbag_wall/barrier/tent`; `rock_a` is
  walk-through) — mirroring `PhysicsSystem.attachEngine`'s `addAabb` loop.

**Static vs dynamic walkability** (bake-once vs per-tile rebuild):

| Input | Class | Rebuild trigger |
| --- | --- | --- |
| Terrain heightfield, towns, military compound, natural trees, solid props | **Static** | none — baked once at boot |
| **Player structures** (place / demolish / door-or-gate open) | **Dynamic** | `structures.ts:239 / 414 / 448`. Foundations step-on-able; walls/gates block; an **open** door/gate derives zero AABBs → passable. |
| **Planted trees** (plant / grow / fell→stump) | **Dynamic** | `trees.ts:440 / 514 / 340`. ⚠️ Growth is **wall-clock timed** (young @15 min, mature @60 min): walkability flips with **no player action** via the growth scan (`:514`) — the dirty-marking must watch the scan, not just commands. |
| **Felling a natural tree** | *not a trigger* | `world.trees` is immutable; `fellTree` only swaps the Rapier collider (`PhysicsSystem.ts:532-556`), so the kinematic sim keeps colliding at the full trunk radius. |
| Barrels, vehicles, crates | *not baked* | dynamic Rapier bodies the kinematic sim ignores (`world.queryStatics` = walls + trees only) — out of scope (non-goal). |

**Three walkability reconciliations** the baker must make (the spike's config drifts from sim
rules here):

- **Water cut.** The spike marks walkable by a 60° slope test only and does **not** cut cells
  below `WATER_WALK_MIN = -0.55` — so shallow-underwater cells read walkable in the mesh but
  the sim full-stops there. Add an explicit water-height mask so the navmesh never routes into
  water the sim refuses.
- **Slope over-approximation.** The kinematic sim has **no slope cap** (only per-step
  `STEP_UP_MAX = 0.6`); the spike's 60° cap makes steep-but-traversable terrain unreachable in
  paths. Pick a slope value that over-approximates sim reachability — a path may lead somewhere
  the sim then can't climb (the mover slides, no worse than today), but must never *exclude* a
  cell the sim can reach.
- **Vertical passability.** This is the subtle one. `resolveStatics` (`movement.ts:36-53`)
  decides per box at the agent's snapped `y`: a box is ignored if steppable (`wall.y1 <= y +
  STEP_UP_MAX`) or fully overhead (`wall.y0 >= y + PLAYER_HEIGHT`), else it blocks. navcat
  instead voxelizes and tests `walkableHeight`/`walkableClimb` clearance — so the pass/block
  set can diverge on exactly the cases that matter: an **open doorway** (header at ~2.2 m —
  passable both ways) vs a **window** (a solid sill box to ~0.75 m with the head at ~1.85 m —
  the sim calls it IMPASSABLE, and the mesh must too), and step-on-able foundations vs blocking
  walls. Pin `walkableHeight = PLAYER_HEIGHT` and `walkableClimb = STEP_UP_MAX`, and make the
  M1 correctness check a **generate-and-compare-*to-sim*** pass (sample points, assert navmesh
  walkability agrees with `resolveStatics`/`heightAt`) — not merely generate-twice-identical,
  which only proves the mesh is self-consistent, not that it matches the mover.

Agent sizing: the spike bakes at `PLAYER_RADIUS = 0.45`, which equals `ZOMBIE_RADIUS`, so one
navmesh fits both zombies and (approximately) deer/wolves. Larger future species get either a
per-agent filter or an accepted approximation (Open Q6).

### 3. Wire + client — nothing changes, and why

This section exists to state a decision, not describe a change. Zombies/animals already ship
`id/x/y/z/yaw/state` and are pure client-interpolation. Pathfinding alters only which velocity
the server picks each tick, so:

- **No `PROTOCOL_VERSION` bump** (currently 14). The one thing that would force one is a new
  `ZombieState` enum value (append-only closed enum, `snapCodec.ts:55-60`) — so path-follow
  **reuses `chase`/`wander`**, never adds a `'pathing'` state.
- **No client render change.** Clients keep lerping positions; sharper per-tick heading changes
  interpolate fine (a cosmetic smoothing consideration at most, not correctness).
- **No SCHEMA_VERSION bump.** The navmesh is derived and not persisted; the new per-entity
  `path` fields are in-memory `GameState` only.

### 4. Tick integration and cost

Two costs, both server-CPU inside the 66.7 ms tick (15 Hz), neither on the wire:

- **Query cost is cheap but per-mover-per-tick.** The spike measured `findPath` at p50 0.10 ms
  / p95 0.32 ms — hundreds of queries of headroom per tick — but computing a fresh path for
  every zombie every tick is still wasteful. A **repath cadence** is mandatory: new transient
  `Zombie`/`Deer` fields `path: {x,z}[]`, `pathIndex: number`, `repathT: number`, and
  `pathGoalX/pathGoalZ` (goal-drift detection). Re-query when `repathT` elapses, when the
  **target** moves past a threshold from `pathGoal`, **or when the agent itself is displaced**
  off its polyline — because `separateZombies` (`zombies.ts:239-309`) mutates x/z *after*
  `stepZombie` every tick, pushing crowded zombies sideways and, in the deep-water case,
  **teleporting one back to `(homeX, homeZ)`** (`:299-303`). A displacement the repath triggers
  don't see leaves a zombie steering straight at a cached waypoint from a spot it no longer
  occupies — and `stepZombie` will drive that straight segment through the very wall corner the
  path routed around (`resolveStatics` slides, never re-routes), worst in the crowded-doorway
  funnel that *is* the cheese-fix scenario. So: compare each post-separation position to its
  path segment and repath when it drifts beyond a threshold, re-snap the query start onto the
  navmesh (nearest-poly), and force a repath after any teleport-to-home. Arrive-radius slop
  governs waypoint *advancement* only — it does not cover a position discontinuity.
- **Build cost is the real risk and must be amortized.** Synchronous whole-region generation is
  ~1 s per 256 m region — it would blow the tick outright, and workerd under-measures pure-CPU
  ticks (`performance.now` only advances at I/O boundaries, `GameRoom.ts:820-822`), so it must
  be bounded by a `NAV_BUILD_BUDGET_MS` knob rather than trusted to self-report. `stepBuild`
  drains a bounded worklist — **≤1 tile per tick** (per-tile rebuild measured p50 ~5–9 ms): the
  world tiles lazily/activity-scoped around live AI and players at boot (mirroring the ambient
  seed radius and the trees growth-scan cadence), and structure/tree edits enqueue their
  covering tile(s) as dirty. For large/huge tiers where a full mesh exceeds the memory budget,
  cold tiles evict over a `navTileCap` (modeled on `config.physics.bodyCap`), keeping the tile
  cache well under the 128 MB DO ceiling (Open Q3).

`stepBuild` runs as its **own engine `phase("nav")` in `GameRoom.tick()`, between the physics
block (`GameRoom.ts:1385`) and `mode.simAfterPhysics` (`:1388`)** — an engine phase, not mode
gameplay, because nav is infrastructure that exists for any mode (the same reason physics is an
engine phase). Placing it there guarantees the mesh is current for `tickZombies`, which runs
inside `simAfterPhysics`, and the labeled bucket keeps the amortized cost visible in
`/api/health` telemetry exactly like the `physics` phase.

**The attack short-circuit needs a line-of-sight gate, or the cheese-fix is incomplete.** Today
the state machine flips to `attack` on raw distance — `distSq2D(zombie, target) <=
ZOMBIE_ATTACK_RANGE²` (`zombies.ts:196-197`, `ZOMBIE_ATTACK_RANGE = 1.7`) — with **no wall
check**, and the attack branch makes no `stepZombie` call. A player hugging the inner face of a
one-`BUILD_WALL_THICKNESS` (0.25 m) wall is only ~1.15 m from a zombie against the outer face
(two 0.45 m radii + the wall), i.e. *inside* attack range: the zombie freezes in attack-pause
against the wall and never routes to the opening. `attackBlocked` (`zombies.ts:169-182`)
already suppresses the *damage* through the wall via a raycast, but not the *movement* freeze —
so a walled base still cheeses even with a navmesh. **M2 must gate the `attack` transition on
reachability** (reuse `attackBlocked`'s static raycast, or require the current path-to-target
length below a small multiple of the straight-line distance), so a wall-separated zombie keeps
path-following instead of pausing. Without this, M2's headline acceptance criterion cannot pass.

Wander (short hops within `WANDER_RADIUS = 10` of home) does **not** pathfind — not worth the
A\* budget, and straight-line is fine at that range. If `findPath` returns `null` (target
unreachable, or its tile isn't built yet), the mover falls back to today's straight-line
`stepZombie(target)` — never a stall.

### 5. Determinism, persistence & mod:check

- **Not fingerprinted, not `mod:check`-gated.** AI is already `Math.random`-driven and outside
  the contract; the fingerprint runs worldgen only. The single real risk is *module placement*:
  keep navcat and all pathfinding in `apps/game/src/server/**` — never in `world.ts`/`movement.ts`
  or anything the shared fingerprint path transitively imports. Documented so a modder reading
  `mod:check`'s "no Math.random/Date.now" warning knows it means *worldgen*, and AI (incl.
  pathfinding) is deliberately exempt.
- **Self-consistency, not cross-OS.** The navmesh must be *internally* reproducible (a
  generate-twice-assert-identical check, as the spike does with FNV-1a) so tile rebuilds are
  stable, but cross-OS byte-identity is neither tested nor required — the mesh is server-private
  and regenerated on wake, so a possibly-different-per-host mesh only changes AI *routing
  detail*, never client agreement.
- **Never persisted.** Derivable from worldgen + the live `StructureIndex`, the navmesh rebuilds
  on DO wake. The ordering is already safe: `loadWorld` (`persistence.ts:774`) runs
  **synchronously** in `ensureGame` and rebuilds the `StructureIndex` in memory *before* the
  async physics attach resolves (the load-bearing comment at `persistence.ts:945-947`), so boot
  tiling picks up restored bases with no race. Persistence itself is unchanged — the split rows
  (`meta`, `characters`, `world_state` snapshot/trees/`structures:<bucket>`, `leaderboard`;
  `SCHEMA_VERSION` 2) gain nothing, so **no `SCHEMA_VERSION` bump**.

### 6. Feature order

Zombie chase first because it is the smallest end-to-end slice that exercises every layer once
(query → waypoint → steer → repath) and it delivers the headline fix (the doc 06 `:331`
enclosure cheese). Wildlife (wolf stalk/chase) reuses the identical `stepZombie` hook. Deer flee
stays straight-line. The config dial can fold into M1 or trail as its own small milestone.

## Implications

**Opens up**
- The doc 06 `:331` base-immunity exploit closes: a walled base makes zombies *route*, not
  freeze — real pressure on bases, which base-building wants.
- Wolf packs (doc 07) get to stalk around terrain instead of line-of-sight charging — the
  behavior doc 07 describes becomes buildable on a real nav layer.
- A reusable server-side spatial substrate: once the world is tiled and queryable, later AI
  (patrols, flee-to-cover, ranged-kiting) has somewhere to stand.

**Complicates**
- Every tick now carries an AI path budget + a tile-build budget. DOs bill on **duration**, so
  this is a new CPU line item — bounded by the repath cadence and the ≤1-tile/tick build cap,
  measured in M0.
- Base-building and the wall-clock tree-growth scan now have a walkability side effect (dirty a
  tile), coupling doc 06/doc 05's edit paths to the nav layer via one hook each.
- Large/huge world tiers force activity-scoped tiling + eviction — a real memory manager, not a
  bake-it-all shortcut.

**Breaks**
- Nothing shipped. No wire change, no persistence change, `movement.ts` untouched, AI states
  unchanged. A fork with the dial off behaves exactly as today.

**Threatens**
- ~~**workerd execution is asserted-by-inspection, not proven.**~~ **RESOLVED by M0 (2026-07-15):**
  navcat's build pipeline + `findPath` ran inside a real workerd Durable Object, pure-JS with no
  shim — see M0 findings. A deployed-prod smoke remains a cheap M1 add.
- **Memory at large/huge scale.** ~75–80 MB for a full standard mesh is close enough to 128 MB
  that the bigger tiers cannot bake fully — the eviction policy is load-bearing, not polish.
- **Scope gravity.** "make zombies dig through walls," "avoid the barrels," "predict paths
  client-side" each drag a non-goal back open. All explicit non-goals until real play demands
  them.

## Migration & compatibility

- **Existing worlds: no migration.** The navmesh is derived and not persisted; it builds on
  boot for fresh and restored worlds alike. No `SCHEMA_VERSION` or `PROTOCOL_VERSION` bump.
- **Presets/config**: a pathfinding on/off dial (with straight-line fallback) lands in
  `ServerConfig` as a **LIVE-class** group (never WIPE — it doesn't change worldgen). LIVE is
  safe here for the same reason doc 13 gave physics: the navmesh is server-authoritative and
  outside the client determinism contract; the self-consistency check pins its own constants,
  not `ServerConfig`. Arena/creative/potato servers set it off and get today's straight-line
  behavior.
- **Worker bundle**: navcat + `mathcat` are small pure-JS additions (no WASM, unlike doc 13's
  ~1.9 MB Rapier blob). Confirm exact size in M0.

## Implementation plan

Ordering: **M0 → M1 → M2 → {M3, M4}**. M0 is a contained Wave-1.5 weekly slice (GO/NO-GO). M1
is the anchored big build if M0 passes. M2 delivers the headline fix. M3/M4 are weekly-slice
sized. Platform spine unaffected.

1. **M0 — workerd execution + cost confirmation** *(one session; GO/NO-GO)* — **✅ RAN 2026-07-15
   — GO** (see M0 findings). The biggest unknown, isolated. The 2026-07-10 spike proved feasibility
   **under Node**; this proved it **inside the DO**.
   - **Files:** a reproducible harness that runs navcat's build + `findPath` inside real workerd,
     not just Node. *Shipped as* `apps/game/scripts/navcat-m0/` — a `wrangler dev` scratch DO (the
     repo has no vitest Workers pool; `wrangler dev` runs the real workerd binary). navcat is
     installed in isolation for the run; the real `apps/game` dependency lands in M1 with the
     first import.
   - **Accept:** navcat imports and `findPath` + per-tile rebuild **execute in workerd without
     throwing** on a missing Node builtin; re-captured p50/p95, per-tile rebuild ms, and
     retained-heap numbers on a Linux/workerd-representative runtime — measured by **wall-clock /
     an external probe**, since workerd under-reports pure-CPU time via `performance.now`
     (`GameRoom.ts:820-822`); worker-bundle delta recorded; **findings written into this doc's
     Spike/M0 section with an explicit GO/NO-GO line.** *(Opus 4.8 — runtime-compat + the whole
     feature gates on it.)*
2. **M1 — NavSystem substrate + `Pathfinder` seam** *(the big one)* — engine-owned nav service
   modeled on `PhysicsSystem`.
   - **Files:** `apps/game/src/server/nav/` (the `Pathfinder` interface + navcat impl, lifting
     `rebuildTile()` from the spike); `NavSystem` constructed in `createGameState`
     (`state.ts:542`, beside `physics`) and stored on `game.nav` (`state.ts:439` parallel); built
     synchronously after `loadWorld` since navcat is pure-JS (mirror `PhysicsSystem`'s async
     `attachEngine` only if M0 forces a WASM path); stepped as `phase("nav")` in the tick
     (`GameRoom.ts:1385→1388`); consume `PhysicsStaticsSource` (`PhysicsSystem.ts:36-50`);
     **dirty-marking hooks** at the same sites physics already hooks —
     `PhysicsSystem.addStructure/removeStructure/setStructureOpen` (`PhysicsSystem.ts:346-388`,
     called from `structures.ts:239/414/448`) and the planted-tree paths (`trees.ts:340/440/514`,
     incl. the wall-clock growth scan); water + slope + vertical-passability walkability mask
     (§2); `navTileCap` + cold-tile eviction; a **generate-and-compare-to-sim** walkability
     check (§2 — not just generate-twice); **amends `ARCHITECTURE.md:211`** to name the
     server-side navmesh as an engine responsibility.
   - **Accept:** a booted room tiles the area around spawn; placing a wall re-carves its tile
     within a bounded number of ticks; two consecutive generations of a tile hash identically
     **and** sampled navmesh walkability agrees with `resolveStatics`/`heightAt` (incl. an open
     doorway passable, a window blocked); retained heap stays under a defined budget at standard
     tier. *(Opus 4.8 — engine seam, memory ceiling, tick budget, determinism module-placement.)*
3. **M2 — zombie chase path-following** *(the headline fix)* — swap the target, keep the mover.
   - **Files:** `zombies.ts:207-212` (feed `path[pathIndex]` instead of `target.core.x/z`;
     `null` path → straight-line fallback); transient `path/pathIndex/repathT/pathGoal` fields on
     `Zombie` (`state.ts:176-195`); repath on timer / goal-drift / **agent displacement + the
     deep-water teleport-to-home** (§4), re-snapping the query start onto the mesh; **gate the
     `attack` transition on line-of-sight** (§4 — reuse `attackBlocked`'s raycast) so a
     wall-separated zombie keeps routing instead of freezing in attack-pause. `stepZombie`
     unchanged.
   - **Accept:** a zombie aggroed outside a sealed three-wall enclosure **routes around** it to
     reach the player — **including when the player presses against the inner wall face** (no
     attack-pause freeze), which is the actual doc 06 `:331` cheese; tick cost at `ZOMBIE_MAX`
     stays within budget with the repath cadence; a zombie shoved off its path or teleported
     home re-routes rather than cutting a wall corner; no regression in open-terrain chase feel.
     *(Opus 4.8 — hot-path tick budget, interacts with separation + attack states.)*
4. **M3 — wildlife / wolf-pack routing** *(after doc 07's species framework, or against deer
   today)* — extend the M2 pattern to `wildlife.ts` chase/stalk; deer flee stays straight-line
   (projected target); decide per-species. *(Sonnet 4.8 — mechanical reuse of M2.)*
5. **M4 — LIVE-class config dial** *(optional; fold into M1)* — `ServerConfig` on/off +
   straight-line fallback so arena/creative/potato servers disable pathfinding. *(Sonnet 4.8 —
   table-driven config.)*

## Spike findings (navcat, run 2026-07-10, Node only) — **GO-with-conditions; workerd confirmed by M0 below**

Harness: `apps/game/scripts/navcat-spike.mjs` (branch `spike/navcat`, commit `dcda503`, **not**
merged/CI-wired). navcat **0.4.1** (only hard dep `mathcat@0.0.12`; `three` optional and
unused). Real standard-tier world, seed 1337, a 256 m region sampled at PhysicsSystem's exact
4 m heightfield + region static AABBs + a synthetic 15-wall player base. Config: cell 0.5 m,
tile 32 m (64 voxels), `walkableRadius = 0.45`, `walkableHeight = 1.8`, `walkableClimb = 0.6`
(`STEP_UP_MAX`), slope 60°. **Ran under `node --experimental-strip-types --expose-gc` on macOS
arm64 — never inside workerd.**

| Metric | Result |
| --- | --- |
| `findPath` latency | p50 **0.10 ms** / p95 **0.32 ms** (hundreds of queries/tick of headroom) |
| Per-tile rebuild (base changed) | p50 **~5–9 ms** → budget ≈ **1 tile/tick** |
| Retained heap, 256 m region | **~8 MB** net (with `--expose-gc`) |
| Full 800 m world (extrapolated) | **~75–80 MB** retained of the 128 MB DO limit |
| `navcat/blocks` preset transient peak | **~81–89 MB** (retains every tile's intermediates) |
| Synchronous full-region generation | **~1 s / 256 m region** (est. 4–12 s full world) |
| Same-process determinism (FNV-1a) | tiled `21541f88`, solo `8d8910b6` (independently reproduced) |

**The three conditions (code-confirmed):**
1. **Do not use `navcat/blocks` preset builders in prod** — `generateTiledNavMesh` retains
   every tile's `triAreaIds/heightfield/compactHeightfield/contourSet/polyMesh/polyMeshDetail`
   (the ~81–89 MB peak). Ship the ejected per-tile pipeline (`:425-484`), keeping only
   `chunkyTriMesh` + bounds.
2. **Never generate a region synchronously in one tick** (~1 s/256 m blows the 66.7 ms budget)
   — tile incrementally at boot / lazily around activity.
3. **Treat the navmesh as derived server data** — never fingerprinted (worldgen is already
   non-deterministic macOS↔Linux), never client-shared; cross-OS byte-identity untested.

**Not yet proven (→ M0):** execution inside workerd (pure JS *should* be fine — no WASM-from-bytes
issue like doc 13's Rapier — but unverified); Linux/workerd cost numbers; a reproducible,
CI-wireable harness. **GO-with-conditions on feasibility and Node cost; the workerd GO/NO-GO
line is M0's to write.** M0 ran 2026-07-15 and closed it — see the next section.

## M0 findings (run 2026-07-15) — **GO**

Harness: `apps/game/scripts/navcat-m0/` — a throwaway scratch **Durable Object** (`worker.ts` +
`wrangler.jsonc`) that imports `navcat` + `navcat/blocks`, builds a solo navmesh from a synthetic
mesh (a 40 m ground plane + a 12 m building block), and runs `findPath` diagonally across it. Run
under `wrangler dev` (local workerd) and curled, against an isolated `navcat@0.4.1` install (M1
adds it as a real `apps/game` dependency when `src/server/nav/` imports it — no unused dep yet).

**navcat executes inside a real workerd Durable Object — the gating unknown is closed.** The DO
returned `ok: true`; the full build pipeline (`generateSoloNavMesh`: rasterize → filter → compact
→ erode → regions → contours → polyMesh → detail → `addTile`) and the query (`findPath`) both ran
with **no thrown Node-builtin error, no runtime shim**. Static confirmation backs it: navcat and
its sole dep `mathcat` ship **zero** Node builtins, no `process.env`, no wasm (pure JS over typed
arrays) — so there is no WASM-from-bytes restriction like doc 13's Rapier hit.

| Metric | Result (local workerd DO) |
| --- | --- |
| Execution | `ok: true` — build + query ran, no throw |
| Navmesh | 1 tile, 35 polys, 69 verts (valid) |
| Query | `findPath` **success**, `COMPLETE_PATH`, 3-point path |
| Routing | path `[-15,-12] → [-6,7] → [12,15]` **detours around** the block corner (±6), not straight through |
| Build cost | cold 58 ms (first-call JIT), **warm p50 8 ms** — consistent with the spike's 5–9 ms per-tile rebuild |
| Query cost | sub-ms — workerd rounds pure-CPU `performance.now` to **0 ms** (the predicted caveat); the spike's Node p50 **0.10 ms** stands as the real figure |
| Bundle delta | **~285 KiB raw / ~54 KiB gzip** (navcat-dominated) — vs doc 13's ~1.9 MB Rapier wasm |

**Honest boundaries of this run:** it used *local* workerd (`wrangler dev`), not deployed
production Cloudflare — sufficient for the import/execute question (it is the real workerd binary),
with a deployed-prod smoke a cheap M1 add (as doc 13 did). The mesh was synthetic, not the real
256 m worldgen region — the spike already measured real-world build+cost under Node; M0's job was
runtime compatibility, and M1 marries the two (real `PhysicsStaticsSource` geometry built inside
the DO). Determinism was not re-tested here (M0 = execute + cost); the spike's same-process
byte-identity holds and M1 adds the generate-and-compare-to-sim check.

**GO line: navcat's build pipeline and `findPath` execute inside a real workerd Durable Object,
pure-JS with no shim, at a per-tile build cost consistent with the spike and a trivial bundle
delta. The gating unknown is closed — proceed to M1.**

## Open questions

**Resolved 2026-07-15 (Adam): all recommendations below accepted.** Q2 is closed empirically by
M0 (GO — navcat runs in workerd); Q3–Q6 are the accepted build decisions for M1; Q7's exact
numbers finalize during M1 against the M0/spike cost curve.

1. **Doc placement.** New doc **14** (standalone, doc-13-shaped) vs folding into doc 07. *Recommendation:
   14 — pathfinding is a multi-consumer engine substrate (zombies have no owning doc; doc 07
   owns wildlife behaviors, not a nav layer), exactly doc 13's situation; one new row each in
   README's doc-index and vocabulary tables, and promote README's "pathfinding (navcat spike
   GO)" bullet to reference it.*
2. ~~**Does navcat run in workerd at all?**~~ *(the gate)* **ANSWERED by M0 (2026-07-15): GO** —
   navcat's build pipeline + `findPath` execute inside a real workerd Durable Object, pure-JS with
   no shim, build warm-p50 ~8 ms, ~54 KiB gzip bundle delta. See M0 findings.
3. **Walkability mask — match the sim or over-constrain?** *Recommendation: add the
   `WATER_WALK_MIN` cut (routing into refused water is a real bug) and over-approximate the
   slope cap so navmesh reachability ⊇ sim reachability — never exclude a cell the sim can
   reach.*
4. **Tiling for large/huge (memory).** A full mesh exceeds budget above standard tier.
   *Recommendation: activity-scoped tiling around live AI/players with cold-tile eviction and a
   cache budget well under 128 MB — mandatory, not optional.*
5. **Scope: zombies-only vs wildlife + dynamic obstacles.** *Recommendation: v1 = zombie chase
   around static obstacles (the cheese fix); wildlife chase/stalk in M3; deer flee straight-line;
   dynamic-body (barrel/vehicle) avoidance an explicit non-goal.*
6. **One player-sized navmesh for all AI, or per-agent bakes?** `ZOMBIE_RADIUS = PLAYER_RADIUS
   = 0.45`, so one mesh fits zombies + deer. *Recommendation: single navmesh in v1; revisit only
   if larger species (boar/wolf) need distinct footprints.*
7. **Repath cadence + per-tick tile budget numbers.** *Recommendation: pick from M0's re-captured
   cost curve — a repath interval (e.g. ~0.3–0.5 s) plus goal-drift trigger, and ≤1 tile/tick.
   Report **two** tick-budget margins, not one: the aggregate per-tick **query** cost (cheap —
   p50 0.10 ms × the repath'ing zombies, doc-13-style "< 1% of the tick"), and separately the
   **single tile-build spike** (~5–9 ms ≈ 8–13% of the 66.7 ms tick — an order of magnitude
   larger), confirming the tick still fits when a build coincides with physics + broadcast at
   the 40-player cap. Do not fold the build cost into the query margin.*
