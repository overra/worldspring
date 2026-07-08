// Doc 07 M2 — createWorld parameterization (world size tiers).
//
// The BIT-IDENTITY guarantee for the standard tier is owned by the CI worldgen
// fingerprint gate (scripts/fingerprint.mjs vs the committed
// world.fingerprint.txt) — sha256 over the full geometry JSON + exact Float64
// height-grid bytes. These vitest cases cover the parameter plumbing, the
// per-tier structure, and the groundHeight footprint-grid rewrite's
// value-parity against the old linear scan.

import { describe, expect, it } from "vitest";

import { tierParamsOf } from "./config";
import { WORLD_SIZE, TOWN_COUNT, TREE_COUNT, CABIN_COUNT, ROCK_COUNT } from "./constants";
import { createRng } from "./rng";
import { createWorld } from "./world";
import type { World } from "./world";

function makeWorld(seed: number, tier: "standard" | "large" | "huge"): World {
  return createWorld({ seed, ...tierParamsOf(tier) });
}

describe("createWorld(params) — standard tier", () => {
  const w = makeWorld(1337, "standard");

  it("carries its size (= WORLD_SIZE at standard)", () => {
    expect(w.size).toBe(WORLD_SIZE);
  });

  it("hits the standard targets at seed 1337 (towns/trees/cabins/rocks)", () => {
    expect(w.towns.length).toBe(TOWN_COUNT);
    expect(w.trees.length).toBe(TREE_COUNT);
    expect(w.buildings.filter((b) => b.area === "wild").length).toBe(CABIN_COUNT);
    expect(w.props.filter((p) => p.kind.startsWith("rock")).length).toBe(ROCK_COUNT);
  });

  it("is deterministic: two runs serialize identically", () => {
    const again = makeWorld(1337, "standard");
    expect(JSON.stringify(again)).toBe(JSON.stringify(w));
  });
});

describe("createWorld(params) — large/huge tiers", () => {
  for (const tier of ["large", "huge"] as const) {
    const tp = tierParamsOf(tier);

    it(`${tier}: world spans its tier size and content stays inside it`, () => {
      const w = makeWorld(42, tier);
      expect(w.size).toBe(tp.size);
      const half = tp.size / 2;
      for (const t of w.trees) {
        expect(Math.abs(t.x)).toBeLessThanOrEqual(half);
        expect(Math.abs(t.z)).toBeLessThanOrEqual(half);
      }
      // Trees actually use the >standard extent (some land beyond the
      // standard half-size) — proves the scatter reads params.size.
      expect(w.trees.some((t) => Math.abs(t.x) > WORLD_SIZE / 2)).toBe(true);
    });

    it(`${tier}: reaches >=90% of the tier's town/tree targets (doc 07 acceptance)`, () => {
      const w = makeWorld(42, tier);
      expect(w.towns.length).toBeGreaterThanOrEqual(Math.ceil(tp.towns * 0.9));
      expect(w.trees.length).toBeGreaterThanOrEqual(Math.ceil(tp.trees * 0.9));
    });

    it(`${tier}: repeated generation is deterministic`, () => {
      expect(JSON.stringify(makeWorld(7, tier))).toBe(JSON.stringify(makeWorld(7, tier)));
    });
  }

  it("spawn-ring density scales per tier (48/24 -> 96/48 -> 192/96 targets)", () => {
    expect(makeWorld(1337, "standard").spawnPoints.length).toBeLessThanOrEqual(24);
    expect(makeWorld(1337, "large").spawnPoints.length).toBeLessThanOrEqual(48);
    expect(makeWorld(1337, "large").spawnPoints.length).toBeGreaterThan(24);
    expect(makeWorld(1337, "huge").spawnPoints.length).toBeLessThanOrEqual(96);
    expect(makeWorld(1337, "huge").spawnPoints.length).toBeGreaterThan(48);
  });
});

describe("groundHeight footprint grid == the old linear scan (doc 07 M2)", () => {
  // The grid lookup must be VALUE-IDENTICAL to a linear scan over every
  // building (the pre-M2 implementation): 10K seeded probe points per tier
  // (doc contract acceptance), weighted toward building footprints.
  for (const tier of ["standard", "large"] as const) {
    it(`${tier}: 10K probe points match a reference linear scan`, () => {
      const w = makeWorld(1337, tier);
      const linearGround = (x: number, z: number): number => {
        const terrain = w.heightAt(x, z);
        for (const b of w.buildings) {
          if (Math.abs(x - b.cx) <= b.halfW && Math.abs(z - b.cz) <= b.halfD) {
            return b.floorY > terrain ? b.floorY : terrain;
          }
        }
        return terrain;
      };
      const rng = createRng(0xf00d);
      const half = w.size / 2;
      for (let i = 0; i < 10_000; i++) {
        let x: number;
        let z: number;
        if (i % 2 === 0) {
          // Half the probes land in/around a random building footprint —
          // including exact corners/edges via the inflation band.
          const b = w.buildings[rng.int(0, w.buildings.length - 1)];
          x = b.cx + rng.range(-b.halfW - 2, b.halfW + 2);
          z = b.cz + rng.range(-b.halfD - 2, b.halfD + 2);
        } else {
          x = rng.range(-half, half);
          z = rng.range(-half, half);
        }
        expect(w.groundHeight(x, z)).toBe(linearGround(x, z));
      }
    });
  }
});
