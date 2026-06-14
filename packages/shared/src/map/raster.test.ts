// packages/shared/src/map/raster.test.ts — doc 12 M1. Locks the shared map
// raster core: the projection orientation (north = +Z is image-up), that the
// biome raster paints ocean blue and land green for the prod seed, and that the
// POI layer surfaces the town names + a footprint per building. Pure shared
// code, plain node env — no canvas, no three.js.

import { describe, expect, it } from "vitest";

import { WATER_LEVEL, WORLD_SIZE } from "../constants";
import { createWorld } from "../world";
import { makeProjection } from "./projection";
import { mapPOIs, rasterizeBase } from "./raster";

describe("makeProjection", () => {
  const p = makeProjection(WORLD_SIZE, 64);

  it("puts north (+Z) at the top, east (-X) on the right, and centers the origin", () => {
    expect(p.worldToImage(0, WORLD_SIZE / 2).iy).toBeCloseTo(0); // +Z (north) -> top
    expect(p.worldToImage(0, -WORLD_SIZE / 2).iy).toBeCloseTo(64); // -Z (south) -> bottom
    expect(p.worldToImage(WORLD_SIZE / 2, 0).ix).toBeCloseTo(0); // +X (west) -> left
    expect(p.worldToImage(-WORLD_SIZE / 2, 0).ix).toBeCloseTo(64); // -X (east) -> right
    expect(p.worldToImage(0, 0).ix).toBeCloseTo(32); // origin -> center
  });

  it("round-trips world <-> image", () => {
    const { x, z } = p.imageToWorld(50, 10);
    const { ix, iy } = p.worldToImage(x, z);
    expect(ix).toBeCloseTo(50);
    expect(iy).toBeCloseTo(10);
  });
});

describe("rasterizeBase", () => {
  const world = createWorld(1337);
  const px = 64;
  const { pixels } = rasterizeBase(world.heightAt, WORLD_SIZE, px, WATER_LEVEL);
  const at = (ix: number, iy: number): { r: number; g: number; b: number } => {
    const o = (iy * px + ix) * 4;
    return { r: pixels[o], g: pixels[o + 1], b: pixels[o + 2] };
  };

  it("paints a full opaque image", () => {
    expect(pixels.length).toBe(px * px * 4);
    expect(pixels[3]).toBe(255);
  });

  it("paints the ocean corner blue and the island center green", () => {
    const corner = at(0, 0); // image origin = world (+half,+half) corner = open sea on this island
    expect(world.heightAt(WORLD_SIZE / 2, WORLD_SIZE / 2)).toBeLessThan(WATER_LEVEL);
    expect(corner.b).toBeGreaterThan(corner.r); // water reads blue

    const center = at(px / 2, px / 2); // origin = inland (the military plateau)
    expect(world.heightAt(0, 0)).toBeGreaterThanOrEqual(WATER_LEVEL);
    expect(center.g).toBeGreaterThan(center.b); // land reads green
  });
});

describe("mapPOIs", () => {
  const world = createWorld(1337);
  const shapes = mapPOIs(world);

  it("emits a footprint rect per building and a label per town", () => {
    const rects = shapes.filter((s) => s.kind === "rect");
    const labels = shapes.filter((s) => s.kind === "label");
    expect(rects.length).toBe(world.buildings.length);
    expect(labels.map((s) => (s.kind === "label" ? s.text : "")).sort()).toEqual(
      world.towns.map((t) => t.name).sort(),
    );
  });
});
