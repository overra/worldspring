// doc 13 M3 — physics-prop placement + loot determinism.
//
// barrelSpawns is the seeded, worldgen-DERIVED placement (a pure function of an
// already-generated World). "Determinism is law" (doc 13 §2): the same seed
// must yield the same barrels on every run/runtime, which is what makes the
// server's boot spawn safe to persist. Crucially, barrelSpawns touches ZERO
// worldgen rng and never mutates the World — so it can't move the worldgen
// fingerprint (that gate hashes createWorld's output; barrels live outside it).
// These cases pin the determinism + placement invariants, plus the barrel loot
// table's validity (the server-side break roll's source of truth).

import { describe, expect, it } from "vitest";

import { tierParamsOf } from "./config";
import { MAX_BARRELS, barrelSpawns } from "./props";
import { BARREL_LOOT_TABLE, ITEM_DEFS } from "./items";
import { createWorld } from "./world";
import type { World } from "./world";

function makeWorld(seed: number, tier: "standard" | "large" | "huge" = "standard"): World {
  return createWorld({ seed, ...tierParamsOf(tier) });
}

describe("barrelSpawns — determinism", () => {
  it("is stable across two calls on the same world (byte-identical)", () => {
    const w = makeWorld(1337);
    expect(JSON.stringify(barrelSpawns(w))).toBe(JSON.stringify(barrelSpawns(w)));
  });

  it("is stable across two freshly-generated worlds of the same seed", () => {
    expect(JSON.stringify(barrelSpawns(makeWorld(1337)))).toBe(
      JSON.stringify(barrelSpawns(makeWorld(1337))),
    );
  });

  it("does NOT mutate the world (createWorld output unchanged after placement)", () => {
    const w = makeWorld(1337);
    const before = JSON.stringify(w);
    barrelSpawns(w);
    expect(JSON.stringify(w)).toBe(before);
  });

  it("differs between seeds (placement is seed-derived, not fixed)", () => {
    expect(JSON.stringify(barrelSpawns(makeWorld(1337)))).not.toBe(
      JSON.stringify(barrelSpawns(makeWorld(2026))),
    );
  });
});

describe("barrelSpawns — placement invariants", () => {
  const seeds = [1337, 0, 42, 2026];

  it("never exceeds the island cap (headroom under PHYSICS_BODY_CAP)", () => {
    for (const seed of seeds) {
      expect(barrelSpawns(makeWorld(seed)).length).toBeLessThanOrEqual(MAX_BARRELS);
    }
  });

  it("produces some barrels on the shipped world", () => {
    expect(barrelSpawns(makeWorld(1337)).length).toBeGreaterThan(0);
  });

  it("stands every barrel OUTSIDE every building footprint (no wall/roof spawns)", () => {
    for (const seed of seeds) {
      const w = makeWorld(seed);
      for (const s of barrelSpawns(w)) {
        expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z)).toBe(true);
        for (const b of w.buildings) {
          const outside = Math.abs(s.x - b.cx) > b.halfW || Math.abs(s.z - b.cz) > b.halfD;
          expect(outside).toBe(true);
        }
      }
    }
  });

  it("scales up with more buildings at larger tiers (still capped)", () => {
    const std = barrelSpawns(makeWorld(1337, "standard")).length;
    const huge = barrelSpawns(makeWorld(1337, "huge")).length;
    expect(huge).toBeGreaterThanOrEqual(std);
    expect(huge).toBeLessThanOrEqual(MAX_BARRELS);
  });
});

describe("BARREL_LOOT_TABLE — the break roll's source of truth", () => {
  it("is a non-empty, well-formed weighted table of real items", () => {
    expect(BARREL_LOOT_TABLE.length).toBeGreaterThan(0);
    for (const entry of BARREL_LOOT_TABLE) {
      expect(entry.weight).toBeGreaterThan(0);
      expect(entry.min).toBeGreaterThanOrEqual(1);
      expect(entry.max).toBeGreaterThanOrEqual(entry.min);
      // Every drop is a real ItemType the client can render.
      expect(ITEM_DEFS[entry.type]).toBeDefined();
    }
  });
});
