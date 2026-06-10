// Zombie spawning, AI state machine (idle/wander/chase/attack) and respawn
// scheduling. Movement goes through the shared stepZombie so zombies respect
// the same statics and water rules as players.

import {
  WORLD_SIZE,
  ZOMBIE_AGGRO_RADIUS,
  ZOMBIE_ATTACK_COOLDOWN_S,
  ZOMBIE_ATTACK_RANGE,
  ZOMBIE_CHASE_SPEED,
  ZOMBIE_DEAGGRO_RADIUS,
  ZOMBIE_DMG,
  ZOMBIE_HP,
  ZOMBIE_MAX,
  ZOMBIE_RESPAWN_S,
  ZOMBIE_ROAMERS,
  ZOMBIE_SPAWN_MIN_PLAYER_DIST,
  ZOMBIE_WANDER_SPEED,
  ZOMBIES_PER_TOWN,
} from "@/shared/constants";
import { distSq2D } from "@/shared/math";
import { stepZombie } from "@/shared/movement";
import type { World } from "@/shared/world";
import { spawnZombieCorpse } from "./loot";
import { damagePlayer } from "./survival";
import { queueEvent, type GameState, type ServerPlayer, type Zombie } from "./state";

// Contract gaps (no shared constants for these — local tuning, cosmetic only):
/** How far from home a wandering zombie roams. */
const WANDER_RADIUS = 10;
/** Pause between wander target re-rolls, seconds. */
const WANDER_WAIT_MIN_S = 2;
const WANDER_WAIT_MAX_S = 6;
/** Minimum terrain height for a zombie spawn — keeps them out of the water. */
const SPAWN_MIN_TERRAIN_H = 0.3;
/** Roamers must spawn inland — beaches (h 0.4-1.6) are player spawn territory. */
const ROAMER_MIN_TERRAIN_H = 2.5;
/** Close enough to the wander target to stand idle. */
const WANDER_ARRIVE_DIST = 0.5;

function spawnZombie(state: GameState, x: number, z: number): void {
  const id = state.nextEntityId++;
  state.zombies.set(id, {
    id,
    x,
    y: state.world.groundHeight(x, z),
    z,
    yaw: Math.random() * Math.PI * 2,
    hp: ZOMBIE_HP,
    state: "idle",
    homeX: x,
    homeZ: z,
    targetId: null,
    wanderX: x,
    wanderZ: z,
    wanderWait: WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S),
    attackCooldown: 0,
  });
}

/** Random dry-land point within `radius` of (cx, cz), or null after attempts. */
function findLandNear(
  world: World,
  cx: number,
  cz: number,
  radius: number,
  attempts: number,
): { x: number; z: number } | null {
  for (let i = 0; i < attempts; i++) {
    const ang = Math.random() * Math.PI * 2;
    const d = Math.random() * radius;
    const x = cx + Math.cos(ang) * d;
    const z = cz + Math.sin(ang) * d;
    if (world.heightAt(x, z) >= SPAWN_MIN_TERRAIN_H) return { x, z };
  }
  return null;
}

/** ZOMBIES_PER_TOWN around each town plus ZOMBIE_ROAMERS scattered inland. */
export function spawnInitialZombies(state: GameState): void {
  for (const town of state.world.towns) {
    for (let i = 0; i < ZOMBIES_PER_TOWN && state.zombies.size < ZOMBIE_MAX; i++) {
      const pos = findLandNear(state.world, town.cx, town.cz, town.radius, 20);
      if (pos) spawnZombie(state, pos.x, pos.z);
    }
  }
  for (let i = 0; i < ZOMBIE_ROAMERS && state.zombies.size < ZOMBIE_MAX; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (Math.random() * 2 - 1) * WORLD_SIZE * 0.45;
      const z = (Math.random() * 2 - 1) * WORLD_SIZE * 0.45;
      if (state.world.heightAt(x, z) < ROAMER_MIN_TERRAIN_H) continue;
      spawnZombie(state, x, z);
      break;
    }
  }
}

/** Remove a dead zombie, leave its body, emit the death effect, schedule a respawn. */
export function killZombie(state: GameState, zombie: Zombie): void {
  state.zombies.delete(zombie.id);
  spawnZombieCorpse(state, zombie);
  queueEvent(state, { e: "zdie", x: zombie.x, y: zombie.y, z: zombie.z }, zombie.x, zombie.z);
  state.zombieRespawns.push(ZOMBIE_RESPAWN_S);
}

