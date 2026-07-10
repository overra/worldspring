// Tree chopping + falling trees (doc 13 M2) + the planted-tree lifecycle
// (follow-up to #85). Axe swings are the wood faucet (doc 05's gather-node
// design folded into felling): every landed chop grants wood, and the FINAL
// chop topples the tree as a dynamic "trunk" physics body — static collider
// out, trunk spawned with an off-center impulse away from the chopper, settle →
// TTL → despawn dropping bonus wood where it rests.
//
// Two tree identities share this code:
//   • NATURAL trees — fingerprint-coupled entries in world.trees, addressed by
//     INDEX, felled-state persisted in state.felledTrees / felledDelta.
//   • PLANTED trees — player-grown entities in world.plantedTrees, addressed by
//     stable id, mutated live (plant/grow/fell) via state.plantedTreeDelta.
// A mature planted tree chops and fells exactly like a natural one; the only
// difference is identity + how "gone" is recorded (remove from the index vs a
// felled-index bit).
//
// Seeds (pine_cone → conifer, acorn → oak) close the loop: felling has a chance
// to drop the matching seed, a budgeted ambient scan sprinkles seeds near
// active players, and planting a seed grows a new tree through sapling → young
// → mature on a WALL-CLOCK schedule (offline/idle time counts).
//
// The chop TRIGGER deliberately reuses {t:"attack"} (a whiffed melee swing
// with the axe equipped) instead of doc 05's reserved-but-unbuilt {t:"gather"}
// verb: zero new ClientMsg surface, zero client input code, and the swing
// animation/cooldown pacing come for free. Planting rides the existing
// {t:"use"} placeable verb (seeds are ITEM_DEFS kind "placeable"), so it adds
// no ClientMsg surface either.
//
// The kinematic statics (movement.ts queryStatics) intentionally still treat
// felled NATURAL trees as solid trunk cylinders on BOTH client and server — the
// shared deterministic sim is untouched (no prediction desync), and walking
// through stump footprints is doc 05's concern, not M2's. A felled PLANTED tree
// is REMOVED from the shared index, so its footprint stops colliding on both
// ends symmetrically (the client applies the same remove delta).

import {
  DROPPED_LOOT_TTL_S,
  MELEE_HALF_ANGLE_RAD,
  MELEE_RANGE,
  PLANTED_TREE_CAP,
  TREE_CHOPS_TO_FELL,
  TREE_FELL_SEED_CHANCE,
  TREE_PLANT_CLEARANCE,
  TREE_PLANT_DIST,
  TREE_SEED_DROP_INTERVAL_S,
  TREE_SEED_LOOSE_CAP,
  TREE_WOOD_PER_CHOP,
  TRUNK_SETTLE_TTL_S,
  TRUNK_WOOD_BONUS,
} from "@worldspring/shared/constants";
import { clamp, distSq2D, inMeleeCone, yawToDir, type Aabb } from "@worldspring/shared/math";
import {
  toPlantedRecord,
  treeStageAt,
  type PlantedTree,
  type PlantedTreeRecord,
  type TreeSpecies,
} from "@worldspring/shared/trees";
import type { Tree } from "@worldspring/shared/world";
import { meleeBlocked } from "./combat";
import { addToInventory, sendInventory } from "./players";
import { queueEvent, sendTo, type GameState, type ServerPlayer } from "./state";

/** Max vertical separation for a chop (mirrors combat's MELEE_MAX_DY). */
const CHOP_MAX_DY = 2.5;
/** Horizontal speed (m/s) the topple impulse imparts at the trunk TOP —
 * multiplied by the trunk's mass so light and heavy trees tip alike. */
const TOPPLE_SPEED = 2.5;
/** Spawn the trunk base slightly above the analytic ground: the physics
 * heightfield is SAMPLED (≤ half-cell seam vs heightAt, PhysicsSystem.ts), so
 * a flush base could start intersecting it and pop. */
const TRUNK_SPAWN_LIFT = 0.3;
/** How far around an active player the ambient seed scan looks for a mature
 * standing tree to shed a seed from. Player-local, so cost is bounded. */
const AMBIENT_SEED_RADIUS = 22;
/** Wall-clock cadence of the growth scan. Well under the minutes-long stage
 * boundaries, so a transition is applied within a scan of becoming due. */
const GROWTH_SCAN_INTERVAL_MS = 15_000;

/** A resolved chop target — a natural tree (by world.trees index) or a mature
 * planted tree (by stable entity id). `key` is the identity used for the
 * per-tree chop counter map and the fell path. */
