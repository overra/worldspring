// Tree lifecycle — the pure, shared, deterministic core: wall-clock stage
// thresholds, RNG-free per-stage geometry, and the mutable spatial index that
// server authority and client prediction BOTH query (so collision is identical
// on both ends). These have no worldgen rng and never touch world.trees, so
// they cannot move the worldgen fingerprint.

import { describe, expect, it } from "vitest";

import {
  createPlantedTreeIndex,
  plantedTreeGeometry,
  STUMP_HEIGHT,
  TREE_MATURE_AT_MS,
  TREE_YOUNG_AT_MS,
  treeStageAt,
  type PlantedTreeRecord,
  type TreeGrowthStage,
} from "./trees";

function rec(over: Partial<PlantedTreeRecord> = {}): PlantedTreeRecord {
  return {
    id: 1,
    species: "oak",
    appearanceSeed: 0x12345678,
    x: 10,
    z: 20,
    groundY: 5,
    plantedAtMs: 0,
    stage: "mature",
    ...over,
  };
}

describe("treeStageAt — wall-clock thresholds", () => {
  it("advances sapling → young → mature at the named boundaries", () => {
    expect(treeStageAt(0, 0)).toBe("sapling");
    expect(treeStageAt(0, TREE_YOUNG_AT_MS - 1)).toBe("sapling");
    expect(treeStageAt(0, TREE_YOUNG_AT_MS)).toBe("young");
    expect(treeStageAt(0, TREE_MATURE_AT_MS - 1)).toBe("young");
    expect(treeStageAt(0, TREE_MATURE_AT_MS)).toBe("mature");
    expect(treeStageAt(0, TREE_MATURE_AT_MS * 10)).toBe("mature");
  });

  it("clamps negative age (clock skew) to sapling, never throws", () => {
    expect(treeStageAt(1_000_000, 0)).toBe("sapling");
  });

  it("is a pure function of (plantedAtMs, nowMs)", () => {
    const planted = 5_000;
    const now = planted + TREE_MATURE_AT_MS;
    expect(treeStageAt(planted, now)).toBe(treeStageAt(planted, now));
    expect(treeStageAt(planted, now)).toBe("mature");
  });
});

