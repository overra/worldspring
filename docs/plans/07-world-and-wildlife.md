# World Expansion: Size Tiers, Fresh Water, Wildlife

## Summary

Three coupled expansions, all gated behind doc 04's `ServerConfig`
(`docs/plans/04-gameplay-presets.md` owns `src/shared/config.ts`; this doc adds fields and
values to that schema and defines no rival config file, env var, preset registry, or wire
field). Worldgen fields ride doc 04's `welcome.config` exactly like `seed` does today, and
the client re-clamps them on receipt (`clampConfig` — welcome is attacker-controlled in
the community-server world):

1. **World size tiers** — `world.sizeTier: "standard" | "large" | "huge"` (800m / 1,600m /
   3,200m; internal scale 1/2/4). `createWorld` takes the resolved worldgen params; every
   baked count (towns, trees, cabins, rocks, spawn points) becomes a per-tier parameter
   with today's values as the standard-tier defaults. The client terrain mesh becomes
   chunked (128m chunks, 2 LOD rings, skirts for crack-hiding, fog as the budget valve —
   fog far is already 320m so nothing beyond ~450m is ever drawn). `heightAt` stays a pure
   analytic function; the sim does not know or care that rendering is chunked.
2. **Fresh water** — rivers carved into the heightfield by deterministic gradient-descent
   splines from highland sources, plus stamped pond basins. The carve **changes `heightAt`**,
   which is world-fingerprint-breaking **by design**: it is gated on doc 04's
   `world.waterFeatures` flag and the `world_fingerprint` persistence guard (doc 04 §4's
   fail-closed extension of the existing `world_seed` wipe). Gameplay: wading with depth
   slowdown (swimming is an explicit non-goal), drink-from-source with a dirty-water HP
   penalty (raw-venison precedent), fishing as a timer + loot roll (no fish entities;
   supersedes doc 05's interim cast mechanic — see §6), purification deferred to doc 05.
3. **Wildlife** — `Deer` generalizes to `Animal` with a `species` field (`deer | rabbit |
   boar | wolf`). Rabbits flee erratically, boars retaliate when shot, wolves hunt in packs
   at night (leader + followers, howl event). Birds are client-only ambience (crows circle
   lootable corpses — free intel, zero wire cost). Fish are not entities. Wildlife counts
   are per-species density multipliers in doc 04's `wildlife` config group — client-visible
   via `welcome.config`, so render pools size from the same shared derivation helpers the
   server caps use, with a hard per-species ceiling against hostile snapshots. Animals
   outside ~260m of every player skip their AI tick so wildlife never ticks the whole map.

Determinism law restated and enforced throughout: existing rng stream draw order is frozen;
all new generation uses new hash-salted streams; a multi-seed fingerprint harness
(`scripts/worldgen-fingerprint.ts`, new) proves the scale-1 default world stays bit-identical
through every refactor.

## Goals / Non-goals

**Goals**

- Meaningfully longer travel: large/huge (2x/4x linear) tiers with tier-scaled towns and
  landmarks, same per-client wire cost (interest radius is constant).
- Fresh water as terrain, obstacle (pools block, fords wade), resource (drink, fish), and
  landmark — fully deterministic, client/server identical.
- 3 new server wildlife species with distinct roles + client-only birds; spawn ecology from
  `ServerConfig`; dormancy outside player interest.
- Official 1x world survives every milestone unchanged (fingerprint-proven) until Adam
  deliberately flips config.

**Non-goals**

- Swimming. Water deeper than the wade limit blocks movement, exactly as the ocean does
  today. Full swimming means a new vertical movement mode in `stepPlayer`, buoyancy,
  animations, and reconciliation churn on both sides — engine surgery deferred until a
  feature actually needs deep-water traversal. Wading-with-slowdown delivers 90% of the
  fantasy at 5% of the risk.
- Bridges, boats, water vehicles.
- Fish as simulated entities; bird entities on the server.
- Heightmap terrain or erosion simulation. The heightfield stays analytic.
- Per-chunk world streaming of the *sim* (statics grid already scales; only rendering chunks).

## Current state

All verified against this worktree.

**World gen / terrain**

- `WORLD_SIZE = 800` (`src/shared/constants.ts:7`), `WATER_LEVEL = 0` (`:8`),
  `WATER_WALK_MIN = -0.55` (`:9`), `TERRAIN_MAX_HEIGHT = 22` (`:10`), `TOWN_COUNT = 4`,
  `CABIN_COUNT = 6`, `TREE_COUNT = 700` (`:11-13`), `ROCK_COUNT = 70` (`:172`).
- `makeHeightFn` (`src/shared/world.ts:178-190`): 3 simplex octaves × radial island mask;
  the mask divides by `WORLD_SIZE * 0.5` (`world.ts:185`) — world size is baked into the
  height *formula*, so a bigger world is a different world by construction.
- Sequential rng streams in creation order (`world.ts:343-676`): base `rng` (one burned draw
  at `:866`), `noise` (`seed^0x9e3779b9`, `:344`), `milRng` (`^0x3f1c7`, `:350`), `townRng`
  (`^0x7041`, `:372`), `bRng` (`^0xb17d`, `:388`), `lRng` (`^0x100c`, `:496`), `tRng`
  (`^0x7ee5`, `:513`), `rockRng` (`^0x6a09e6`, `:645`), `propRng` (`^0x1d872b`, `:676`).
  The warning block at `world.ts:607-609` names them. Hash-salted per-feature streams are
  the sanctioned extension pattern: `createRng(hashString(`win|${seed}|${id}`))`
  (`world.ts:232`), client grass/trim streams.
- Rejection loops have fixed max attempt counts: towns 4000 (`world.ts:373`), buildings 220
  per town (`:476`), cabins 2000 (`:486`), trees 6000 (`:514`), rocks 8000 (`:646`). The
  military site loop is fixed-iteration (600 draws regardless of acceptance, `:356-367`).
- `groundHeight` linear-scans **all** buildings per call (`world.ts:799-810`) — fine at ~36
  buildings, a scaling hazard at ~200.
- Spawn points: 48 angles, no rng, marching inward from `WORLD_SIZE*0.49` (`world.ts:533-548`).
- Client terrain: ONE `PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 200, 200)` — 4m vertex spacing,
  40,401 verts, `frustumCulled={false}` (`src/client/render/world/Terrain.tsx:11,25,80`).
  Vertex colors from height + central-difference slope (`Terrain.tsx:39-53`).
- Fog: day near/far 40/320, night 20/140 (`src/client/render/world/SkyAndLighting.tsx:42-45`);
  camera far 600 (`src/client/GameCanvas.tsx:39`). Nothing past ~320m is visible **today** —
  the current 800m mesh is already mostly fog-hidden.
- Ocean: translucent plane sized `WORLD_SIZE * 1.6`, 64×64 segments, patched
  `MeshStandardMaterial` with sine displacement + fresnel
  (`src/client/render/world/WaterPlane.tsx:13-14,49-75`). Render-only.

**Water in the sim**

- Deep water is a movement wall: `heightAt < WATER_WALK_MIN` blocks with axis-separated
  sliding for players (`src/shared/movement.ts:86-95`) and a hard stop for zombies/deer
  (`movement.ts:158-161`). No swim state, no depth concept, no fresh water anywhere.
- Thirst exists: `Vitals.water` decays (`src/server/systems/survival.ts:132-133`), refilled
  only by `water_bottle` (kind `drink`, `src/server/systems/players.ts:364-366`;
  `src/shared/items.ts:58`).

**Wildlife**

- One species. `Deer` (`src/server/systems/state.ts:148-161`) is structurally a `ZombieCore`;
  states `idle | wander | flee`. Spawn: `DEER_COUNT = 10` inland via Math.random rejection
  sampling against `WORLD_SIZE * 0.45` (`src/server/systems/wildlife.ts:58-78`). Flee blends
  away-vectors from all players within 22m at 8.5 m/s (`wildlife.ts:111-149`). Kill drops
  2-3 `raw_venison` as timed loot + schedules a 120s respawn (`wildlife.ts:92-109`);
  `state.deerRespawns` is a bare `number[]` (`state.ts:243`). Never persisted
  (`src/server/GameRoom.ts:359-361`).
- Combat treats deer as player-sized cylinders: `PLAYER_HEIGHT` × `HIT_CAPSULE_RADIUS`
  (`src/server/systems/combat.ts:358-369` ranged, `:226-234` melee). Lag-comp rewinds
  animals (`combat.ts:164`, `state.ts:305-308`).
- Wire: `WireAnimal {id, x, y, z, yaw, state}` — **no species field**
  (`src/shared/protocol.ts:133-142`); snapshot loop at `GameRoom.ts:815-826`, filtered at
  `INTEREST_RADIUS = 220` computed per player (`GameRoom.ts:722-725` — verified per-player).
- Render: `Animals.tsx` pools `DEER_COUNT + 4` rigs cloned from the `deer` node in
  `public/models/props.glb`, gait via `leg_fl/fr/bl/br` hip-pivot nodes, procedural box
  fallback (`src/client/render/entities/Animals.tsx:18-156`). Pool size depends on a shared
  compile-time constant — this changes once counts come from config (`welcome.config` makes
  them client-visible; pool rule in §7).
- `CharacterRig` is humanoid-only: `CharacterKind = "survivor" | "zombie"`
  (`src/client/render/entities/CharacterRig.ts:16`). Quadrupeds use the Animals.tsx pattern,
  not CharacterRig.
- Audio: `SfxName` manifest is the contract (`src/client/audio/manifest.ts:5-37`); no wildlife
  sounds beyond zombie set.

**Config & capacity**

- The `welcome` message's `seed` is the ONLY worldgen-config channel to the client
  (`protocol.ts:196`; server `GameRoom.ts:354` / client `connection.ts:260` per
  `docs/plans/research/codebase-sim.md`). No `PROTOCOL_VERSION` exists — doc 03's M1
  creates it (as the two-sided `proto` field on `join` and `welcome`), and doc 04's M1
  creates `src/shared/config.ts`/`welcome.config`. Both are designed, not yet
  implemented; this doc consumes both rather than re-creating either.
- Persistence guard: `schema_version` (=2) + `world_seed` meta mismatch wipes characters +
  world, keeps leaderboard (`src/server/persistence.ts:34,107-117` per research docs).
- Capacity envelope (verified loadtest, `docs/plans/research/codebase-server.md`): 20 bots /
  120s → tick 0.51ms EMA / 3ms max at 60 zombies + 10 deer. `persistAll` wipe-and-reinsert
  costs ~74K SQLite rows written per active hour at 1x — already the free-plan killer
  (`docs/plans/research/cf-costs.md`).

## Design

### 1. Config plumbing — extending doc 04's `ServerConfig`

**Ownership (binding):** `docs/plans/04-gameplay-presets.md` owns `src/shared/config.ts` —
the grouped `ServerConfig` (`{preset, world, threats, loot, survival, pvp, time, wildlife,
building, session}`), the `PRESETS: Record<string, DeepPartial<ServerConfig>>` registry
(deadcoast/driftwood/ironcoast/warpath/homestead/nightfall), `resolveServerConfig`
(server side, from the `GAME_CONFIG` env var), `clampConfig` (client side, on
`welcome.config`), and the fail-closed wipe machinery (doc 04 §4). This doc contributes
fields and values to that schema and consumes its plumbing. An earlier draft specified a
rival `WorldGenConfig`/`WORLD_PRESET`/`welcome.cfg`/classic-riverlands-frontier design;
that draft is dead — an implementer who builds it produces a config file, wire field, and
persisted meta that doc 04's milestones would have to migrate away.

**Resolution point (binding):** config is resolved **once, in the GameRoom constructor**
(doc 04 §4) — not in `ensureGame`. `initSchema` runs inside the constructor's
`blockConcurrencyWhile` (`GameRoom.ts:153-158`), so the `world_fingerprint` guard below
can only see a config resolved before it. `ensureGame` then calls
`createWorld(worldParamsOf(this.config.world))` — `worldParamsOf` is doc 04's pure shared
derivation, the single worldgen-input path on both sides.

**Doc 07's world fields**, slotting into doc 04's `world` group (which reserves them):

```ts
// doc 04's WorldConfig — doc 07 supplies the real value set and semantics
export type WorldSizeTier = "standard" | "large" | "huge"; // 800 / 1,600 / 3,200 m
export interface WorldConfig {
  seed: number;            // unchanged (doc 04)
  sizeTier: WorldSizeTier; // WIPE-class; internal scale 1 | 2 | 4 derived per §3
  waterFeatures: boolean;  // WIPE-class; default FALSE — today's world has no fresh water
}
```

Two amendments doc 04 had to take, flagged here because doc 07 cannot land without them
— **both have been applied to doc 04** (its §1 `WorldSizeTier`/`waterFeatures` and its
M6 tier table now match this doc; doc 04's M6 still says "Coordinate with doc 07 before
starting"). Kept for the record:

1. `WorldSizeTier` becomes the set above. Doc 04 §4's provisional M6 lookup
   (`small 560 / standard 800 / large 1120`) is superseded by §3's tier table: a sub-1x
   tier has no design or demand behind it, `makeHeightFn` bakes size into world character
   (`world.ts:185`), and the three-tier ladder spanning 16x area is what this doc's
   render/capacity work actually covers (Open question 9 if `small` should return).
2. `world.waterFeatures`'s reserved placeholder flips from "forced `true`" to "forced
   `false` until doc 07 wires it". A `true` default for a feature that does not exist
   bakes `water:1` into stored fingerprints of worlds that never had water — when the
   carve lands, either every world wipes (via the genVersion bump) or doc 07 needs a
   special-case migration. Defaulting `false` makes `deadcoast` reproduce the live world
   with no transition at all. Fallback if doc 04's M2 ships first with `water:1` stored:
   doc 07's M1 adopts-in-place a stored fingerprint that differs only in the placeholder
   water component.

**Presets:** `riverlands` and `frontier` become proposed rows in doc 04's registry as
DeepPartials — `riverlands: { world: { sizeTier: "large", waterFeatures: true } }`,
`frontier: { world: { sizeTier: "huge", waterFeatures: true } }` (plus whatever
threat/loot flavor each wants). There is no `classic` preset: `deadcoast` with default
world fields IS the live world and MUST reproduce it bit-for-bit (fingerprint-checked).

**Wildlife config** lands in doc 04's `wildlife` group as per-species density multipliers
(LIVE-class — animals are never persisted): `deerDensity` already exists; add
`rabbitDensity`, `boarDensity`, `wolfPackDensity` (each 0..3, default 1), multiplying
per-tier base counts in the `ANIMAL_SPECIES` table (§7, `constants.ts`). The whole config
reaches the client in `welcome.config`, so client render pools size from the same shared
`effectiveAnimalMax(cfg, species)` helpers the server caps use (doc 04 §5's
`effectiveDeerMax` precedent). The earlier "counts are server-only, pools must grow on
demand" rationale is dead; §7 has the bounded pool rule. Likewise there is no
`ZombiePopulation` group: outpost garrisons (§3) are per-tier base counts in
`constants.ts` scaled by doc 04's existing `threats.zombieDensity`.

**Wire:** doc 04's `welcome.config?: ServerConfig` (full object, ~700 bytes, once per
join) — no separate `welcome.cfg`. The client runs `clampConfig` on it before building
anything. That trust rule (doc 04 §2) is more load-bearing here than anywhere: in the
community-server world (docs 01-03) `welcome` arrives from untrusted third-party origins,
and `world.sizeTier` is the single most allocation-driving field in the system — the §3
tier tables scale tree records, statics cells, and rejection-attempt caps x16 at `huge`.
`clampConfig` coerces `sizeTier` against the enum **whitelist** (a hostile
`sizeTier: 64` or `"gigantic"` coerces to a known tier and never reaches allocation —
the `WorldSizeTier` TypeScript type does not validate runtime JSON), coerces
`waterFeatures` to a boolean, and clamps every wildlife density to its documented range.
Client allocation is therefore bounded by the largest *legitimate* tier — which the
client must support anyway, and after §4 lands, render cost is fog-bounded rather than
world-size-bounded. M1 acceptance includes a forged-welcome fuzz case (doc 04 M4's
pattern).

**Versioning — two constants, two owners:**

- `PROTOCOL_VERSION` is **created by doc 03** (`03-server-info-contract.md` M1) — not
  here, and not by the directory doc (doc 02 is the directory; it *consumes* the
  constant for outdated badges). Doc 03's gate is **two-sided** and the wire field is
  `proto`: `join.proto` checked server-side (absent `proto` accepted while
  `PROTOCOL_VERSION === 1` for rollout, rejected once it bumps) and `welcome.proto`
  checked client-side (`03-server-info-contract.md` §1). This doc consumes that gate
  verbatim — no `join.v`, no second constant. **Bump policy for this doc's milestones:**
  M1-M6 and M8-M12 are wire-additive and MUST NOT bump; **M7 MUST bump** — it changes
  `stepPlayer` semantics everywhere (doc 03's bump criteria name `src/shared/movement.ts`
  behavior explicitly). The bump converts "stale tab mispredicts in shallows" into
  "stale tab is cleanly refused at rejoin": a worker deploy restarts the DO and drops
  sockets, and the client has no auto-reconnect (`connection.ts:80-87,193-197` — close
  goes to the menu with "Connection lost"), so every stale tab re-enters through the
  gated join. Corollary: flipping any server to a non-default world config is only safe
  on builds where `PROTOCOL_VERSION ≥ 2` (post-M7), so absent-`proto` clients that would
  build the wrong world from the bare seed are refused — the same hard dependency
  doc 04's M6 declares.
- `WORLDGEN_VERSION` (new, `src/shared/constants.ts`, starts 1) is bumped whenever a
  carve/derivation formula change alters the world generated from identical config. It
  does NOT ride the wire — both sides compile it in, and a formula change is by
  definition a shared-sim behavior change, so every `WORLDGEN_VERSION` bump is
  accompanied by a `PROTOCOL_VERSION` bump (doc 03's criteria already require it).
  It exists for the persistence fingerprint only.

**Persistence** — extends doc 04's fingerprint; governed by doc 04's fail-closed table:

- The canonical fingerprint string (doc 04 §4) gains one component:
  `v1|seed:1337|size:standard|water:0|gen:1` — `gen:` is `WORLDGEN_VERSION`.
  `parseWorldFingerprint` treats an absent `gen:` component as `1`, and the boot path
  rewrites the stored string in place (adopt, never wipe) when components are merely
  absent.
- **Absent-fingerprint transition rule (binding — closes a wipe-the-live-world bug):**
  the deployed official database has NO `world_fingerprint` row. Under the existing
  guard pattern (`persistence.ts:107-117`), `getMeta` returns `null` for a missing row
  and `null !== computed` would take the wipe path — the first post-M1 deploy would
  delete every character on the production server while this doc promises "no wipe on
  ship". Rule: when `schema_version` matches and the legacy `world_seed` row matches the
  resolved config's seed (and the rest of the fingerprint is default), **adopt** —
  compute and write the fingerprint, wipe nothing. Doc 04 §4 specifies the same
  graceful migration; it is restated here as binding because either doc's milestone may
  be the one that lands it. M1 acceptance includes a simulated pre-M1 database
  upgrading without a wipe.
- A present-but-different fingerprint goes through **doc 04 §4's fail-closed decision
  table** — never a bare "mismatch → wipe": `varAbsent` or `worldTainted` config
  REFUSES to wipe and boots from the STORED fingerprint; only an explicit,
  cleanly-parsed config wipes, and a PITR bookmark is captured first. A one-character
  `GAME_CONFIG` typo, or a git-driven deploy stripping a dashboard-set var, must boot
  the old world loudly — not destroy it on a platform where the bookmark is the only
  recovery.
- **Rollback guard (replaces a false claim):** an earlier draft said "keep writing
  `world_seed` too for one version so a rollback deploy still guards" — false in the
  primary scenario it exists for. Presets share `seed: 1337`, so flipping
  deadcoast → riverlands changes the fingerprint but leaves `world_seed = "1337"`; a
  rolled-back binary checks only `schema_version` + `world_seed`
  (`persistence.ts:107-109`), both match, and it hydrates 1,600m-world coordinates into
  an 800m island with no wipe at all. Rule instead: every boot writes `world_seed` as
  the raw seed string **only when the resolved world config is all-default**; on any
  non-default world it writes the **fingerprint string** as a poison value — rolled-back
  code's string-compare against `"1337"` then fails and trips its own wipe. Honest
  caveat: that old-code wipe takes no PITR bookmark (old binaries don't know to);
  rolling back across a world-config flip is inherently destructive and the runbook
  must say so.

### 2. The determinism law + fingerprint harness

Restated from `docs/plans/research/codebase-sim.md` §3.2/§10, binding for every milestone:

1. The nine sequential streams (`rng/noise/milRng/townRng/bRng/lRng/tRng/rockRng/propRng`)
   must never gain or lose a draw **at standard tier (scale 1) with default config**.
   Parameterizing a loop bound is legal only if the standard-tier parameter equals
   today's literal.
2. New generation features (rivers, ponds, outposts) use NEW hash-salted streams:
   `createRng(hashString(`river|${seed}`))` etc. — never the streams above, and generated
   AFTER reading the base heightfield they need.
3. New rejection *conditions* in existing loops (e.g. "not in water") are legal only when
   they cannot fire at default config (no water exists when `waterFeatures: false`),
   because a changed acceptance changes the world.
4. Deterministic fix-ups consume zero draws (door-clamp precedent, `world.ts:435-437`).

**Verification harness** (`scripts/worldgen-fingerprint.ts`, new; run via `npx tsx`):

- For each seed in `[1337, 1..49]` × each config in a matrix (`deadcoast` defaults,
  `large`, `huge`, `standard+water`, …): build the world, serialize a canonical digest — towns,
  buildings (`id,kind,area,cx,cz,floorY,doorSide,windows`), lootSpawns, trees, props,
  militaryWalls, spawnPoints, plus `heightAt` sampled on an 8m lattice and at 1,000
  hash-derived probe points — FNV-1a hash the JSON.
- Compare against committed baselines (`scripts/fixtures/worldgen-fingerprints.json`).
  Two modes: `--check` (CI gate: refactors must not move any baseline) and `--update`
  (sanctioned changes regenerate, reviewed in the diff).
- The `heightAt` lattice is what makes the river-carve milestone honest: flipping
  `waterFeatures` must change the lattice hash; leaving it off must not.

### 3. World size tiers

`createWorld(params: WorldGenParams)` — `params` from doc 04's `worldParamsOf(cfg.world)`,
the single shared worldgen-input path — resolves a `GenParams` record per tier. Tier ids
map to an internal scale used as shorthand below: `standard` = 1x, `large` = 2x,
`huge` = 4x. Today's literals become the standard row; `World` gains `size: number` and
all consumers of
`WORLD_SIZE` outside the formula switch to it (`world.ts:185,487-488,515-516,537,647-648`;
server: `zombies.ts:110-111`, `wildlife.ts:63-64`, `airdrops.ts:38`; client: `Terrain.tsx:25`,
`WaterPlane.tsx:13`). `WORLD_SIZE` remains in constants.ts as the scale-1 base.

| param (constants.ts table) | standard (1x, today) | large (2x) | huge (4x) |
|---|---|---|---|
| size (m) | 800 | 1,600 | 3,200 |
| towns / ring (m) / min separation | 4 / 70-270 / 150 | 10 / 140-620 / 190 | 22 / 280-1,350 / 230 |
| town name pool | 6 | 12 | 24 (append-only list) |
| cabins | 6 | 18 | 44 |
| trees | 700 | 2,800 | 11,200 |
| rocks | 70 | 280 | 1,120 |
| military compounds | 1 | 1 | 1 + 2 satellite outposts |
| spawn angles / target points | 48 / 24 | 96 / 48 | 192 / 96 |
| rejection attempt caps | today's | ×4 | ×16 |

- Counts scale roughly with area but deliberately under-density at 4x (22 towns, not 64):
  "meaningfully longer travel" means emptier space between landmarks, not the same map
  repeated.
- **Satellite outposts (huge only):** small walled checkpoints (1 barracks + 4 sandbag
  props, reuse `MILITARY_SPECS`), military-tier loot, garrison = per-tier base counts in
  `constants.ts` scaled by doc 04's `threats.zombieDensity`. New stream
  `createRng(hashString(`outpost|${seed}`))`, placed after all existing streams run,
  rejecting sites near towns/compound. They give huge a reason to traverse: three armed
  POIs instead of one.
- Loot scales for free: lootSpawns derive from buildings (`world.ts:495-509`). Airdrop
  interval gets a per-tier row (1x today; 2x ×0.75; 4x ×0.5) — more map, more drops.
- **`groundHeight` fix (required at 2x+):** `buildingFloorAt` linear-scans all buildings per
  call (`world.ts:799-804`). Insert building footprints into the existing statics grid (a
  parallel `floors` list per cell) for O(cell) lookup. Zero rng, bit-identical results —
  fingerprint-safe, and it's a hot path (every `stepPlayer`/`stepZombie` vertical resolve).
- Interest radius interplay: `INTEREST_RADIUS = 220` / `LOOT_INTEREST_RADIUS = 120` are
  per-player distance filters (`GameRoom.ts:722-725`) and **do not change per tier** —
  per-client snapshot size and bandwidth stay flat regardless of world size, because entity
  *density* (not count) is what the filter sees, and density is held roughly constant.
- Airdrops are never interest-filtered (`GameRoom.ts:801-813`). Keep that (≤3 crates is
  cheap), but note: at 2x+ the smoke column is beyond fog (320m) for most players — see
  Open questions for the HUD bearing marker.

### 4. Chunked terrain (client render only)

`heightAt` is analytic; the mesh is cosmetic (`codebase-sim.md` §3.7). Chunking is purely a
`Terrain.tsx` rewrite — zero sim impact. Key insight from the verified fog numbers: **fog
far is 320m (day)**, so the render budget is bounded by fog, not world size. The valve
already exists.

- **Chunk size 128m.** Grid: 7×7 at 1x, 13×13 at 2x, 25×25 at 4x. Only chunks within
  `CHUNK_DRAW_RADIUS = 448m` of the camera are built/drawn (fog far 320 + margin; beyond it
  the background color already equals the fog color — `SkyAndLighting.tsx` lerps them
  together, so the horizon stays seamless).
- **LOD rings** (distance from camera to chunk **center**, with ±16m hysteresis). Sizing
  rule, load-bearing not cosmetic: LOD0 must cover every entity a client can ever see.
  Entity y is server-set from `groundHeight` (`movement.ts:166`), so an entity standing
  on a coarser render mesh shows floating/sunken feet. That means
  `INTEREST_RADIUS = 220` (`constants.ts:20`) **plus** the center-metric slack — a 128m
  chunk's corner sits up to ~91m from its center — plus hysteresis: 220 + 91 + 16 ≈ 327
  ⇒ **LOD0 ≤ 336m**. (An earlier draft used LOD0 ≤ 192m and claimed it covered
  `INTEREST_RADIUS`; wrong on the raw numbers — 220 > 192 — and worse under the center
  metric, which let an entity as close as ~102m stand on 8m-spaced terrain.)
  - LOD0 ≤ 336m: 4m spacing → 33×33 = 1,089 verts per chunk (matches today's density)
  - LOD1 ≤ 448m: 8m spacing → 17×17 = 289 verts per chunk
  - Two rings, not three: the 336→448m annulus is ~112m wide — narrower than one chunk —
    so a third ring would never own more than a boundary sliver.
- **Draw-call / vertex math (worst case, any tier):** ~45 chunks in the 448m disc
  (π·448²/128² ≈ 38.5 + boundary) → ~24 LOD0 + ~21 LOD1 ≈ **32K verts total**
  (vs 40K today) and ≤45 terrain draw calls before frustum culling, ~15-20 after
  (`frustumCulled` true per chunk, bounding sphere from displaced verts). Buildings merge
  to ~4 draws today; total scene stays well under 150 draws.
- **Cracks:** per-chunk skirts — edge vertex ring duplicated and extruded 3m down. Standard
  low-poly fix; no index stitching across LOD boundaries. Flat shading + fog makes skirts
  invisible in practice.
- **Build amortization:** chunk geometries built lazily from a queue, ≤2 per frame
  (~1,089 verts × 5 `heightAt` calls ≈ 5.4K noise evals ≈ <2ms each). Vertex-color formula
  unchanged (`Terrain.tsx:39-53`), generalized to (originX, originZ, size, spacing).
  Geometry cache keyed `(cx,cz,lod)` with LRU eviction beyond ~120 entries.
- **Ocean:** `WaterPlane` sizes from `world.size * 1.6`; segments scale `64 × scale` capped
  at 192 so wave-shader wavelengths (~60-180m) stay sampled.
- **Trees at 4x:** `Trees.tsx` instances the whole island; 11,200 trees ≈ 1M+ tris mostly
  in fog. Acceptance test in M4 measures it; if needed, rebuild instance buffers from trees
  within draw radius on a cell-crossing cadence (same hysteresis as chunks). Grass already
  per-16m-cell hash-streamed around the camera (`Grass.tsx:164`) — scales for free.

### 5. Fresh water

**Decision: carve-in-heightfield, not overlay decals.** Decals leave `heightAt` ignorant of
water — wading depth, movement blocking, drink/fish proximity, AI water avoidance, and the
terrain raycast would all disagree with the visuals. The carve changes `heightAt` everywhere
near water, which changes building acceptance downstream, which changes the world — **this
is fingerprint-breaking by design** and is therefore double-gated: `waterFeatures: false`
worlds take the EXACT current code path (zero carve lookups beyond one Map.get), and
flipping the flag trips the sanctioned `world_fingerprint` wipe path (doc 04 §4's
fail-closed table — only an explicit, cleanly-parsed config can fire it).

Generation order inside `createWorld`: base heightfield → **rivers → ponds** (new streams) →
compose `heightAt` → everything else (military, towns, …) reads the carved field, so
placement naturally respects channels (town h∈[2.5,9.5] and slope checks reject banks), plus
explicit no-rng water rejections for buildings/trees/rocks/spawn points (legal under law #3).

**Rivers** — stream `createRng(hashString(`river|${seed}`))`, count per tier (2 / 4 / 8):

1. *Sources:* fixed-iteration loop (law: military-site precedent, `world.ts:356-367`) — 200
   candidate draws, keep the N highest base-height points with h ≥ 10 and pairwise
   separation ≥ size/8.
2. *Descent march*, step 6m, max 400 steps, one meander draw per step (fixed):
   `dir_i = normalize(0.65·dir_{i-1} + 0.35·(−∇baseH))` rotated by `riverRng.range(-0.25, 0.25)`;
   ∇ via central differences. Terminate on `baseH ≤ WATER_LEVEL + 0.2` (reached the sea),
   step cap, or |∇| < 0.005 for 8 consecutive steps (basin → stamp a terminus pond).
3. *Per-vertex polyline record* `{x, z, halfW, surfY, bedDepth}`:
   - `halfW` lerps 1.5 → 4.0 over the march (width grows downstream)
   - `surfY_i = min(surfY_{i-1}, baseH_i − 0.45)` — monotonic, water never flows uphill
   - `bedDepth_i = FORD_DEPTH + (POOL_DEPTH − FORD_DEPTH) · (1 + sin(i·0.35 + φ))/2` with
     `FORD_DEPTH = 0.45`, `POOL_DEPTH = 1.4`, φ one draw per river. **This is load-bearing:**
     fords (0.45 < wade limit 0.55) keep rivers crossable every ~100m; pools (1.4) block and
     are fishable. Without it rivers would bisect the island with no swimming to cross them.
4. *Carve:* `carvedH(x,z) = min(baseH, surfY − bedDepth · clamp(1 − (d/R)², 0, 1))` where
   `d` = distance to nearest segment (interpolated attrs), `R = halfW · 2.2`.

**Ponds** — stream `hashString(`pond|${seed}`)`, count per tier (3 / 8 / 18), fixed 300
candidate draws: accept low-slope sites, base h ∈ [3, 12], ≥ 40m from rivers/other ponds.
Stamp: radius ∈ [7, 16], `surfY` = (min of 16 fixed rim samples) − 0.25, center depth ∈
[0.9, 1.6], same radial profile. Carves combine with rivers by `min` (deepest wins).

**Spatial index + perf:** 32m grid mapping cell → nearby segment/pond indices, built at gen.
`heightAt` prepends one `Map.get`; empty cell (the vast majority — also EVERY cell when
`waterFeatures: false`) falls straight through to the base formula. `heightAt` is the hottest
function in the sim (movement, raycast march at 2m steps, AI, mesh builds) — the harness
gains a microbench asserting carved-world `heightAt` ≤ 2× base cost on dry points.

**New World API:**

```ts
// world.ts — pure, deterministic, derived entirely from gen output
waterAt(x: number, z: number): { surface: number; depth: number } | null;
// ocean: heightAt < WATER_LEVEL → { surface: WATER_LEVEL, depth: -h }
// fresh: inside a river/pond influence with carvedH < surfY → { surface: surfY, depth }
// both: deeper wins; null on dry land
```

**Client render:** all fresh water merges into ONE static BufferGeometry (river ribbons:
paired verts offset ±(halfW+0.3) per polyline vertex at `surfY − 0.05`; ponds: 24-gon discs)
sharing a second instance of the patched water material from `WaterPlane.tsx` (refactor
`createWaterMaterial` to an export; wave amplitude 0.03 for fresh water). One extra draw
call. Ambient `river_loop` SFX cross-faded by distance to the nearest segment (client-side
lookup against the same water grid — the world object is local).

### 6. Gameplay hooks

**Wading (shared movement — determinism-sensitive):** replace the `WATER_WALK_MIN` check in
`stepPlayer` (`movement.ts:86-95`) and `stepZombie` (`:158-161`) with `world.waterAt`:

- Block when `depth > WADE_MAX_DEPTH = 0.55` — for ocean (surface 0) this is *exactly*
  `heightAt < −0.55`, the current rule, preserving behavior bit-for-bit on water-less worlds.
- Slowdown: `speed *= 1 − WADE_SLOWDOWN · clamp(depth / WADE_MAX_DEPTH, 0, 1)` with
  `WADE_SLOWDOWN = 0.45`; no jump when `depth > 0.35`. **Honest flag:** this changes feel
  in ocean shallows on ALL existing worlds (new behavior where depth ∈ (0, 0.55]). Stale
  tabs do NOT mispredict: M7 ships with the `PROTOCOL_VERSION` bump (§1 bump policy), the
  deploy's DO restart drops every socket, and the client has no auto-reconnect
  (`connection.ts:80-87,193-197`) — a stale bundle is refused at rejoin with the readable
  "client outdated" error instead of silently mispredicting in water. See Open questions.

**Drink from source:** new `ClientMsg { t: "drink" }` (parser case + GameRoom handler).
Server validates `waterAt` depth ≥ 0.15 at the player or any of 4 offsets within 1.5m.
Restores `DRINK_FRESH_WATER = 30` water, costs `DIRTY_WATER_HP_PENALTY = 5` hp floored at
1 (exact raw-venison precedent, `players.ts:344-358`). Doc 05's purification/canteen removes
the penalty later — the hook is the penalty constant, nothing structural. Client: "E — Drink"
prompt when near water and no loot prompt (loot wins); plays the existing `drink` cue.

**Fishing (supersedes doc 05 §4.3's interim mechanic; consumes doc 05's items):** doc 05
owns the item definitions — `fishing_rod`, `raw_fish` (power 12, `rawPenaltyHp: 5`,
`cooksTo: "cooked_fish"`), `cooked_fish` (doc 05's item table, lines 182-184) — plus the
`cooksTo` cooking wiring. This doc owns the *mechanic* from M12 on, replacing doc 05
§4.3's interim version (an instant `FISH_CHANCE` 0.45 roll on a cooldown, with water
detected by sampling `heightAt` 2.5m ahead — written before fresh water existed): rod
equipped + `attack` while facing water with `waterAt` depth ≥ 0.8 within 3m → server sets
`player.fishingUntil = time + rand(4, 10)` (Math.random — server-only, no determinism
constraint); movement or a second attack cancels; on completion roll `FISH_TABLE`
(raw_fish 80% / nothing 15% / junk surprise 5%), `splash` GameEvent at the bobber point.
Doc 05's `FISH_CHANCE`/`FISHING_COOLDOWN_S` constants and heightAt-ahead water test must
not ship alongside this — **coordination note:** doc 05 §4.3 needs an annotation marking
it superseded by this doc's M12, or two cold implementing sessions will double-define the
items and ship two incompatible fishing mechanics. No fish entities — pools are the
"fish biome".

### 7. Wildlife

**Data model:** `Deer` → `Animal` (`state.ts`): adds `species: AnimalSpecies`, optional
`packId`, `targetId`, `attackCooldown`. `state.animals: Map<number, Animal>`;
`deerRespawns: number[]` → `animalRespawns: Array<{ species: AnimalSpecies; t: number;
packId?: number }>`. Species tunables live in `constants.ts` as a single
`ANIMAL_SPECIES: Record<AnimalSpecies, SpeciesDef>` table (house rule: tunables in constants):

| species | hp | wander / run m/s | hit r × h | behavior | drops (meat) | respawn |
|---|---|---|---|---|---|---|
| deer | 25 | 1.2 / 8.5 | 0.55 × 1.2 | flee ≥22m (today, unchanged) | 2-3 | 120s |
| rabbit | 5 | 0.8 / 9.5 | 0.25 × 0.4 | flee ≥14m, zigzag: re-roll flee bearing ±60° every 0.4s | 1 | 90s |
| boar | 70 | 1.0 / 7.8 | 0.50 × 1.0 | neutral; **retaliates when damaged**: charge attacker, gore 18 dmg @1.6m / 1.4s cd; gives up after 12s or >40m, brief flee, resume wander | 3-5 | 240s |
| wolf | 45 | 1.4 / 7.5 | 0.45 × 0.9 | pack predator (below) | 1-2 | 300s (pack slot) |

Per-species hit cylinders replace the player-sized cylinder deer get today
(`combat.ts:358-369`) — rabbits become genuinely hard to shoot. Both wolves (7.5) and boars
(7.8) outrun `SPRINT_SPEED = 6.8`; deer flee (8.5) still outruns everything.

**Meat consolidation (recommendation):** all land species drop the existing `raw_venison`
type with its display `name` changed to "Raw Meat" (`items.ts:95` — `name` is presentation
only; the persisted `type` string never changes, so no `SCHEMA_VERSION` bump). One meat
economy, zero inventory clutter, zero save risk. Fish stay separate (`raw_fish`).

**Wolf packs:**

- Spawn: pack-count dens — per-tier base count × `wildlife.wolfPackDensity` (Math.random
  rejection like `pickDeerPoint`, terrain h ∈ [4, 14], outside towns/military, not in
  water). Leader + `WOLF_PACK_SIZE = 3` followers within 10m, sharing `packId`; leader =
  lowest live id (promotion on death is automatic).
- Leader state machine: `idle/wander` near den (deer pattern) → `stalk` when a living player
  is within `WOLF_AGGRO_NIGHT = 45m` during night hours (`gameHours` ∈ [21, 5), the existing
  `NIGHT_START_HOUR/NIGHT_END_HOUR`) or within 12m in daytime, or when any packmate is
  damaged (retaliation) → approach to 18m, hold `WOLF_STALK_S = 4s` → `attack`: chase at
  7.5 m/s, bite `WOLF_DMG = 14` @ 1.5m / 1.0s cd (reuse the zombie attack-blocked occlusion
  ray, `zombies.ts:162-175`). Disengage: target dead/escaped >70m, or own hp < 30% → `flee`.
- Followers mirror the leader's state; movement target = leader ± fixed angular offset while
  wandering/stalking; in `attack` each chases the pack target independently via `stepZombie`.
- **Howl:** new `GameEvent { e: "howl"; x, z }` — emitted once when a pack enters `stalk`,
  plus ambient rolls every 60-120s at night per pack. Interest-filtered like all events
  (220m, fog is 320 — you hear them before you ever see them). Client: positional one-shot.
- Day behavior: wary-neutral (keeps ≥20m from players while wandering) — wolves are a
  *night/forest* threat by design, complementing zombies (a town/military threat).

**Crows/seagulls — client-only (recommendation):** birds as server entities cost wire and
tick for ambience. Instead: client renders a slow orbit of 2-3 crow billboards/low-poly
boids above any `WireCorpse` with `items > 0` already present in the snapshot (corpses
arrive within 120m, `GameRoom.ts:780-793`), plus hash-streamed ambient gulls along the
beach ring (grass-pattern cosmetic stream). The corpse crows are real gameplay — a visible
"someone died here" marker — for zero server cost. `crow_caw` SFX when first spotted.

**Dormancy (spawn/despawn lifecycle):** animals don't despawn (homes are fixed; counts are
small), they *sleep*: each tick `tickWildlife` computes nearest-player distSq per animal
(O(A×P), 280×24 ≈ 6.7K distSq at 4x — trivial) and skips AI for animals with no player
within `WILDLIFE_ACTIVE_RADIUS = 260m` (just past `INTEREST_RADIUS` 220 so nothing visibly
freezes). A sleeping animal stands still, takes damage normally (combat doesn't care), and
wakes instantly. Respawn timers tick globally (cheap counters, `wildlife.ts:178-190`
pattern). Zombies keep their current always-tick behavior (300 wandering zombies at 4x is
within budget — see capacity math); applying the same dormancy to zombies is an optional
follow-up, not in scope.

**Wire:** `WireAnimal` gains `species: AnimalSpecies`; `AnimalState` widens to
`"idle" | "wander" | "flee" | "stalk" | "charge" | "attack"`. Additive + widened-union —
old open tabs render unknown species as deer until refresh (acceptable; M8/M9 deliberately
do not bump `PROTOCOL_VERSION` per the §1 policy, and doc 03's `proto` join gate stops
*new* sessions from skewing).

**Render:** generalize `Animals.tsx` to per-species pools keyed by GLB node name (`deer`,
`boar`, `wolf`, `rabbit`) using the SAME `leg_fl/fr/bl/br` hip-pivot convention the deer
already uses (`Animals.tsx:25,94`) — new models are a live Blender session on
`assets/items.blend` → appended to `public/models/props.glb` (one `useGLTF` cache entry,
existing precedent), each with a procedural-box fallback like the deer's
(`Animals.tsx:98-137`). Pool sizing: wildlife counts ARE client-visible (clamped
`welcome.config`, §1), so each species pool sizes to
`min(effectiveAnimalMax(clampedCfg, species) + 4, ANIMAL_POOL_MAX)` — replacing the
module-scope `DEER_COUNT + 4` (`Animals.tsx:18`). `ANIMAL_POOL_MAX = 64` per species
(constants.ts) is a hard ceiling regardless of config or snapshot contents: a hostile
community server controls the snapshot too (it IS the interest filter), and without the
cap a 5,000-entry `animals` array (~275KB JSON × 15Hz ≈ 4MB/s) would clone thousands of
skinned rigs and freeze the tab. Snapshot entries beyond pool capacity are dropped —
exactly the existing pool-exhaustion `continue` behavior. Per-species gait params (rabbit
hop = phase-synced y-bounce; boar charge = flat fast cycle; wolf = low lope).

**Audio manifest additions** (`manifest.ts` + generation pipeline): `wolf_howl`,
`wolf_attack`, `boar_grunt`, `boar_charge`, `rabbit_death`, `crow_caw`, `splash`,
`river_loop`.

### 8. DO capacity at 4x (vs the 20-bot envelope)

Baseline (verified, `codebase-server.md`): 0.51ms tick EMA / 3ms max with 20 bots, 60
zombies, 10 deer, ~90 loot entities. At `frontier` (4x): ~320 zombies, ~280 animals
(mostly dormant), ~210 buildings → ~450 loot spawns/entities.

- **Tick CPU:** zombie AI is the dominant term and scales linearly in zombie count
  (target-acquisition O(Z×P) = 320×24 ≈ 7.7K distSq + per-mover statics queries). Linear
  extrapolation: ~2.5-3ms EMA, ~12-15ms max — under 25% of the 66.7ms budget. The
  `groundHeight` grid fix (§3) is required to keep `stepZombie`'s vertical resolve O(1).
- **Snapshots:** O(players × entities) distance checks = 24 × ~1,100 ≈ 26K distSq per tick —
  sub-ms. Per-client wire size unchanged (interest-filtered, density flat).
- **Boot:** `createWorld` at 4x ≈ 100-400ms (96K tree attempts × O(buildings) overlap scans
  dominate) — one-time per DO boot and per client join (loading screen); measure in M11.
- **Memory:** 11.2K trees + 40K statics cells + world JSON ≈ single-digit MB against the
  128MB DO. Non-issue.
- **Persistence (the real constraint):** `persistAll` wipes and reinserts world_state every
  20s; at huge that's ~1,000 rows/save ≈ 180K rows written/hour — the free plan's 100K/day
  rows-written cap dies in ~33 minutes (vs ~80 at standard; `cf-costs.md`). **Large/huge
  presets on the free plan are not viable until the single-JSON-row persistAll fix lands**
  (the ~30-line lever cf-costs identifies). Paid plan, with assumptions stated (an earlier
  draft said "~$3-8/mo worst case", which matches no cf-costs scenario): rows written scale
  with *active hours*, so the worst case is a 24/7-active server — pre-fix at huge that is
  ~130M rows/month → (130 − 50 incl.) × $1.00/M ≈ **$80/mo rows overage alone**, plus
  ~$9-12 requests overage and the $5 base ≈ **$90-100/mo**. Post-fix the rows line
  vanishes and the 24/7 worst case is requests-dominated ≈ **$15-24/mo** (cf-costs §4
  scenario (c) — world-size-independent). The persistAll fix is therefore a prerequisite
  for *paid* large/huge hosting being cheap, not just for free-plan viability; the
  directory/server-info labels for large/huge presets should carry the cost caveat until
  it lands. This doc treats that fix as an external prerequisite, not a milestone here.
- **Acceptance gate:** rerun `apps/game/scripts/loadtest.mjs` (20 bots / 120s) against `frontier`;
  pass = 100% joins, tick max < 15ms, no unexpected closes.

## Implications

**Opens up**

- Per-deploy world identity (`seed × sizeTier × waterFeatures`) — community servers
  (docs 01-06) get real variety; `/api/server-info` can advertise the preset.
- Rivers/pools create fords, ambush chokepoints, fishing economy, and a water-route mental
  map — terrain finally *routes* players instead of just slowing them.
- The species framework (SpeciesDef table + per-species pools + pack logic) makes species
  #5+ (bears, horses?) data-plus-one-AI-function work.
- Chunked terrain removes the single-mesh ceiling for any future world geometry work
  (cliffs, biome coloring per chunk).

**Complicates**

- `createWorld` gains config-derived parameters that MUST stay in lockstep across
  `welcome.config`, the client build, and the persistence guard — one more way to desync
  if a future change forgets the welcome channel. `worldParamsOf` as the single input
  path plus the fingerprint harness in CI are the mitigations.
- Terrain rendering goes from 1 static mesh to a chunk manager with LOD hysteresis, build
  queue, and cache — more moving parts in the client's hottest visual system.
- `heightAt` gains a branch (water grid lookup). It must stay allocation-free and fast; the
  microbench guards it.
- Animals.tsx pool sizing moves from a compile-time constant to clamped-config-derived
  values with a hard `ANIMAL_POOL_MAX` ceiling (§7).
- Cross-doc coupling is real and named: `ServerConfig` is doc 04's, `PROTOCOL_VERSION` is
  doc 03's — this doc consumes both, and the two §1 amendments to doc 04 (tier value set,
  `waterFeatures` default false) must land in that doc before its M2/M6 are implemented.
  Doc 05 §4.3 needs the fishing-supersession annotation (§6).

**Breaks**

- Flipping `sizeTier` or `waterFeatures` on a deployment wipes characters + world_state on
  that deployment (sanctioned `world_fingerprint` path gated by doc 04 §4's fail-closed
  table — only an explicit, cleanly-parsed config can fire it; PITR bookmark first;
  leaderboard survives). The official server changes worlds only when Adam opts in.
- Wading slowdown alters movement feel in ocean shallows on ALL worlds (including
  standard) the moment M7 deploys (shared-code edit; `movement.ts` landmine
  acknowledged). Stale tabs are dropped by the deploy and refused at rejoin by M7's
  `PROTOCOL_VERSION` bump — a readable error, not silent misprediction.
- Old open tabs across the wildlife deploy render wolves/boars as deer and don't know new
  anim states until refresh (M8/M9 don't bump the protocol). Doc 03's `proto` gate covers
  new joins only.

**Threatens**

- **River-carve correctness:** a subtle asymmetry between gen-time and runtime carve
  evaluation (e.g. float-order differences in the spatial index) would desync client
  prediction against server authority in the worst possible way — silently, near water
  only. Mitigation: ONE carve implementation, no duplicated math; fingerprint lattice
  includes near-river probe points.
- **`simplex-noise` stays pinned** — tier scaling multiplies how much world depends on it.
- 4x emptiness: 22 towns on 10.2km² may feel dead below ~12 concurrent players. Content
  density numbers are constants — tune after playtests, each tune is a fingerprint change
  for that tier only (1x untouched).
- Free-plan community servers running big presets will hit the rows-written wall
  mid-session and silently lose saves (`cf-costs.md` failure mode) until the persistAll
  single-row fix lands.

## Migration & compatibility

- **Existing official world (standard tier, seed 1337):** zero impact. Default config
  reproduces it bit-identically; the fingerprint harness proves it at every milestone; the
  absent-fingerprint **adopt** rule (§1) writes the new meta row in place instead of
  treating a missing row as a mismatch. No wipe on ship — M1 acceptance simulates exactly
  this upgrade.
- **Persistence:** `SCHEMA_VERSION` stays 2 — item additions (`raw_fish`, `cooked_fish`)
  are doc 05's and additive; `raw_venison` keeps its type string, display name only. The
  `world_fingerprint` meta row supersedes `world_seed` via adopt-in-place; `world_seed`
  keeps being written every boot — the raw seed string on all-default worlds, the
  fingerprint string as a rollback poison on non-default worlds (§1). Sanctioned config
  wipes go through doc 04 §4's fail-closed table with a PITR bookmark.
- **Wire:** all changes additive (doc 04's `welcome.config`, `WireAnimal.species`, widened
  `AnimalState`, doc 03's `join.proto`/`welcome.proto`, new `ClientMsg drink`, new
  `GameEvent howl/splash`). The parser ignores unknown fields; the client event switch
  must be verified to ignore unknown `e` values (flagged in codebase-sim §5.3 — M1
  acceptance includes this check). Post-deploy open tabs degrade visually (deer-shaped
  wolves), never crash; new joins are version-gated per the §1 bump policy.
- **Shared movement edit (wading)** is deploy-atomic for prediction parity but changes feel
  everywhere at once; ship it in its own deploy with a notice and the `PROTOCOL_VERSION`
  bump, not bundled with a content drop, so regressions are attributable.
- **Deployed community servers** (docs 01-06 world): preset changes are their owner's
  choice; doc 04 §6's `RulesSummary` already carries `worldSize` — it should grow a
  water flag so the directory can label world size/water (and the large/huge cost caveat,
  §8).

## Implementation plan

Dependencies: doc 04 M1+M2 (`config.ts`, `clampConfig`, fail-closed fingerprint) and
doc 03 M1 (`PROTOCOL_VERSION`/`proto` gate) are upstream of M1 here — this doc creates
neither. Then M1 → M2 → {M3, M4, M5}; M5 → {M6, M7}; M8 → {M9, M10}; M11 last; M12 after
M7 + doc 05's rod. Each milestone is one focused session, PR-sized.

1. **M1 — Config consumption + fingerprint extension + harness** *(Opus 4.8)*
   Files: `src/shared/config.ts` (extend doc 04's schema per §1: tier value set,
   `waterFeatures` default false, wildlife density fields, `riverlands`/`frontier`
   DeepPartial presets, `effectiveAnimalMax`), `src/shared/constants.ts`
   (`WORLDGEN_VERSION`), `src/server/persistence.ts` (`gen:` fingerprint component,
   absent-fingerprint ADOPT rule, `world_seed` poison rule), `src/server/GameRoom.ts`
   (`ensureGame` consumes the constructor-resolved config — resolution itself is
   doc 04's), `scripts/worldgen-fingerprint.ts` + committed baselines, `ARCHITECTURE.md`
   (NET contract: welcome carries `config`; client builds via
   `createWorld(worldParamsOf(config.world))`, superseding "build createWorld(seed)" at
   ARCHITECTURE.md:69).
   Accept: harness `--check` green across 50 seeds at `deadcoast` defaults; a simulated
   pre-M1 database (schema_version=2, world_seed=1337, NO fingerprint row) upgrades with
   zero wipe; a forged `welcome.config` (`sizeTier: 64`, non-boolean water flag, huge
   wildlife densities) is clamped with no runaway allocation; client event switch
   verified to ignore unknown `e`/`t`.

2. **M2 — `createWorld` parameterization** *(Opus 4.8 — determinism-critical refactor)*
   Files: `src/shared/world.ts` (GenParams threading, `World.size`, `groundHeight` grid
   fix), `src/shared/constants.ts` (tier tables), consumers of `WORLD_SIZE`
   (`zombies.ts:110`, `wildlife.ts:63`, `airdrops.ts:38`, `Terrain.tsx:25`,
   `WaterPlane.tsx:13`).
   Accept: `deadcoast`-default fingerprints unchanged; large/huge worlds generate with
   ≥90% of target town counts across 50 seeds (report fill rates); `groundHeight` grid
   returns identical values to the linear scan on 10K probe points.

3. **M3 — Chunked terrain renderer** *(Opus 4.8 — the risky render milestone)*
   Files: `src/client/render/world/Terrain.tsx` (chunk manager, LOD rings, skirts, build
   queue, frustum culling), `WaterPlane.tsx` (size/segments per scale), `ARCHITECTURE.md`
   (replace the one-plane Terrain spec at ARCHITECTURE.md:107-110 with the chunk/LOD
   manager description — downstream parallel sessions treat that file as the contract).
   Accept: visual parity screenshots at standard tier (day + night fog); terrain ≤45 draw
   calls pre-cull at every tier; no visible cracks at LOD boundaries; chunk builds
   ≤2/frame with no >8ms frame hitches while sprinting across the island; entities at
   100-220m never stand on coarser-than-4m terrain (no visible foot-float at LOD
   boundaries — the §4 LOD0 sizing rule, verified with zombies/animals parked in the
   192-336m band).

4. **M4 — Tier content: scaled counts + satellite outposts** *(Sonnet 4.8, fingerprint
   harness as the guard)*
   Files: `world.ts` (`outpost|${seed}` stream, town-name pool), `constants.ts`,
   `src/server/systems/zombies.ts` (outpost garrisons: per-tier base counts ×
   `threats.zombieDensity`), `Trees.tsx` (measure huge-tier instancing; distance-culled
   rebuild if needed).
   Accept: `deadcoast`-default fingerprint unchanged; outposts never overlap
   towns/compound across 50 seeds; huge frame rate within 15% of standard in identical
   scenes.

5. **M5 — Fresh water generation + carve** *(Opus 4.8 — THE risky determinism milestone)*
   Files: `world.ts` (river march, pond stamps, carve composition, water grid, `waterAt`),
   `constants.ts` (water tunables), harness matrix rows for `waterFeatures: true`.
   Accept: `waterFeatures: false` fingerprints (incl. heightAt lattice) unchanged;
   `waterFeatures: true` baselines committed; every river reaches sea or terminus pond across
   50 seeds; ≥1 ford (depth < 0.55) per 150m of river verified programmatically; carved
   `heightAt` ≤2× base cost on dry probe points.

6. **M6 — Fresh water rendering + ambience** *(Sonnet 4.8)*
   Files: `WaterPlane.tsx` (export `createWaterMaterial`), new
   `src/client/render/world/FreshWater.tsx` (merged ribbon/disc mesh), audio manifest +
   `river_loop`/`splash` assets, AudioSystem distance fade.
   Accept: one draw call for all fresh water; surfaces never z-fight banks; river audio
   audible ≤40m.

7. **M7 — Wading + drink-from-source + PROTOCOL_VERSION bump** *(Opus 4.8 — touches
   shared `stepPlayer` prediction)*
   Files: `src/shared/movement.ts` (waterAt block/slowdown/jump-gate), `protocol.ts`
   (`drink` msg, `PROTOCOL_VERSION` bump — the §1 policy: this is the milestone that
   changes predicted movement semantics everywhere), `src/server/systems/players.ts`
   (handler + penalty), client prompt + cue.
   Accept: water-less worlds byte-identical movement traces on a recorded input script
   (golden-file test); prediction error stays <1cm wading in live test; drink restores 30
   water / −5 hp floored at 1; a pre-M7 client's join is refused with the readable
   outdated error (doc 03's gate doing its job).

8. **M8 — Wildlife core: species framework + rabbits + dormancy** *(Sonnet 4.8)*
   Files: `state.ts` (Animal), `constants.ts` (`ANIMAL_SPECIES`), `wildlife.ts`
   (species spawn/AI dispatch, dormancy, `animalRespawns`), `combat.ts` (per-species
   cylinders, `killAnimal`, retaliation hook), `protocol.ts` (`WireAnimal.species`, states),
   `GameRoom.ts` snapshot, `items.ts` (meat display rename).
   Accept: deer behavior unchanged side-by-side; rabbits one-shot, hard to hit at range;
   animals >260m from every player consume zero AI time (counter in /api/health debug).

9. **M9 — Boars + wolf packs** *(Sonnet 4.8)*
   Files: `wildlife.ts` (boar retaliation, pack machine, promotion), `constants.ts`,
   `protocol.ts` (`howl` event), audio manifest entries.
   Accept: boar charges its attacker and gives up per spec; pack stalks at night, howl
   fires once per aggro; wolves wary-neutral in daytime; pack respawns as a pack at its den.

10. **M10 — Wildlife visuals + birds** *(Sonnet 4.8 + Adam Blender session)*
    Files: `assets/items.blend` → `public/models/props.glb` (boar/wolf/rabbit with
    `leg_fl/fr/bl/br` convention), `Animals.tsx` (per-species pools sized from clamped
    config per §7, gaits, box fallbacks), `constants.ts` (`ANIMAL_POOL_MAX`), new
    `Birds.tsx` (corpse crows + beach gulls, client-only), sfx assets.
    Accept: every species renders with fallback when GLB nodes absent; crows appear over
    corpses with `items > 0` within loot interest; all animals render at huge-tier
    counts; pools never exceed `ANIMAL_POOL_MAX` regardless of snapshot contents (a
    forged 5,000-entry animals array renders ≤64/species, rest dropped, no allocation
    growth).

11. **M11 — Huge-tier capacity validation** *(Sonnet 4.8)*
    Files: `apps/game/scripts/loadtest.mjs` config pass-through; results appended to this doc.
    Accept: 20 bots / 120s on `frontier`: 100% joins, tick max <15ms, EMA <4ms, boot
    `createWorld` time recorded; free-plan caveat AND the §8 paid-plan cost numbers
    (pre-fix ~$90-100/mo vs post-fix ~$15-24/mo for 24/7 large/huge) documented in
    README/server docs.

12. **M12 — Fishing** *(Sonnet 4.8; blocked on doc 05's `fishing_rod`/`raw_fish`/
    `cooked_fish` items — consumed, NOT redefined here)*
    Files: `players.ts`/`combat.ts` (cast intercept), `protocol.ts` (`splash`), client
    prompt/VFX; remove/replace doc 05 §4.3's interim `useItem` fishing branch if it
    shipped (§6 supersession).
    Accept: catch only in depth ≥0.8 water; cancel on move; cook parity with venison;
    no second fishing code path remains.

## Open questions

1. **Official server world after ship?** Staying standard/no-water keeps everyone's
   characters; flipping to `riverlands` (large + water) wipes characters (leaderboard
   survives) and shows off everything. **Recommendation:** ship milestones against
   standard, then announce a "new continent" wipe to `riverlands` — necessarily post-M7,
   so the `proto` gate refuses stale clients that would build the wrong world (§1).
   Wipes are a genre tradition and the leaderboard preserves history.
2. **Wading slowdown in ocean shallows on existing worlds** — accept the feel change, or
   gate slowdown to fresh water only (ocean keeps binary block)? **Recommendation:** accept
   universally; one rule everywhere is simpler to predict and beach-wading slowdown is
   genre-correct. Ship in its own deploy (see Migration).
3. **Meat consolidation** — one "Raw Meat" item for all land species (display rename of
   `raw_venison`) vs per-species meats? **Recommendation:** consolidate; per-species meat
   is inventory clutter with 8 slots, and the type-string rename trap (`SCHEMA_VERSION`)
   isn't worth flavor text.
4. **Birds client-only** — confirm dropping server-side scavenger birds.
   **Recommendation:** yes; corpse-crows give the gameplay value at zero wire/tick cost.
5. **Airdrop visibility beyond fog at 2x/4x** — add a HUD bearing marker / compass tick for
   active drops, or let big-map drops be local knowledge? **Recommendation:** small HUD
   bearing tick while a crate is falling/smoking; without it the airdrop system silently
   stops mattering at 4x.
6. **Huge at launch** — ship `frontier` as selectable, or hold it behind "experimental"
   until the persistAll single-row fix and a content-density pass land?
   **Recommendation:** hold; ship standard + large, validate huge via M11 and the
   persistence fix first (the §8 cost math says paid 24/7 huge is ~$90-100/mo until that
   fix lands).
7. **Wolf daytime posture** — wary-neutral (recommended) vs fully passive vs always hostile.
   Affects how safe forest looting feels during the day.
8. **Fog far per tier** — keep 320m everywhere (recommended; preserves the claustrophobic
   read and the render budget) vs widening to ~450m on large/huge for vista moments at a
   ~2x terrain draw cost.
9. **Does a sub-1x tier survive?** Doc 04's provisional M6 table had `small` (560m); §1
   supersedes that table with standard/large/huge and drops it. A cozy duel-sized island
   is cheap to add later (one more tier row + fingerprint value) if community operators
   ask. **Recommendation:** drop it for now; nothing in this doc's render or capacity
   work depends on it either way. (Doc 04 has taken the §1 amendment — the two docs now
   agree on standard/large/huge.)
