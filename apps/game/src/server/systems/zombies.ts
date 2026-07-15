// Zombie spawning, AI state machine (idle/wander/chase/attack) and respawn
// scheduling. Movement goes through the shared stepZombie so zombies respect
// the same statics and water rules as players.

import {
  WATER_WALK_MIN,
  ZOMBIE_RADIUS,
  MILITARY_RESPAWN_MIN_PLAYER_DIST,
  MILITARY_ZOMBIE_DMG,
  MILITARY_ZOMBIE_HP,
  MILITARY_ZOMBIE_SPEED,
  MILITARY_ZOMBIES,
  ZOMBIE_AGGRO_RADIUS,
  ZOMBIE_ATTACK_COOLDOWN_S,
  ZOMBIE_ATTACK_RANGE,
  ZOMBIE_CHASE_SPEED,
  ZOMBIE_DEAGGRO_RADIUS,
  ZOMBIE_DMG,
  ZOMBIE_HP,
  ZOMBIE_RESPAWN_S,
  ZOMBIE_ROAMERS,
  ZOMBIE_SPAWN_MIN_PLAYER_DIST,
  ZOMBIE_WANDER_SPEED,
  ZOMBIES_PER_TOWN,
} from "@worldspring/shared/constants";
import { effectiveZombieMax } from "@worldspring/shared/config";
import { distSq2D } from "@worldspring/shared/math";
import { resolveStatics, stepZombie } from "@worldspring/shared/movement";
import type { World } from "@worldspring/shared/world";
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
/** Contract gap (spec says "± ~30"): military zombies spawn within this
 * radius of the compound center — inside the walls (half-extent 40). */
const MILITARY_SPAWN_RADIUS = 30;

// Exported for the horde GameMode (docs/plans/00), which spawns waves and then
// post-scales the returned zombie's hp. Survival's callers below invoke it as a
// statement and ignore the return, so their behaviour is byte-identical.
export function spawnZombie(state: GameState, x: number, z: number, mil: boolean): Zombie {
  const id = state.nextEntityId++;
  const zombie: Zombie = {
    id,
    x,
    y: state.world.groundHeight(x, z),
    z,
    yaw: Math.random() * Math.PI * 2,
    hp: mil ? MILITARY_ZOMBIE_HP : ZOMBIE_HP,
    mil,
    state: "idle",
    homeX: x,
    homeZ: z,
    targetId: null,
    wanderX: x,
    wanderZ: z,
    wanderWait: WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S),
    attackCooldown: 0,
  };
  state.zombies.set(id, zombie);
  return zombie;
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

/**
 * MILITARY_ZOMBIES inside the compound walls, ZOMBIES_PER_TOWN around each
 * town, ZOMBIE_ROAMERS scattered inland. Military spawn FIRST so the
 * compound's garrison is never starved by the ZOMBIE_MAX cap; home = spawn
 * point, so the wander loop keeps them inside the walls.
 */
export function spawnInitialZombies(state: GameState): void {
  if (!state.config.threats.zombies) return;
  const density = state.config.threats.zombieDensity;
  const max = effectiveZombieMax(state.config);
  if (state.config.threats.militaryZone) {
    const { cx, cz } = state.world.military;
    const milCount = Math.round(MILITARY_ZOMBIES * density);
    for (let i = 0; i < milCount && state.zombies.size < max; i++) {
      const pos = findLandNear(state.world, cx, cz, MILITARY_SPAWN_RADIUS, 20);
      if (pos) spawnZombie(state, pos.x, pos.z, true);
    }
  }
  const perTown = Math.round(ZOMBIES_PER_TOWN * density);
  for (const town of state.world.towns) {
    for (let i = 0; i < perTown && state.zombies.size < max; i++) {
      const pos = findLandNear(state.world, town.cx, town.cz, town.radius, 20);
      if (pos) spawnZombie(state, pos.x, pos.z, false);
    }
  }
  const roamers = Math.round(ZOMBIE_ROAMERS * density);
  for (let i = 0; i < roamers && state.zombies.size < max; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (Math.random() * 2 - 1) * state.world.size * 0.45;
      const z = (Math.random() * 2 - 1) * state.world.size * 0.45;
      if (state.world.heightAt(x, z) < ROAMER_MIN_TERRAIN_H) continue;
      spawnZombie(state, x, z, false);
      break;
    }
  }
}

/** Remove a dead zombie, leave its body, emit the death effect, schedule a respawn. */
export function killZombie(state: GameState, zombie: Zombie): void {
  state.zombies.delete(zombie.id);
  spawnZombieCorpse(state, zombie);
  queueEvent(state, { e: "zdie", x: zombie.x, y: zombie.y, z: zombie.z }, zombie.x, zombie.z);
  // The respawn preserves the variant: a dead military zombie comes back
  // military, inside the compound.
  state.zombieRespawns.push({ t: ZOMBIE_RESPAWN_S, mil: zombie.mil });
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
  // Master toggle: threats.zombies=false means no spawn, tick, OR respawn —
  // never advance AI/damage/separation even if the set were somehow non-empty
  // (e.g. a future live M5 admin disable). Spawn + respawn are gated separately.
  if (!state.config.threats.zombies) return;
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
          const dmg =
            (zombie.mil ? MILITARY_ZOMBIE_DMG : ZOMBIE_DMG) * state.config.threats.zombieDamage;
          damagePlayer(state, target, dmg, "a zombie", true);
        }
      } else {
        zombie.state = "chase";
        const speed =
          (zombie.mil ? MILITARY_ZOMBIE_SPEED : ZOMBIE_CHASE_SPEED) *
          state.config.threats.zombieSpeed;
        stepZombie(zombie, tx, tz, speed, dt, state.world);
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

  separateZombies(state);
}

