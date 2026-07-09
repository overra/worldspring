// Deterministic world generation. The client and the GameRoom Durable Object
// each call createWorld(worldParamsOf(config.world)) and MUST get identical
// results — movement prediction depends on it. Keep everything here seeded; no
// Math.random().
//
// doc 07 M2: createWorld takes explicit WorldGenParams (size/counts derived
// from the config sizeTier by config.ts tierParamsOf — this module stays
// config-agnostic). ABSOLUTE constraint: with the standard-tier params (which
// equal the constants below) the output is BIT-IDENTICAL to the pre-M2
// createWorld(seed) — the committed world.fingerprint.txt baseline is the CI
// gate. The nine sequential rng streams (rng/noise/milRng/townRng/bRng/lRng/
// tRng/rockRng/propRng) must never gain or lose a draw at standard scale.

import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { STEP_UP_MAX, TERRAIN_MAX_HEIGHT, WATER_LEVEL, WORLD_SIZE } from "./constants";
import { clamp, distSq2D, rayAabb, type Aabb, type Vec3 } from "./math";
import { createRng, hashString, type Rng } from "./rng";
import { createStructureIndex, type StructureIndex } from "./structures";
import { buildWaterField, type WaterFeatures } from "./water";

export type { River, RiverVertex, Pond, WaterFeatures } from "./water";
export { RIVER_R_MULT } from "./water";

export type BuildingKind = "house" | "shed" | "barn" | "barracks" | "hangar";

/** Which zone a building belongs to — drives its loot table tier. */
export type BuildingArea = "town" | "wild" | "military";

export interface Building {
  id: number;
  kind: BuildingKind;
  area: BuildingArea;
  /** Loot spawn points generated inside this building. */
  lootPoints: number;
  cx: number;
  cz: number;
  halfW: number; // x extent
  halfD: number; // z extent
  floorY: number;
  wallHeight: number;
  /** 0:+Z 1:-Z 2:+X 3:-X — which side the door gap is on. */
  doorSide: number;
  /** Real window openings cut from the walls (and framed by the trim kit).
   * offset = signed distance along the wall from its center. */
  windows: Array<{ side: number; offset: number }>;
  walls: Aabb[];
  roof: Aabb;
}

export interface Tree {
  x: number;
  z: number;
  groundY: number;
  r: number; // trunk collision radius
  height: number;
  kind: "conifer" | "oak";
}

export interface Town {
  cx: number;
  cz: number;
  radius: number;
  name: string;
}

import type { LootTier } from "./items";

export interface LootSpawn {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Zone tier — picks the loot table when (re)stocking. */
  tier: LootTier;
}

/** Searchable container placed inside a building (doc 05 §3). Render-only +
 * a future search prompt — no collision AABB, so the statics grid and
 * movement prediction are untouched. */
export type ContainerKind = "wardrobe" | "cabinet" | "toolbox" | "locker";

export interface WorldContainer {
  /** Sequential as generated — its own id space, like LootSpawn.id. */
  id: number;
  kind: ContainerKind;
  buildingId: number;
  x: number;
  y: number;
  z: number;
  /** Faces away from its wall. */
  yaw: number;
}

export interface MilitaryZone {
  cx: number;
  cz: number;
  radius: number;
}

/** Deterministic set-dressing scatter: rocks island-wide, defensive props
 * inside the military compound. rock_a is walk-through; everything else
 * carries a collision AABB in the statics grid. */