function acquireTarget(state: GameState, zombie: Zombie): ServerPlayer | null {
  // Keep the current target until it dies or escapes the deaggro radius.
  if (zombie.targetId !== null) {
    const current = state.players.get(zombie.targetId);
    if (
      current &&
      current.alive &&
      distSq2D(zombie.x, zombie.z, current.core.x, current.core.z) <=
        ZOMBIE_DEAGGRO_RADIUS * ZOMBIE_DEAGGRO_RADIUS
    ) {
      return current;
    }
    zombie.targetId = null;
  }
  // Aggro the nearest living player within the aggro radius.
  let best: ServerPlayer | null = null;
  let bestSq = ZOMBIE_AGGRO_RADIUS * ZOMBIE_AGGRO_RADIUS;
  for (const player of state.players.values()) {
    if (!player.alive) continue;
    const dSq = distSq2D(zombie.x, zombie.z, player.core.x, player.core.z);
    if (dSq <= bestSq) {
      bestSq = dSq;
      best = player;
    }
  }
  zombie.targetId = best ? best.id : null;
  return best;
}

/** Chest height for the wall-occlusion check on zombie swipes. */
const ZOMBIE_RAY_HEIGHT = 1.2;

/** No clawing through walls: walls-only ray from zombie chest to player chest. */
function attackBlocked(state: GameState, zombie: Zombie, target: ServerPlayer): boolean {
  const dx = target.core.x - zombie.x;
  const dy = target.core.y - zombie.y;
  const dz = target.core.z - zombie.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-4) return false;
  const t = state.world.raycastStatics(
    { x: zombie.x, y: zombie.y + ZOMBIE_RAY_HEIGHT, z: zombie.z },
    { x: dx / dist, y: dy / dist, z: dz / dist },
    dist,
    false,
  );
  return t !== null && t < dist - 0.05;
}

export function tickZombies(state: GameState, dt: number): void {
  for (const zombie of state.zombies.values()) {
    if (zombie.attackCooldown > 0) zombie.attackCooldown -= dt;

    const target = acquireTarget(state, zombie);
    if (target) {
      const tx = target.core.x;
      const tz = target.core.z;
      const dSq = distSq2D(zombie.x, zombie.z, tx, tz);
      if (dSq <= ZOMBIE_ATTACK_RANGE * ZOMBIE_ATTACK_RANGE) {
        zombie.state = "attack";
        zombie.yaw = Math.atan2(-(tx - zombie.x), -(tz - zombie.z));
        zombie.y = state.world.groundHeight(zombie.x, zombie.z);
        if (zombie.attackCooldown <= 0 && !attackBlocked(state, zombie, target)) {
          zombie.attackCooldown = ZOMBIE_ATTACK_COOLDOWN_S;
          damagePlayer(state, target, ZOMBIE_DMG, "a zombie", true);
        }
      } else {
        zombie.state = "chase";
        stepZombie(zombie, tx, tz, ZOMBIE_CHASE_SPEED, dt, state.world);
      }
      continue;
    }

    // No target: slow random walk near home.
    zombie.wanderWait -= dt;
    if (zombie.wanderWait <= 0) {
      const pos = findLandNear(state.world, zombie.homeX, zombie.homeZ, WANDER_RADIUS, 6);
      if (pos) {
        zombie.wanderX = pos.x;
        zombie.wanderZ = pos.z;
      }
      zombie.wanderWait =
        WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S);
    }
    if (
      distSq2D(zombie.x, zombie.z, zombie.wanderX, zombie.wanderZ) >
      WANDER_ARRIVE_DIST * WANDER_ARRIVE_DIST
    ) {
      zombie.state = "wander";
      stepZombie(zombie, zombie.wanderX, zombie.wanderZ, ZOMBIE_WANDER_SPEED, dt, state.world);
    } else {
      zombie.state = "idle";
    }
  }
}

function pickRespawnPos(state: GameState): { x: number; z: number } | null {
  const towns = state.world.towns;
  if (towns.length === 0) return null;
  const minSq = ZOMBIE_SPAWN_MIN_PLAYER_DIST * ZOMBIE_SPAWN_MIN_PLAYER_DIST;
  for (let attempt = 0; attempt < 12; attempt++) {
    const town = towns[Math.floor(Math.random() * towns.length)];
    const pos = findLandNear(state.world, town.cx, town.cz, town.radius, 4);
    if (!pos) continue;
    let blocked = false;
    for (const player of state.players.values()) {
      if (distSq2D(pos.x, pos.z, player.core.x, player.core.z) < minSq) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return pos;
  }
  return null;
}

/** Count down pending respawns; blocked ones are held and retried next tick. */
export function tickZombieRespawns(state: GameState, dt: number): void {
  for (let i = state.zombieRespawns.length - 1; i >= 0; i--) {
    state.zombieRespawns[i] -= dt;
    if (state.zombieRespawns[i] > 0) continue;
    if (state.zombies.size >= ZOMBIE_MAX) {
      state.zombieRespawns[i] = 0;
      continue;
    }
    const pos = pickRespawnPos(state);
    if (!pos) {
      state.zombieRespawns[i] = 0;
      continue;
    }
    spawnZombie(state, pos.x, pos.z);
    state.zombieRespawns.splice(i, 1);
  }
}
