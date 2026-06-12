# Items, Scavenging & Crafting — the minutes 10–120 loop

## Summary

This doc expands DEADCOAST's item economy from "walk into a building, grab what's on the
floor" into a loop: scavenge containers for **materials** → craft **tools** → use tools to
**harvest** (chop branches, dress deer, fish, boil water) → **gear up** (jacket, backpack,
better meds). Decisions made here:

- **16 new ItemTypes, zero new engines.** Every behavior is an optional config object on
  `ItemDef`, following the `RangedConfig` precedent: `cooksTo` (generalizes the raw-venison
  hack), `water` (canteen fill/boil/drink), `wear` (insulation + capacity), `light` (torch).
- **Searchable containers** (wardrobe/toolbox/locker) placed deterministically inside
  buildings via a **new hash-salted rng stream** (windows precedent) — existing worldgen
  streams are untouched, **no collision**, so no schema wipe. Searching spills rolled loot
  onto the floor as ordinary loot entities with their own short `CONTAINER_SPILL_TTL_S`
  (unlooted spill is persisted rows — see Implications); only the searched-flag rides the
  wire, and it persists as a **single meta row**, not per-container rows (§3 — rows
  written are billed, including deletes).
- **One new keybind: F = use the selected hotbar item** (sends the existing `use` message;
  client spec in §6, ships in M1). This is what makes `kind: "tool"` items (fishing rod,
  empty canteen) actually usable — today nothing in the client can "use" a tool: no key
  sends `use`, and the Tab panel's USE button excludes tools (`HUD.tsx:23-28`).
- **No destructible trees.** Trees become renewable gather nodes: E-interact with an axe
  equipped, per-tree server cooldown. Felling is rejected (collision + determinism +
  persistence surgery for negative gameplay value).
- **Deer leave corpses** that a knife field-dresses into venison + pelts (pelts feed the
  jacket recipe; knife becomes a real tool target).
- **Crafting is a flat `RECIPES` array** in `src/shared/items.ts`; the client sends
  `{t:"craft", recipe}`, the server validates inputs/tool/station and grants the output.
  Campfire is the first (and only) station. No skill trees, no recipe discovery — all
  recipes always visible in the Tab panel.
- **Inventory stays 8 slots**; materials stack to 8, and a worn **backpack** adds 4
  non-hotbar slots. A worn **jacket** slows temperature loss. Two wear slots
  (`body`/`back`) on the player, not inventory slots.
- Five additive `ClientMsg` types (`craft`, `search`, `gather`, `wear`, `unwear`), one
  additive snapshot field (`conts`), additive `inv`/`WireCorpse` fields. All back-compat
  per doc 03; every wire-vocabulary milestone bumps `PROTOCOL_VERSION` — **including M1**,
  whose 16 new ItemTypes grow a wire enum that doc 03's bump rule names explicitly.

## Goals / Non-goals

**Goals**

- Give minutes 10–120 a progression: materials → tools → harvest → cook → gear.
- Deepen scavenging (containers, per-building-kind tables) without touching the frozen
  worldgen streams or the loot-spawn economy that already works.
- Keep everything data-first: a future item/recipe is a table row, not a code branch.
- Keep the 8-slot inventory tension; relieve it only through an earned item (backpack).

**Non-goals**

- Skill trees, XP, recipe unlocks, blueprints — knowledge-free by design.
- Item durability/condition. `ItemStack` stays `{type, count}`; anything needing per-item
  state (torch burn-down, gun wear) is deferred until a real need forces the wire/persistence
  change.
- Destructible world geometry (tree felling, breakable walls). Rejected below.
- Base building / placed storage. Campfire stays the only placeable; workbenches and
  stashes belong to a future doc, but the `station` field on recipes is built for them.
- New weapons. The bow/arrows idea composes with `RangedConfig` but is out of scope here.

## Current state

Verified against source in this worktree:

- **Items are pure data.** `ItemType` is a 14-member string union, `ItemDef` carries
  `kind/stack/color/power` plus optional `ranged: RangedConfig`
  (`src/shared/items.ts:1-54`). Combat never branches on weapon identity
  (`src/server/systems/combat.ts:169-183` picks melee vs ranged from the equipped def).
- **The one behavior hack:** `raw_venison` is special-cased by type inside `useItem` —
  near a campfire it converts to `cooked_venison`, otherwise eaten with an HP penalty
  (`src/server/systems/players.ts:344-358`, penalty constant `items.ts:100`). This is the
  template (and the refactor target) for cook/boil conversions.
- **Loot is floor-spawn only.** `LootSpawn` points are generated inside buildings by the
  frozen `lRng` stream (`seed ^ 0x100c`, `src/shared/world.ts:494-509`); tier mapping is
  `military → "military"`, `town → "coastal"`, `wild → "inland"` (`world.ts:499`) — note
  every town is "coastal" tier regardless of location; "inland" means the lone cabins.
  Server stocks/respawns them from `LOOT_TABLES` (`src/server/systems/loot.ts:49-104`).
  There are no containers, no per-building-kind tables.
- **Safe worldgen extension precedent:** per-building windows use a hash-salted stream
  `createRng(hashString(`win|${seed}|${id}`))` (`world.ts:224-248`) so new generation
  never shifts existing streams. Containers will copy this exactly.
- **Trees have no ids.** `Tree = {x, z, groundY, r, height, kind}` (`world.ts:44-51`),
  generated by the frozen `tRng` stream (`world.ts:511-530`), inserted into the statics
  grid as collision. The deterministic array order is the only stable handle.
- **Deer drop venison directly** — `killDeer` spawns a `raw_venison` loot entity where the
  deer fell; there is no deer corpse (`src/server/systems/wildlife.ts:92-109`).
  `Corpse.kind` is `"player" | "zombie"` (`src/server/systems/state.ts:120-131`,
  `src/shared/protocol.ts:100-111`).
- **Temperature is modeled, insulation is not.** `tickSurvival` pulls `v.temp` down at
  `TEMP_FALL_PER_S` (plus `RAIN_TEMP_FALL_PER_S` when rain-exposed) with no per-player
  modifier hook (`src/server/systems/survival.ts:140-151`). Shelter = building footprint
  or campfire. So insulation is **scoped in** here as a worn-item multiplier.
