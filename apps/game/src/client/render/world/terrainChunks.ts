// Chunked-terrain math + mesh/cache management (doc 07 §4) — React-free and
// unit-tested headlessly by scripts/terrain-chunks.mjs (three's scene-graph
// objects work fine in node; only the React frame loop lives in Terrain.tsx).
//
// Layout contract (load-bearing — see docs/plans/07-world-and-wildlife.md §4):
// the chunk grid is CENTERED on the world origin, `ceil(size / 128)` chunks
// per side (7×7 at 800m, 13×13 at 1600m, 25×25 at 3200m). The grid origin is
// always a multiple of 64, so LOD0's 4m vertex lattice lands on exactly the
// same world coordinates as the old monolithic mesh (spacing 4m from
// -size/2, itself a multiple of 4) — identical heightAt samples, identical
// facets, no off-by-half-cell drift against the server's analytic
// groundHeight.
//
// LOD sizing rule: entity y is server-set from analytic groundHeight, so the
// full-density LOD0 ring must cover every entity a client can ever see:
// INTEREST_RADIUS 220 + worst-case center-metric slack 64·√2 ≈ 90.5 + the
// 16m hysteresis band ≈ 327 ⇒ LOD0_RADIUS = 336. Do not shrink any of these
// numbers without redoing that arithmetic.

import * as THREE from "three";
import { clamp } from "@worldspring/shared/math";
import { MAP_BIOME, MAP_PALETTE } from "@worldspring/shared/map/palette";

/** Chunk edge length (m). 128 = 32 LOD0 cells; grid counts in doc 07 §4. */
export const TERRAIN_CHUNK_SIZE = 128;
/** Chunks with centers beyond this are neither built nor drawn (fog far is
 * 320m day — the horizon past this is pure background color). */
export const CHUNK_DRAW_RADIUS = 448;
/** Chunk-center distance splitting LOD0 (4m verts) from LOD1 (8m verts). */
export const LOD0_RADIUS = 336;
/** Dead band applied to BOTH boundaries: a chunk enters a nearer state at
 * (boundary − 16) and leaves it at (boundary + 16), so a camera dithering on
 * a boundary never flip-flops rebuilds. */
export const LOD_HYSTERESIS = 16;
/** Vertex spacing per LOD (m). LOD0 matches the old monolithic density. */
export const LOD_SPACINGS = [4, 8] as const;
/** Skirt drop (m): edge ring duplicated and extruded straight down to hide
 * cracks at LOD seams — no index stitching. */
export const SKIRT_DEPTH = 3;
/** Geometry-build budget per frame (each LOD0 build ≈ 5.4K noise evals). */
export const MAX_CHUNK_BUILDS_PER_FRAME = 2;
/** LRU cap on cached chunk geometries, keyed (cx,cz,lod). ~45 chunks are
 * visible worst-case, so 120 keeps a generous revisit halo. */
export const CHUNK_CACHE_CAP = 120;

export type ChunkLod = 0 | 1;

export interface ChunkGrid {
  /** Chunks per side. */
  count: number;
  /** World x/z of the grid's -x/-z corner (chunk (0,0) origin). */
  origin: number;
}

/** Centered chunk grid covering (and slightly overhanging) the island. The
 * overhang is flat -4m ocean floor under the water plane — invisible, and it
 * extends the ocean-floor ring the monolithic mesh already showed at its
 * corners. */
export function chunkGridFor(worldSize: number): ChunkGrid {
  const count = Math.ceil(worldSize / TERRAIN_CHUNK_SIZE);
  return { count, origin: -(count * TERRAIN_CHUNK_SIZE) / 2 };
}

/** Map key for chunk (cx, cz) within `grid` — stable for one grid only. */
export function chunkKey(grid: ChunkGrid, cx: number, cz: number): number {
  return cz * grid.count + cx;
}

export function chunkFromKey(grid: ChunkGrid, key: number): { cx: number; cz: number } {
  const cx = key % grid.count;
  return { cx, cz: (key - cx) / grid.count };
}

