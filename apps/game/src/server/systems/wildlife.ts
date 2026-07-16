// Deer: passive wildlife that wanders like zombies and flees from players.
// Deer never attack; their value is venison — killing one drops raw_venison
// as a timed loot entity where it fell, and a respawn is scheduled so the
// island never runs dry. Movement reuses stepZombie (Deer is structurally a
// ZombieCore), so deer respect the same statics and water rules as everything
// else.

import {
  DEER_CORPSE_TTL_S,
  DEER_FLEE_RADIUS,
  DEER_FLEE_SPEED,
  DEER_HP,
  DEER_RESPAWN_S,
  DEER_WANDER_SPEED,
  VENISON_PER_DEER_MAX,
  VENISON_PER_DEER_MIN,
} from "@worldspring/shared/constants";
import { effectiveDeerMax } from "@worldspring/shared/config";
import { distSq2D } from "@worldspring/shared/math";
import { stepZombie } from "@worldspring/shared/movement";
import type { Deer, GameState } from "./state";

// Contract gaps (no shared constants — local tuning, cosmetic only):
/** Deer spawn inland: minimum terrain height (spec: "height >= 2"). */
const SPAWN_MIN_TERRAIN_H = 2;
/** Rejection-sampling attempts per spawn point. */
const SPAWN_ATTEMPTS = 40;
/** How far from home a wandering deer grazes. */
const WANDER_RADIUS = 14;
/** Pause between wander target re-rolls, seconds. */
const WANDER_WAIT_MIN_S = 2;
const WANDER_WAIT_MAX_S = 7;
/** Close enough to the wander target to stand idle. */
const WANDER_ARRIVE_DIST = 0.5;
/** How far ahead the flee target is projected each tick. */
const FLEE_TARGET_DIST = 10;

function spawnDeer(state: GameState, x: number, z: number): void {
  const id = state.nextEntityId++;
  state.animals.set(id, {
    id,
    x,
    y: state.world.groundHeight(x, z),
    z,
    yaw: Math.random() * Math.PI * 2,
    hp: DEER_HP,
    state: "idle",
    homeX: x,
    homeZ: z,
    wanderX: x,
    wanderZ: z,
    wanderWait: WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S),
  });
}

/** Random inland point: high enough ground, outside towns and the compound. */
function pickDeerPoint(state: GameState): { x: number; z: number } | null {
  const world = state.world;
  const military = world.military;
  const militaryRadiusSq = military.radius * military.radius;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const x = (Math.random() * 2 - 1) * world.size * 0.45;
    const z = (Math.random() * 2 - 1) * world.size * 0.45;
    if (world.heightAt(x, z) < SPAWN_MIN_TERRAIN_H) continue;
    if (distSq2D(x, z, military.cx, military.cz) < militaryRadiusSq) continue;
    let inTown = false;
    for (const town of world.towns) {
      if (distSq2D(x, z, town.cx, town.cz) < town.radius * town.radius) {
        inTown = true;
        break;
      }
    }
    if (inTown) continue;
    return { x, z };
  }
  return null;
}

/** effectiveDeerMax deer scattered inland at room boot (never persisted). */
export function spawnInitialDeer(state: GameState): void {
  const max = effectiveDeerMax(state.config);
  for (let i = 0; i < max; i++) {
    const pos = pickDeerPoint(state);
    if (pos) spawnDeer(state, pos.x, pos.z);
  }
}

/**
 * Remove a dead deer, drop its venison as a timed loot entity where it fell,
 * and schedule a replacement. Called by combat when a deer's hp reaches 0.
 */
export function killDeer(state: GameState, deer: Deer): void {
  state.animals.delete(deer.id);
  const count =
    VENISON_PER_DEER_MIN +
    Math.floor(Math.random() * (VENISON_PER_DEER_MAX - VENISON_PER_DEER_MIN + 1));
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: "raw_venison",
    count,
    x: deer.x,
    y: state.world.groundHeight(deer.x, deer.z),
    z: deer.z,
    spawnId: null,
    ttl: DEER_CORPSE_TTL_S,
  });
  state.deerRespawns.push(DEER_RESPAWN_S);
}