- **Flashlight exists and renders.** `ITEM_DEFS.flashlight` (`items.ts:92`) drives a
  pooled spotlight on remote players holding it (`src/client/render/entities/RemotePlayers.tsx:220-240`)
  and has a held-model anchor (`CharacterRig.ts:145`). A torch can reuse this path keyed
  on item type.
- **Inventory = flat 8 slots, hotbar IS the inventory.** `INVENTORY_SLOTS = 8`
  (`src/shared/constants.ts:114`), `(ItemStack | null)[]` on `ServerPlayer`
  (`state.ts:36`), helpers `addToInventory`/`consumeFromSlot` are array-length-agnostic
  (`players.ts:274-304`). Full-inventory `inv` message after every mutation.
- **Interaction is one id space + one prompt.** `pickup` resolves loot → corpse → airdrop
  by shared entity id (`players.ts:408-457`); the client computes a single nearest-target
  prompt (`src/client/net/NetSystem.tsx:111-144`, `clientWorld.promptLootId` in
  `runtime.ts:160`) and E sends `doPickup` (`InputController.tsx:98`).
- **Wire protocol** is a `t`-discriminated JSON union with no version field
  (`protocol.ts:44-57, 193-232`); `parseClientMsg` is the trust boundary
  (`protocol.ts:245-315`). Doc 03 owns introducing `PROTOCOL_VERSION` in
  `src/shared/protocol.ts`; this doc's wire changes are all additive and assume it.
- **Persistence:** world entities are `(kind, JSON)` rows in `world_state`, rewritten
  wholesale through `persistAll`'s single transaction (`src/server/GameRoom.ts:598-606`,
  `persistence.ts:128-156`); `loadWorld`'s switch **silently** skips unknown kinds — it
  has no `default` case, and the only `console.error` is the corrupt-JSON catch
  (`persistence.ts:188-224`) — rollback-safe for additive kinds, just not observable.
  Two cost facts that shape §3: the wipe-and-reinsert means every persisted row is billed
  as a delete **plus** an insert (Cloudflare counts deletes as rows written —
  research/cf-costs.md §1), and the baseline is already ~411 rows written per 20s save
  (cf-costs §2). `CharacterState` is JSON (`persistence.ts:37-47`); additive optional
  fields need no `SCHEMA_VERSION` bump. `SCHEMA_VERSION = 2` (`persistence.ts:34`).
- **Tab panel UI:** `InventoryPanel` in `src/client/ui/HUD.tsx:204-272` renders slot rows
  with USE/DROP buttons from the zustand store (`src/client/state/store.ts`); icons fall
  back to `def.color` swatches automatically (`HUD.tsx:119-124`), so new items work
  without art.

## Design

### 1. Catalog expansion (data only)

`ItemDef` gains four optional behavior configs, mirroring `ranged`:

```ts
// src/shared/items.ts
export interface WaterConfig {
  /** Using next to water (see §4.4) converts to this type. */
  fillsTo?: ItemType;
  /** Using within FIRE_WARMTH_RADIUS of a campfire converts to this type. */
  boilsTo?: ItemType;
  /** Drinking: restore water, optionally cost hp, become emptiesTo. */
  drink?: { restore: number; hpPenalty?: number; emptiesTo: ItemType };
}

export interface WearConfig {
  slot: "body" | "back";
  /** Fraction of temperature fall negated while worn (0..1). */
  insulation?: number;
  /** Extra inventory slots granted while worn. */
  extraSlots?: number;
}

export interface LightConfig {
  /** Spotlight tint + reach for the client light pool. */
  color: string;
  intensity: number;
  range: number;
}

export interface ItemDef {
  // ...existing fields...
  ranged?: RangedConfig;
  /** Using within FIRE_WARMTH_RADIUS of a campfire converts to this type
   *  (generalizes the raw_venison branch in players.ts:344-358). */
  cooksTo?: ItemType;
  /** HP cost of consuming this raw (replaces RAW_VENISON_HP_PENALTY). */
  rawPenaltyHp?: number;
  water?: WaterConfig;
  wear?: WearConfig;
  light?: LightConfig;
}
```

`ItemKind` gains two members: `"material"` (inert, craft input only) and `"wear"`.
`useItem`'s switch ignores `material`; `wear` routes to the wear flow (§5).

**Full proposed catalog.** Existing 14 items unchanged (except `raw_venison` migrating to
`cooksTo`/`rawPenaltyHp` data); 16 new items below brings the total to 30:

| id | name | kind | stack | spawns | purpose |
|---|---|---|---|---|---|
| `wood` | Wood Branches | material | 8 | tree gathering (axe), toolbox containers | campfire kit, torch, knife handle, fishing rod |
| `cloth` | Cloth Scraps | material | 8 | wardrobes, zombie corpses | bandage, rope, torch, jacket, backpack |
| `scrap` | Scrap Metal | material | 8 | toolboxes, lockers, military floor loot | knife, fishing hook |
| `rope` | Rope | material | 4 | toolboxes, barns; craft from cloth ×3 | fishing rod, jacket, backpack |
| `deer_pelt` | Deer Pelt | material | 4 | knife-harvest of deer corpses | jacket |
| `knife` | Hunting Knife | melee | 1 | toolboxes, lockers; craftable | power 20 melee; **gates** deer harvest + is the `tool` for sewn recipes |
| `fishing_rod` | Fishing Rod | tool | 1 | craft only | use near water → chance of `raw_fish` (§4.3) |
| `raw_fish` | Raw Fish | food | 4 | fishing | power 12, `rawPenaltyHp: 5`, `cooksTo: "cooked_fish"` |
| `cooked_fish` | Cooked Fish | food | 4 | cooking | power 50 |
| `canteen_empty` | Canteen (empty) | tool | 1 | wardrobes, lockers | `water.fillsTo: "canteen_dirty"` |
| `canteen_dirty` | Canteen (murky) | drink | 1 | filling at open water | `water.boilsTo: "canteen_clean"`, `water.drink: {restore: 25, hpPenalty: 10, emptiesTo: "canteen_empty"}` |
| `canteen_clean` | Canteen (clean) | drink | 1 | boiling; doc 07 fresh sources fill straight to this | `water.drink: {restore: 70, emptiesTo: "canteen_empty"}` |
| `torch` | Torch | tool | 1 | craft only | held light (`light` config, dimmer/warmer than flashlight), no durability — flashlight has no battery either |
| `first_aid_kit` | First Aid Kit | heal | 2 | lockers, airdrops | power 60 — the medical tier above bandage |
| `padded_jacket` | Padded Jacket | wear | 1 | craft; rare wardrobe find | `wear: {slot: "body", insulation: 0.65}` |
| `backpack` | Canvas Backpack | wear | 1 | craft; rare wardrobe/locker find | `wear: {slot: "back", extraSlots: 4}` |