export function chunkOriginOf(grid: ChunkGrid, cx: number, cz: number): { x: number; z: number } {
  return {
    x: grid.origin + cx * TERRAIN_CHUNK_SIZE,
    z: grid.origin + cz * TERRAIN_CHUNK_SIZE,
  };
}

// Squared thresholds (all comparisons are on squared center distance).
const ENTER_2 = (CHUNK_DRAW_RADIUS - LOD_HYSTERESIS) ** 2; // hidden -> visible
const EXIT_2 = (CHUNK_DRAW_RADIUS + LOD_HYSTERESIS) ** 2; // visible -> hidden
const PROMOTE_2 = (LOD0_RADIUS - LOD_HYSTERESIS) ** 2; // lod1 -> lod0
const DEMOTE_2 = (LOD0_RADIUS + LOD_HYSTERESIS) ** 2; // lod0 -> lod1
const FRESH_LOD0_2 = LOD0_RADIUS ** 2; // no prior state: raw boundary

/**
 * The set of chunks to draw and their LODs, given the previous frame's
 * result (`prev`) for hysteresis. Pure: same inputs → same output.
 *
 * Distance metric is camera → chunk CENTER on XZ. Transitions:
 *   absent  → lod0/lod1  at d ≤ 432 (split at raw 336)
 *   lod1    → lod0       at d < 320   (320 > 220 + 64·√2 ≈ 310.5, so every
 *                                      chunk that can host a visible entity
 *                                      is full density — the invariant)
 *   lod0    → lod1       at d > 352
 *   visible → absent     at d > 464
 */
