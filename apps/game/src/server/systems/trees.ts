// Tree chopping + falling trees (doc 13 M2). Axe swings are the wood faucet
// (doc 05's gather-node design folded into felling): every landed chop grants
// wood, and the FINAL chop topples the tree as a dynamic "trunk" physics body
// — static collider out, trunk spawned with an off-center impulse away from
// the chopper, settle → TTL → despawn dropping bonus wood where it rests.
//
// The chop TRIGGER deliberately reuses {t:"attack"} (a whiffed melee swing
// with the axe equipped) instead of doc 05's reserved-but-unbuilt {t:"gather"}
// verb: zero new ClientMsg surface, zero client input code, and the swing
// animation/cooldown pacing come for free. If doc 05 later ships the gather
// channel it can re-route completion into fellTree below.
//
// The kinematic statics (movement.ts queryStatics) intentionally still treat
// felled trees as solid trunk cylinders on BOTH client and server — the shared
// deterministic sim is untouched (no prediction desync), and walking through
// stump footprints is doc 05's concern, not M2's.

import {
  DROPPED_LOOT_TTL_S,
  MELEE_HALF_ANGLE_RAD,
  MELEE_RANGE,
  TREE_CHOPS_TO_FELL,
  TREE_WOOD_PER_CHOP,
  TRUNK_SETTLE_TTL_S,
  TRUNK_WOOD_BONUS,
} from "@worldspring/shared/constants";
import { distSq2D, inMeleeCone, yawToDir } from "@worldspring/shared/math";
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

/**
 * Resolve a whiffed melee swing against the forest: with the axe equipped and
 * a standing tree trunk in the melee cone, land a chop — grant wood, and on
 * the TREE_CHOPS_TO_FELL-th hit fell the tree. Returns true when a chop
 * landed (combat uses it only for flow; the swing event already went out).
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

  // Nearest standing trunk in the cone. queryStatics returns Tree objects by
  // reference into world.trees, so indexOf recovers the wire/persist identity
  // (index in the seed-derived array) — O(TREE_COUNT), chop-rate only.
  const nearby = state.world.queryStatics(x, z, MELEE_RANGE + 2);
  let bestSq = Infinity;
  let hitIndex = -1;
  let hitTree: Tree | null = null;
  for (const tree of nearby.trees) {
    if (Math.abs(tree.groundY - py) > CHOP_MAX_DY) continue;
    // The trunk has girth: extend the reach by its radius so grazing swings land.
    if (!inMeleeCone(x, z, yaw, tree.x, tree.z, MELEE_RANGE + tree.r, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, tree.x, tree.z);
    if (dSq >= bestSq) continue;
    const index = state.world.trees.indexOf(tree);
    if (index === -1 || state.felledTrees.has(index)) continue;
    // Same wall/roof occlusion ray every living melee target gets — worldgen
    // places trees as close as 2 m outside building walls, so an unchecked
    // cone would harvest (and fell) the forest from indoors.
    if (meleeBlocked(state, x, py, z, tree.x, tree.groundY, tree.z)) continue;
    bestSq = dSq;
    hitIndex = index;
    hitTree = tree;
  }
  if (hitIndex === -1 || !hitTree) return false;

  // Impact flash on the trunk at chest height (the melee-hit feedback).
  queueEvent(state, { e: "hit", x: hitTree.x, y: hitTree.groundY + 1.2, z: hitTree.z }, hitTree.x, hitTree.z);

  // Wood per chop; overflow falls at the tree's base.
  const leftover = addToInventory(player.inventory, "wood", TREE_WOOD_PER_CHOP);
  if (leftover > 0) dropWoodAt(state, hitTree.x, hitTree.z, leftover);
  sendInventory(state, player);

  const chops = (state.treeChops.get(hitIndex) ?? 0) + 1;
  if (chops < TREE_CHOPS_TO_FELL) {
    state.treeChops.set(hitIndex, chops);
    return true;
  }

  // Final chop. Physics off (potato preset): the tree stays STANDING and the
  // counter resets — chopping remains the same wood faucet, there is just no
  // fell (doc 13 M2's config rule: no new config; the fell rides physics.enabled).
  if (!state.config.physics.enabled) {
    state.treeChops.delete(hitIndex);
    return true;
  }
  fellTree(state, player, hitIndex);
  return true;
}

/** Topple tree `index`: mark it felled (persisted + wire delta), remove its
 * static physics collider, and spawn the dynamic trunk with an off-center
 * impulse away from the chopper. */
function fellTree(state: GameState, player: ServerPlayer, index: number): void {
  const tree = state.world.trees[index];
  state.treeChops.delete(index);
  state.felledTrees.add(index);
  state.felledDelta.push(index);
  state.physics.fellTree(index);

  // Trunk body: same footprint as the static collider it replaces, base
  // lifted a hair above the sampled heightfield seam.
  const halfH = tree.height / 2;
  const y = tree.groundY + halfH + TRUNK_SPAWN_LIFT;
  const id = state.physics.spawnBody(
    state.nextEntityId++,
    "trunk",
    tree.x,
    y,
    tree.z,
    [tree.r, halfH, tree.r],
  );
  if (id !== null) {
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
    state.physics.applyImpulseAtPoint(
      id,
      dx * impulse,
      0,
      dz * impulse,
      tree.x,
      tree.groundY + tree.height,
      tree.z,
    );
  }
  sendTo(state, player.id, { t: "notice", msg: "Timber!" });
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
