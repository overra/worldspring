// doc 13 M4 — vehicle spawn determinism + the fuel item.
//
// Placement (vehicleSpawns) is the seeded, worldgen-rng-FREE faucet: the same
// world yields the same sites on every run and every runtime, which is what lets
// the boot spawn be safe to persist (a fresh world spawns once; a restored world
// rebuilds from the snapshot). It must ALSO never perturb worldgen — the CI
// worldgen fingerprint gate (scripts/fingerprint.mjs) owns the byte-identity
// guarantee; these cases pin the placement contract itself.

import { describe, expect, it } from "vitest";

import { tierParamsOf } from "./config";
import { MAX_VEHICLES, WATER_WALK_MIN } from "./constants";
import { ITEM_DEFS, LOOT_TABLES } from "./items";
import { createWorld } from "./world";
import type { World } from "./world";
import { vehicleSpawns } from "./vehicles";

function makeWorld(seed: number): World {
  return createWorld({ seed, ...tierParamsOf("standard") });
}

describe("vehicleSpawns — deterministic placement", () => {
  const world = makeWorld(1337);

  it("is byte-stable across repeated calls (same seed → same sites)", () => {
    const a = vehicleSpawns(world, MAX_VEHICLES);
    const b = vehicleSpawns(world, MAX_VEHICLES);
    expect(a).toEqual(b);
  });

  it("is stable across a fresh world rebuilt from the same seed", () => {
    const a = vehicleSpawns(makeWorld(1337), MAX_VEHICLES);
    const b = vehicleSpawns(makeWorld(1337), MAX_VEHICLES);
    expect(a).toEqual(b);
  });

  it("never exceeds the requested cap", () => {
    expect(vehicleSpawns(world, MAX_VEHICLES).length).toBeLessThanOrEqual(MAX_VEHICLES);
    expect(vehicleSpawns(world, 1).length).toBeLessThanOrEqual(1);
    expect(vehicleSpawns(world, 0).length).toBe(0);
  });

  it("spawns at least one vehicle on the standard island", () => {
    // The standard world has barns/hangars/houses large enough to qualify.
    expect(vehicleSpawns(world, MAX_VEHICLES).length).toBeGreaterThan(0);
  });

  it("only places vehicles on driveable (non-deep-water) ground", () => {
    for (const s of vehicleSpawns(world, MAX_VEHICLES)) {
      expect(world.heightAt(s.x, s.z)).toBeGreaterThanOrEqual(WATER_WALK_MIN);
      // y is the ground height at the site (the server lifts the hull center).
      expect(s.y).toBe(world.groundHeight(s.x, s.z));
    }
  });

  it("does NOT mutate the world (worldgen fingerprint stays byte-identical)", () => {
    const before = JSON.stringify(world.buildings);
    vehicleSpawns(world, MAX_VEHICLES);
    expect(JSON.stringify(world.buildings)).toBe(before);
  });

  it("varies with the seed (not a fixed layout)", () => {
    const a = JSON.stringify(vehicleSpawns(makeWorld(1337), MAX_VEHICLES));
    const b = JSON.stringify(vehicleSpawns(makeWorld(9999), MAX_VEHICLES));
    expect(a).not.toBe(b);
  });
});

describe("fuel item (doc 13 M4)", () => {
  it("is a stackable material with a valid def", () => {
    const def = ITEM_DEFS.fuel;
    expect(def).toBeDefined();
    expect(def.kind).toBe("material");
    expect(def.stack).toBeGreaterThan(0);
  });

  it("drops from the inland + military (vehicle-adjacent) loot tiers", () => {
    expect(LOOT_TABLES.inland.some((e) => e.type === "fuel")).toBe(true);
    expect(LOOT_TABLES.military.some((e) => e.type === "fuel")).toBe(true);
  });
});