type TreeTarget =
  | { identity: "natural"; key: number; tree: Tree }
  | { identity: "planted"; key: number; tree: PlantedTree };

/** A planted tree materializes with the extra lifecycle fields a natural Tree
 * lacks; `stage` is the cheapest reliable discriminator in queryStatics output. */
function isPlanted(tree: Tree): tree is PlantedTree {
  return "stage" in tree;
}

function seedType(species: TreeSpecies): "pine_cone" | "acorn" {
  return species === "conifer" ? "pine_cone" : "acorn";
}

/** Loose (on-the-ground) seed count across the world, for the global budget.
 * Bounded by loot size, not tree count — cheap to call per ambient roll. */
function looseSeedCount(state: GameState): number {
  let n = 0;
  for (const item of state.loot.values()) {
    if (item.type === "pine_cone" || item.type === "acorn") n += item.count;
  }
  return n;
}

/** Closest-point circle-vs-AABB overlap (walls are y-extruded boxes; planting
 * is a flat 2D clearance test, so the y span is ignored). */
function circleOverlapsAabb(a: Aabb, x: number, z: number, r: number): boolean {
  const nx = clamp(x, a.minX, a.maxX);
  const nz = clamp(z, a.minZ, a.maxZ);
  return distSq2D(x, z, nx, nz) < r * r;
}

/** Wood on the ground at (x, z) — the dropAtFeet shape (spawnId null = never
 * respawns, TTL'd like any player-dropped stack). */
function dropWoodAt(state: GameState, x: number, z: number, count: number): void {
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: "wood",
    count,
    x,
    y: state.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
}

/** One matching seed as loose loot at (x, z) — same never-respawn, TTL'd shape
 * as dropped wood. Species maps to the placeable seed item type. */
function dropSeedAt(state: GameState, species: TreeSpecies, x: number, z: number): void {
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: seedType(species),
    count: 1,
    x,
    y: state.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
}

/** Chance-gated matching-seed drop when a tree is felled, respecting the global
 * loose-seed budget (a felled tree over the cap simply drops no seed). */
function maybeDropFellSeed(state: GameState, species: TreeSpecies, x: number, z: number): void {
  if (Math.random() >= TREE_FELL_SEED_CHANCE) return;
  if (looseSeedCount(state) >= TREE_SEED_LOOSE_CAP) return;
  dropSeedAt(state, species, x, z);
}

/**
 * Resolve a whiffed melee swing against the forest: with the axe equipped and
 * a standing choppable trunk in the melee cone, land a chop — grant wood, and
 * on the TREE_CHOPS_TO_FELL-th hit fell the tree. Handles natural AND mature
 * planted trees; young planted trees block movement but are too small to chop,
 * saplings aren't collidable at all (excluded from queryStatics). Returns true
 * when a chop landed.
 *
 * Called from combat's meleeAttack ONLY when no zombie/deer/player was hit,
 * so a target in front of a tree always takes the swing.
 */