export interface WorldProp {
  kind: "rock_a" | "rock_b" | "rock_c" | "sandbag_wall" | "barrier" | "tent";
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

export interface StaticsQuery {
  walls: Aabb[];
  trees: Tree[];
}

export interface World {
  seed: number;
  /** World edge length in meters (square, centered on origin). Standard tier
   * equals WORLD_SIZE (800); everything downstream reads this, not the
   * constant. */
  size: number;
  heightAt(x: number, z: number): number;
  /** Terrain height plus building floors — what you actually stand on. */
  groundHeight(x: number, z: number): number;
  /**
   * doc 07 M5 — fresh water at (x,z): the ocean (heightAt < WATER_LEVEL) OR a
   * river/pond footprint whose carved bed sits below its surface; the deeper of
   * the two wins, null on dry land. Pure/deterministic — one water-grid Map.get.
   * The wading/drink/fish hooks (doc 07 M7/M12) read this instead of a bare
   * height threshold.
   */
  waterAt(x: number, z: number): { surface: number; depth: number } | null;
  towns: Town[];
  buildings: Building[];
  /** The walled compound: zone bounds + its perimeter/tower collision boxes
   * (already inserted into the static grid; exposed for rendering). */
  military: MilitaryZone;
  militaryWalls: Aabb[];
  /** Set-dressing scatter (rocks + military props). Solid kinds are already
   * inserted into the static collision grid; exposed for rendering. */
  props: WorldProp[];
  trees: Tree[];
  lootSpawns: LootSpawn[];
  /** doc 07 M5 — fresh-water geometry (river polylines + pond basins). Present
   * ONLY on a water world (waterFeatures:true); ABSENT on the default dry world
   * so its serialized shape stays byte-identical (the fingerprint gate). Pure
   * worldgen output — the client renders the surfaces; the carve is already
   * folded into heightAt/waterAt. */
  water?: WaterFeatures;
  /** Searchable containers inside buildings (doc 05 §3). Render-only — no
   * collision, generated by a hash-salted stream after every other stream. */
  containers: WorldContainer[];
  spawnPoints: Array<{ x: number; z: number }>;
  /** doc 06 — player-built structures. A MUTABLE index created EMPTY here
   * (zero rng draws — worldgen determinism untouched); the server is the only
   * mutation originator and both sides apply identical add/remove/setOpen
   * records, so the three query methods below see identical collision on
   * client and server. */
  structures: StructureIndex;
  /** Static colliders (wall boxes + tree trunks) near a point. */
  queryStatics(x: number, z: number, r: number): StaticsQuery;
  /**
   * Nearest hit distance vs walls/roofs (+terrain unless includeTerrain is
   * false), or null. dir must be normalized. Melee occlusion passes false —
   * a chest-high ray over bumpy ground must not block point-blank swings.
   */
  raycastStatics(origin: Vec3, dir: Vec3, maxDist: number, includeTerrain?: boolean): number | null;
}

const WALL_THICKNESS = 0.35;
const WALL_HEIGHT = 3.0;
const DOOR_WIDTH = 1.6;
const GRID_CELL = 16;
/**
 * Walls extend this far below the floor so buildings on slopes read as
 * founded in the terrain instead of floating. Collision is y-aware
 * (movement.ts), so the below-floor portion never blocks anyone standing
 * above it, and the door sill reads as a normal step.
 */
const FOUNDATION_DEPTH = 3.6;

const TOWN_NAMES = ["Staroye", "Kamensk", "Vybor", "Polana", "Gorka", "Zeleno"];

interface BuildingSpec {
  kind: BuildingKind;
  halfW: number;
  halfD: number;
  lootPoints: number;
}

const BUILDING_SPECS: BuildingSpec[] = [
  { kind: "house", halfW: 3.5, halfD: 4.5, lootPoints: 2 },
  { kind: "shed", halfW: 2.2, halfD: 2.2, lootPoints: 1 },
  { kind: "barn", halfW: 5, halfD: 7, lootPoints: 3 },
];

const MILITARY_SPECS: BuildingSpec[] = [
  { kind: "barracks", halfW: 2.8, halfD: 5.5, lootPoints: 3 },
  { kind: "hangar", halfW: 4.5, halfD: 6.5, lootPoints: 4 },
  { kind: "shed", halfW: 2.2, halfD: 2.2, lootPoints: 2 },
];

const MIL_HALF = 40; // compound wall half-extent
const MIL_WALL_HEIGHT = 3.2;
const MIL_WALL_THICKNESS = 0.45;
const MIL_GATE_WIDTH = 4.5;
const MIL_TOWER_HALF = 2;
const MIL_TOWER_HEIGHT = 7.5;

/** Collision footprints for solid set-dressing props (full width x depth in
 * local space + height), scaled by prop.scale. rock_a is deliberately absent
 * — small rocks are walk-through. */
const PROP_FOOTPRINTS = {
  rock_b: { w: 1.2, d: 1.2, h: 1.0 },
  rock_c: { w: 2.2, d: 2.2, h: 1.8 },
  sandbag_wall: { w: 1.2, d: 0.45, h: 0.9 },
  barrier: { w: 1.5, d: 0.4, h: 0.8 },
  tent: { w: 2.0, d: 1.6, h: 1.6 },
} as const;

const ROCK_MIN_TERRAIN_H = 0.8;
/** Rectangle inflation past each building's footprint when placing rocks.
 * Must exceed the largest rotated rock half-extent (rock_c at max scale:
 * 1.1 * 1.2 * sqrt(2) ~= 1.87m) so no rock can touch a wall or block a door. */
const ROCK_BUILDING_MARGIN = 4;
const PROP_LOOTPOINT_CLEARANCE = 1.5; // military props keep loot spawns reachable

function makeHeightFn(noise: NoiseFunction2D, size: number): (x: number, z: number) => number {
  return (x: number, z: number): number => {
    const n =
      0.6 * noise(x * 0.008, z * 0.008) +
      0.3 * noise(x * 0.02 + 100, z * 0.02 + 100) +
      0.1 * noise(x * 0.06 + 200, z * 0.06 + 200);
    const h01 = n * 0.5 + 0.5;
    // Radial island mask scales with the world edge (size is baked into world
    // character). At size === WORLD_SIZE the arithmetic is bit-identical to
    // the pre-M2 constant path.
    const d = Math.sqrt(x * x + z * z) / (size * 0.5);
    let mask = clamp(1.15 - 1.6 * d * d, 0, 1);
    mask = mask * mask * (3 - 2 * mask);
    return (h01 * 0.75 + 0.35) * TERRAIN_MAX_HEIGHT * mask - 4;
  };
}

function slopeAt(heightAt: (x: number, z: number) => number, x: number, z: number, r: number): number {
  const h0 = heightAt(x, z);
  let max = 0;
  for (const [dx, dz] of [
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
  ] as const) {
    max = Math.max(max, Math.abs(heightAt(x + dx, z + dz) - h0));
  }
  return max;
}

/** Window opening: 1.0m wide; sill 0.75 above the floor, head at 1.85. Sill
 * height blocks walking (STEP_UP_MAX 0.6) but not a jump-vault (apex ~0.85),
 * and shots/sight pass — the trim kit frames the same opening. */
const WINDOW_WIDTH = 1.0;
/** Doorway height — matches the trim kit's door frame lintel, closing the
 * wall above it (the gap used to run to the roofline, leaving a visible
 * hole over every door frame). */
const DOOR_HEIGHT = 2.2;
const WINDOW_SILL = 0.75;
const WINDOW_HEAD = 1.85;
/** No window center closer than this to a wall end (corner posts + jambs). */
const WINDOW_EDGE_MARGIN = 1.4;
/** Wide buildings get two windows per wall, others one. */
const WIDE_WINDOW_KINDS = new Set(["barn", "hangar", "barracks"]);

/** Containers stand flush against the inner wall face; this is the gap from
 * the wall plane to the container center (half a placeholder box depth + a
 * sliver so it reads as touching the wall, not embedded in it). */
const CONTAINER_WALL_GAP = 0.35;
/** Re-roll a container's along-wall offset if its center lands within this of
 * a window center on that side (so it doesn't block the opening). */
const CONTAINER_WINDOW_CLEARANCE = 1.0;
/** Keep container centers this far from each wall end (corner posts + jambs),
 * mirroring the window edge margin. */
const CONTAINER_EDGE_MARGIN = 1.0;
/** Roomier buildings get more containers. */
const WIDE_CONTAINER_KINDS = new Set(["barn", "hangar", "barracks"]);
/** Candidate kinds per building kind — picked per container off the same
 * per-building stream. Zone tier is implicit in the building kind. */
const CONTAINER_KINDS_BY_BUILDING: Record<BuildingKind, ContainerKind[]> = {
  house: ["wardrobe", "cabinet"],
  shed: ["toolbox"],
  barn: ["toolbox"],
  barracks: ["locker"],
  hangar: ["locker"],
};

/** Deterministic per-building window layout — keyed off a hash, never the
 * shared worldgen streams, so adding/changing windows can't shift towns,
 * loot or trees for existing worlds. */
function placeWindows(
  seed: number,
  id: number,
  kind: string,
  halfW: number,
  halfD: number,
  doorSide: number,
): Array<{ side: number; offset: number }> {
  const rng = createRng(hashString(`win|${seed}|${id}`) >>> 0);
  const windows: Array<{ side: number; offset: number }> = [];
  const wide = WIDE_WINDOW_KINDS.has(kind);
  for (let side = 0; side < 4; side++) {
    if (side === doorSide) continue;
    const half = side < 2 ? halfW : halfD;
    const usable = half - WINDOW_EDGE_MARGIN;
    if (usable <= 0.2) continue;
    if (wide) {
      windows.push({ side, offset: -rng.range(0.35, 0.8) * usable });
      windows.push({ side, offset: rng.range(0.35, 0.8) * usable });
    } else {
      windows.push({ side, offset: rng.range(-0.6, 0.6) * usable });
    }
  }
  return windows;
}

/** Outward wall normal per side index (0:+Z 1:-Z 2:+X 3:-X). */
const CONTAINER_SIDE_NORMAL: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];
/** yaw facing INTO the room (away from the wall) per side. The container's
 * back is against the wall, so it faces opposite the outward normal. */
