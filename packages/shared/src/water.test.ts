// doc 07 M5 — fresh water (rivers + ponds) determinism, crossability, perf, and
// the placement water-rejections. The byte-identity of the DRY world is owned by
// the CI worldgen fingerprint gate (scripts/fingerprint.mjs vs
// world.fingerprint.txt); these vitest cases pin the WET world's determinism and
// the design invariants the fingerprint can't read directly (ford spacing, the
// dry heightAt overhead, no static in carved water).

import { describe, expect, it } from "vitest";

import { tierParamsOf } from "./config";
import { RIVER_FORD_DEPTH, RIVER_POOL_DEPTH } from "./constants";
import { createRng } from "./rng";
import { createWorld } from "./world";
import type { World } from "./world";

type Tier = "standard" | "large" | "huge";

function dryWorld(seed: number, tier: Tier = "standard"): World {
  return createWorld({ seed, ...tierParamsOf(tier), waterFeatures: false });
}
function wetWorld(seed: number, tier: Tier = "standard"): World {
  return createWorld({ seed, ...tierParamsOf(tier), waterFeatures: true });
}

// The M7 wade limit is 0.55 (WADE_MAX_DEPTH, doc §6). It is not a shipped
// constant until M7, so this test pins the value it depends on locally.
const WADE = 0.55;

describe("waterFeatures:false takes the exact dry path", () => {
  it("omitted === explicit-false, and neither carries a water field", () => {
    for (const tier of ["standard", "large"] as const) {
      const omitted = createWorld({ seed: 1337, ...tierParamsOf(tier) });
      const explicitFalse = createWorld({ seed: 1337, ...tierParamsOf(tier), waterFeatures: false });
      expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicitFalse));
      expect(omitted.water).toBeUndefined();
      expect(explicitFalse.water).toBeUndefined();
    }
  });

  it("dry heightAt is unchanged by the water plumbing (== a base sample)", () => {
    const w = dryWorld(1337);
    // waterAt is null everywhere except the ocean (heightAt < 0); on dry land
    // it must be null (no fresh water exists).
    expect(w.waterAt(0, 0)).not.toBeUndefined();
    const rng = createRng(0xabc);
    for (let i = 0; i < 500; i++) {
      const x = rng.range(-200, 200);
      const z = rng.range(-200, 200);
      const h = w.heightAt(x, z);
      const wa = w.waterAt(x, z);
      if (h >= 0) expect(wa).toBeNull(); // dry land / above the ocean
      else expect(wa).toEqual({ surface: 0, depth: -h }); // ocean
    }
  });
});

describe("wet world is deterministic (same seed → identical carve + records)", () => {
  for (const tier of ["standard", "large", "huge"] as const) {
    it(`${tier}: two runs serialize identically and carve identically`, () => {
      const a = wetWorld(2026, tier);
      const b = wetWorld(2026, tier);
      // Records (rivers/ponds) byte-identical.
      expect(JSON.stringify(a.water)).toBe(JSON.stringify(b.water));
      // Carved heightAt bit-identical on a lattice spanning the world.
      const half = a.size / 2;
      for (let i = 0; i <= 24; i++) {
        for (let j = 0; j <= 24; j++) {
          const x = -half + (i / 24) * a.size;
          const z = -half + (j / 24) * a.size;
          expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
          const wa = a.waterAt(x, z);
          const wb = b.waterAt(x, z);
          expect(wa).toEqual(wb);
        }
      }
    });
  }
});

describe("the carve is real (water changes heightAt)", () => {
  it("at least one river-centreline point is carved below the base height", () => {
    const wet = wetWorld(1337);
    const dry = dryWorld(1337);
    let carvedSomewhere = false;
    for (const river of wet.water!.rivers) {
      for (const v of river.verts) {
        if (wet.heightAt(v.x, v.z) < dry.heightAt(v.x, v.z) - 0.2) {
          carvedSomewhere = true;
          break;
        }
      }
      if (carvedSomewhere) break;
    }
    expect(carvedSomewhere).toBe(true);
    // Away from water the carve touches nothing: over dry-LAND points (excluding
    // the ocean, which dominates the map corners) the two worlds' heightAt agree
    // for the vast majority — only the near-river/pond minority differs.
    const rng = createRng(1);
    let land = 0;
    let landMatches = 0;
    for (let i = 0; i < 4000; i++) {
      const x = rng.range(-260, 260);
      const z = rng.range(-260, 260);
      if (dry.heightAt(x, z) <= 0.5) continue; // ocean/beach — skip
      land++;
      if (wet.heightAt(x, z) === dry.heightAt(x, z)) landMatches++;
    }
    expect(land).toBeGreaterThan(500);
    expect(landMatches / land).toBeGreaterThan(0.9); // carve is a local minority of the land
  });
});

