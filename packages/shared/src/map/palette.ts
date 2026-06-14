// The map biome palette — the single source of truth for terrain coloring,
// lifted out of apps/game/src/client/render/world/Terrain.tsx so the in-game
// map, the offline render, and the 3D terrain never drift. Terrain.tsx keeps its
// THREE.Color linear-space conversion; only these literals + the lerp math are
// shared. The map works in authored sRGB hex directly (it is a flat 2D image, no
// lighting), so colors here are taken as authored — a faithful, not exact, match
// to the lit terrain.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Authored sRGB hex, matching Terrain.tsx (water tones match the --ui-water token). */
export const MAP_PALETTE = {
  sand: "#c2b280",
  grassLow: "#5a7247",
  grassHigh: "#49593b",
  rock: "#7d7f78",
  waterShallow: "#3e7fa8",
  waterDeep: "#1d3a52",
} as const;

/** Biome thresholds, identical to Terrain.tsx:19-22. */
export const MAP_BIOME = {
  sandMaxH: 1.5,
  rockHeight: 14,
  rockSlopeStart: 0.32,
  rockSlopeFull: 0.52,
} as const;

/** Depth (meters below the waterline) at which water reads fully "deep". */
const WATER_DEEP_AT = 6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

const SAND = hexToRgb(MAP_PALETTE.sand);
const GRASS_LOW = hexToRgb(MAP_PALETTE.grassLow);
const GRASS_HIGH = hexToRgb(MAP_PALETTE.grassHigh);
const ROCK = hexToRgb(MAP_PALETTE.rock);
const WATER_SHALLOW = hexToRgb(MAP_PALETTE.waterShallow);
const WATER_DEEP = hexToRgb(MAP_PALETTE.waterDeep);

/**
 * Land color at height `h` (meters) with local gradient magnitude `slope`
 * (m/m). Replicates Terrain.tsx:44-53 — grass low->high by altitude, sand near
 * the waterline, bare rock on steep faces and high ground — in sRGB space.
 */
export function biomeColorAt(h: number, slope: number): RGB {
  let c = lerpRgb(GRASS_LOW, GRASS_HIGH, clamp01((h - 2) / 14));
  c = lerpRgb(c, SAND, clamp01((MAP_BIOME.sandMaxH + 0.3 - h) / 0.6));
  const rockT = Math.max(
    clamp01((slope - MAP_BIOME.rockSlopeStart) / (MAP_BIOME.rockSlopeFull - MAP_BIOME.rockSlopeStart)),
    clamp01((h - MAP_BIOME.rockHeight) / 2.5),
  );
  return lerpRgb(c, ROCK, rockT);
}

/** Ocean color at `depth` = (waterLevel - h), ramped shallow->deep so coasts read. */
export function waterColorAt(depth: number): RGB {
  return lerpRgb(WATER_SHALLOW, WATER_DEEP, clamp01(depth / WATER_DEEP_AT));
}