Medical tiers stop there deliberately: bandage (25, now craftable) and first aid kit (60,
risk-gated). Painkillers/splints imply status effects that do not exist — not invented here.

Loot table rebalance is data-only: `cloth`/`scrap` enter `ZOMBIE_LOOT_TABLE` and the floor
`LOOT_TABLES` at low weights; `first_aid_kit` enters `LOOT_TABLES.military` and
`AIRDROP_TABLE`; `canteen_empty` enters coastal/inland. Exact weights are a balancing PR,
not an architecture decision — milestone 7.

Icons: ship without art; the existing `onError` color-swatch fallback (`HUD.tsx:119-124`)
covers every new item. `/public/icons/*.png` can trail.

### 2. Crafting

```ts
// src/shared/items.ts
export type CraftStation = "campfire"; // future: "workbench" | ...

export interface CraftRecipe {
  /** Stable wire id — RECIPES array index. Append-only; never reorder. */
  name: string;
  inputs: ReadonlyArray<{ type: ItemType; count: number }>;
  output: { type: ItemType; count: number };
  /** Must be present anywhere in the inventory; NOT consumed. */
  tool?: ItemType;
  /** Player must be within the station's radius (campfire = FIRE_WARMTH_RADIUS). */
  station?: CraftStation;
}

export const RECIPES: readonly CraftRecipe[] = [ /* table below */ ];
```

| # | output | inputs | tool | station |
|---|---|---|---|---|
| 0 | bandage ×2 | cloth ×2 | — | — |
| 1 | rope ×1 | cloth ×3 | — | — |
| 2 | torch ×1 | wood ×1, cloth ×1 | — | campfire |
| 3 | campfire_kit ×1 | wood ×3, cloth ×1 | — | — |
| 4 | knife ×1 | scrap ×2, wood ×1 | — | — |
| 5 | fishing_rod ×1 | wood ×2, rope ×1, scrap ×1 | knife | — |
| 6 | padded_jacket ×1 | cloth ×4, deer_pelt ×2, rope ×1 | knife | — |
| 7 | backpack ×1 | cloth ×6, rope ×2 | knife | — |

Cooking is **not** a recipe — raw→cooked and dirty→clean conversions stay on the
use-near-fire path (`cooksTo`/`water.boilsTo`), which already has UX (use the item, get a
notice). Recipes are for combining.

**Craft flow** (server, new `craftItem` in `src/server/systems/players.ts`):

1. Client: Tab panel CRAFT button → `sendMsg({t: "craft", recipe: i})`.
2. `parseClientMsg` shape-checks `recipe` as a finite number (`| 0`).
3. `GameRoom.webSocketMessage` case `"craft"` → `craftItem(game, player, msg.recipe)`.
4. Server validates, early-return on each failure: alive; `0 <= recipe < RECIPES.length`;
   `countOf(inv, input.type) >= input.count` for every input (new helper that sums across
   stacks, sibling of `addToInventory`); `tool` present in any slot; `station ===
   "campfire"` → reuse the `nearFire` check already duplicated in `players.ts:308-314`.
