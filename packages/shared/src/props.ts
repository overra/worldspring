// doc 13 M3 — deterministic placement of physics props (barrels).
//
// Barrels are dynamic "barrel" bodies (protocol.ts BodyKind) that the server
// spawns at DO boot near loot-bearing buildings, then players shove and break
// open for loot. This module owns ONLY the seeded PLACEMENT — a pure function
// of an already-generated World; the server (systems/props.ts) turns each
// position into a physics body, and PhysicsSystem steps/persists them.
//
// DETERMINISM (doc 13 §2 — "determinism is law"): placement is derived from a
// per-building HASH-salted rng stream (`barrel|seed|id`), exactly the windows /
// containers precedent (world.ts) — it draws from ZERO worldgen rng streams and
// never mutates the World. It is therefore SEPARATE from createWorld: the
// worldgen fingerprint (scripts/fingerprint.mjs hashes createWorld's output) is
// byte-identical whether or not barrels exist. The same seed yields the same
// barrels on every run and every runtime, which is what lets the boot spawn be
// safe to persist (a fresh world spawns them once; a restored world rebuilds
// them from the bodies snapshot instead — never both).

import { createRng, hashString } from "./rng";
import type { World } from "./world";

/** Island-wide barrel cap — kept well under PHYSICS_BODY_CAP (64) so felled
 * trunks and shoved barrels always have body-cap headroom to coexist. */
export const MAX_BARRELS = 24;
/** Fraction of buildings that receive a barrel (per-building hash roll). */
const BARREL_BUILDING_CHANCE = 0.5;
/** Barrel stands this far OUTSIDE the building footprint (min/max), so it never
 * spawns inside a wall or on a roof — just a scavengeable drum by the door. */
const BARREL_MIN_OFFSET = 1.5;
const BARREL_MAX_OFFSET = 3;

/** A barrel spawn site: the GROUND position. The server lifts the body center
 * by the barrel half-height (+ a seam lift) when it materializes the body. */
export interface BarrelSpawn {
  x: number;
  y: number;
  z: number;
}

/**
 * Deterministic barrel spawn sites for a world — one near a hash-selected
 * subset of buildings (military/town/wild loot zones alike; the building's zone
 * already gates its loot tier). Reads world.buildings in stable generation
 * order and derives each candidate from a fresh `barrel|seed|id` stream, so the
 * result is byte-stable across runs/runtimes and touches no worldgen rng. Capped
 * at MAX_BARRELS. Pure — never mutates `world`.
 */
export function barrelSpawns(world: World): BarrelSpawn[] {
  const out: BarrelSpawn[] = [];
  for (const b of world.buildings) {
    if (out.length >= MAX_BARRELS) break;
    const rng = createRng(hashString(`barrel|${world.seed}|${b.id}`) >>> 0);
    if (!rng.chance(BARREL_BUILDING_CHANCE)) continue;
    const ang = rng.range(0, Math.PI * 2);
    const dist = Math.max(b.halfW, b.halfD) + rng.range(BARREL_MIN_OFFSET, BARREL_MAX_OFFSET);
    const x = b.cx + Math.cos(ang) * dist;
    const z = b.cz + Math.sin(ang) * dist;
    out.push({ x, y: world.groundHeight(x, z), z });
  }
  return out;
}