export function selectChunks(
  grid: ChunkGrid,
  camX: number,
  camZ: number,
  prev: ReadonlyMap<number, ChunkLod>,
): Map<number, ChunkLod> {
  const next = new Map<number, ChunkLod>();
  const { count, origin } = grid;
  const half = TERRAIN_CHUNK_SIZE / 2;
  // Chunks outside this box are > EXIT radius from the camera in at least
  // one axis, so they resolve to "absent" regardless of prior state.
  const reach = CHUNK_DRAW_RADIUS + LOD_HYSTERESIS + half;
  const cxMin = Math.max(0, Math.floor((camX - reach - origin) / TERRAIN_CHUNK_SIZE));
  const cxMax = Math.min(count - 1, Math.floor((camX + reach - origin) / TERRAIN_CHUNK_SIZE));
  const czMin = Math.max(0, Math.floor((camZ - reach - origin) / TERRAIN_CHUNK_SIZE));
  const czMax = Math.min(count - 1, Math.floor((camZ + reach - origin) / TERRAIN_CHUNK_SIZE));

  for (let cz = czMin; cz <= czMax; cz++) {
    const dz = origin + cz * TERRAIN_CHUNK_SIZE + half - camZ;
    for (let cx = cxMin; cx <= cxMax; cx++) {
      const dx = origin + cx * TERRAIN_CHUNK_SIZE + half - camX;
      const d2 = dx * dx + dz * dz;
      const key = cz * count + cx;
      const was = prev.get(key);
      if (was === undefined) {
        if (d2 <= ENTER_2) next.set(key, d2 <= FRESH_LOD0_2 ? 0 : 1);
        continue;
      }
      if (d2 > EXIT_2) continue; // drop
      if (was === 0) next.set(key, d2 > DEMOTE_2 ? 1 : 0);
      else next.set(key, d2 < PROMOTE_2 ? 0 : 1);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Chunk geometry arrays
// ---------------------------------------------------------------------------

// Palette literals + thresholds are the SHARED source (packages/shared/src/
// map/palette.ts) so the 3D terrain and the top-down map never drift (doc 12
// M1). THREE.Color converts the same hex from sRGB to working space.
const SAND = new THREE.Color(MAP_PALETTE.sand);
const GRASS_LOW = new THREE.Color(MAP_PALETTE.grassLow);
const GRASS_HIGH = new THREE.Color(MAP_PALETTE.grassHigh);
const ROCK = new THREE.Color(MAP_PALETTE.rock);

const SAND_MAX_H = MAP_BIOME.sandMaxH; // sand below here, blending out just above
const ROCK_HEIGHT = MAP_BIOME.rockHeight; // high altitude turns to bare rock
const ROCK_SLOPE_START = MAP_BIOME.rockSlopeStart; // gradient (m/m) where rock starts blending in
const ROCK_SLOPE_FULL = MAP_BIOME.rockSlopeFull;

export type HeightFn = (x: number, z: number) => number;

export interface ChunkArrays {
  /** World-space xyz triplets — grid verts first, then 4 skirt strips. */
  positions: Float32Array;
  /** Linear-space rgb triplets, same order (skirts copy their top vertex). */
  colors: Float32Array;
  /** Triangle indices: interior grid (PlaneGeometry-identical winding and
   * diagonal), then outward-facing skirt quads. */
  indices: Uint16Array;
}

const tmp = new THREE.Color();

/** The pre-chunking Terrain.tsx vertex-color formula, verbatim — grass
 * darkening with altitude, beach sand at the waterline, rock on steep or
 * high ground. Slope sampling stays ±2m at every LOD (formula unchanged per
 * doc 07 §4; identical inputs ⇒ bit-identical colors vs the old mesh). */
function writeVertexColor(
  heightAt: HeightFn,
  x: number,
  z: number,
  h: number,
  colors: Float32Array,
  offset: number,
): void {
  const dhdx = (heightAt(x + 2, z) - heightAt(x - 2, z)) / 4;
  const dhdz = (heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
  const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);

  tmp.copy(GRASS_LOW).lerp(GRASS_HIGH, clamp((h - 2) / 14, 0, 1));
  tmp.lerp(SAND, clamp((SAND_MAX_H + 0.3 - h) / 0.6, 0, 1));
  const rockT = Math.max(
    clamp((slope - ROCK_SLOPE_START) / (ROCK_SLOPE_FULL - ROCK_SLOPE_START), 0, 1),
    clamp((h - ROCK_HEIGHT) / 2.5, 0, 1),
  );
  tmp.lerp(ROCK, rockT);

  colors[offset] = tmp.r;
  colors[offset + 1] = tmp.g;
  colors[offset + 2] = tmp.b;
}

/**
 * Displaced, vertex-colored arrays for one chunk at one LOD, positions in
 * WORLD space (the mesh sits at the scene origin, so three's
 * computeBoundingSphere over these verts is the correct world-space culling
 * sphere, skirts included).
 *
 * Grid: (n+1)² verts at `spacing`, indexed with PlaneGeometry's exact
 * per-cell diagonal ((a,b,d),(b,c,d) — the "/" diagonal in world XZ) so LOD0
 * facets are pixel-identical to the old monolithic mesh. Skirts: each edge's
 * vertex row duplicated SKIRT_DEPTH lower and quadded outward-facing;
 * corners are duplicated per side (2 wasted verts per corner — simpler than
 * a welded ring and invisible).
 */
export function buildChunkArrays(
  heightAt: HeightFn,
  originX: number,
  originZ: number,
  lod: ChunkLod,
): ChunkArrays {
  const spacing = LOD_SPACINGS[lod];
  const n = TERRAIN_CHUNK_SIZE / spacing; // cells per side (32 or 16)
  const w = n + 1; // verts per side
  const gridCount = w * w;
  const vertCount = gridCount + 4 * w; // + one skirt strip per side
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);

  for (let iz = 0; iz < w; iz++) {
    const z = originZ + iz * spacing;
    for (let ix = 0; ix < w; ix++) {
      const x = originX + ix * spacing;
      const h = heightAt(x, z);
      const o = (iz * w + ix) * 3;
      positions[o] = x;
      positions[o + 1] = h;
      positions[o + 2] = z;
      writeVertexColor(heightAt, x, z, h, colors, o);
    }
  }

  // Skirt strips: -Z, +Z, -X, +X. Each duplicates its edge row, dropped by
  // SKIRT_DEPTH, colors copied from the top vertex.
  const sideTopIndex: ReadonlyArray<(j: number) => number> = [
    (j) => j, // -Z edge (iz = 0)
    (j) => n * w + j, // +Z edge (iz = n)
    (j) => j * w, // -X edge (ix = 0)
    (j) => j * w + n, // +X edge (ix = n)
  ];
  for (let side = 0; side < 4; side++) {
    const base = gridCount + side * w;
    const topOf = sideTopIndex[side];
    for (let j = 0; j < w; j++) {
      const t = topOf(j) * 3;
      const o = (base + j) * 3;
      positions[o] = positions[t];
      positions[o + 1] = positions[t + 1] - SKIRT_DEPTH;
      positions[o + 2] = positions[t + 2];
      colors[o] = colors[t];
      colors[o + 1] = colors[t + 1];
      colors[o + 2] = colors[t + 2];
    }
  }

  const indices = new Uint16Array((2 * n * n + 8 * n) * 3);
  let ptr = 0;
  // Interior: PlaneGeometry's triangulation, mapped through rotateX(-PI/2):
  // a=(x0,z0) b=(x0,z1) c=(x1,z1) d=(x1,z0); (a,b,d),(b,c,d); CCW from +Y.
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iz * w + ix;
      const b = (iz + 1) * w + ix;
      const c = (iz + 1) * w + ix + 1;
      const d = iz * w + ix + 1;
      indices[ptr++] = a;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = b;
      indices[ptr++] = c;
      indices[ptr++] = d;
    }
  }
  // Skirts, wound to face OUTWARD (material is front-side only). For edge
  // direction e and drop (0,-SKIRT_DEPTH,0), triangle (t0,t1,b0) has normal
  // ∝ (e.z, 0, -e.x): -Z for the -Z side and +X for the +X side, so those
  // two sides use it directly and +Z/-X use the mirrored winding.
  for (let side = 0; side < 4; side++) {
    const base = gridCount + side * w;
    const topOf = sideTopIndex[side];
    const direct = side === 0 || side === 3; // -Z and +X
    for (let j = 0; j < n; j++) {
      const t0 = topOf(j);
      const t1 = topOf(j + 1);
      const b0 = base + j;
      const b1 = base + j + 1;
      if (direct) {
        indices[ptr++] = t0;
        indices[ptr++] = t1;
        indices[ptr++] = b0;
        indices[ptr++] = t1;
        indices[ptr++] = b1;
        indices[ptr++] = b0;
      } else {
        indices[ptr++] = t0;
        indices[ptr++] = b0;
        indices[ptr++] = t1;
        indices[ptr++] = t1;
        indices[ptr++] = b0;
        indices[ptr++] = b1;
      }
    }
  }

  return { positions, colors, indices };
}