export function tryChopTree(state: GameState, player: ServerPlayer): boolean {
  const stack = player.inventory[player.selectedSlot];
  if (!stack || stack.type !== "axe") return false;
  // Dynamic bodies are overworld-only (doc 13 M1's snapshot decision), so
  // felling from the red realm would drop an invisible trunk — don't chop there.
  if (player.realm !== "overworld") return false;

  const { x, z, yaw } = player.core;
  const py = player.core.y;

  // Nearest standing choppable trunk in the cone. queryStatics folds natural
  // trees (by reference into world.trees), planted young/mature trees, and
  // structure/building walls; we recover each tree's identity below.
  const nearby = state.world.queryStatics(x, z, MELEE_RANGE + 2);
  let bestSq = Infinity;
  let best: TreeTarget | null = null;
  for (const tree of nearby.trees) {
    if (Math.abs(tree.groundY - py) > CHOP_MAX_DY) continue;
    // The trunk has girth: extend the reach by its radius so grazing swings land.
    if (!inMeleeCone(x, z, yaw, tree.x, tree.z, MELEE_RANGE + tree.r, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, tree.x, tree.z);
    if (dSq >= bestSq) continue;

    let target: TreeTarget;
    if (isPlanted(tree)) {
      // Only mature planted trees are choppable — young ones are collidable but
      // not yet a wood source (the lifecycle payoff for waiting out growth).
      if (tree.stage !== "mature") continue;
      target = { identity: "planted", key: tree.id, tree };
    } else {
      // queryStatics returns Tree objects by reference, so indexOf recovers the
      // wire/persist identity (index in the seed-derived array) — O(TREE_COUNT),
      // chop-rate only.
      const index = state.world.trees.indexOf(tree);
      if (index === -1 || state.felledTrees.has(index)) continue;
      target = { identity: "natural", key: index, tree };
    }
    // Same wall/roof occlusion ray every living melee target gets — worldgen
    // places trees as close as 2 m outside building walls, so an unchecked
    // cone would harvest (and fell) the forest from indoors.
    if (meleeBlocked(state, x, py, z, tree.x, tree.groundY, tree.z)) continue;
    bestSq = dSq;
    best = target;
  }
  if (best === null) return false;
  const hitTree = best.tree;

  // Impact flash on the trunk at chest height (the melee-hit feedback).
  queueEvent(state, { e: "hit", x: hitTree.x, y: hitTree.groundY + 1.2, z: hitTree.z }, hitTree.x, hitTree.z);

  // Wood per chop; overflow falls at the tree's base.
  const leftover = addToInventory(player.inventory, "wood", TREE_WOOD_PER_CHOP);
  if (leftover > 0) dropWoodAt(state, hitTree.x, hitTree.z, leftover);
  sendInventory(state, player);

  // Per-tree chop counter keyed by identity (natural index vs planted id).
  const chopMap = best.identity === "planted" ? state.plantedTreeChops : state.treeChops;
  const chops = (chopMap.get(best.key) ?? 0) + 1;
  if (chops < TREE_CHOPS_TO_FELL) {
    chopMap.set(best.key, chops);
    return true;
  }

  // Final chop. Physics off (potato preset): the tree stays STANDING and the
  // counter resets — chopping remains the same wood faucet, there is just no
  // fell (doc 13 M2's config rule: no new config; the fell rides physics.enabled).
  chopMap.delete(best.key);
  if (!state.config.physics.enabled) return true;
  if (best.identity === "planted") fellPlantedTree(state, player, best.tree);
  else fellTree(state, player, best.key);
  return true;
}

/** Spawn the dynamic falling-trunk body for a felled tree and topple it AWAY
 * from the chopper. Shared by natural and planted felling — same footprint as
 * the static collider it replaces, base lifted a hair above the sampled
 * heightfield seam. */
function spawnFallingTrunk(
  state: GameState,
  player: ServerPlayer,
  tree: Pick<Tree, "x" | "z" | "groundY" | "r" | "height">,
): void {
  const halfH = tree.height / 2;
  const y = tree.groundY + halfH + TRUNK_SPAWN_LIFT;
  const id = state.physics.spawnBody(state.nextEntityId++, "trunk", tree.x, y, tree.z, [tree.r, halfH, tree.r]);
  if (id === null) return;
  // Topple AWAY from the chopper: horizontal impulse at the trunk TOP (the
  // off-center point is what makes it tip instead of slide). Direction from
  // player→tree; a degenerate overlap falls back to the player's facing.
  let dx = tree.x - player.core.x;
  let dz = tree.z - player.core.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-3) {
    dx /= len;
    dz /= len;
  } else {
    [dx, dz] = yawToDir(player.core.yaw);
  }
  // Rapier's default density is 1: mass = 8·hx·hy·hz. Scaling by mass keeps
  // the tip-over speed uniform across the 6–11 m worldgen height range.
  const mass = 8 * tree.r * halfH * tree.r;
  const impulse = mass * TOPPLE_SPEED;
  state.physics.applyImpulseAtPoint(id, dx * impulse, 0, dz * impulse, tree.x, tree.groundY + tree.height, tree.z);
}

/** Topple natural tree `index`: mark it felled (persisted + wire delta), remove
 * its static physics collider, spawn the dynamic trunk, and roll a matching
 * seed drop. */
function fellTree(state: GameState, player: ServerPlayer, index: number): void {
  const tree = state.world.trees[index];
  state.felledTrees.add(index);
  state.felledDelta.push(index);
  state.physics.fellTree(index);
  spawnFallingTrunk(state, player, tree);
  maybeDropFellSeed(state, tree.kind, tree.x, tree.z);
  sendTo(state, player.id, { t: "notice", msg: "Timber!" });
}

/** Topple a mature planted tree: remove it from the shared index (collision
 * stops on both ends via the remove delta), drop its runtime collider, spawn
 * the same dynamic trunk, and roll a matching seed drop. The felled tree does
 * NOT linger as a felled-index bit — planted identities are removable. */
