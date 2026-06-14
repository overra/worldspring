// The map raster core: turn a deterministic World into (a) a top-down biome
// raster and (b) a set of render-target-agnostic POI vector shapes. Pure and
// three.js-free, so both the Node offline script and the in-game 2D canvas
// import one codepath. The caller owns the surface: it paints the RGBA buffer
// and strokes the projected shapes onto a CanvasRenderingContext2D (browser) or
// into an SVG/PNG (Node).

import type { World, Building } from "../world";
import { biomeColorAt, waterColorAt } from "./palette";

export interface BaseRasterResult {
  /** square image dimension. */
  px: number;
  /** RGBA, length px*px*4, row-major, top row = north (-Z). Opaque (a=255). */
  pixels: Uint8ClampedArray;
}

/**
 * Rasterize the biome base. Per pixel: image->world, sample heightAt; below
 * waterLevel -> water ramp, else central-difference slope (±2m, matching
 * Terrain.tsx) -> biome color. `size` is the world extent in meters (pass
 * WORLD_SIZE, or world.size once doc 07 lands it) — never hardcoded here.
 */
export function rasterizeBase(
  heightAt: (x: number, z: number) => number,
  size: number,
  px: number,
  waterLevel: number,
): BaseRasterResult {
  const pixels = new Uint8ClampedArray(px * px * 4);
  const half = size / 2;
  const mpp = size / px;
  for (let iy = 0; iy < px; iy++) {
    // pixel center -> world z (north/-Z at the top)
    const z = half - (iy + 0.5) * mpp;
    for (let ix = 0; ix < px; ix++) {
      const x = -half + (ix + 0.5) * mpp;
      const h = heightAt(x, z);
      let r: number;
      let g: number;
      let b: number;
      if (h < waterLevel) {
        const c = waterColorAt(waterLevel - h);
        r = c.r;
        g = c.g;
        b = c.b;
      } else {
        const dhdx = (heightAt(x + 2, z) - heightAt(x - 2, z)) / 4;
        const dhdz = (heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
        const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
        const c = biomeColorAt(h, slope);
        r = c.r;
        g = c.g;
        b = c.b;
      }
      const o = (iy * px + ix) * 4;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 255;
    }
  }
  return { px, pixels };
}

/** A render-target-agnostic POI shape in WORLD coordinates. The caller projects. */
export type MapShape =
  | { kind: "disc"; x: number; z: number; r: number; fill: string; stroke?: string }
  | { kind: "rect"; cx: number; cz: number; halfW: number; halfD: number; fill: string; stroke?: string }
  | { kind: "ring"; x: number; z: number; r: number; stroke: string }
  | { kind: "label"; x: number; z: number; text: string };

export interface POILayerOpts {
  /** beach spawn ring (default true). */
  showSpawns?: boolean;
  /** town name labels (default true). */
  showLabels?: boolean;
  /** loot-tier building tinting beyond the area color (default false; clutter). */
  showLoot?: boolean;
}

/** Building footprint fill by zone. */
const BUILDING_FILL: Record<Building["area"], string> = {
  town: "#caa46a",
  wild: "#8a8a7a",
  military: "#b85a4a",
};

/**
 * The POI vector layer (towns, the military compound, building footprints, the
 * spawn ring) in world space. Live player/entity markers are NOT here — those
 * are dynamic and owned by the client render layer.
 */
export function mapPOIs(world: World, opts: POILayerOpts = {}): MapShape[] {
  const showSpawns = opts.showSpawns ?? true;
  const showLabels = opts.showLabels ?? true;
  const shapes: MapShape[] = [];

  // Zone discs (under everything else).
  for (const t of world.towns) {
    shapes.push({ kind: "disc", x: t.cx, z: t.cz, r: t.radius, fill: "rgba(120,140,90,0.18)" });
  }
  shapes.push({
    kind: "disc",
    x: world.military.cx,
    z: world.military.cz,
    r: world.military.radius,
    fill: "rgba(150,60,50,0.16)",
  });

  // Building footprints.
  for (const b of world.buildings) {
    shapes.push({
      kind: "rect",
      cx: b.cx,
      cz: b.cz,
      halfW: b.halfW,
      halfD: b.halfD,
      fill: BUILDING_FILL[b.area],
      stroke: "rgba(20,20,20,0.55)",
    });
  }

  // Spawn ring.
  if (showSpawns) {
    for (const s of world.spawnPoints) {
      shapes.push({ kind: "disc", x: s.x, z: s.z, r: 3, fill: "rgba(240,230,140,0.9)" });
    }
  }

  // Town labels (drawn last, on top).
  if (showLabels) {
    for (const t of world.towns) {
      shapes.push({ kind: "label", x: t.cx, z: t.cz, text: t.name });
    }
  }

  return shapes;
}
