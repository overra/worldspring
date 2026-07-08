// Doc 06 M5–M7 — shared-layer coverage for the crate piece kind (free in-cell
// placement, own occupancy map, zero collision boxes) and the raid damage
// table. The server-system behavior (locks/backoff, cMove, decay, damage
// application) lives in apps/game/scripts/structures.mjs — the established
// server harness; this file owns what is shared and deterministic.

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, worldParamsOf } from "./config";
import { BUILD_CELL } from "./constants";
import {
  CRATE_HEIGHT,
  CRATE_SIZE,
  PIECE_DEFS,
  PLACEABLE_KINDS,
  TIER_DMG_MULT,
  canPlace,
  computeFoundationFloorY,
  crateAabb,
  pieceAabbs,
  pieceCenter,
  quantizeFloorY,
  targetFloorY,
  type StructurePiece,
} from "./structures";
import { createWorld } from "./world";

const world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));

/** First cell (scanning outward) where a foundation legally places — the
 * structures.mjs findBuildableCell pattern, official seed. */
function findBuildableCell(): [number, number] {
  for (let r = 8; r < 120; r++) {
    for (const [gx, gz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [r, r],
      [-r, -r],
      [r, -r],
      [-r, r],
    ] as const) {
      if (canPlace(world, { kind: "foundation", tier: 0, gx, gz }) === null) return [gx, gz];
    }
  }
  throw new Error("no buildable cell at the official seed");
}
const [BGX, BGZ] = findBuildableCell();