function fellPlantedTree(state: GameState, player: ServerPlayer, tree: PlantedTree): void {
  state.world.plantedTrees.remove(tree.id);
  state.plantedTreeDelta.push({ op: "remove", id: tree.id });
  state.physics.removePlantedTree(tree.id);
  spawnFallingTrunk(state, player, tree);
  maybeDropFellSeed(state, tree.species, tree.x, tree.z);
  sendTo(state, player.id, { t: "notice", msg: "Timber!" });
}

/**
 * Plant a seed TREE_PLANT_DIST in front of the player, growing a new sapling.
 * Server-authoritative placement, rejecting (with a notice, and WITHOUT
 * consuming the seed — the caller consumes only on a true return) for: wrong
 * realm, out of world bounds, water, the global planted cap, building
 * footprints, and insufficient clearance from any tree or structure. Returns
 * true when a sapling was planted.
 *
 * Invoked from the {t:"use"} placeable path (players.useItem) — seeds are
 * ITEM_DEFS kind "placeable", so this needs no ClientMsg of its own.
 */
export function plantSeed(state: GameState, player: ServerPlayer, species: TreeSpecies): boolean {
  if (player.realm !== "overworld") {
    sendTo(state, player.id, { t: "notice", msg: "You can't plant here" });
    return false;
  }
  const [fx, fz] = yawToDir(player.core.yaw);
  const x = player.core.x + fx * TREE_PLANT_DIST;
  const z = player.core.z + fz * TREE_PLANT_DIST;

  const limit = state.world.size / 2 - 1;
  if (Math.abs(x) > limit || Math.abs(z) > limit) {
    sendTo(state, player.id, { t: "notice", msg: "You can't plant out there" });
    return false;
  }
  if (state.world.waterAt(x, z) !== null) {
    sendTo(state, player.id, { t: "notice", msg: "You can't plant in water" });
    return false;
  }
  if (state.world.plantedTrees.trees.size >= PLANTED_TREE_CAP) {
    sendTo(state, player.id, { t: "notice", msg: "Too many trees have been planted" });
    return false;
  }
  // Building footprints (mirrors canPlace's no-build building test) — keep
  // saplings out of house interiors/roofs.
  for (const b of state.world.buildings) {
    if (Math.abs(x - b.cx) < b.halfW + 1 && Math.abs(z - b.cz) < b.halfD + 1) {
      sendTo(state, player.id, { t: "notice", msg: "Too close to a building" });
      return false;
    }
  }
  // Clearance from any tree (natural or planted young/mature) or wall
  // (structures + building walls). queryStatics folds all of these together.
  const nearby = state.world.queryStatics(x, z, TREE_PLANT_CLEARANCE);
  for (const t of nearby.trees) {
    const rr = TREE_PLANT_CLEARANCE + t.r;
    if (distSq2D(x, z, t.x, t.z) < rr * rr) {
      sendTo(state, player.id, { t: "notice", msg: "Too close to another tree" });
      return false;
    }
  }
  for (const w of nearby.walls) {
    if (circleOverlapsAabb(w, x, z, TREE_PLANT_CLEARANCE)) {
      sendTo(state, player.id, { t: "notice", msg: "Too close to a structure" });
      return false;
    }
  }
  // Sibling SAPLINGS separately: queryStatics deliberately excludes them (r=0,
  // walk-through), so without this a player could stand still and plant a whole
  // seed stack at one spot — all maturing later into overlapping colliders.
  // Linear over the cap-bounded (≤ PLANTED_TREE_CAP) collection, plant-rate only.
  const clearSq = TREE_PLANT_CLEARANCE * TREE_PLANT_CLEARANCE;
  for (const t of state.world.plantedTrees.trees.values()) {
    if (t.stage !== "sapling") continue; // young/mature already covered above
    if (distSq2D(x, z, t.x, t.z) < clearSq) {
      sendTo(state, player.id, { t: "notice", msg: "Too close to another tree" });
      return false;
    }
  }

  const record: PlantedTreeRecord = {
    id: state.nextEntityId++,
    species,
    // uint32 appearance seed — drives per-instance variant/yaw/height/tint on
    // the client; persisted so a tree looks identical across rejoins.
    appearanceSeed: (Math.random() * 0x100000000) >>> 0,
    x,
    z,
    groundY: state.world.groundHeight(x, z),
    plantedAtMs: Date.now(),
    stage: "sapling",
  };
  const tree = state.world.plantedTrees.upsert(record);
  // Sapling geometry is r=0 → addPlantedTree is a no-op until it grows into a
  // young/mature collider (the growth scan re-adds/resizes at each transition).
  state.physics.addPlantedTree(tree.id, tree.x, tree.groundY, tree.z, tree.r, tree.height);
  state.plantedTreeDelta.push({ op: "upsert", tree: record });
  return true;
}

