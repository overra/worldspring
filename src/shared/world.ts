// Deterministic world generation. The client and the GameRoom Durable Object
// each call createWorld(WORLD_SEED) and MUST get identical results — movement
// prediction depends on it. Keep everything here seeded; no Math.random().

import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import {
  CABIN_COUNT,
  TERRAIN_MAX_HEIGHT,
  TOWN_COUNT,
  TREE_COUNT,
  WORLD_SIZE,
} from "./constants";
import { clamp, rayAabb, type Aabb, type Vec3 } from "./math";
import { createRng, type Rng } from "./rng";

export type BuildingKind = "house" | "shed" | "barn";

export interface Building {
  id: number;
  kind: BuildingKind;
  cx: number;
  cz: number;
  halfW: number; // x extent
  halfD: number; // z extent
  floorY: number;
  wallHeight: number;
  /** 0:+Z 1:-Z 2:+X 3:-X — which side the door gap is on. */
  doorSide: number;
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

export interface LootSpawn {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface StaticsQuery {
  walls: Aabb[];
  trees: Tree[];
}

export interface World {
  seed: number;
  heightAt(x: number, z: number): number;
  /** Terrain height plus building floors — what you actually stand on. */
  groundHeight(x: number, z: number): number;
  towns: Town[];
  buildings: Building[];
  trees: Tree[];
  lootSpawns: LootSpawn[];
  spawnPoints: Array<{ x: number; z: number }>;
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

function makeHeightFn(noise: NoiseFunction2D): (x: number, z: number) => number {
  return (x: number, z: number): number => {
    const n =
      0.6 * noise(x * 0.008, z * 0.008) +
      0.3 * noise(x * 0.02 + 100, z * 0.02 + 100) +
      0.1 * noise(x * 0.06 + 200, z * 0.06 + 200);
    const h01 = n * 0.5 + 0.5;
    const d = Math.sqrt(x * x + z * z) / (WORLD_SIZE * 0.5);
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

function buildWalls(b: {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  floorY: number;
  doorSide: number;
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
      walls.push({ minX, minZ, maxX, maxZ, y0, y1 });
      return;
    }
    const half = DOOR_WIDTH / 2;
    if (horizontal) {
      const mid = (minX + maxX) / 2;
      walls.push({ minX, minZ, maxX: mid - half, maxZ, y0, y1 });
      walls.push({ minX: mid + half, minZ, maxX, maxZ, y0, y1 });
      walls.push({ minX: mid - half, minZ, maxX: mid + half, maxZ, y0, y1: floorY });
    } else {
      const mid = (minZ + maxZ) / 2;
      walls.push({ minX, minZ, maxX, maxZ: mid - half, y0, y1 });
      walls.push({ minX, minZ: mid + half, maxX, maxZ, y0, y1 });
      walls.push({ minX, minZ: mid - half, maxX, maxZ: mid + half, y0, y1: floorY });
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

export function createWorld(seed: number): World {
  const rng: Rng = createRng(seed >>> 0);
  const noise = createNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0).next);
  const heightAt = makeHeightFn(noise);

  // --- Towns ---
  const towns: Town[] = [];
  const townRng = createRng((seed ^ 0x7041) >>> 0);
  for (let attempt = 0; attempt < 4000 && towns.length < TOWN_COUNT; attempt++) {
    const ang = townRng.range(0, Math.PI * 2);
    const dist = townRng.range(70, 270);
    const cx = Math.cos(ang) * dist;
    const cz = Math.sin(ang) * dist;
    const h = heightAt(cx, cz);
    if (h < 2.5 || h > 9.5) continue;
    if (slopeAt(heightAt, cx, cz, 14) > 3) continue;
    if (towns.some((t) => (t.cx - cx) ** 2 + (t.cz - cz) ** 2 < 150 ** 2)) continue;
    towns.push({ cx, cz, radius: townRng.range(26, 38), name: TOWN_NAMES[towns.length] ?? "Outpost" });
  }

  // --- Buildings ---
  const buildings: Building[] = [];
  const bRng = createRng((seed ^ 0xb17d) >>> 0);
  let buildingId = 0;

  const tryPlace = (px: number, pz: number, spec: BuildingSpec): boolean => {
    const margin = 2.5;
    if (slopeAt(heightAt, px, pz, Math.max(spec.halfW, spec.halfD)) > 1.6) return false;
    const h = heightAt(px, pz);
    if (h < 1.5) return false;
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
    const base = {
      cx: px,
      cz: pz,
      halfW: spec.halfW,
      halfD: spec.halfD,
      floorY,
      doorSide,
    };
    const { walls, roof } = buildWalls(base);
    buildings.push({
      id: buildingId++,
      kind: spec.kind,
      ...base,
      wallHeight: WALL_HEIGHT,
      walls,
      roof,
    });
    return true;
  };

  for (const town of towns) {
    const target = bRng.int(5, 8);
    let placed = 0;
    for (let attempt = 0; attempt < 220 && placed < target; attempt++) {
      const ang = bRng.range(0, Math.PI * 2);
      const dist = bRng.range(4, town.radius);
      const spec = bRng.pick(BUILDING_SPECS);
      if (tryPlace(town.cx + Math.cos(ang) * dist, town.cz + Math.sin(ang) * dist, spec)) placed++;
    }
  }
  // Lone cabins in the wilderness.
  for (let placed = 0, attempt = 0; attempt < 2000 && placed < CABIN_COUNT; attempt++) {
    const x = bRng.range(-WORLD_SIZE * 0.42, WORLD_SIZE * 0.42);
    const z = bRng.range(-WORLD_SIZE * 0.42, WORLD_SIZE * 0.42);
    if (towns.some((t) => (t.cx - x) ** 2 + (t.cz - z) ** 2 < (t.radius + 30) ** 2)) continue;
    if (tryPlace(x, z, BUILDING_SPECS[0])) placed++;
  }

  // --- Loot spawn points (inside buildings) ---
  const lootSpawns: LootSpawn[] = [];
  const lRng = createRng((seed ^ 0x100c) >>> 0);
  let lootId = 0;
  for (const b of buildings) {
    const spec = BUILDING_SPECS.find((s) => s.kind === b.kind) ?? BUILDING_SPECS[0];
    for (let i = 0; i < spec.lootPoints; i++) {
      lootSpawns.push({
        id: lootId++,
        x: b.cx + lRng.range(-(b.halfW - 1.2), b.halfW - 1.2),
        y: b.floorY,
        z: b.cz + lRng.range(-(b.halfD - 1.2), b.halfD - 1.2),
      });
    }
  }

  // --- Trees ---
  const trees: Tree[] = [];
  const tRng = createRng((seed ^ 0x7ee5) >>> 0);
  for (let attempt = 0; attempt < 6000 && trees.length < TREE_COUNT; attempt++) {
    const x = tRng.range(-WORLD_SIZE * 0.48, WORLD_SIZE * 0.48);
    const z = tRng.range(-WORLD_SIZE * 0.48, WORLD_SIZE * 0.48);
    const h = heightAt(x, z);
    if (h < 1.2) continue;
    if (towns.some((t) => (t.cx - x) ** 2 + (t.cz - z) ** 2 < (t.radius + 4) ** 2)) continue;
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
  const spawnPoints: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < 48 && spawnPoints.length < 24; i++) {
    const ang = (i / 48) * Math.PI * 2;
    // March inward from the edge until we cross onto dry beach.
    for (let d = WORLD_SIZE * 0.49; d > WORLD_SIZE * 0.2; d -= 4) {
      const x = Math.cos(ang) * d;
      const z = Math.sin(ang) * d;
      const h = heightAt(x, z);
      if (h > 0.4 && h < 1.6) {
        spawnPoints.push({ x, z });
        break;
      }
    }
  }
  // Safety net: should never trigger with a sane seed.
  if (spawnPoints.length === 0) spawnPoints.push({ x: 0, z: 0 });

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
  for (const tree of trees) {
    cellAt(cellOf(tree.x), cellOf(tree.z)).trees.push(tree);
  }

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
    return out;
  };

  const buildingFloorAt = (x: number, z: number): number | null => {
    for (const b of buildings) {
      if (Math.abs(x - b.cx) <= b.halfW && Math.abs(z - b.cz) <= b.halfD) return b.floorY;
    }
    return null;
  };

  const groundHeight = (x: number, z: number): number => {
    const terrain = heightAt(x, z);
    const floor = buildingFloorAt(x, z);
    return floor !== null && floor > terrain ? floor : terrain;
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

  // Burn a value so future additions don't shift existing rng streams.
  rng.next();

  return {
    seed,
    heightAt,
    groundHeight,
    towns,
    buildings,
    trees,
    lootSpawns,
    spawnPoints,
    queryStatics,
    raycastStatics,
  };
}
