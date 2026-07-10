// Wildlife: small, unpersisted animal populations that spawn from dedicated
// hash-salted streams, sleep outside player interest, and drop the shared land
// meat item when killed.

import {
  ANIMAL_SPECIES,
  DEER_CORPSE_TTL_S,
  WILDLIFE_ACTIVE_RADIUS,
  type AnimalSpecies,
} from "@worldspring/shared/constants";
import { effectiveAnimalMax } from "@worldspring/shared/config";
import { distSq2D } from "@worldspring/shared/math";
import { stepZombie } from "@worldspring/shared/movement";
import { createRng, hashString, type Rng } from "@worldspring/shared/rng";
import type { Animal, GameState } from "./state";

// M8 activates the species framework plus rabbits. Boars/wolves keep their
// shared constants/config slots, but their behavior is doc 07 M9.
const SPAWNED_SPECIES = ["deer", "rabbit"] as const satisfies readonly AnimalSpecies[];

/** Inland-only wildlife spawn floor. */
const SPAWN_MIN_TERRAIN_H = 2;
/** Rejection attempts per deterministic spawn stream. */
const SPAWN_ATTEMPTS = 60;
/** How far from home a grazing animal wanders. */
const WANDER_RADIUS = 14;
/** Pause between wander target re-rolls, seconds. */
const WANDER_WAIT_MIN_S = 2;
const WANDER_WAIT_MAX_S = 7;
/** Close enough to the wander target to stand idle. */
const WANDER_ARRIVE_DIST = 0.5;
/** How far ahead the flee target is projected each tick. */
const FLEE_TARGET_DIST = 10;
/** Rabbits juke while fleeing instead of running a straight away-vector. */
const RABBIT_ZIGZAG_INTERVAL_S = 0.4;
const RABBIT_ZIGZAG_MAX_RAD = Math.PI / 3;

function speciesEnabled(species: AnimalSpecies): species is (typeof SPAWNED_SPECIES)[number] {
  return (SPAWNED_SPECIES as readonly AnimalSpecies[]).includes(species);
}

function animalRng(state: GameState, species: AnimalSpecies, salt: string): Rng {
  return createRng(hashString(`animal|${state.world.seed}|${state.world.size}|${species}|${salt}`) >>> 0);
}

function outsideNoSpawnZones(state: GameState, x: number, z: number): boolean {
  const world = state.world;
  const militaryMargin = world.military.radius + 8;
  if (distSq2D(x, z, world.military.cx, world.military.cz) < militaryMargin * militaryMargin) {
    return false;
  }
  for (const town of world.towns) {
    const margin = town.radius + 10;
    if (distSq2D(x, z, town.cx, town.cz) < margin * margin) return false;
  }
  return true;
}

/**
 * Deterministic animal spawn placement. This never touches worldgen RNG streams:
 * every candidate is derived from a species+slot salt over an already-built World.
 */
function pickAnimalPoint(
  state: GameState,
  species: AnimalSpecies,
  salt: string,
): { x: number; z: number; rng: Rng } | null {
  const world = state.world;
  const rng = animalRng(state, species, salt);
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const x = rng.range(-world.size * 0.45, world.size * 0.45);
    const z = rng.range(-world.size * 0.45, world.size * 0.45);
    if (world.heightAt(x, z) < SPAWN_MIN_TERRAIN_H) continue;
    if (world.waterAt(x, z) !== null) continue;
    if (!outsideNoSpawnZones(state, x, z)) continue;
    return { x, z, rng };
  }
  return null;
}

function spawnAnimal(state: GameState, species: AnimalSpecies, x: number, z: number, rng: Rng): void {
  const id = state.nextEntityId++;
  const def = ANIMAL_SPECIES[species];
  state.animals.set(id, {
    id,
    species,
    attackCooldown: 0,
    x,
    y: state.world.groundHeight(x, z),
    z,
    yaw: rng.range(0, Math.PI * 2),
    hp: def.hp,
    state: "idle",
    homeX: x,
    homeZ: z,
    wanderX: x,
    wanderZ: z,
    wanderWait: rng.range(WANDER_WAIT_MIN_S, WANDER_WAIT_MAX_S),
    nextFleeTurnAt: 0,
    fleeYawOffset: 0,
  });
}

/** Spawn the configured M8 species at room boot. Animals are never persisted. */
export function spawnInitialAnimals(state: GameState): void {
  for (const species of SPAWNED_SPECIES) {
    const max = effectiveAnimalMax(state.config, species);
    for (let i = 0; i < max; i++) {
      const pos = pickAnimalPoint(state, species, `initial|${i}`);
      if (pos) spawnAnimal(state, species, pos.x, pos.z, pos.rng);
    }
  }
}

function liveSpeciesCount(state: GameState, species: AnimalSpecies): number {
  let count = 0;
  for (const animal of state.animals.values()) {
    if (animal.species === species) count++;
  }
  return count;
}

/**
 * Remove a dead animal, drop land meat where it fell, and schedule a species
 * replacement. Called by combat when hp reaches 0.
 */
export function killAnimal(state: GameState, animal: Animal): void {
  state.animals.delete(animal.id);
  const def = ANIMAL_SPECIES[animal.species];
  const count = def.meatMin + Math.floor(Math.random() * (def.meatMax - def.meatMin + 1));
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: "raw_venison",
    count,
    x: animal.x,
    y: state.world.groundHeight(animal.x, animal.z),
    z: animal.z,
    spawnId: null,
    ttl: DEER_CORPSE_TTL_S,
  });
  state.animalRespawns.push({ species: animal.species, t: def.respawnS });
}