/**
 * Budgeted ambient seed rain: each active overworld player, on a per-player
 * cooldown, sheds ONE matching seed from a random mature standing tree within
 * AMBIENT_SEED_RADIUS — capped globally by TREE_SEED_LOOSE_CAP. Deliberately
 * player-local (never iterates the ~11k-tree forest per tick) and cooldown-
 * gated, so cost scales with players, not trees.
 */
export function tickAmbientSeeds(state: GameState): void {
  // Cheap global short-circuit — skip all per-player work when the ground is
  // already saturated with seeds.
  if (looseSeedCount(state) >= TREE_SEED_LOOSE_CAP) return;
  for (const player of state.players.values()) {
    if (!player.alive || player.realm !== "overworld") continue;
    const due = state.seedDropAt.get(player.id) ?? 0;
    if (state.time < due) continue;
    // Re-arm the cooldown regardless of outcome, jittered ±25% so players who
    // joined together don't all roll on the same tick.
    state.seedDropAt.set(player.id, state.time + TREE_SEED_DROP_INTERVAL_S * (0.75 + Math.random() * 0.5));
    if (looseSeedCount(state) >= TREE_SEED_LOOSE_CAP) continue;

    const { x, z } = player.core;
    const nearby = state.world.queryStatics(x, z, AMBIENT_SEED_RADIUS);
    const mature: Array<{ species: TreeSpecies; x: number; z: number }> = [];
    for (const tree of nearby.trees) {
      if (isPlanted(tree)) {
        if (tree.stage === "mature") mature.push({ species: tree.species, x: tree.x, z: tree.z });
      } else {
        const index = state.world.trees.indexOf(tree);
        if (index !== -1 && !state.felledTrees.has(index)) {
          mature.push({ species: tree.kind, x: tree.x, z: tree.z });
        }
      }
    }
    if (mature.length === 0) continue;
    const pick = mature[Math.floor(Math.random() * mature.length)];
    // Small jitter so repeated drops from the same tree don't pile at one point.
    dropSeedAt(state, pick.species, pick.x + (Math.random() - 0.5), pick.z + (Math.random() - 0.5));
  }
}

/**
 * Wall-clock growth scan: on a coarse cadence, advance any planted tree whose
 * stage has changed (sapling→young→mature) — re-materializing its geometry,
 * resizing/adding its Rapier collider, and emitting an upsert delta so clients
 * rescale the instance. Bounded by the planted cap (≤ PLANTED_TREE_CAP), never
 * the natural forest; growth continues while the room is idle because age is
 * measured from plantedAtMs against Date.now() (persistence restores the same
 * way).
 */
export function tickTreeGrowth(state: GameState): void {
  const nowMs = Date.now();
  if (nowMs < state.treeGrowthNextAtMs) return;
  state.treeGrowthNextAtMs = nowMs + GROWTH_SCAN_INTERVAL_MS;
  for (const tree of state.world.plantedTrees.trees.values()) {
    const stage = treeStageAt(tree.plantedAtMs, nowMs);
    if (stage === tree.stage) continue;
    const record: PlantedTreeRecord = { ...toPlantedRecord(tree), stage };
    // Re-upsert re-derives r/height for the new stage; addPlantedTree resizes
    // (young→mature) or first-adds (sapling→young) the collider — r=0 saplings
    // never reach here since they only ever grow UP.
    const grown = state.world.plantedTrees.upsert(record);
    state.physics.addPlantedTree(grown.id, grown.x, grown.groundY, grown.z, grown.r, grown.height);
    state.plantedTreeDelta.push({ op: "upsert", tree: record });
  }
}

/**
 * Per-tick trunk despawn sweep: trunks asleep for TRUNK_SETTLE_TTL_S vanish
 * and drop TRUNK_WOOD_BONUS wood at their RESTING position — a small bonus on
 * top of the per-chop grants (the chop already paid out the doc-05 wood).
 * Caveats accepted: cap eviction can reap a trunk first (no bonus), and a
 * restart while a trunk is mid-air restores it with a fresh settle clock.
 */
export function tickTrunks(state: GameState): void {
  const expired = state.physics.expireSettled("trunk", TRUNK_SETTLE_TTL_S, state.time);
  for (const trunk of expired) {
    dropWoodAt(state, trunk.x, trunk.z, TRUNK_WOOD_BONUS);
  }
}