5. Consume inputs via new `removeFromInventory(inv, type, count)` (drains stacks
   back-to-front so the hotbar's low slots keep their tools); add output via
   `addToInventory`; overflow → `dropAtFeet` (`players.ts:317-330` precedent).
6. `sendInventory` + `sendTo(... {t:"notice", msg: "crafted Rope"})`.

Client-side availability (greyed rows, "needs campfire" hint) is computed from the store's
inventory plus `clientWorld.fires` — purely cosmetic; the server is the authority.

Recipes are baked into both bundles, so client UI and server validation always agree at a
given deploy. If a future `ServerConfig` (doc 04 vocabulary — doc 04 owns the
`ServerConfig`/`PRESETS` design in `src/shared/config.ts`; doc 03 only stubs the file)
wants per-server recipe toggles, that config must ride the `welcome` message like the seed
does — flagged for doc 04, not built here.

### 3. Scavenging depth — searchable containers

**Generation (deterministic, shared).** New world feature in `createWorld`, placed AFTER
all existing streams, using a per-building hash stream — the windows precedent
(`world.ts:224-248`):

```ts
// src/shared/world.ts
export type ContainerKind = "wardrobe" | "cabinet" | "toolbox" | "locker";

export interface WorldContainer {
  id: number;          // sequential as generated — its own id space, like LootSpawn.id
  kind: ContainerKind;
  buildingId: number;
  x: number; y: number; z: number;
  yaw: number;         // faces away from its wall
}
// per building: createRng(hashString(`cont|${seed}|${building.id}`))
```

Placement rules: per building, roll 1–2 containers (2–3 for barn/hangar/barracks); each
picks a wall side ≠ `doorSide`, a position flush against the inner wall face, offset
re-rolled (max 4 attempts) if within 1.0m of a window center on that side; skip on
exhaustion. Kind by building: `house → wardrobe|cabinet`, `shed|barn → toolbox`,
`barracks|hangar → locker`. **No collision AABB** — containers are render-only + a prompt,
so the statics grid, movement prediction, and persisted character positions are untouched
(see Open questions for the solid-container alternative). `World` gains
`containers: WorldContainer[]`; the client renders them instanced like `BuildingTrim.tsx`.

~36 buildings → roughly 50–80 containers island-wide.

**Per-kind tables** (server-only data, `src/shared/items.ts` next to `LOOT_TABLES`,
reusing `LootTableEntry`):

```ts
export const CONTAINER_TABLES: Record<ContainerKind, LootTableEntry[]> = {
  wardrobe: /* cloth-heavy: cloth, bandage, canteen_empty, rare padded_jacket/backpack */,
  cabinet:  /* pantry: beans, water_bottle, raw-fish-adjacent, matches-flavored cloth */,
  toolbox:  /* materials: scrap, rope, wood, knife, axe, ammo_9mm */,
  locker:   /* military: ammo_762, shells, first_aid_kit, scrap, rare backpack */,
};
```

Zone tier is implicit in placement (lockers only exist in military buildings), so no
tier × kind matrix is needed.

**Server state + search flow.** `GameState` gains
`containerState: Map<number, { respawnT: number }>` — an entry exists **only while a
container is searched-out**; absence = stocked. New `src/server/systems/containers.ts`:

1. Client: nearest stocked container within `SEARCH_RANGE` (2.6, = `PICKUP_RANGE`) drives
   the prompt `[E] Search wardrobe` → `sendMsg({t: "search", id})`.
2. Server validates: alive; id indexes `world.containers`; 2D distance ≤ `SEARCH_RANGE`;
   no `containerState` entry (else ignore).
3. Roll `CONTAINER_ROLLS_MIN..MAX` (1..3) stacks from `CONTAINER_TABLES[kind]` via the
   existing `rollFromTable` (`loot.ts:27-42`); spawn each as a normal loot entity
   (`state.nextEntityId++`, `spawnId: null`, `ttl: CONTAINER_SPILL_TTL_S`) scattered
   ±0.5m at the container's base. The TTL is its own constant (proposed 150s), deliberately
   much shorter than `DROPPED_LOOT_TTL_S` (600s): searching is a take-it-now interaction,
   and every unlooted spilled stack is a persisted loot row billing 2 rows written per
   save while it lies there (see Implications for the math). **Reuses pickup, wire loot,
   rendering, and the single entity id space wholesale** — the `search` message lives in
   the container id space, but nothing pickup-able ever does.
4. Set `containerState.set(id, { respawnT: rand(CONTAINER_RESPAWN_MIN_S, MAX_S) })`
   (proposed 420–720s — slower than floor loot, containers are denser).
5. `tickContainers(state, dt)` counts respawnT down and deletes the entry (container
   restocks silently); runs in the tick loop next to `tickLootRespawns`
   (`GameRoom.ts:685`).

**Wire representation.** Snapshot gains one additive field:
`conts: number[]` — ids of **searched-out** containers within `LOOT_INTEREST_RADIUS`
(positions are worldgen; only the flag syncs). 10–20 small ints typical; negligible. The
client suppresses the prompt for listed ids and may render doors ajar (cosmetic).

**Persistence.** The searched-out set persists as **one meta row**, not per-container
`world_state` rows. Inside `saveWorld`'s existing transaction, next to the other meta
writes (`persistence.ts:155-163`):
`setMeta("containers_searched", JSON.stringify([...game.containerState].map(([id, s]) => [id, s.respawnT])))`.
`loadWorld` parses it back into the Map; a missing or corrupt key restores an empty Map,
the same tolerant shape as the weather meta restores (`persistence.ts:234-240`). Cost:
exactly **1 row written per save** no matter how many containers are searched-out. A
per-container `world_state` kind was considered and rejected: the wholesale
`DELETE FROM world_state` + reinsert bills every stored row as a delete **plus** an
insert (cf-costs §1), so ~80 flag rows would have billed ~160 rows per save — on top of
the spilled-loot rows counted in Implications. The meta row is also cleaner on rollback:
old code reads meta by explicit key (`persistence.ts:60-65`) and simply never sees the
new one.

### 4. Harvesting

#### 4.1 Trees: gather nodes, not felling (decision)

Felling is rejected: trees are collision in the shared statics grid on both sides
(`world.ts:776-793`), so removal would need wire-synced world mutation, client grid
surgery, prediction agreement, and permanent persistence — engine surgery for a mechanic
(deforestation) the 800m island doesn't want anyway. Instead:

- Tree identity = **index in `world.trees`** (deterministic, identical both sides — the
  array is built by the frozen `tRng` stream in fixed order).
- With an **axe equipped** (selected slot), the nearest tree trunk within `GATHER_RANGE`
  (3.0) prompts `[E] Gather branches` → `{t: "gather", k: "tree", id: index}`.
- Server validates: alive; axe equipped; index in `[0, world.trees.length)`; distance to
  trunk ≤ `GATHER_RANGE`; tree not on cooldown. Grants `WOOD_PER_GATHER_MIN..MAX` (2..3)
  wood (overflow → `dropAtFeet`), sets `treeGatherT: Map<number, number>` cooldown
  `TREE_GATHER_COOLDOWN_S` (180).
- Cooldowns are **transient** (not persisted) — a room restart refreshes branches, the
  same precedent as zombies/deer never persisting. Map entries are removed as they expire
  in a `tickTreeGathers` sweep.
- No tree visual change, no wire state. The axe swing stays a pure weapon; gathering is
  the E-interact path so `combat.ts` is untouched.

#### 4.2 Deer harvesting with a knife

`killDeer` (`wildlife.ts:92-109`) changes: instead of dropping venison loot directly, it
spawns a **corpse** with `kind: "deer"`, empty `contents`, ttl `DEER_CORPSE_TTL_S`, plus a
new server-side field `harvested: boolean` on `Corpse`. Flow:

1. Unharvested deer corpse within `PICKUP_RANGE` prompts `[E] Harvest deer` (knife
   equipped) or `[E] Tear meat` (anything else).
2. `{t: "gather", k: "corpse", id}` (entity id space). Server validates alive + distance +
   corpse is `kind === "deer" && !harvested`.
3. Knife equipped → contents become `raw_venison ×(VENISON_PER_DEER_MIN..MAX)` +
   `deer_pelt ×(1..2)`; otherwise → `raw_venison ×1` (bare hands ruin the pelt, early-game
   food still works). Set `harvested = true`; from here it is a normal scavengeable corpse
   (`pickup` path unchanged).
4. `WireCorpse` gains additive optional `hv?: 1` (harvestable) so the client can
   distinguish "unharvested" from "picked clean" (`items === 0` is ambiguous);
   `WireCorpse.kind` union gains `"deer"`. `Corpses.tsx` needs a deer death pose —
   cosmetic, the zombie pose is an acceptable placeholder.

Persistence: `Corpse` rows already serialize whole structs to JSON
(`persistence.ts:134-140`); `kind: "deer"` and `harvested` ride along additively.

#### 4.3 Fishing

> **Superseded by doc 07 M12 once fresh water lands.** The mechanic below is the
> *interim* version, written before `world.waterAt` existed: it detects water by
> sampling `heightAt` 2.5m ahead and rolls instantly on a cooldown. Doc 07 §6/M12
> replaces it with a timed cast (`fishingUntil`, cancel-on-move, splash event, depth
> ≥ 0.8 via `waterAt`) and removes `FISH_CHANCE`/`FISHING_COOLDOWN_S` and the
> heightAt-ahead test. The ITEMS (`fishing_rod`, `raw_fish`, `cooked_fish`) are this
> doc's and survive unchanged — only the cast mechanic is replaced. If doc 07 M12 ships
> first, skip this subsection entirely.

`useItem` case for `fishing_rod`: require water ahead — `world.heightAt` sampled 2.5m
along the player's yaw `< WATER_LEVEL`; require `player.fishCooldownT <= 0` (new transient
`ServerPlayer` field). Roll `FISH_CHANCE` (0.45): success grants `raw_fish ×1` + notice
"you caught a fish", failure notices "nothing biting". Either way set `fishCooldownT =
FISHING_COOLDOWN_S` (8). AFK farming is bounded by the cooldown, the click-per-cast, and
fish being a mid-tier food. No casting animation needed for v1; the swing anim flag
(`attackAnimT`) is reused for feedback.