const CONTAINER_SIDE_YAW: readonly number[] = [Math.PI, 0, -Math.PI / 2, Math.PI / 2];

/** Deterministic per-building container layout — keyed off a fresh hash
 * stream `cont|seed|id`, drawn only after every other worldgen stream, so it
 * cannot shift towns/buildings/loot/trees for existing worlds (windows
 * precedent). Render-only: no collision AABB. Containers carry their own
 * sequential id space, assigned by the caller. */
function placeContainers(
  seed: number,
  building: Building,
  nextId: () => number,
): WorldContainer[] {
  const rng = createRng(hashString(`cont|${seed}|${building.id}`) >>> 0);
  const wide = WIDE_CONTAINER_KINDS.has(building.kind);
  const count = wide ? rng.int(2, 3) : rng.int(1, 2);
  const kinds = CONTAINER_KINDS_BY_BUILDING[building.kind];
  const out: WorldContainer[] = [];
  // Inner wall face is WALL_THICKNESS inside the half-extent; sit the
  // container center CONTAINER_WALL_GAP further in so it reads as flush.
  const inset = WALL_THICKNESS + CONTAINER_WALL_GAP;
  for (let i = 0; i < count; i++) {
    // Wall side ≠ doorSide.
    let side = rng.int(0, 3);
    if (side === building.doorSide) side = (side + 1) % 4;
    // Side 0/1 are the ±Z walls (run along X, length 2·halfW); 2/3 are the
    // ±X walls (run along Z, length 2·halfD). `normalHalf` is the distance
    // from center to the wall along its normal; `alongHalf` bounds the
    // along-wall offset.
    const normalHalf = side < 2 ? building.halfD : building.halfW;
    const alongHalf = side < 2 ? building.halfW : building.halfD;
    const usable = alongHalf - CONTAINER_EDGE_MARGIN;
    const kind = kinds[rng.int(0, kinds.length - 1)];
    if (usable <= 0.2) {
      // Wall too short to stand a container against — still consume the kind
      // roll above and the offset attempts below so the stream stays fixed.
      for (let a = 0; a < 4; a++) rng.next();
      continue;
    }
    // Re-roll the along-wall offset until it clears every window center on
    // this side (max 4 attempts); skip on exhaustion. Fixed attempt count so
    // the stream is identical whether or not an attempt is accepted.
    const winsOnSide = building.windows.filter((w) => w.side === side).map((w) => w.offset);
    let offset = 0;
    let ok = false;
    for (let a = 0; a < 4; a++) {
      const candidate = rng.range(-usable, usable);
      if (winsOnSide.every((wo) => Math.abs(candidate - wo) >= CONTAINER_WINDOW_CLEARANCE)) {
        offset = candidate;
        ok = true;
        break;
      }
    }
    if (!ok) continue; // exhausted all 4 offset rolls — skip this container
    const [nx, nz] = CONTAINER_SIDE_NORMAL[side];
    const tx = Math.abs(nz); // along-wall tangent (X for Z-walls, 0 for X-walls)
    const tz = Math.abs(nx);
    out.push({
      id: nextId(),
      kind,
      buildingId: building.id,
      x: building.cx + nx * (normalHalf - inset) + tx * offset,
      y: building.floorY,
      z: building.cz + nz * (normalHalf - inset) + tz * offset,
      yaw: CONTAINER_SIDE_YAW[side],
    });
  }
  return out;
}

function buildWalls(b: {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  floorY: number;
  doorSide: number;
  windows: Array<{ side: number; offset: number }>;
}): { walls: Aabb[]; roof: Aabb } {
  const { cx, cz, halfW, halfD, floorY, doorSide } = b;
  const y0 = floorY - FOUNDATION_DEPTH;
  const y1 = floorY + WALL_HEIGHT;
  const t = WALL_THICKNESS;
  const walls: Aabb[] = [];

  // Each side either a full wall box or two boxes leaving a centered door
  // gap, plus a below-floor sill closing the gap down to the foundation.
  const side = (
    which: number,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    horizontal: boolean,
  ): void => {
    if (which !== doorSide) {
      // Cut real openings for this wall's windows: full-height strips
      // between openings, plus below-sill and above-head boxes per opening.
      // Sight, shots and a jump-vault pass; walking does not (sill 0.75).
      const wins = b.windows
        .filter((w) => w.side === which)
        .map((w) => w.offset)
        .sort((p, q) => p - q);
      if (wins.length === 0) {
        walls.push({ minX, minZ, maxX, maxZ, y0, y1 });
        return;
      }
      const lo = horizontal ? minX : minZ;
      const hi = horizontal ? maxX : maxZ;
      const mid = (lo + hi) / 2;
      const sillY = floorY + WINDOW_SILL;
      const headY = floorY + WINDOW_HEAD;
      const strip = (a: number, bnd: number, yLo: number, yHi: number): void => {
        if (bnd - a < 0.01 || yHi - yLo < 0.01) return;
        if (horizontal) walls.push({ minX: a, minZ, maxX: bnd, maxZ, y0: yLo, y1: yHi });
        else walls.push({ minX, minZ: a, maxX, maxZ: bnd, y0: yLo, y1: yHi });
      };
      let cursor = lo;
      for (const off of wins) {
        const a = mid + off - WINDOW_WIDTH / 2;
        const bnd = mid + off + WINDOW_WIDTH / 2;
        strip(cursor, a, y0, y1); // solid strip up to the opening
        strip(a, bnd, y0, sillY); // below the sill
        strip(a, bnd, headY, y1); // above the head
        cursor = bnd;
      }
      strip(cursor, hi, y0, y1);
      return;
    }
    const half = DOOR_WIDTH / 2;
    const headerY = floorY + DOOR_HEIGHT;
    if (horizontal) {
      const mid = (minX + maxX) / 2;
      walls.push({ minX, minZ, maxX: mid - half, maxZ, y0, y1 });
      walls.push({ minX: mid + half, minZ, maxX, maxZ, y0, y1 });
      walls.push({ minX: mid - half, minZ, maxX: mid + half, maxZ, y0, y1: floorY });
      walls.push({ minX: mid - half, minZ, maxX: mid + half, maxZ, y0: headerY, y1 });
    } else {
      const mid = (minZ + maxZ) / 2;
      walls.push({ minX, minZ, maxX, maxZ: mid - half, y0, y1 });
      walls.push({ minX, minZ: mid + half, maxX, maxZ, y0, y1 });
      walls.push({ minX, minZ: mid - half, maxX, maxZ: mid + half, y0, y1: floorY });
      walls.push({ minX, minZ: mid - half, maxX, maxZ: mid + half, y0: headerY, y1 });
    }
  };

  side(0, cx - halfW, cz + halfD - t, cx + halfW, cz + halfD, true); // +Z
  side(1, cx - halfW, cz - halfD, cx + halfW, cz - halfD + t, true); // -Z
  side(2, cx + halfW - t, cz - halfD, cx + halfW, cz + halfD, false); // +X
  side(3, cx - halfW, cz - halfD, cx - halfW + t, cz + halfD, false); // -X

  const roof: Aabb = {
    minX: cx - halfW,
    minZ: cz - halfD,
    maxX: cx + halfW,
    maxZ: cz + halfD,
    y0: y1,
    y1: y1 + 0.3,
  };
  return { walls, roof };
}