// ---------------------------------------------------------------------------
// Chunk renderer: mesh set + LRU geometry cache + amortized build queue
// ---------------------------------------------------------------------------

export interface ChunkRenderer {
  /** Parent of every live chunk mesh — Terrain.tsx mounts this via <primitive>. */
  group: THREE.Group;
  grid: ChunkGrid;
  heightAt: HeightFn;
  material: THREE.Material;
  /** LRU geometry cache keyed "cx,cz,lod" — Map insertion order is recency. */
  cache: Map<string, THREE.BufferGeometry>;
  /** Live mesh per visible chunk key. */
  meshes: Map<number, THREE.Mesh>;
  /** Previous frame's selection — the hysteresis memory. */
  lodState: Map<number, ChunkLod>;
}

export function createChunkRenderer(
  worldSize: number,
  heightAt: HeightFn,
  material: THREE.Material,
): ChunkRenderer {
  return {
    group: new THREE.Group(),
    grid: chunkGridFor(worldSize),
    heightAt,
    material,
    cache: new Map(),
    meshes: new Map(),
    lodState: new Map(),
  };
}

/** Frees every cached geometry (GPU buffers included) and empties the group. */
export function disposeChunkRenderer(r: ChunkRenderer): void {
  for (const geometry of r.cache.values()) geometry.dispose();
  r.cache.clear();
  r.meshes.clear();
  r.lodState.clear();
  r.group.clear();
}

function geometryKey(cx: number, cz: number, lod: ChunkLod): string {
  return `${cx},${cz},${lod}`;
}