#### 4.4 Water (canteen)

All three canteen states are driven by `WaterConfig` in `useItem` order:
near-campfire + `water.boilsTo` → boil; water-ahead (same test as fishing) +
`water.fillsTo` → fill; `water.drink` → drink (restore/penalty/empties). Ocean water fills
**dirty** — drinkable in desperation (raw-venison-style penalty), or boiled clean at a
fire. When doc 07's fresh-water sources land, they fill straight to `canteen_clean`; the
data model already supports it (fresh sources just call the conversion with a different
target). This keeps doc 05 self-contained with no hard dependency on doc 07.

### 5. Wearables — insulation and capacity

`ServerPlayer` gains `worn: { body: ItemStack | null; back: ItemStack | null }`
(persisted as an additive optional `CharacterState.worn` field; missing on old saves →
both null).

- `{t: "wear", slot}`: if the inventory slot holds a `kind === "wear"` item, swap it with
  the current occupant of its `wear.slot` (occupant returns to that inventory slot).
- `{t: "unwear", ws: "body" | "back"}`: move the worn item back into the inventory
  (`addToInventory`; **rejected with a notice if nothing fits** — never silently drop).
  Unwearing a backpack additionally requires the extra slots be empty (notice: "empty
  your pack first") — simpler and loss-proof vs. spilling items.
- **Insulation:** in `tickSurvival`, every computed temperature fall is multiplied by
  `1 - (worn.body?.wear.insulation ?? 0)` — one line each at `survival.ts:144-150`. A
  0.65 jacket turns a freezing night into a slow chill and meaningfully extends rain
  exposure. Warm-up rates are unchanged.
- **Capacity:** effective inventory length = `INVENTORY_SLOTS +
  (worn.back?.wear.extraSlots ?? 0)`. On wear, the inventory array is extended with
  nulls. On unwear the order matters: **truncate first, then add.** Verify pack slots
  8–11 are empty, truncate the array to 8, then `addToInventory` the backpack into the
  now-8-slot array; if it does not fit, re-extend to 12 and reject with the notice. The
  naive order (add, then truncate) destroys the backpack: `addToInventory` fills the
  *first* empty slot (`players.ts:289-294`), so with hotbar slots full and pack slots
  empty — which passes the precondition — the unworn backpack lands in slot 8 and the
  truncation deletes it.
  Slot-bounds checks split deliberately: `useItem` and `dropSlot` (`players.ts:335, 462`)
  switch from `INVENTORY_SLOTS` to `player.inventory.length` so pack slots work from the
  Tab panel, but **`equipSlot` keeps the `INVENTORY_SLOTS` bound** (`players.ts:395`) —
  selection is the server-side authority for the held weapon (`combat.ts:176`), and a
  modified client must not be able to wield from pack slots. `addToInventory` and
  persistence are already length-agnostic (`players.ts:274-296`, JSON arrays). The hotbar
  renders slots 0–7 only; slots 8–11 appear in the Tab panel under a PACK divider,
  reachable by USE/DROP buttons (no hotkeys, and the `equipSlot` bound enforces that
  server-side — they're storage, which preserves hotbar tension).
- Wire: `inv` message gains additive optional `worn` field mirroring the struct; the `inv`
  `slots` array length becomes 8 or 12 (the client store already takes the array as-is,
  `store.ts:102`; `HUD.tsx` switches its inventory-panel `INVENTORY_SLOTS` loops to
  `inventory.length` — the hotbar loop stays at 8, matching the server's `equipSlot` bound).
  Optional cosmetic follow-up: `WirePlayer` gains `wb?: ItemType` so remote players render
  the jacket color — deferred to the polish milestone.

This is the one milestone that edits the inventory model's bounds assumptions — flagged
as such (M6), with the smallest possible blast radius.

### 6. Protocol additions (complete list)

```ts
// ClientMsg additions — all new cases in parseClientMsg with the usual
// isFiniteNum/`| 0` discipline; range/identity checks live in the systems.
| { t: "craft"; recipe: number }
| { t: "search"; id: number }                       // WorldContainer id space
| { t: "gather"; k: "tree" | "corpse"; id: number } // tree index | entity id
| { t: "wear"; slot: number }
| { t: "unwear"; ws: "body" | "back" }

// ServerMsg changes — all additive:
// snap:    conts: number[]            (searched containers within LOOT_INTEREST_RADIUS)
// inv:     worn?: { body: ItemStack | null; back: ItemStack | null }
// WireCorpse: kind gains "deer"; hv?: 1
```

The `gather` union tag exists precisely because trees and corpses live in different id
spaces — one message, no ambiguity, no second pickup-able id space (the landmine in
research/codebase-sim.md §10 stays respected).

**Versioning.** Doc 03's bump rule covers any change "to `ItemType` wire enums", not just
message shapes — so **M1 bumps `PROTOCOL_VERSION`** for its 16 new ItemTypes despite
adding no messages (an old client crashes on `ITEM_DEFS[type]` for a type it has never
heard of — `HUD.tsx:117`, `NetSystem.tsx:121`), and M2/M4/M5/M6 bump for the additions
above.

**New keybind (ships in M1): F = use the selected hotbar item.** `InputController.tsx`
gains an edge-triggered `case "KeyF"` next to the existing `KeyE`/`KeyG` cases
(`InputController.tsx:96-103`, same gating: chat-open returns earlier, `e.repeat` is
already filtered) calling `doUse(ui.selectedSlot)` — the same existing `use` message the
Tab panel's USE button sends; zero wire change. This is load-bearing, not polish: today
no client path can "use" a `kind: "tool"` item at all — `HUD.tsx`'s `USABLE_KINDS` is
`{food, drink, heal, placeable}` (`HUD.tsx:23-28`) and no key sends `use` — so without it
the canteen and fishing-rod flows in §4.3/§4.4 are unreachable. M1 also adds `"tool"` to
`USABLE_KINDS` (M6 later adds `"wear"`) so the Tab panel's USE button stays at parity
with F.

Client interaction refactor: `clientWorld.promptLootId: number | null` becomes
`promptTarget: { act: "pickup" | "search" | "gather-tree" | "gather-corpse"; id: number } | null`;
`updatePrompt` (`NetSystem.tsx:111-144`) gains container/tree/deer-corpse scans (world
containers and trees are static arrays — scan with the same `dist2D` pattern; trees only
when an axe is equipped); the E handler (`InputController.tsx:98`) dispatches on `act`.
The rename touches the binding contract: `promptLootId` lives in `runtime.ts`
(`runtime.ts:160`), which ARCHITECTURE.md lists under "read, do not modify", and the
symbol is named in both its NET and InputController contract sections (ARCHITECTURE.md:59,
:83). M4 is the sanctioned exception: it amends those ARCHITECTURE.md lines (and the
`ClientWorldState` field) in the same PR as the code — a contract/code mismatch here
would strand the next implementing session.

New constants in `src/shared/constants.ts` (house rule — no system-local tunables):
`SEARCH_RANGE`, `GATHER_RANGE`, `CONTAINER_ROLLS_MIN/MAX`,
`CONTAINER_RESPAWN_MIN_S/MAX_S`, `CONTAINER_SPILL_TTL_S`, `TREE_GATHER_COOLDOWN_S`,
`WOOD_PER_GATHER_MIN/MAX`, `FISHING_COOLDOWN_S`, `FISH_CHANCE`, `DEER_PELT_MIN/MAX`. Per-item numbers (insulation,
drink restore, recipe costs) live in `ITEM_DEFS`/`RECIPES` — the weapons-as-data precedent.

### 7. UI outline (Tab panel)

```
INVENTORY                      ← existing rows 1–8 (HUD.tsx:204-272)
  [1] Fire Axe        melee   USE DROP
  ...
PACK (only when backpack worn)
  [·] Cloth Scraps ×6          USE DROP
EQUIPMENT
  body: Padded Jacket          REMOVE        ← wear/unwear buttons; WEAR appears
  back: —                                       on inventory rows of kind "wear"
CRAFTING
  Bandage ×2     2× Cloth Scraps              [CRAFT]
  Torch          1× Wood, 1× Cloth  needs campfire   [CRAFT, disabled + hint]
  ...all 8 recipes, greyed when inputs/tool/station unmet
```

Prompt strings: `Search wardrobe` / `Gather branches` / `Harvest deer` / `Tear meat` join
the existing pickup prompts; same `[E]` affordance (`HUD.tsx:139-147`).

## Implications

**Opens up**

- A real 10–120 minute arc: coastal scavenging → knife/rope → deer hunting → jacket +
  backpack → confident night/rain traversal → military runs for first aid kits.
- `station` on recipes is the hook for workbenches/base-building later; `WearConfig` is
  the hook for armor; `CONTAINER_TABLES` is the hook for per-server loot economies via a
  future `ServerConfig`.
- Doc 07 fresh water plugs into `WaterConfig.fillsTo` with zero rework.
- Containers + per-kind tables make building interiors destinations, which the window/trim
  work (commits 8e90991, 05cc4c1) already made readable.

**Complicates**

- `useItem` grows from 4 branches to ~8 (cook, boil, fill, drink, fishing, wear) — still
  one function, but it is now the kitchen sink; if it passes ~120 lines, split into
  `useConsumable`/`useTool` siblings in `players.ts`.
- The single prompt becomes a 5-way scan over loot/corpses/drops/containers/trees — still
  O(nearby), but `updatePrompt` needs care to keep priorities sane (pickup beats search
  beats gather at equal distance).
- Container search adds persisted rows two ways; both are bounded by design, but the
  arithmetic matters because the wipe-and-reinsert bills every stored `world_state` row
  as a delete **plus** an insert (cf-costs §1), on a ~411-rows-per-save baseline that is
  already the free-plan killer (cf-costs §2–3). (a) The searched-flag set costs a flat
  **1 meta row per save** (§3) — the per-container row design was rejected precisely
  because ~80 flag rows would have billed ~160 rows/save. (b) Each spilled-but-unlooted
  stack is an ordinary persisted loot row: 2 billed rows per save, for up to
  `CONTAINER_SPILL_TTL_S` ≈ 7 consecutive saves. Worst plausible abuse — one player
  sweeps all ~80 containers across a respawn cycle and loots nothing (~80 E-presses,
  trivially inside the 600-msgs/5s rate limit, `GameRoom.ts:117-119`) — keeps roughly
  60 spill stacks alive at any instant (240 stacks × 150/600s), ≈ **+120 rows/save
  transiently**. Under the per-container-row + 600s-TTL design that same sweep would
  have been ~+640 rows/save — enough for one bored player to roughly halve a free-plan
  server's daily save budget — which is why both knobs are specced the way they are.
  M4's accept criteria include measuring rows-written-per-save after a full sweep to
  keep this honest.
- The structural fix remains cf-costs §6 lever 1 (single-JSON-row world snapshot, ~30
  lines, ~50× fewer rows written). **No plan doc owns it today** — doc 01 M6 only gates
  free-plan marketing copy on it, doc 07 treats it as external. This doc takes the
  dependency explicitly: ship lever 1 as its own small PR, and do not ship M4 to
  community-host builds before it lands (gate restated in M4).
- Balance surface triples (3 floor tables + 4 container tables + zombie + airdrop). M7
  exists for this; expect iteration.

**Breaks**

- Nothing in existing saves or worlds: no existing rng stream is touched, no ItemType is
  renamed/removed, all persistence changes are additive JSON fields or meta keys, and
  `loadWorld`/`getMeta` skip-unknown semantics make rollback safe.
- Open tabs straddling the deploy will throw on unknown snapshot fields? No — extra JSON
  fields are ignored by the old client; but an old client **will** crash rendering a new
  ItemType (`ITEM_DEFS[stack.type]` lookup returns undefined in `HUD.tsx`/`NetSystem.tsx`).
  Mitigation: **M1 itself bumps `PROTOCOL_VERSION`** (new ItemTypes are wire vocabulary
  per doc 03's bump rule), so mismatched joins are refused from the first wire-touching
  deploy onward; the `ITEM_DEFS[type] ?? UNKNOWN_DEF` client guard also ships in M1, but
  it only hardens post-M1 clients — the version gate is what covers pre-M1 tabs, and only
  once doc 03's gate has landed (see Migration).

**Threatens**

- Container loot could obsolete floor loot (same buildings, denser rewards) — mitigated by
  slower respawns and material-heavy tables, but if scavenging collapses into
  container-only routes, floor tables need re-weighting (M7).
- Knife-gating pelts makes the jacket chain ~4 steps deep; if playtests show players never
  reach it inside 120 minutes, move `knife` weight up in toolbox tables before touching
  recipe costs.
- The backpack milestone (M6) is the only one that can regress core inventory invariants
  (slot bounds, persistence array lengths). It is deliberately last-but-one and isolated.

## Migration & compatibility

- **No `SCHEMA_VERSION` bump.** New ItemTypes are additive; `CharacterState.worn` and
  `Corpse.harvested`/`kind:"deer"` are additive JSON; the searched-container set is a new
  `containers_searched` meta key that older code never reads (meta is fetched by explicit
  key — `persistence.ts:60-65`). Existing characters, inventories, corpses, and the
  leaderboard carry through untouched.
- **No worldgen wipe.** Containers use a new `hashString`-salted stream after all existing
  draws and add no collision — existing worlds regenerate identically and persisted
  positions stay valid. (The solid-container alternative requires `SCHEMA_VERSION = 3`;
  see Open questions.)
- **Wire:** all changes additive. Deploy-atomic for fresh sessions (client + server ship
  in one `wrangler deploy`); stale open tabs are handled by doc 03's `PROTOCOL_VERSION`
  welcome check — milestones M1/M2/M4/M5/M6 each note the bump (M1's is for the ItemType
  enum growth alone, per doc 03's bump rule). If doc 03 has not landed
  first, these features still work but stale tabs degrade as today (landmine #9 in
  research/codebase-sim.md, unchanged in severity).
- **Rollback:** rolling the worker back leaves the `containers_searched` meta key and
  `worn` fields in storage; old code never reads that meta key, and old `loadWorld`
  **silently** skips unknown `world_state` kinds — its switch has no `default` case and
  the only `console.error` is the corrupt-JSON catch (`persistence.ts:190-224`) — so
  additive-kind rollbacks are safe but invisible to an operator. M4 adds a `console.warn`
  default case so every future rollback across an additive kind is observable. Old
  `CharacterState` readers ignore `worn` (field absent from the interface — JSON.parse
  keeps it, restore ignores it). Players holding new ItemTypes on rollback would crash
  old `ITEM_DEFS` lookups server-side (`addToInventory` reads `ITEM_DEFS[type].stack`) —
  rollback across this expansion needs a wipe or a forward-fix; flag in the deploy notes.
- Deployed official instance: ship M1–M5 together or in fast sequence; there is no
  inter-server compatibility concern until the server directory (docs 03/04) exists,
  after which `PROTOCOL_VERSION` carries the burden by design.

## Implementation plan

Order: M1 → M2 → (M3 → M4) → M5 → M6 → M7. M3/M4 can proceed in parallel with M2. Each
milestone ends with `npm run typecheck` clean and a manual two-client smoke test via
`npm run dev` (`apps/game/scripts/loadtest.mjs` for tick-budget regression after M4, which adds the
only new per-tick sweeps).

1. **M1 — Catalog + use behaviors as data** *(Sonnet 4.8)*.
   Files: `src/shared/items.ts`, `src/server/systems/players.ts`,
   `src/shared/constants.ts`, `src/client/net/NetSystem.tsx` (UNKNOWN_DEF guard),
   `src/client/render/entities/InputController.tsx` (F keybind, §6),
   `src/client/ui/HUD.tsx` (`USABLE_KINDS` + `"tool"`), `src/shared/protocol.ts`
   (`PROTOCOL_VERSION` bump).
   Scope: 16 new ItemTypes + defs; `cooksTo`/`rawPenaltyHp`/`water`/`wear`/`light` config
   types; migrate raw_venison to data (delete the type-switch branch and
   `RAW_VENISON_HP_PENALTY`); canteen fill/boil/drink; fishing; F = use selected slot plus
   `"tool"` in `USABLE_KINDS` (§6 — without these, the canteen/fishing acceptance below
   is unreachable from the client); loot-table entries for new items (initial weights).
   NO new protocol messages — but the ItemType wire enum grows and new types become
   spawnable immediately, which is a `PROTOCOL_VERSION` bump per doc 03's rule (old
   clients crash rendering unknown types).
   Accept: cook venison via data path identically to today; F on the selected hotbar slot
   sends `use`; fill→boil→drink canteen cycle works near ocean+fire (via F or the Tab
   USE button); fishing grants raw_fish on cooldown; typecheck clean.
2. **M2 — Crafting core** *(Opus 4.8 — protocol + inventory-mutation validation)*.
   Files: `items.ts` (RECIPES), `protocol.ts` (+`craft`, parse case), `GameRoom.ts`
   (dispatch), `players.ts` (`craftItem`, `countOf`, `removeFromInventory`), `HUD.tsx`
   (CRAFTING section), `connection.ts` (`doCraft`). Depends: M1.
   Accept: each of the 8 recipes crafts with correct consumption incl. multi-stack
   inputs; tool not consumed; campfire-gated recipes fail away from fire with a notice;
   output overflow drops at feet; malformed `craft` payloads are ignored.
3. **M3 — Deterministic containers in worldgen** *(Opus 4.8 — determinism-sensitive)*.
   Files: `src/shared/world.ts` (WorldContainer + generation AFTER existing streams),
   `src/client/render/world/` (instanced container meshes, BuildingTrim pattern).
   Accept: client and server `createWorld(1337)` produce byte-identical
   `containers` arrays (assert via a temporary JSON-dump diff in dev); **zero diff in
   every pre-existing World field** (towns/buildings/lootSpawns/trees serialized before
   vs after the change — this is the milestone's critical test); containers render inside
   buildings, never blocking doorways, no collision.
4. **M4 — Container search loop** *(Opus 4.8 — protocol + persistence)*.
   Files: `protocol.ts` (+`search`, +`conts`), new `src/server/systems/containers.ts`,
   `GameRoom.ts` (dispatch, tick, snapshot field), `state.ts` (containerState),
   `persistence.ts` (`containers_searched` meta write/restore per §3; `console.warn`
   default case in `loadWorld`'s kind switch), `constants.ts` (incl.
   `CONTAINER_SPILL_TTL_S`), `runtime.ts` + `NetSystem.tsx` + `InputController.tsx`
   (promptTarget refactor), `HUD.tsx` prompt strings, `ARCHITECTURE.md` (amend the
   NET/InputController contract lines naming `promptLootId` — see §6; `runtime.ts` is on
   its do-not-modify list, so the contract amendment ships in the same PR as the code).
   Depends: M3. Community-host gate: do not ship M4 to community-host builds before the
   single-row world snapshot fix (cf-costs §6 lever 1) lands as its own PR — see
   Implications.
   Accept: searching spills 1–3 table-correct stacks as pickup-able loot; re-search
   ignored until respawn; searched flags survive a DO restart (kill `wrangler dev`,
   rejoin); searched ids appear only within `LOOT_INTEREST_RADIUS`; loadtest tick EMA
   within budget; measured rows-written-per-save after a full container sweep matches the
   Implications estimate (1 flag meta row + ~2 rows per live spill stack — the loadtest
   harness from commit 914fd65 can drive the sweep).
5. **M5 — Harvesting: trees + deer** *(Sonnet 4.8 — follows M2/M4 message patterns)*.
   Files: `protocol.ts` (+`gather`, WireCorpse `"deer"`/`hv`), `players.ts` or new
   `harvest.ts` (gather handlers), `wildlife.ts` (corpse instead of loot drop),
   `state.ts` (`Corpse.harvested`, `treeGatherT`), `GameRoom.ts`, `constants.ts`,
   client prompt + `Corpses.tsx` deer rendering (placeholder pose OK). Depends: M1; M4's
   promptTarget refactor must be merged first.
   Accept: axe-equipped tree gather grants wood, honors per-tree cooldown, validates
   index+distance; deer death leaves harvestable corpse; knife harvest yields venison+pelts,
   bare-hand yields 1 venison; harvested corpse scavenges normally; deer corpse persists
   across restart with harvested flag intact.
6. **M6 — Wear system: jacket + backpack** *(Opus 4.8 — inventory-model surgery)*.
   Files: `state.ts` (`worn`), `players.ts` (wear/unwear with §5's truncate-then-add
   unwear order; `useItem`/`dropSlot` bounds → `inventory.length`, **`equipSlot` stays at
   `INVENTORY_SLOTS`** — §5, hotbar tension is server-enforced),
   `survival.ts` (insulation multiplier), `protocol.ts` (+`wear`/`unwear`, `inv.worn`),
   `persistence.ts` (`CharacterState.worn`), `GameRoom.ts`, `store.ts`, `HUD.tsx`
   (EQUIPMENT + PACK sections, `"wear"` into `USABLE_KINDS`). Depends: M1.
   Accept: jacket measurably slows night/rain temp fall (log vitals over a game night);
   backpack grows inv to 12 and Tab shows PACK rows; unwear with full inventory / occupied
   pack slots is rejected with notice, never loses items; worn state survives restart;
   death drops worn items into the corpse (extend `spawnPlayerCorpse` to append `worn`);
   old saves without `worn` restore cleanly.
7. **M7 — Balance + polish pass** *(Sonnet 4.8)*.
   Files: `items.ts` tables/weights, `Corpses.tsx` deer pose, torch/flashlight light pool
   keying (`RemotePlayers.tsx`), first-person held light for torch, optional
   `WirePlayer.wb` jacket tint, icons as available. Depends: all.
   Accept: a fresh character can plausibly reach jacket+backpack inside ~90 min; military
   tables still uniquely gate rifles/shotguns/first-aid kits; no table references a
   nonexistent ItemType (add a dev-time assertion iterating all tables/recipes against
   `ITEM_DEFS` — cheap and permanent).

## Open questions

1. **Solid containers?** v1 ships them collision-less to avoid a `SCHEMA_VERSION` wipe
   and any movement-prediction delta. Solid wardrobes feel better but require schema v3
   (characters could be standing in a new AABB) — wipes are cheap at the current player
   count, so this is a taste call. **Recommendation:** ghost containers now; revisit
   alongside the next unavoidable wipe.
2. **Backpack vs. just bumping `INVENTORY_SLOTS` to 10.** The global bump is a 3-line
   change but gives capacity for free and dilutes hotbar tension permanently.
   **Recommendation:** backpack (M6) — capacity as an earned item is the whole gear-up
   fantasy; accept the surgery.
3. **Chop-by-swinging instead of E-interact?** Swinging an axe at a tree is more visceral
   but puts inventory mutation inside `combat.ts`'s miss path. **Recommendation:**
   E-interact for v1; if it feels flat, route melee misses whose cone contains a trunk
   into the same gather handler later (additive).
4. **Torch with no durability** (flashlight precedent — also infinite). Fine forever, or
   does it cheapen the flashlight as loot? **Recommendation:** ship infinite; make the
   torch dim/short-range so the flashlight stays a real find. Durability waits for an
   `ItemStack` state field that something else also needs.
5. **Is fishing in scope?** It's ~40 lines riding entirely on existing patterns and gives
   the coast an identity beyond spawning. **Recommendation:** yes, in M1; cut it first if
   M1 sprawls.
6. **Doc-03 ordering.** M1/M2/M4/M5/M6 each want a `PROTOCOL_VERSION` bump (M1 for the
   ItemType enum growth alone). If this doc lands
   before doc 03's versioning milestone, stale-tab behavior degrades exactly as today.
   **Recommendation:** land doc 03's `PROTOCOL_VERSION` milestone first; it's small and
   every subsequent doc leans on it.
7. **Bare-hand deer harvest yield** (1 venison vs nothing). Nothing makes the knife
   mandatory but bricks early-game protein. **Recommendation:** 1 venison bare-handed,
   pelts knife-only — keep both incentives.
