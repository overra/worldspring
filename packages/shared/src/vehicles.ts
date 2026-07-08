// doc 13 M4 — deterministic placement of the ground vehicle (buggy).
//
// A vehicle is a dynamic "vehicle" body (protocol.ts BodyKind) the server spawns
// at DO boot beside a hash-selected subset of the island's larger buildings —
// somewhere with open ground to drive out of (barns/hangars, not sheds). This
// module owns ONLY the seeded PLACEMENT: a pure function of an already-generated
// World; the server (systems/vehicles.ts) turns each site into a physics body +
// gameplay meta (fuel/hp/seats), and PhysicsSystem steps/persists the body.
//
// DETERMINISM (doc 13 §2 — "determinism is law"): placement draws from a per-
// building HASH-salted rng stream (`vehicle|seed|id`), exactly the barrels /
// windows precedent (props.ts / world.ts) — it touches ZERO worldgen rng streams
// and never mutates the World. It is therefore SEPARATE from createWorld: the
// worldgen fingerprint (scripts/fingerprint.mjs hashes createWorld's output) is
// byte-identical whether or not vehicles exist. The same seed yields the same
// vehicles on every run and every runtime, which is what lets the boot spawn be
// safe to persist (a fresh world spawns them once; a restored world rebuilds
// them from the bodies snapshot instead — never both, the barrel posture).

import { WATER_WALK_MIN } from "./constants";
import { createRng, hashString } from "./rng";
import type { World } from "./world";

/** Fraction of ELIGIBLE (large enough) buildings that receive a vehicle. */
const VEHICLE_BUILDING_CHANCE = 0.5;
/** A building is a vehicle site only if it is at least this wide/deep — a buggy
 * needs a barn/hangar-sized clearing beside it, not a shed. */
const VEHICLE_MIN_BUILDING_HALF = 3.5;
/** The vehicle stands this far OUTSIDE the building footprint (min/max), so it
 * never spawns inside a wall or on the roof — clear ground by the structure. */
const VEHICLE_MIN_OFFSET = 4;
const VEHICLE_MAX_OFFSET = 7;

/** A vehicle spawn site: the GROUND position (the server lifts the hull center
 * by the hull half-height + a seam lift when it materializes the body). */
export interface VehicleSpawn {
  x: number;
  y: number;
  z: number;
}

/**
 * Deterministic vehicle spawn sites for a world — a few buggies parked beside a
 * hash-selected subset of the island's larger buildings, on driveable (non-
 * water) ground. Reads world.buildings in stable generation order and derives
 * each candidate from a fresh `vehicle|seed|id` stream, so the result is byte-
 * stable across runs/runtimes and touches no worldgen rng. Capped at `max`.
 * Pure — never mutates `world`.
 */
export function vehicleSpawns(world: World, max: number): VehicleSpawn[] {
  const out: VehicleSpawn[] = [];
  for (const b of world.buildings) {
    if (out.length >= max) break;
    if (b.halfW < VEHICLE_MIN_BUILDING_HALF && b.halfD < VEHICLE_MIN_BUILDING_HALF) continue;
    const rng = createRng(hashString(`vehicle|${world.seed}|${b.id}`) >>> 0);
    if (!rng.chance(VEHICLE_BUILDING_CHANCE)) continue;
    const ang = rng.range(0, Math.PI * 2);
    const dist = Math.max(b.halfW, b.halfD) + rng.range(VEHICLE_MIN_OFFSET, VEHICLE_MAX_OFFSET);
    const x = b.cx + Math.cos(ang) * dist;
    const z = b.cz + Math.sin(ang) * dist;
    // Never park a buggy in the sea (a body spawned below the waterline would be
    // undriveable and look broken). Deterministic reject — it consumes no extra
    // rng, so the site set stays byte-stable.
    if (world.heightAt(x, z) < WATER_WALK_MIN) continue;
    out.push({ x, y: world.groundHeight(x, z), z });
  }
  return out;
}
