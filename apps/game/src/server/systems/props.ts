// Physics props: spawnable, shovable barrels (doc 13 M3). Barrels are the
// sibling of felled trunks (systems/trees.ts) — the same spawn → dynamic body →
// settle lifecycle, but SERVER-INITIATED at world boot (near loot zones) and
// with a melee interaction on top: every swing shoves the barrel along the
// look direction (the marquee "shove"), and the BARREL_HITS_TO_BREAK-th swing
// breaks it open, spilling a rolled loot table where it stood.
//
// DETERMINISM: placement is the pure, seeded barrelSpawns (shared/props.ts),
// which touches ZERO worldgen rng and never mutates the World — the worldgen
// fingerprint is byte-identical. Barrels persist on the SAME additive `bodies`
// snapshot field as trunks (no schema bump), so a fresh world spawns them once
// here and a restored world rebuilds them from the snapshot instead — never
// both (GameRoom only calls spawnInitialProps on the fresh-world branch, the
// stockInitialLoot precedent).

import {
  BARREL_HALF_Y,
  BARREL_HITS_TO_BREAK,
  DROPPED_LOOT_TTL_S,
  MELEE_HALF_ANGLE_RAD,
  MELEE_RANGE,
} from "@worldspring/shared/constants";
import { BARREL_LOOT_TABLE } from "@worldspring/shared/items";
import { distSq2D, inMeleeCone, yawToDir } from "@worldspring/shared/math";
import { barrelSpawns } from "@worldspring/shared/props";
import { meleeBlocked } from "./combat";
import { rollFromTable } from "./loot";
import { queueEvent, type GameState, type ServerPlayer } from "./state";

/** Half the barrel's X/Z extent — extends melee reach so grazing swings land
 * (the tree-radius precedent) AND lifts the spawn center off the ground. MUST
 * match the shared BARREL_HALF_XZ / PhysicsSystem's collider. */
const BARREL_RADIUS = 0.3;
/** Lift the barrel base a hair above the analytic ground: the physics
 * heightfield is SAMPLED (≤ half-cell seam vs groundHeight), so a flush base
 * could start intersecting it and pop (the trunk-spawn-lift precedent). */
const BARREL_SPAWN_LIFT = 0.2;
/** Max vertical separation for a shove to land (mirrors combat's MELEE_MAX_DY):
 * no shoving a barrel through a floor from the storey above. */
const BARREL_MAX_DY = 2.5;
/** Rapier default density is 1, so a cuboid barrel's mass = 8·hx·hy·hz. Scaling
 * the impulse by it gives a consistent shove velocity regardless of the tuning. */
const BARREL_MASS = 8 * BARREL_RADIUS * BARREL_HALF_Y * BARREL_RADIUS;
/** Horizontal shove speed (m/s) imparted along the look direction. */
const BARREL_SHOVE_SPEED = 4.5;
/** A touch of upward speed (m/s) so a shoved barrel hops/tips rather than just
 * sliding — the satisfying part of the interaction. */
const BARREL_SHOVE_LIFT = 1.2;

/**
 * Spawn the world's deterministic barrels as dynamic bodies. Called ONCE at
 * boot on a FRESH world (GameRoom's stockInitialLoot branch); a restored world
 * rebuilds barrels from the persisted `bodies` snapshot instead. No-op when
 * physics is disabled (potato preset) — spawnBody would warn-noop anyway.
 *
 * The engine attaches asynchronously (wasm), so these spawns buffer in the
 * PhysicsSystem and materialize on attach (the restored-body path) — the body
 * cap is enforced then; MAX_BARRELS (24) sits well under PHYSICS_BODY_CAP (64).
 */
export function spawnInitialProps(state: GameState): void {
  if (!state.config.physics.enabled) return;
  for (const s of barrelSpawns(state.world)) {
    state.physics.spawnBody(
      state.nextEntityId++,
      "barrel",
      s.x,
      s.y + BARREL_HALF_Y + BARREL_SPAWN_LIFT,
      s.z,
    );
  }
}

/**
 * Resolve a whiffed melee swing against the nearest barrel in the cone: shove
 * it along the player's look direction and accumulate a hit; the
 * BARREL_HITS_TO_BREAK-th hit breaks it open for loot. Returns true when a
 * barrel took the swing (combat uses it only for cascade flow — the swing event
 * already went out).
 *
 * Called from combat's meleeAttack ONLY after no living target, structure, or
 * tree took the swing (the additive doc 13 M3 fallback). Overworld-only:
 * dynamic bodies never exist in the red realm (the snapshot decision), so a
 * shove there would target an invisible body — never chop/shove there.
 */
export function tryShoveProp(state: GameState, player: ServerPlayer): boolean {
  if (player.realm !== "overworld") return false;
  if (!state.config.physics.enabled) return false;

  const { x, z, yaw } = player.core;
  const py = player.core.y;

  // Nearest barrel body inside the melee cone (reach extended by the barrel
  // radius so grazing swings land), unoccluded by a wall/roof — the same
  // occlusion every living melee target gets.
  let bestSq = Infinity;
  let hit: { id: number; x: number; y: number; z: number } | null = null;
  for (const b of state.physics.bodyPositions("barrel")) {
    if (Math.abs(b.y - py) > BARREL_MAX_DY) continue;
    if (!inMeleeCone(x, z, yaw, b.x, b.z, MELEE_RANGE + BARREL_RADIUS, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, b.x, b.z);
    if (dSq >= bestSq) continue;
    if (meleeBlocked(state, x, py, z, b.x, b.y, b.z)) continue;
    bestSq = dSq;
    hit = b;
  }
  if (!hit) return false;

  // Impact flash at the barrel's mid-height (the standard melee-hit feedback).
  queueEvent(state, { e: "hit", x: hit.x, y: hit.y, z: hit.z }, hit.x, hit.z);

  const hits = (state.propHits.get(hit.id) ?? 0) + 1;
  if (hits >= BARREL_HITS_TO_BREAK) {
    breakBarrel(state, hit.id, hit.x, hit.z);
    return true;
  }
  state.propHits.set(hit.id, hits);

  // Shove AWAY along the player's facing (the barrel sits in the cone ahead of
  // them); scaled by mass for a uniform velocity, with a little lift so it hops.
  const [dx, dz] = yawToDir(yaw);
  state.physics.applyImpulse(
    hit.id,
    dx * BARREL_MASS * BARREL_SHOVE_SPEED,
    BARREL_MASS * BARREL_SHOVE_LIFT,
    dz * BARREL_MASS * BARREL_SHOVE_SPEED,
  );
  return true;
}

/**
 * Break a barrel: remove the dynamic body and spill one rolled loot stack where
 * it stood (dropAtFeet shape — spawnId null so it never respawns, TTL'd like
 * any dropped stack). Server-authoritative; the hit counter is transient
 * (state.propHits), so a room restart "heals" a partly-broken barrel exactly
 * like a partly-chopped tree (the treeChops posture).
 */
function breakBarrel(state: GameState, id: number, x: number, z: number): void {
  state.physics.removeBody(id);
  state.propHits.delete(id);
  const stack = rollFromTable(BARREL_LOOT_TABLE);
  const lootId = state.nextEntityId++;
  state.loot.set(lootId, {
    id: lootId,
    type: stack.type,
    count: stack.count,
    x,
    y: state.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
}