/** Minimum center distance between two zombies (slightly under 2x radius so
 * a pack reads as a crowd, not a single stacked model). */
const ZOMBIE_SEPARATION = ZOMBIE_RADIUS * 1.9;
/** Zombies are pushed out of players' capsules one-sidedly: only the zombie
 * moves, so client-side player prediction never diverges. */
const PLAYER_SEPARATION = ZOMBIE_RADIUS + 0.45;

/**
 * Soft separation pass after movement: zombies converging on one target no
 * longer interpenetrate into a single stacked model. One iteration per tick
 * is enough — 15Hz convergence reads as natural shuffling. O(n^2) over at
 * most ZOMBIE_MAX zombies (~1.8k pair checks) is negligible.
 */
function separateZombies(state: GameState): void {
  const zombies = [...state.zombies.values()];
  const pushedIds = new Set<number>();

  for (let i = 0; i < zombies.length; i++) {
    const a = zombies[i];
    for (let j = i + 1; j < zombies.length; j++) {
      const b = zombies[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dSq = dx * dx + dz * dz;
      if (dSq >= ZOMBIE_SEPARATION * ZOMBIE_SEPARATION) continue;
      const d = Math.sqrt(dSq);
      // Perfectly stacked pair: split along a deterministic-ish axis.
      const nx = d > 1e-4 ? dx / d : 1;
      const nz = d > 1e-4 ? dz / d : 0;
      const push = (ZOMBIE_SEPARATION - d) / 2;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
      pushedIds.add(a.id);
      pushedIds.add(b.id);
    }
    // One-sided push out of player capsules.
    for (const player of state.players.values()) {
      if (!player.alive) continue;
      const dx = a.x - player.core.x;
      const dz = a.z - player.core.z;
      const dSq = dx * dx + dz * dz;
      if (dSq >= PLAYER_SEPARATION * PLAYER_SEPARATION) continue;
      const d = Math.sqrt(dSq);
      const nx = d > 1e-4 ? dx / d : 1;
      const nz = d > 1e-4 ? dz / d : 0;
      a.x = player.core.x + nx * PLAYER_SEPARATION;
      a.z = player.core.z + nz * PLAYER_SEPARATION;
      pushedIds.add(a.id);
    }
  }

  // Pushed zombies re-resolve against statics/water and re-snap to ground so
  // separation can never shove them into a wall or the sea.
  for (const zombie of zombies) {
    if (!pushedIds.has(zombie.id)) continue;
    if (state.world.heightAt(zombie.x, zombie.z) < WATER_WALK_MIN) {
      // Pushed into deep water: pull back toward home instead.
      zombie.x = zombie.homeX;
      zombie.z = zombie.homeZ;
    }
    const [nx, nz] = resolveStatics(state.world, zombie.x, zombie.z, zombie.y, ZOMBIE_RADIUS);
    zombie.x = nx;
    zombie.z = nz;
    zombie.y = state.world.groundHeight(zombie.x, zombie.z);
  }
}

/** True when any player (online or lingering) is within `dist` of (x, z). */
function playerWithin(state: GameState, x: number, z: number, dist: number): boolean {
  const dSq = dist * dist;
  for (const player of state.players.values()) {
    if (distSq2D(x, z, player.core.x, player.core.z) < dSq) return true;
  }
  return false;
}

function pickRespawnPos(state: GameState): { x: number; z: number } | null {
  const towns = state.world.towns;
  if (towns.length === 0) return null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const town = towns[Math.floor(Math.random() * towns.length)];
    const pos = findLandNear(state.world, town.cx, town.cz, town.radius, 4);
    if (!pos) continue;
    if (!playerWithin(state, pos.x, pos.z, ZOMBIE_SPAWN_MIN_PLAYER_DIST)) return pos;
  }
  return null;
}

/** Inside the compound, gated on no player within MILITARY_RESPAWN_MIN_PLAYER_DIST. */
function pickMilitaryRespawnPos(state: GameState): { x: number; z: number } | null {
  const { cx, cz } = state.world.military;
  for (let attempt = 0; attempt < 12; attempt++) {
    const pos = findLandNear(state.world, cx, cz, MILITARY_SPAWN_RADIUS, 4);
    if (!pos) continue;
    if (!playerWithin(state, pos.x, pos.z, MILITARY_RESPAWN_MIN_PLAYER_DIST)) return pos;
  }
  return null;
}

/** Count down pending respawns; blocked ones are held and retried next tick. */
export function tickZombieRespawns(state: GameState, dt: number): void {
  if (!state.config.threats.zombies) return;
  const max = effectiveZombieMax(state.config);
  for (let i = state.zombieRespawns.length - 1; i >= 0; i--) {
    const pending = state.zombieRespawns[i];
    pending.t -= dt;
    if (pending.t > 0) continue;
    if (state.zombies.size >= max) {
      pending.t = 0;
      continue;
    }
    const pos = pending.mil ? pickMilitaryRespawnPos(state) : pickRespawnPos(state);
    if (!pos) {
      pending.t = 0;
      continue;
    }
    spawnZombie(state, pos.x, pos.z, pending.mil);
    state.zombieRespawns.splice(i, 1);
  }
}