/** Cache get + mark-recently-used. */
function touch(cache: Map<string, THREE.BufferGeometry>, key: string): THREE.BufferGeometry | undefined {
  const geometry = cache.get(key);
  if (geometry !== undefined) {
    cache.delete(key);
    cache.set(key, geometry);
  }
  return geometry;
}

function buildChunkGeometry(r: ChunkRenderer, cx: number, cz: number, lod: ChunkLod): THREE.BufferGeometry {
  const { x, z } = chunkOriginOf(r.grid, cx, cz);
  const { positions, colors, indices } = buildChunkArrays(r.heightAt, x, z, lod);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  // Positions are world-space (meshes sit at the scene origin), so this is
  // the correct culling sphere over the DISPLACED verts, skirts included.
  geometry.computeBoundingSphere();
  return geometry;
}

function assignChunkMesh(r: ChunkRenderer, key: number, geometry: THREE.BufferGeometry): void {
  let mesh = r.meshes.get(key);
  if (mesh === undefined) {
    mesh = new THREE.Mesh(geometry, r.material);
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    r.meshes.set(key, mesh);
    r.group.add(mesh);
    return;
  }
  if (mesh.geometry !== geometry) mesh.geometry = geometry;
}

interface WantedBuild {
  key: number;
  lod: ChunkLod;
  d2: number;
}

/**
 * One frame of chunk streaming: re-select (hysteresis-stable, so this is
 * cheap and idempotent when the camera is still), retire departed meshes
 * (their geometries stay cached), assign cached geometries — falling back to
 * the chunk's OTHER LOD while the desired one is pending, a fallback beats a
 * hole — then build at most MAX_CHUNK_BUILDS_PER_FRAME missing geometries
 * nearest-first and LRU-evict (with dispose) past CHUNK_CACHE_CAP. Returns
 * the number of geometries built (test/instrumentation hook).
 */
export function updateChunks(r: ChunkRenderer, camX: number, camZ: number): number {
  const next = selectChunks(r.grid, camX, camZ, r.lodState);
  r.lodState = next;

  for (const [key, mesh] of r.meshes) {
    if (next.has(key)) continue;
    r.group.remove(mesh);
    r.meshes.delete(key);
  }

  const wanted: WantedBuild[] = [];
  for (const [key, lod] of next) {
    const { cx, cz } = chunkFromKey(r.grid, key);
    let geometry = touch(r.cache, geometryKey(cx, cz, lod));
    if (geometry === undefined) {
      const { x, z } = chunkOriginOf(r.grid, cx, cz);
      const dx = x + TERRAIN_CHUNK_SIZE / 2 - camX;
      const dz = z + TERRAIN_CHUNK_SIZE / 2 - camZ;
      wanted.push({ key, lod, d2: dx * dx + dz * dz });
      geometry = touch(r.cache, geometryKey(cx, cz, (1 - lod) as ChunkLod));
    }
    if (geometry !== undefined) assignChunkMesh(r, key, geometry);
  }

  // Amortized builds, nearest chunk first so the ground under the player
  // streams in before the horizon.
  wanted.sort((a, b) => a.d2 - b.d2);
  const builds = Math.min(wanted.length, MAX_CHUNK_BUILDS_PER_FRAME);
  for (let i = 0; i < builds; i++) {
    const { key, lod } = wanted[i];
    const { cx, cz } = chunkFromKey(r.grid, key);
    const geometry = buildChunkGeometry(r, cx, cz, lod);
    r.cache.set(geometryKey(cx, cz, lod), geometry);
    assignChunkMesh(r, key, geometry);
  }

  // LRU eviction beyond the cap — never a geometry currently on a mesh, and
  // dispose what we evict so GPU memory is actually released.
  if (r.cache.size > CHUNK_CACHE_CAP) {
    const inUse = new Set<THREE.BufferGeometry>();
    for (const mesh of r.meshes.values()) inUse.add(mesh.geometry as THREE.BufferGeometry);
    for (const [key, geometry] of r.cache) {
      if (r.cache.size <= CHUNK_CACHE_CAP) break;
      if (inUse.has(geometry)) continue;
      r.cache.delete(key);
      geometry.dispose();
    }
  }
  return builds;
}