/**
 * Explicit worldgen inputs (doc 07 M2). Derived from the config sizeTier by
 * config.ts `worldParamsOf` (integers only, no float math). The standard tier
 * is exactly the shipped constants, so createWorld with those params is
 * bit-identical to the pre-M2 seed-only generator.
 */
export interface WorldGenParams {
  seed: number;
  /** World edge in meters. Standard = WORLD_SIZE (800); large 1600; huge 3200. */
  size: number;
  towns: number;
  cabins: number;
  trees: number;
  rocks: number;
  /** doc 07 M5 — carve rivers + ponds into heightAt. OPTIONAL and default false:
   * an omitted/false value takes the EXACT pre-M5 code path (no water streams,
   * no carve, no grid lookup — heightAt === the base formula), so the dry-world
   * fingerprint stays byte-identical. worldParamsOf supplies world.waterFeatures. */
  waterFeatures?: boolean;
}

/**
 * Per-tier town placement bands (doc 07 §3): the distance ring towns are
 * scattered over and their minimum separation. Keyed off the linear scale
 * (size / WORLD_SIZE); the standard row is EXACTLY today's literals so the
 * rng stream consumes identical values at scale 1.
 */
function townPlacementOf(scale: number): { ringMin: number; ringMax: number; minSep: number } {
  if (scale <= 1) return { ringMin: 70, ringMax: 270, minSep: 150 };
  if (scale <= 2) return { ringMin: 140, ringMax: 620, minSep: 190 };
  return { ringMin: 280, ringMax: 1350, minSep: 230 };
}