export function tickWildlife(state: GameState, dt: number): void {
  for (const deer of state.animals.values()) {
    // Flee from every living player inside the flee radius: blend the
    // away-vectors so a deer between two hunters runs perpendicular, not
    // into either of them.
    let fleeX = 0;
    let fleeZ = 0;
    let threatened = false;
    const fleeSq = DEER_FLEE_RADIUS * DEER_FLEE_RADIUS;
    for (const player of state.players.values()) {
      if (!player.alive) continue;
      const dx = deer.x - player.core.x;
      const dz = deer.z - player.core.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > fleeSq) continue;
      threatened = true;
      const d = Math.sqrt(dSq);
      if (d > 1e-4) {
        // Closer threats push harder (normalized away-vector / distance).
        fleeX += dx / d / Math.max(d, 1);
        fleeZ += dz / d / Math.max(d, 1);
      }
    }
    if (threatened) {
      deer.state = "flee";
      const len = Math.hypot(fleeX, fleeZ);
      // Opposing threats can cancel exactly; bolt along the current facing.
      const nx = len > 1e-4 ? fleeX / len : -Math.sin(deer.yaw);
      const nz = len > 1e-4 ? fleeZ / len : -Math.cos(deer.yaw);
      stepZombie(
        deer,
        deer.x + nx * FLEE_TARGET_DIST,
        deer.z + nz * FLEE_TARGET_DIST,
        DEER_FLEE_SPEED,
        dt,
        state.world,
      );
      // Re-anchor the grazing territory to WHERE it flees. Otherwise `home` stays
      // at the spawn point — usually right where the player walked up — so the
      // moment the deer clears the flee radius it wanders back toward home (toward
      // the player) and re-triggers flee: the "run off, turn around, walk back,
      // turn away" oscillation. Following home out, and re-rolling a fresh nearby
      // graze target as soon as it's calm, makes a spooked deer settle where it
      // fled instead of ping-ponging.
      deer.homeX = deer.x;
      deer.homeZ = deer.z;
      deer.wanderWait = 0;
      continue;
    }

    // No threat: graze near home (same pattern as the zombie wander loop).
    deer.wanderWait -= dt;
    if (deer.wanderWait <= 0) {
      const ang = Math.random() * Math.PI * 2;
      const d = Math.random() * WANDER_RADIUS;
      const wx = deer.homeX + Math.cos(ang) * d;
      const wz = deer.homeZ + Math.sin(ang) * d;
      if (state.world.heightAt(wx, wz) >= SPAWN_MIN_TERRAIN_H) {
        deer.wanderX = wx;
        deer.wanderZ = wz;
      }
      deer.wanderWait =
        WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S);
    }
    if (
      distSq2D(deer.x, deer.z, deer.wanderX, deer.wanderZ) >
      WANDER_ARRIVE_DIST * WANDER_ARRIVE_DIST
    ) {
      deer.state = "wander";
      stepZombie(deer, deer.wanderX, deer.wanderZ, DEER_WANDER_SPEED, dt, state.world);
    } else {
      deer.state = "idle";
    }
  }
}

/** Count down pending deer respawns; blocked ones retry next tick. No deer at
 * all (deerDensity 0) → nothing respawns. */
export function tickDeerRespawns(state: GameState, dt: number): void {
  if (effectiveDeerMax(state.config) <= 0) return;
  for (let i = state.deerRespawns.length - 1; i >= 0; i--) {
    state.deerRespawns[i] -= dt;
    if (state.deerRespawns[i] > 0) continue;
    const pos = pickDeerPoint(state);
    if (!pos) {
      state.deerRespawns[i] = 0; // hold and retry next tick
      continue;
    }
    spawnDeer(state, pos.x, pos.z);
    state.deerRespawns.splice(i, 1);
  }
}