export function damageAnimal(
  state: GameState,
  animal: Animal,
  dmg: number,
  attackerId?: string,
): boolean {
  animal.hp -= dmg;
  if (animal.species === "boar" && attackerId !== undefined && animal.hp > 0) {
    animal.targetId = attackerId;
    animal.state = "charge";
    animal.attackCooldown = 0;
  }
  if (animal.hp > 0) return false;
  killAnimal(state, animal);
  return true;
}

function nearestPlayerDistSq(state: GameState, animal: Animal): number {
  let best = Infinity;
  for (const player of state.players.values()) {
    if (!player.alive) continue;
    const dSq = distSq2D(animal.x, animal.z, player.core.x, player.core.z);
    if (dSq < best) best = dSq;
  }
  return best;
}

function fleeVector(state: GameState, animal: Animal, fleeRadius: number): { x: number; z: number } | null {
  if (fleeRadius <= 0) return null;
  const fleeSq = fleeRadius * fleeRadius;
  let fleeX = 0;
  let fleeZ = 0;
  let threatened = false;
  for (const player of state.players.values()) {
    if (!player.alive) continue;
    const dx = animal.x - player.core.x;
    const dz = animal.z - player.core.z;
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
  if (!threatened) return null;
  const len = Math.hypot(fleeX, fleeZ);
  if (len <= 1e-4) return { x: -Math.sin(animal.yaw), z: -Math.cos(animal.yaw) };
  return { x: fleeX / len, z: fleeZ / len };
}

function rotate2D(v: { x: number; z: number }, angle: number): { x: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

function tickGrazingAnimal(state: GameState, animal: Animal, dt: number): void {
  const def = ANIMAL_SPECIES[animal.species];
  const flee = fleeVector(state, animal, def.fleeRadius);
  if (flee) {
    animal.state = "flee";
    let dir = flee;
    if (animal.species === "rabbit") {
      if (state.time >= animal.nextFleeTurnAt) {
        animal.fleeYawOffset = (Math.random() * 2 - 1) * RABBIT_ZIGZAG_MAX_RAD;
        animal.nextFleeTurnAt = state.time + RABBIT_ZIGZAG_INTERVAL_S;
      }
      dir = rotate2D(flee, animal.fleeYawOffset);
    }
    stepZombie(
      animal,
      animal.x + dir.x * FLEE_TARGET_DIST,
      animal.z + dir.z * FLEE_TARGET_DIST,
      def.runSpeed,
      dt,
      state.world,
    );
    return;
  }

  animal.wanderWait -= dt;
  if (animal.wanderWait <= 0) {
    const ang = Math.random() * Math.PI * 2;
    const d = Math.random() * WANDER_RADIUS;
    const wx = animal.homeX + Math.cos(ang) * d;
    const wz = animal.homeZ + Math.sin(ang) * d;
    if (state.world.heightAt(wx, wz) >= SPAWN_MIN_TERRAIN_H && state.world.waterAt(wx, wz) === null) {
      animal.wanderX = wx;
      animal.wanderZ = wz;
    }
    animal.wanderWait =
      WANDER_WAIT_MIN_S + Math.random() * (WANDER_WAIT_MAX_S - WANDER_WAIT_MIN_S);
  }
  if (
    distSq2D(animal.x, animal.z, animal.wanderX, animal.wanderZ) >
    WANDER_ARRIVE_DIST * WANDER_ARRIVE_DIST
  ) {
    animal.state = "wander";
    stepZombie(animal, animal.wanderX, animal.wanderZ, def.wanderSpeed, dt, state.world);
  } else {
    animal.state = "idle";
  }
}

export function tickWildlife(state: GameState, dt: number): void {
  state.activeAnimals = 0;
  const activeSq = WILDLIFE_ACTIVE_RADIUS * WILDLIFE_ACTIVE_RADIUS;
  for (const animal of state.animals.values()) {
    if (animal.attackCooldown > 0) animal.attackCooldown = Math.max(0, animal.attackCooldown - dt);
    if (nearestPlayerDistSq(state, animal) > activeSq) continue;
    state.activeAnimals++;
    tickGrazingAnimal(state, animal, dt);
  }
}

/** Count down pending animal respawns; blocked/disabled species retry later. */
export function tickAnimalRespawns(state: GameState, dt: number): void {
  for (let i = state.animalRespawns.length - 1; i >= 0; i--) {
    const respawn = state.animalRespawns[i];
    respawn.t -= dt;
    if (respawn.t > 0) continue;
    if (!speciesEnabled(respawn.species)) {
      respawn.t = 1;
      continue;
    }
    const max = effectiveAnimalMax(state.config, respawn.species);
    if (max <= 0 || liveSpeciesCount(state, respawn.species) >= max) {
      respawn.t = 1;
      continue;
    }
    const salt = `respawn|${state.tick}|${i}|${state.nextEntityId}`;
    const pos = pickAnimalPoint(state, respawn.species, salt);
    if (!pos) {
      respawn.t = 0;
      continue;
    }
    spawnAnimal(state, respawn.species, pos.x, pos.z, pos.rng);
    state.animalRespawns.splice(i, 1);
  }
}

// Compatibility aliases for deer-named call sites and older offline harnesses.
export const spawnInitialDeer = spawnInitialAnimals;
export const tickDeerRespawns = tickAnimalRespawns;
export const killDeer = killAnimal;