export function createWorld(params: WorldGenParams): World {
  const { seed, size } = params;
  // Linear/area scale vs the standard tier. Tier sizes are power-of-two
  // multiples of WORLD_SIZE, so both ratios are exact in float (1/2/4, 1/4/16)
  // and every `cap * areaScale` below is an exact integer.
  const scale = size / WORLD_SIZE;
  const areaScale = scale * scale;
  const rng: Rng = createRng(seed >>> 0);
  const noise = createNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0).next);
  // BASE heightfield (pre-carve). Rivers/ponds march down THIS.
  const baseHeightAt = makeHeightFn(noise, size);

  // --- Fresh water (doc 07 M5) — rivers + ponds carved into heightAt ---
  // Generated FIRST (after the base heightfield, before every placement stream)
  // so military/towns/buildings/trees/rocks/spawns read the CARVED field. Two
  // NEW hash-salted streams (river|/pond|) only — the nine sequential worldgen
  // streams below never gain or lose a draw. When waterFeatures is false this is
  // skipped entirely: `water` is null and heightAt === baseHeightAt (zero grid
  // lookups, zero new draws) — the exact pre-M5 path, byte-identical.
  const water = params.waterFeatures ? buildWaterField({ seed, size }, baseHeightAt) : null;
  const heightAt: (x: number, z: number) => number =
    water === null ? baseHeightAt : (x, z) => water.carvedHeight(x, z, baseHeightAt(x, z));

  // Ocean OR fresh river/pond water at (x,z) — deeper wins, null on dry land.
  const waterAt = (x: number, z: number): { surface: number; depth: number } | null => {
    let best: { surface: number; depth: number } | null = null;
    const h = heightAt(x, z);
    if (h < WATER_LEVEL) best = { surface: WATER_LEVEL, depth: WATER_LEVEL - h };
    if (water !== null) {
      const fresh = water.freshAt(x, z);
      if (fresh !== null && (best === null || fresh.depth > best.depth)) best = fresh;
    }
    return best;
  };
  // PURE water rejection for placement (law #3: no rng draws). Gated on
  // `water !== null` so on the default dry world the check is never evaluated —
  // the placement streams below are provably untouched (byte-identical).
  const inWater = (x: number, z: number): boolean => water !== null && waterAt(x, z) !== null;

  // --- Military compound site (chosen first: everything else avoids it) ---
  // Highest acceptable ground near the island center: the compound should be
  // visible from a distance and force an uphill approach.
  const milRng = createRng((seed ^ 0x3f1c7) >>> 0);
  const military: MilitaryZone = { cx: 0, cz: 0, radius: MIL_HALF + 14 };
  {
    let bestH = -Infinity;
    // Fixed iteration count: every candidate consumes rng regardless of
    // acceptance, so client and server walk identical streams.
    for (let i = 0; i < 600; i++) {
      const ang = milRng.range(0, Math.PI * 2);
      const dist = milRng.range(0, 130);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const h = heightAt(x, z);
      if (slopeAt(heightAt, x, z, MIL_HALF) > 4.5) continue;
      if (h <= bestH) continue;
      bestH = h;
      military.cx = x;
      military.cz = z;
    }
  }

  // --- Towns ---
  // Placement ring + min separation are per-tier rows; the rejection-attempt
  // cap scales with area (×4 large, ×16 huge; exactly 4000 at standard).
  const towns: Town[] = [];
  const townRng = createRng((seed ^ 0x7041) >>> 0);
  const townPlace = townPlacementOf(scale);
  const townAttemptCap = 4000 * areaScale;
  for (let attempt = 0; attempt < townAttemptCap && towns.length < params.towns; attempt++) {
    const ang = townRng.range(0, Math.PI * 2);
    const dist = townRng.range(townPlace.ringMin, townPlace.ringMax);
    const cx = Math.cos(ang) * dist;
    const cz = Math.sin(ang) * dist;
    if (distSq2D(cx, cz, military.cx, military.cz) < (military.radius + 70) ** 2) continue;
    const h = heightAt(cx, cz);
    if (h < 2.5 || h > 9.5) continue;
    if (inWater(cx, cz)) continue; // no town centre in a river/pond (dry: inert)
    if (slopeAt(heightAt, cx, cz, 14) > 3) continue;
    if (towns.some((t) => (t.cx - cx) ** 2 + (t.cz - cz) ** 2 < townPlace.minSep ** 2)) continue;
    towns.push({ cx, cz, radius: townRng.range(26, 38), name: TOWN_NAMES[towns.length] ?? "Outpost" });
  }

  // --- Buildings ---
  const buildings: Building[] = [];
  const bRng = createRng((seed ^ 0xb17d) >>> 0);
  let buildingId = 0;

  const tryPlace = (px: number, pz: number, spec: BuildingSpec, area: BuildingArea): boolean => {
    const margin = 2.5;
    if (slopeAt(heightAt, px, pz, Math.max(spec.halfW, spec.halfD)) > 1.6) return false;
    const h = heightAt(px, pz);
    if (h < 1.5) return false;
    if (inWater(px, pz)) return false; // no building over a river/pond (dry: inert)
    for (const other of buildings) {
      if (
        Math.abs(other.cx - px) < other.halfW + spec.halfW + margin &&
        Math.abs(other.cz - pz) < other.halfD + spec.halfD + margin
      ) {
        return false;
      }
    }
    // Floor sits just above the highest corner so it never clips terrain.
    let floorY = -Infinity;
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      floorY = Math.max(floorY, heightAt(px + sx * spec.halfW, pz + sz * spec.halfD));
    }
    floorY += 0.18;
    // Door goes on the side with the smallest step up from outside terrain.
    const doorCandidates: Array<{ side: number; dx: number; dz: number }> = [
      { side: 0, dx: 0, dz: spec.halfD + 1 },
      { side: 1, dx: 0, dz: -spec.halfD - 1 },
      { side: 2, dx: spec.halfW + 1, dz: 0 },
      { side: 3, dx: -spec.halfW - 1, dz: 0 },
    ];
    let doorSide = 0;
    let best = Infinity;
    for (const c of doorCandidates) {
      const step = floorY - heightAt(px + c.dx, pz + c.dz);
      if (step >= -0.1 && step < best) {
        best = step;
        doorSide = c.side;
      }
    }
    // The floor must be climbable from the door side: on steep ground the
    // highest-corner rule can lift it past STEP_UP_MAX, stranding the
    // building's loot (seen at seed 1337: a hangar whose 4 spawns were
    // unreachable). Clamp to a comfortable step; the uphill corner poking
    // through the slab is the accepted cosmetic cost. No RNG draws here —
    // existing worldgen streams are unaffected.
    const doorC = doorCandidates[doorSide];
    const doorGround = heightAt(px + doorC.dx, pz + doorC.dz);
    floorY = Math.min(floorY, doorGround + STEP_UP_MAX - 0.15);
    const windows = placeWindows(seed, buildingId, spec.kind, spec.halfW, spec.halfD, doorSide);
    const base = {
      cx: px,
      cz: pz,
      halfW: spec.halfW,
      halfD: spec.halfD,
      floorY,
      doorSide,
      windows,
    };
    const { walls, roof } = buildWalls(base);
    buildings.push({
      id: buildingId++,
      kind: spec.kind,
      area,
      lootPoints: spec.lootPoints,
      ...base,
      wallHeight: WALL_HEIGHT,
      walls,
      roof,
    });
    return true;
  };

  // --- Military interior: 2 barracks, 1 hangar, 1 supply shed ---
  for (const spec of [MILITARY_SPECS[0], MILITARY_SPECS[0], MILITARY_SPECS[1], MILITARY_SPECS[2]]) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const px = military.cx + milRng.range(-(MIL_HALF - 12), MIL_HALF - 12);
      const pz = military.cz + milRng.range(-(MIL_HALF - 12), MIL_HALF - 12);
      if (tryPlace(px, pz, spec, "military")) break;
    }
  }

  for (const town of towns) {
    const target = bRng.int(5, 8);
    let placed = 0;
    for (let attempt = 0; attempt < 220 && placed < target; attempt++) {
      const ang = bRng.range(0, Math.PI * 2);
      const dist = bRng.range(4, town.radius);
      const spec = bRng.pick(BUILDING_SPECS);
      if (tryPlace(town.cx + Math.cos(ang) * dist, town.cz + Math.sin(ang) * dist, spec, "town")) {
        placed++;
      }
    }
  }
  // Lone cabins in the wilderness.
  const cabinAttemptCap = 2000 * areaScale;
  for (let placed = 0, attempt = 0; attempt < cabinAttemptCap && placed < params.cabins; attempt++) {
    const x = bRng.range(-size * 0.42, size * 0.42);
    const z = bRng.range(-size * 0.42, size * 0.42);
    if (towns.some((t) => (t.cx - x) ** 2 + (t.cz - z) ** 2 < (t.radius + 30) ** 2)) continue;
    if (distSq2D(x, z, military.cx, military.cz) < (military.radius + 30) ** 2) continue;
    if (tryPlace(x, z, BUILDING_SPECS[0], "wild")) placed++;
  }

  // --- Loot spawn points (inside buildings) ---
  const lootSpawns: LootSpawn[] = [];
  const lRng = createRng((seed ^ 0x100c) >>> 0);
  let lootId = 0;
  for (const b of buildings) {
    const tier = b.area === "military" ? "military" : b.area === "town" ? "coastal" : "inland";
    for (let i = 0; i < b.lootPoints; i++) {
      lootSpawns.push({
        id: lootId++,
        x: b.cx + lRng.range(-(b.halfW - 1.2), b.halfW - 1.2),
        y: b.floorY,
        z: b.cz + lRng.range(-(b.halfD - 1.2), b.halfD - 1.2),
        tier,
      });
    }
  }

  // --- Trees ---
  const trees: Tree[] = [];
  const tRng = createRng((seed ^ 0x7ee5) >>> 0);
  const treeAttemptCap = 6000 * areaScale;
  for (let attempt = 0; attempt < treeAttemptCap && trees.length < params.trees; attempt++) {
    const x = tRng.range(-size * 0.48, size * 0.48);
    const z = tRng.range(-size * 0.48, size * 0.48);
    const h = heightAt(x, z);
    if (h < 1.2) continue;
    if (inWater(x, z)) continue; // no tree standing in a river/pond (dry: inert)
    if (towns.some((t) => (t.cx - x) ** 2 + (t.cz - z) ** 2 < (t.radius + 4) ** 2)) continue;
    if (distSq2D(x, z, military.cx, military.cz) < (military.radius + 6) ** 2) continue;
    if (buildings.some((b) => Math.abs(b.cx - x) < b.halfW + 2 && Math.abs(b.cz - z) < b.halfD + 2)) continue;
    trees.push({
      x,
      z,
      groundY: h,
      r: 0.35,
      height: tRng.range(6, 11),
      kind: tRng.chance(0.65) ? "conifer" : "oak",
    });
  }

  // --- Spawn points (beach ring) ---
  // Angles/target scale linearly with the tier (48/24 → 96/48 → 192/96) so
  // spawn density along the coast stays constant; the march step stays 4.
  const spawnPoints: Array<{ x: number; z: number }> = [];
  const spawnAngles = 48 * scale;
  const spawnTarget = 24 * scale;
  for (let i = 0; i < spawnAngles && spawnPoints.length < spawnTarget; i++) {
    const ang = (i / spawnAngles) * Math.PI * 2;
    // March inward from the edge until we cross onto dry beach.
    for (let d = size * 0.49; d > size * 0.2; d -= 4) {
      const x = Math.cos(ang) * d;
      const z = Math.sin(ang) * d;
      const h = heightAt(x, z);
      if (h > 0.4 && h < 1.6 && !inWater(x, z)) {
        // Skip a river-mouth notch in the beach ring (dry world: inWater false).
        spawnPoints.push({ x, z });
        break;
      }
    }
  }
  // Safety net: should never trigger with a sane seed.
  if (spawnPoints.length === 0) spawnPoints.push({ x: 0, z: 0 });

  // --- Military perimeter: four walls with N/S gates + corner towers ---
  const militaryWalls: Aabb[] = [];
  {
    const { cx, cz } = military;
    const t = MIL_WALL_THICKNESS;
    const groundAt = (x: number, z: number): number => heightAt(x, z);
    // Wall vertical extent follows the terrain along each side: skirt below
    // the lowest point, top above the highest (the y-aware collision in
    // movement.ts ignores below-ground portions).
    const sideBox = (minX: number, minZ: number, maxX: number, maxZ: number): Aabb => {
      const samples = [
        groundAt(minX, minZ),
        groundAt(maxX, maxZ),
        groundAt((minX + maxX) / 2, (minZ + maxZ) / 2),
      ];
      return {
        minX,
        minZ,
        maxX,
        maxZ,
        y0: Math.min(...samples) - 2,
        y1: Math.max(...samples) + MIL_WALL_HEIGHT,
      };
    };
    const gateHalf = MIL_GATE_WIDTH / 2;
    // +Z and -Z sides carry centered gates (two segments each).
    militaryWalls.push(
      sideBox(cx - MIL_HALF, cz + MIL_HALF - t, cx - gateHalf, cz + MIL_HALF),
      sideBox(cx + gateHalf, cz + MIL_HALF - t, cx + MIL_HALF, cz + MIL_HALF),
      sideBox(cx - MIL_HALF, cz - MIL_HALF, cx - gateHalf, cz - MIL_HALF + t),
      sideBox(cx + gateHalf, cz - MIL_HALF, cx + MIL_HALF, cz - MIL_HALF + t),
      // Solid +X / -X sides.
      sideBox(cx + MIL_HALF - t, cz - MIL_HALF, cx + MIL_HALF, cz + MIL_HALF),
      sideBox(cx - MIL_HALF, cz - MIL_HALF, cx - MIL_HALF + t, cz + MIL_HALF),
    );
    // Corner towers: solid blocks rising above the wall line.
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const tx = cx + sx * MIL_HALF;
      const tz = cz + sz * MIL_HALF;
      const g = groundAt(tx, tz);
      militaryWalls.push({
        minX: tx - MIL_TOWER_HALF,
        minZ: tz - MIL_TOWER_HALF,
        maxX: tx + MIL_TOWER_HALF,
        maxZ: tz + MIL_TOWER_HALF,
        y0: g - 2,
        y1: g + MIL_TOWER_HEIGHT,
      });
    }
  }

  // --- Set-dressing props: rocks island-wide + military compound dressing ---
  // DETERMINISM: these use NEW rng streams (fresh xor constants). The existing
  // streams above (mil/town/building/loot/tree) must not gain or lose a single
  // draw, so nothing here touches rng/milRng/townRng/bRng/lRng/tRng.
  const props: WorldProp[] = [];
  const propBoxes: Aabb[] = [];

  /** Conservative collision AABB for a yaw-rotated prop footprint: the exact
   * bounding rectangle of the rotated box (never smaller than the prop). */
  const propAabb = (
    x: number,
    z: number,
    yaw: number,
    kind: keyof typeof PROP_FOOTPRINTS,
    scale: number,
  ): Aabb => {
    const fp = PROP_FOOTPRINTS[kind];
    const hw = (fp.w / 2) * scale;
    const hd = (fp.d / 2) * scale;
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const ex = c * hw + s * hd;
    const ez = s * hw + c * hd;
    const g = heightAt(x, z);
    // Skirt below ground like building walls — y-aware collision ignores it.
    return { minX: x - ex, minZ: z - ez, maxX: x + ex, maxZ: z + ez, y0: g - 1.5, y1: g + fp.h * scale };
  };

  const addProp = (kind: WorldProp["kind"], x: number, z: number, yaw: number, scale: number): void => {
    props.push({ kind, x, z, yaw, scale });
    if (kind === "rock_a") return; // walk-through
    propBoxes.push(propAabb(x, z, yaw, kind, scale));
  };

  // Rocks: rejection-sampled island-wide. Dry land only, outside towns and
  // the compound, clear of every building's footprint rectangle (which also
  // keeps interior loot points clear — those all sit inside buildings). The
  // rectangle test (not town/compound radius) is what guarantees clearance:
  // edge buildings extend beyond their area's exclusion circle.
  const rockRng = createRng((seed ^ 0x6a09e6) >>> 0);
  const rockAttemptCap = 8000 * areaScale;
  for (let attempt = 0, placed = 0; attempt < rockAttemptCap && placed < params.rocks; attempt++) {
    const x = rockRng.range(-size * 0.48, size * 0.48);
    const z = rockRng.range(-size * 0.48, size * 0.48);
    if (heightAt(x, z) < ROCK_MIN_TERRAIN_H) continue;
    if (inWater(x, z)) continue; // no rock submerged in a river/pond (dry: inert)
    if (towns.some((t) => distSq2D(x, z, t.cx, t.cz) < t.radius ** 2)) continue;
    if (distSq2D(x, z, military.cx, military.cz) < military.radius ** 2) continue;
    if (
      buildings.some(
        (b) =>
          Math.abs(b.cx - x) < b.halfW + ROCK_BUILDING_MARGIN &&
          Math.abs(b.cz - z) < b.halfD + ROCK_BUILDING_MARGIN,
      )
    ) {
      continue;
    }
    const roll = rockRng.next();
    const kind = roll < 0.5 ? "rock_a" : roll < 0.85 ? "rock_b" : "rock_c";
    const scale =
      kind === "rock_a"
        ? rockRng.range(0.8, 1.3)
        : kind === "rock_b"
          ? rockRng.range(0.9, 1.4)
          : rockRng.range(0.9, 1.2);
    addProp(kind, x, z, rockRng.range(0, Math.PI * 2), scale);
    placed++;
  }

  // Military set dressing: authored offsets relative to the compound center,
  // with a touch of seeded jitter on yaw (its own "props" stream).
  {
    const propRng = createRng((seed ^ 0x1d872b) >>> 0);
    const { cx, cz } = military;
    const milBuildings = buildings.filter((b) => b.area === "military");
    // The interior layout (barracks/hangar/shed) is seed-dependent, so every
    // authored spot is checked against the placed footprints and loot points;
    // a conflicting prop is dropped rather than nudged (deterministic).
    const placeable = (x: number, z: number, clearance: number): boolean => {
      if (
        milBuildings.some(
          (b) => Math.abs(x - b.cx) < b.halfW + clearance && Math.abs(z - b.cz) < b.halfD + clearance,
        )
      ) {
        return false;
      }
      return !lootSpawns.some((p) => distSq2D(x, z, p.x, p.z) < PROP_LOOTPOINT_CLEARANCE ** 2);
    };
    const place = (kind: WorldProp["kind"], x: number, z: number, yaw: number): void => {
      if (!placeable(x, z, 1)) return;
      addProp(kind, x, z, yaw, 1);
    };

    // Sandbag nests just inside the two gates (+Z and -Z walls): a pair
    // flanking the lane angled toward the opening, plus a center line-blocker
    // set further back. 6 authored, each may drop if the interior layout
    // landed a building on top of it.
    for (const gate of [1, -1] as const) {
      const gz = cz + gate * (MIL_HALF - 4.5);
      place("sandbag_wall", cx - 3.6, gz, gate * 0.55 + propRng.range(-0.08, 0.08));
      place("sandbag_wall", cx + 3.6, gz, -gate * 0.55 + propRng.range(-0.08, 0.08));
      place("sandbag_wall", cx, cz + gate * (MIL_HALF - 7.5), propRng.range(-0.06, 0.06));
    }

    // Barriers staggered along the main N-S lane between the gates.
    const lane: ReadonlyArray<readonly [number, number, number]> = [
      [-2.2, -24, 0.35],
      [2.2, -8, -0.3],
      [-2.2, 8, 0.3],
      [2.2, 24, -0.35],
    ];
    for (const [dx, dz, yaw] of lane) {
      place("barrier", cx + dx, cz + dz, yaw + propRng.range(-0.1, 0.1));
    }

    // Two tents in the first corner (fixed scan order) clear of the
    // barracks/hangar layout; doors face the compound center.
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const ax = cx + sx * 31.5;
      const az = cz + sz * 31.5;
      const bx = cx + sx * 27;
      const bz = cz + sz * 32;
      if (!placeable(ax, az, 2) || !placeable(bx, bz, 2)) continue;
      const inward = Math.atan2(sx, sz); // forward (-sin,-cos) points at center
      place("tent", ax, az, inward + propRng.range(-0.15, 0.15));
      place("tent", bx, bz, inward + propRng.range(-0.15, 0.15));
      break;
    }
  }

  // --- Spatial grid for static colliders ---
  const grid = new Map<number, StaticsQuery>();
  const cellKey = (ix: number, iz: number): number => (ix + 512) * 4096 + (iz + 512);
  const cellOf = (v: number): number => Math.floor(v / GRID_CELL);
  const cellAt = (ix: number, iz: number): StaticsQuery => {
    const key = cellKey(ix, iz);
    let cell = grid.get(key);
    if (!cell) {
      cell = { walls: [], trees: [] };
      grid.set(key, cell);
    }
    return cell;
  };
  for (const b of buildings) {
    for (const w of b.walls) {
      for (let ix = cellOf(w.minX); ix <= cellOf(w.maxX); ix++) {
        for (let iz = cellOf(w.minZ); iz <= cellOf(w.maxZ); iz++) {
          cellAt(ix, iz).walls.push(w);
        }
      }
    }
  }
  for (const w of militaryWalls) {
    for (let ix = cellOf(w.minX); ix <= cellOf(w.maxX); ix++) {
      for (let iz = cellOf(w.minZ); iz <= cellOf(w.maxZ); iz++) {
        cellAt(ix, iz).walls.push(w);
      }
    }
  }
  // Solid set-dressing props collide exactly like military walls.
  for (const w of propBoxes) {
    for (let ix = cellOf(w.minX); ix <= cellOf(w.maxX); ix++) {
      for (let iz = cellOf(w.minZ); iz <= cellOf(w.maxZ); iz++) {
        cellAt(ix, iz).walls.push(w);
      }
    }
  }
  for (const tree of trees) {
    cellAt(cellOf(tree.x), cellOf(tree.z)).trees.push(tree);
  }

  // doc 06 — player structures: own spatial index, created empty (no rng).
  // Merged into the three query methods below so movement/zombies/combat see
  // placed pieces with ZERO changes of their own (the y-aware wall filter in
  // movement.ts makes foundations step-on-able and door headers walk-under).
  const structures = createStructureIndex();

  const queryStatics = (x: number, z: number, r: number): StaticsQuery => {
    const out: StaticsQuery = { walls: [], trees: [] };
    const seen = new Set<Aabb>();
    for (let ix = cellOf(x - r); ix <= cellOf(x + r); ix++) {
      for (let iz = cellOf(z - r); iz <= cellOf(z + r); iz++) {
        const cell = grid.get(cellKey(ix, iz));
        if (!cell) continue;
        for (const w of cell.walls) {
          if (!seen.has(w)) {
            seen.add(w);
            out.walls.push(w);
          }
        }
        for (const t of cell.trees) out.trees.push(t);
      }
    }
    // Player structures (doc 06) — the index dedups its own boxes.
    for (const w of structures.queryWalls(x, z, r)) out.walls.push(w);
    return out;
  };

  // Building-footprint grid for groundHeight (doc 07 M2): the old linear scan
  // over every building is O(n) per sample — pathological at large/huge tier
  // building counts. Same GRID_CELL cells as the statics grid; VALUE-IDENTICAL
  // to the scan (zero rng, buildings never overlap — margin 2.5m — so at most
  // one footprint contains any point and candidate order cannot matter). The
  // CI fingerprint itself verifies this: the harness hashes groundHeight
  // samples.
  const floorGrid = new Map<number, Building[]>();
  for (const b of buildings) {
    for (let ix = cellOf(b.cx - b.halfW); ix <= cellOf(b.cx + b.halfW); ix++) {
      for (let iz = cellOf(b.cz - b.halfD); iz <= cellOf(b.cz + b.halfD); iz++) {
        const key = cellKey(ix, iz);
        let cell = floorGrid.get(key);
        if (!cell) {
          cell = [];
          floorGrid.set(key, cell);
        }
        cell.push(b);
      }
    }
  }

  const buildingFloorAt = (x: number, z: number): number | null => {
    const cell = floorGrid.get(cellKey(cellOf(x), cellOf(z)));
    if (!cell) return null;
    for (const b of cell) {
      if (Math.abs(x - b.cx) <= b.halfW && Math.abs(z - b.cz) <= b.halfD) return b.floorY;
    }
    return null;
  };

  const groundHeight = (x: number, z: number): number => {
    const terrain = heightAt(x, z);
    let ground = terrain;
    const floor = buildingFloorAt(x, z);
    if (floor !== null && floor > ground) ground = floor;
    // doc 06 — foundation tops, same above-terrain guard as building floors.
    const sFloor = structures.floorAt(x, z);
    if (sFloor !== null && sFloor > ground) ground = sFloor;
    return ground;
  };

  const raycastStatics = (
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    includeTerrain = true,
  ): number | null => {
    let best: number | null = null;
    // Walls + roofs: gather candidates by stepping along the ray at half a
    // cell, checking the 3x3 cell ring at each sample so diagonal rays can't
    // slip a cell (and its walls) between samples.
    const seen = new Set<Aabb>();
    for (let d = 0; d <= maxDist + GRID_CELL * 0.5; d += GRID_CELL * 0.5) {
      const sampleD = Math.min(d, maxDist);
      const cx = cellOf(origin.x + dir.x * sampleD);
      const cz = cellOf(origin.z + dir.z * sampleD);
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const cell = grid.get(cellKey(ix, iz));
          if (!cell) continue;
          for (const w of cell.walls) {
            if (seen.has(w)) continue;
            seen.add(w);
            const t = rayAabb(origin, dir, w, maxDist);
            if (t !== null && (best === null || t < best)) best = t;
          }
        }
      }
    }
    for (const b of buildings) {
      const t = rayAabb(origin, dir, b.roof, maxDist);
      if (t !== null && (best === null || t < best)) best = t;
    }
    // doc 06 — player structures, folded into `best` BEFORE the terrain
    // march below (whose limit reads `best`). Melee occlusion and pellet
    // capping inherit this with zero combat changes.
    {
      const ph = structures.raycastPiece(origin, dir, maxDist);
      if (ph !== null && (best === null || ph.t < best)) best = ph.t;
    }
    // Terrain: coarse march then refine.
    if (!includeTerrain) return best;
    const limit = best ?? maxDist;
    for (let d = 2; d <= limit; d += 2) {
      const py = origin.y + dir.y * d;
      if (py < heightAt(origin.x + dir.x * d, origin.z + dir.z * d)) {
        let lo = d - 2;
        let hi = d;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + dir.y * mid;
          if (my < heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid)) hi = mid;
          else lo = mid;
        }
        if (best === null || hi < best) best = hi;
        break;
      }
    }
    return best;
  };

  // --- Searchable containers (doc 05 §3) ---
  // DETERMINISM: drawn LAST, from a per-building hash stream `cont|seed|id`
  // (windows precedent) — never the shared streams above. Every pre-existing
  // World field is therefore byte-identical with or without this block. The
  // walk over `buildings` is in stable generation order, so the sequential
  // container ids match on client and server. Render-only: no collision, so
  // the statics grid built below this point is untouched.
  const containers: WorldContainer[] = [];
  let containerId = 0;
  const nextContainerId = (): number => containerId++;
  for (const b of buildings) {
    for (const c of placeContainers(seed, b, nextContainerId)) containers.push(c);
  }

  // Burn a value so future additions don't shift existing rng streams.
  rng.next();

  return {
    seed,
    size,
    heightAt,
    groundHeight,
    waterAt,
    towns,
    buildings,
    military,
    militaryWalls,
    props,
    trees,
    lootSpawns,
    // doc 07 M5 — present ONLY on a water world; the conditional spread keeps
    // the dry world's key set (and its serialized JSON) byte-identical.
    ...(water !== null ? { water: { rivers: water.rivers, ponds: water.ponds } } : {}),
    containers,
    spawnPoints,
    structures,
    queryStatics,
    raycastStatics,
  };
}