describe("crate piece kind (doc 06 M6)", () => {
  it("is placeable (PLACEABLE_KINDS carries all 7 kinds)", () => {
    expect(PLACEABLE_KINDS).toContain("crate");
    expect(PLACEABLE_KINDS.length).toBe(7);
    expect(Object.keys(PIECE_DEFS).length).toBe(7);
  });

  it("rejects a scrap-tier crate (wood-only v1, parser parity)", () => {
    expect(canPlace(world, { kind: "crate", tier: 1, gx: BGX, gz: BGZ })).toBe("kind");
  });

  it("derives ZERO collision boxes (non-colliding, campfire precedent)", () => {
    const crate: StructurePiece = {
      id: 1,
      kind: "crate",
      tier: 0,
      gx: BGX,
      gz: BGZ,
      x: BGX * BUILD_CELL + 1,
      z: BGZ * BUILD_CELL + 1,
      floorY: 2,
      hp: 200,
    };
    expect(pieceAabbs(crate)).toEqual([]);
  });

  it("is raycast-attributable via crateAabb but never collides (queryWalls)", () => {
    // review: pieceAabbs [] made crates invisible to raycastPiece, so combat
    // could never damage them — the doc's destruction-spill (06:214) was dead
    // code and a foreign crate an indestructible cell blocker. The index now
    // carries a RAYCAST-ONLY body box; movement/overlap stay box-free.
    const x = BGX * BUILD_CELL + 1.5;
    const z = BGZ * BUILD_CELL + 1.5;
    const fy = 2;
    const crate: StructurePiece = {
      id: 9010,
      kind: "crate",
      tier: 0,
      gx: BGX,
      gz: BGZ,
      x,
      z,
      floorY: fy,
      hp: 200,
    };
    world.structures.add(crate);
    try {
      const box = crateAabb(crate);
      expect(box.y1 - box.y0).toBeCloseTo(CRATE_HEIGHT, 10);
      // A ray through the body mid-height attributes the crate…
      const origin = { x: x - 3, y: fy + CRATE_HEIGHT / 2, z };
      const hit = world.structures.raycastPiece(origin, { x: 1, y: 0, z: 0 }, 6);
      expect(hit?.id).toBe(9010);
      expect(hit?.t).toBeCloseTo(3 - CRATE_SIZE / 2, 5);
      // …and world.raycastStatics folds the same box in (pellet capping).
      expect(world.raycastStatics(origin, { x: 1, y: 0, z: 0 }, 6, false)).toBeCloseTo(
        3 - CRATE_SIZE / 2,
        5,
      );
      // But movement/overlap collision stays EMPTY: not in queryWalls…
      expect(world.structures.queryWalls(x, z, 2)).toEqual([]);
      // …and remove() clears the raycast box with the piece.
      world.structures.remove(9010);
      expect(world.structures.raycastPiece(origin, { x: 1, y: 0, z: 0 }, 6)).toBeNull();
    } finally {
      world.structures.remove(9010);
    }
  });

  it("pieceCenter honors the free in-cell position", () => {
    const x = BGX * BUILD_CELL + 0.4;
    const z = BGZ * BUILD_CELL + 2.2;
    expect(pieceCenter({ kind: "crate", gx: BGX, gz: BGZ, x, z })).toEqual([x, z]);
    // Absent free position falls back to the cell center.
    expect(pieceCenter({ kind: "crate", gx: BGX, gz: BGZ })).toEqual([
      BGX * BUILD_CELL + BUILD_CELL / 2,
      BGZ * BUILD_CELL + BUILD_CELL / 2,
    ]);
  });

  it("places on bare terrain and shares a cell with a foundation", () => {
    const x = BGX * BUILD_CELL + 1;
    const z = BGZ * BUILD_CELL + 1;
    expect(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x, z })).toBeNull();
    // targetFloorY on terrain = quantized heightAt.
    expect(targetFloorY(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x, z })).toBe(
      quantizeFloorY(world.heightAt(x, z)),
    );

    const fy = computeFoundationFloorY(world, BGX, BGZ);
    world.structures.add({ id: 9001, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 });
    try {
      // Foundation in the cell does NOT occupy the crate slot…
      expect(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x, z })).toBeNull();
      // …and the crate inherits the slab top.
      expect(targetFloorY(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x, z })).toBe(fy);

      world.structures.add({ id: 9002, kind: "crate", tier: 0, gx: BGX, gz: BGZ, x, z, floorY: fy, hp: 200 });
      try {
        // One crate per cell.
        expect(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: x + 1, z })).toBe("occupied");
        expect(world.structures.cratePiece(BGX, BGZ)?.id).toBe(9002);
        // The foundation slot is still the foundation's.
        expect(world.structures.cellPiece(BGX, BGZ)?.id).toBe(9001);
      } finally {
        world.structures.remove(9002);
      }
      expect(world.structures.cratePiece(BGX, BGZ)).toBeNull();
    } finally {
      world.structures.remove(9001);
    }
  });

  it("rejects a free position outside the addressed cell (bounds)", () => {
    const outX = (BGX + 1) * BUILD_CELL + 0.5; // next cell over
    expect(
      canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: outX, z: BGZ * BUILD_CELL + 1 }),
    ).toBe("bounds");
    // One coord without the other is malformed.
    expect(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: BGX * BUILD_CELL + 1 })).toBe(
      "bounds",
    );
    // Non-crate kinds must not carry a free position.
    expect(
      canPlace(world, {
        kind: "foundation",
        tier: 0,
        gx: BGX,
        gz: BGZ,
        x: BGX * BUILD_CELL + 1,
        z: BGZ * BUILD_CELL + 1,
      }),
    ).toBe("bounds");
  });

  it("rejects a crate in the sea (water) but not on a foundation", () => {
    // Scan outward for a wet cell (the structures.mjs water-scan pattern).
    let found = false;
    outer: for (let r = 100; r < 128; r++) {
      for (let g = -r; g <= r; g += 7) {
        const x = r * BUILD_CELL + 1;
        const z = g * BUILD_CELL + 1;
        if (canPlace(world, { kind: "crate", tier: 0, gx: r, gz: g, x, z }) === "water") {
          found = true;
          break outer;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe("TIER_DMG_MULT (doc 06 M7 — raid math table)", () => {
  it("matches the doc: wood [1.0, 0.5], scrap [0.25, 0.25]", () => {
    expect(TIER_DMG_MULT[0]).toEqual([1.0, 0.5]);
    expect(TIER_DMG_MULT[1]).toEqual([0.25, 0.25]);
  });

  it("keeps the doc raid-time envelope: an axe (6) fells a wood door in ~30s", () => {
    // 250 hp / (6 dmg × 1.0 mult) ≈ 42 swings; at 0.7s cooldown ≈ 29s.
    const swings = Math.ceil(PIECE_DEFS.door.hp[0] / (6 * TIER_DMG_MULT[0][0]));
    expect(swings * 0.7).toBeGreaterThan(25);
    expect(swings * 0.7).toBeLessThan(35);
  });
});