describe("rivers are crossable: fords every ~100m, pools block", () => {
  it("bedDepth spans ford (0.45) to pool (1.4) and fords recur < 150m apart", () => {
    for (const tier of ["standard", "large", "huge"] as const) {
      for (const seed of [1337, 42, 7]) {
        const w = wetWorld(seed, tier);
        for (const river of w.water!.rivers) {
          const v = river.verts;
          expect(v.length).toBeGreaterThanOrEqual(2);
          // Every river carries both crossings and blockers.
          const hasFord = v.some((vv) => vv.bedDepth < WADE);
          const hasPool = v.some((vv) => vv.bedDepth > WADE);
          expect(hasFord).toBe(true);
          expect(hasPool).toBe(true);
          // No 150m stretch of channel without a ford: walk the polyline,
          // resetting the run at each ford vertex; the run never reaches 150m.
          let run = 0;
          let maxRun = 0;
          for (let i = 0; i < v.length; i++) {
            if (v[i].bedDepth < WADE) {
              run = 0;
            } else if (i > 0) {
              run += Math.hypot(v[i].x - v[i - 1].x, v[i].z - v[i - 1].z);
              if (run > maxRun) maxRun = run;
            }
          }
          expect(maxRun).toBeLessThan(150);
        }
      }
    }
  });

  it("bedDepth bounds match the FORD/POOL constants", () => {
    const w = wetWorld(42);
    for (const river of w.water!.rivers) {
      for (const v of river.verts) {
        expect(v.bedDepth).toBeGreaterThanOrEqual(RIVER_FORD_DEPTH - 1e-9);
        expect(v.bedDepth).toBeLessThanOrEqual(RIVER_POOL_DEPTH + 1e-9);
      }
    }
  });

  it("waterAt: clean inland fords wade, pools block (isolated from ocean/pond)", () => {
    // The carved field a player actually reads. Isolate the RIVER channel: skip
    // vertices over the ocean delta (base ≤1.5) and vertices inside a pond, so
    // ocean/pond depth doesn't confound the river's own bed. Every water world
    // then has at least one wadeable ford and one blocking pool, and no clean
    // inland pool vertex ever wades.
    for (const tier of ["standard", "large", "huge"] as const) {
      for (const seed of [1337, 42, 2026]) {
        const w = wetWorld(seed, tier);
        const dry = dryWorld(seed, tier);
        let anyFordWades = false;
        let anyPoolBlocks = false;
        for (const river of w.water!.rivers) {
          for (const v of river.verts) {
            if (dry.heightAt(v.x, v.z) <= 1.5) continue; // ocean-delta stretch
            const inPond = w.water!.ponds.some(
              (p) => (p.cx - v.x) ** 2 + (p.cz - v.z) ** 2 < p.radius * p.radius,
            );
            if (inPond) continue;
            const wa = w.waterAt(v.x, v.z);
            if (wa === null) continue;
            if (v.bedDepth < 0.5 && wa.depth < WADE) anyFordWades = true;
            if (v.bedDepth > 1.2) {
              expect(wa.depth).toBeGreaterThan(WADE); // a pool never wades
              anyPoolBlocks = true;
            }
          }
        }
        expect(anyFordWades).toBe(true);
        expect(anyPoolBlocks).toBe(true);
      }
    }
  });
});

describe("every river reaches the sea or a terminus pond (no dead-end trenches)", () => {
  it("last vertex is near sea level OR a pond sits at the mouth", () => {
    for (const tier of ["standard", "large", "huge"] as const) {
      for (const seed of [1337, 0, 1, 42, 7, 2026]) {
        const w = wetWorld(seed, tier);
        const dry = dryWorld(seed, tier);
        for (const river of w.water!.rivers) {
          const last = river.verts[river.verts.length - 1];
          const reachedSea = dry.heightAt(last.x, last.z) <= 0.2 + 1e-6;
          const terminusPond = w.water!.ponds.some(
            (p) => (p.cx - last.x) ** 2 + (p.cz - last.z) ** 2 < (p.radius + 1) ** 2,
          );
          // STRICT: an inland stop (basin or the march cap) always pools into a
          // terminus lake, so the union holds for every river with no exceptions.
          expect(reachedSea || terminusPond).toBe(true);
        }
      }
    }
  });
});

describe("no static (building/tree/rock/spawn) lands in carved water", () => {
  for (const tier of ["standard", "large"] as const) {
    it(`${tier}: every placement is on dry land (waterAt null)`, () => {
      for (const seed of [1337, 42]) {
        const w = wetWorld(seed, tier);
        for (const b of w.buildings) expect(w.waterAt(b.cx, b.cz)).toBeNull();
        for (const t of w.trees) expect(w.waterAt(t.x, t.z)).toBeNull();
        for (const p of w.props) if (p.kind.startsWith("rock")) expect(w.waterAt(p.x, p.z)).toBeNull();
        for (const s of w.spawnPoints) expect(w.waterAt(s.x, s.z)).toBeNull();
      }
    });
  }
});

describe("perf: carved heightAt ≤ 2× base cost on dry points", () => {
  it("standard tier microbench", () => {
    const wet = wetWorld(2026);
    const dry = dryWorld(2026); // dry.heightAt === the base formula
    const half = wet.size / 2;
    // Gather DRY probe points (empty water cells) — the common case heightAt hits.
    const rng = createRng(0xf00d);
    const pts: Array<[number, number]> = [];
    while (pts.length < 4000) {
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      if (wet.waterAt(x, z) === null) pts.push([x, z]);
    }
    const run = (fn: (x: number, z: number) => number): number => {
      let acc = 0;
      const t0 = performance.now();
      for (let r = 0; r < 40; r++) for (const [x, z] of pts) acc += fn(x, z);
      const dt = performance.now() - t0;
      if (!Number.isFinite(acc)) throw new Error("nan"); // keep the loop honest
      return dt;
    };
    // Warm both JITs, then take the min of several rounds (least noisy).
    for (let i = 0; i < 3; i++) {
      run(dry.heightAt);
      run(wet.heightAt);
    }
    let baseMin = Infinity;
    let wetMin = Infinity;
    for (let i = 0; i < 7; i++) {
      baseMin = Math.min(baseMin, run(dry.heightAt));
      wetMin = Math.min(wetMin, run(wet.heightAt));
    }
    // The dry-point overhead is one grid Map.get miss + a closure hop over the
    // base noise eval; comfortably under 2×.
    expect(wetMin).toBeLessThanOrEqual(baseMin * 2);
  });
});