describe("plantedTreeGeometry — deterministic per-stage dimensions", () => {
  it("kind mirrors species", () => {
    expect(plantedTreeGeometry(rec({ species: "conifer" })).kind).toBe("conifer");
    expect(plantedTreeGeometry(rec({ species: "oak" })).kind).toBe("oak");
  });

  it("saplings are walk-through (r === 0) but still have a (small) height to render", () => {
    const g = plantedTreeGeometry(rec({ stage: "sapling" }));
    expect(g.r).toBe(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it("radius and height grow monotonically sapling < young < mature", () => {
    const s = plantedTreeGeometry(rec({ stage: "sapling" }));
    const y = plantedTreeGeometry(rec({ stage: "young" }));
    const m = plantedTreeGeometry(rec({ stage: "mature" }));
    expect(s.height).toBeLessThan(y.height);
    expect(y.height).toBeLessThan(m.height);
    // r: 0 (sapling) < young < mature.
    expect(s.r).toBeLessThan(y.r);
    expect(y.r).toBeLessThan(m.r);
  });

  it("is deterministic for a given record (RNG-free)", () => {
    const r = rec({ appearanceSeed: 0xdeadbeef });
    expect(plantedTreeGeometry(r)).toEqual(plantedTreeGeometry(r));
  });

  it("produces finite dimensions across a wide seed range", () => {
    for (let i = 0; i < 512; i++) {
      const seed = (i * 0x9e3779b1) >>> 0;
      for (const stage of ["sapling", "young", "mature", "stump"] as TreeGrowthStage[]) {
        for (const species of ["conifer", "oak"] as const) {
          const g = plantedTreeGeometry(rec({ appearanceSeed: seed, stage, species }));
          expect(Number.isFinite(g.r)).toBe(true);
          expect(Number.isFinite(g.height)).toBe(true);
          expect(g.height).toBeGreaterThan(0);
          expect(g.r).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("conifers and oaks differ in trunk radius (perceptual variety)", () => {
    const conifer = plantedTreeGeometry(rec({ species: "conifer", stage: "mature" }));
    const oak = plantedTreeGeometry(rec({ species: "oak", stage: "mature" }));
    expect(conifer.r).not.toBe(oak.r);
  });

  it("stump keeps the FULL mature trunk footprint at stub height", () => {
    const stump = plantedTreeGeometry(rec({ stage: "stump" }));
    const mature = plantedTreeGeometry(rec({ stage: "mature" }));
    expect(stump.r).toBe(mature.r); // movement keeps blocking exactly as before
    expect(stump.height).toBe(STUMP_HEIGHT);
    expect(stump.height).toBeLessThan(plantedTreeGeometry(rec({ stage: "sapling" })).height + 1);
  });
});

describe("stump stage — terminal semantics", () => {
  it("treeStageAt never returns stump (age-driven stages only)", () => {
    for (const age of [0, TREE_YOUNG_AT_MS, TREE_MATURE_AT_MS, TREE_MATURE_AT_MS * 100]) {
      expect(treeStageAt(0, age)).not.toBe("stump");
    }
  });

  it("index query INCLUDES stumps (stub footprint stays collidable)", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 9, x: 0, z: 0, stage: "stump" }));
    expect(index.query(0, 0, 2).map((t) => t.id)).toContain(9);
  });
});

describe("createPlantedTreeIndex — mutable shared spatial index", () => {
  it("upsert materializes geometry and stores the tree by id", () => {
    const index = createPlantedTreeIndex();
    const tree = index.upsert(rec({ id: 7, stage: "mature" }));
    expect(tree.id).toBe(7);
    expect(tree.r).toBeGreaterThan(0);
    expect(index.trees.get(7)).toBe(tree);
  });

  it("query returns collidable (young/mature) trees within radius", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 1, x: 0, z: 0, stage: "mature" }));
    const hit = index.query(0.5, 0, 2);
    expect(hit.map((t) => t.id)).toContain(1);
  });

  it("query EXCLUDES saplings (walk-through), even though they're in trees", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 2, x: 0, z: 0, stage: "sapling" }));
    expect(index.trees.has(2)).toBe(true); // rendered
    expect(index.query(0, 0, 3).map((t) => t.id)).not.toContain(2); // not collided
  });

  it("query excludes trees outside the radius", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 3, x: 100, z: 100, stage: "mature" }));
    expect(index.query(0, 0, 5)).toHaveLength(0);
  });

  it("remove drops the tree from both the map and future queries", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 4, x: 0, z: 0, stage: "mature" }));
    expect(index.remove(4)).toBe(true);
    expect(index.trees.has(4)).toBe(false);
    expect(index.query(0, 0, 5)).toHaveLength(0);
    expect(index.remove(4)).toBe(false); // idempotent
  });

  it("re-upsert (growth) updates geometry in place", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 5, x: 0, z: 0, stage: "sapling" }));
    expect(index.query(0, 0, 3)).toHaveLength(0); // sapling: no collider
    const grown = index.upsert(rec({ id: 5, x: 0, z: 0, stage: "mature" }));
    expect(grown.r).toBeGreaterThan(0);
    expect(index.query(0, 0, 3).map((t) => t.id)).toContain(5); // now collides
    expect(index.trees.size).toBe(1); // same id, not a duplicate
  });

  it("re-upsert to a new position re-buckets in the grid (old cell misses, new hits)", () => {
    const index = createPlantedTreeIndex();
    index.upsert(rec({ id: 6, x: 0, z: 0, stage: "mature" }));
    // Move it two grid cells away (GRID_CELL is 16 in trees.ts).
    index.upsert(rec({ id: 6, x: 40, z: 40, stage: "mature" }));
    expect(index.query(0, 0, 3)).toHaveLength(0); // stale cell cleaned up
    expect(index.query(40, 40, 3).map((t) => t.id)).toContain(6);
    expect(index.trees.size).toBe(1);
  });
});
