// doc 14 M1 — the engine-owned NavSystem: a tiled navmesh built inside the DO
// from the SAME terrain heightfield + static AABBs the kinematic sim collides
// with (`world.heightAt` + `world.queryStatics`), so navmesh reachability tracks
// `resolveStatics` (doc 14 §2). navcat is pure JS (proven in workerd by M0), and
// this whole module is server-only — never fingerprinted, never persisted,
// never client-shared.
//
// The per-tile pipeline is lifted from the `spike/navcat` harness (which mirrors
// navcat/blocks' non-exported `buildNavMeshTile`), but sources each tile's
// geometry LOCALLY — sampled per tile from the statics source — instead of
// pre-building a whole-world triangle soup, so generation is activity-scoped and
// a full world mesh never has to fit in memory (doc 14 §4, RISK: memory).

import {
  addTile,
  buildCompactHeightfield,
  buildContours,
  BuildContext,
  buildDistanceField,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  buildTile,
  ContourBuildFlags,
  createFindNearestPolyResult,
  createHeightfield,
  createNavMesh,
  DEFAULT_QUERY_FILTER,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  findNearestPoly,
  findPath,
  markWalkableTriangles,
  type NavMesh,
  polyMeshDetailToTileDetailMesh,
  polyMeshToTilePolys,
  rasterizeTriangles,
  removeTile,
  WALKABLE_AREA,
} from "navcat";
import { PLAYER_HEIGHT, PLAYER_RADIUS, STEP_UP_MAX, WATER_WALK_MIN } from "@worldspring/shared/constants";
import type { Pathfinder, Waypoint } from "./pathfinder";

// --- geometry the navmesh bakes from (World satisfies this structurally) -----

interface NavAabb {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y0: number;
  y1: number;
}
interface NavTree {
  x: number;
  z: number;
  r: number;
  height: number;
}
export interface NavStaticsSource {
  /** World edge length (m). Terrain is square, origin-centered, like the sim. */
  size: number;
  heightAt(x: number, z: number): number;
  /** The kinematic collision authority — the SAME walls/trees `resolveStatics`
   *  reads (buildings, military, player structures, natural + planted trees). */
  queryStatics(
    x: number,
    z: number,
    r: number,
  ): { walls: ReadonlyArray<NavAabb>; trees: ReadonlyArray<NavTree> };
}

// --- config (server-only tuning; not fingerprinted) --------------------------

/** Terrain sample grid — matches PhysicsSystem's Rapier heightfield exactly so
 *  the navmesh floor equals the collision floor (PhysicsSystem.ts:86). */
const HEIGHTFIELD_CELL_M = 4;
const CELL_SIZE = 0.5; // nav voxel XZ — nav-grade over the 4 m terrain source
const CELL_HEIGHT = 0.25;
const TILE_SIZE_VOXELS = 64; // 64 * 0.5 = 32 m tiles
const TILE_SIZE_WORLD = TILE_SIZE_VOXELS * CELL_SIZE;
const WALKABLE_RADIUS_VOXELS = Math.ceil(PLAYER_RADIUS / CELL_SIZE); // 1
const WALKABLE_CLIMB_VOXELS = Math.ceil(STEP_UP_MAX / CELL_HEIGHT); // 3
// FLOOR, not ceil: the sim's overhead rule ignores a wall when `wall.y0 >= y +
// PLAYER_HEIGHT` (1.8 m exactly), so a DOOR_HEIGHT (2.2 m) header is walk-under.
// ceil(1.8/0.25)=8 voxels = 2.0 m over-restricts and can clip that doorway after
// voxelization — excluding a cell the sim reaches (doc 14 §2, Open Q3). floor →
// 7 voxels = 1.75 m ≤ 1.8 m, so nav reachability ⊇ sim; the 1.1 m window opening
// (< 1.75 m) still yields no walkable span.
const WALKABLE_HEIGHT_VOXELS = Math.floor(PLAYER_HEIGHT / CELL_HEIGHT); // 7
const BORDER_VOXELS = WALKABLE_RADIUS_VOXELS + 3; // recast convention
/** Over-approximate the sim: the kinematic mover has NO terrain slope cap (it
 *  snaps to groundHeight each step), so keep steep terrain reachable while still
 *  rejecting the ~90° faces of wall/tree AABBs (doc 14 §2, Open Q3). */
const WALKABLE_SLOPE_DEG = 80;
const BUILD_CONFIG = {
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxSimplificationError: 1.3,
  maxEdgeLength: 12,
  maxVerticesPerPoly: 5,
  detailSampleDistance: CELL_SIZE * 6,
  detailSampleMaxError: CELL_HEIGHT,
};
/** Query search box — how far off the navmesh a start/end point may sit and
 *  still snap onto it (nearest-poly). Generous on Y (2 m) for ground snap. */
const QUERY_HALF_EXTENTS: [number, number, number] = [2, 4, 2];
/** Memory ceiling on resident tiles (~125 KB navmesh data per tile → ~64 MB at
 *  512). The default cap is `min(tilesPerSide², this)`: small/standard worlds
 *  stay (near-)fully resident so eviction never thrashes the multi-player active
 *  set (40 players × ~16 tiles at NAV_ACTIVE_RADIUS ≈ ≤ this), while large/huge
 *  tiers — whose full mesh far exceeds the 128 MB DO — are activity-scoped and
 *  evict cold tiles (doc 14 §4). The exact value + behavior under extreme player
 *  dispersal is a tuning/measurement item (the M4 config dial + a loadtest). */
const NAV_MAX_RESIDENT_TILES = 512;

/** How far around each live player the engine keeps navmesh tiles resident (m)
 *  — covers a zombie's aggro→chase range so a chase always has mesh under it. */
export const NAV_ACTIVE_RADIUS = 48;
/** Tiles carved per tick from `phase("nav")` (doc 14 §4 — ≤1 steady-state; a
 *  per-tile carve is ~5–9 ms, ~8–13% of the 66.7 ms tick). */
export const NAV_TILES_PER_TICK = 1;

export interface NavSystemOptions {
  /** Cold-tile eviction cap (LRU beyond this). */
  tileCap?: number;
}

interface TileState {
  x: number;
  y: number;
  /** Monotonic use counter for LRU eviction. */
  lastUsed: number;
  /** True once carved (even if it produced zero polys — a water/all-solid tile
   *  is "built", just empty; we don't re-attempt it every tick). */
  built: boolean;
}

/**
 * Engine-owned tiled navmesh. Constructed on `GameState` beside `physics`,
 * stepped once per tick from `phase("nav")`. Mirrors PhysicsSystem's shape:
 * built from the statics source, self-caps memory, cheap when idle.
 */
export class NavSystem implements Pathfinder {
  private readonly statics: NavStaticsSource;
  private readonly navMesh: NavMesh;
  private readonly tileCap: number;
  /** World grid: `n` heightfield samples/side at `HEIGHTFIELD_CELL_M`. */
  private readonly n: number;
  /** Tiles per side (world.size / 32 m), and the tile-grid origin (world min). */
  private readonly tilesPerSide: number;
  private readonly originX: number;
  private readonly originZ: number;

  /** Per-tile state, keyed by tile index (ty * tilesPerSide + tx). */
  private readonly tiles = new Map<number, TileState>();
  /** Tiles queued to (re)build, in insertion order. */
  private readonly buildQueue: number[] = [];
  private readonly queued = new Set<number>();
  private useClock = 0;

  constructor(statics: NavStaticsSource, opts: NavSystemOptions = {}) {
    this.statics = statics;
    this.n = Math.round(statics.size / HEIGHTFIELD_CELL_M) + 1;
    this.tilesPerSide = Math.ceil(statics.size / TILE_SIZE_WORLD);
    // Near-full residency on small/standard worlds (no thrash), memory-bounded
    // on large/huge (activity-scoped eviction).
    this.tileCap = opts.tileCap ?? Math.min(this.tilesPerSide * this.tilesPerSide, NAV_MAX_RESIDENT_TILES);
    this.originX = -statics.size / 2;
    this.originZ = -statics.size / 2;
    this.navMesh = createNavMesh();
    this.navMesh.tileWidth = TILE_SIZE_WORLD;
    this.navMesh.tileHeight = TILE_SIZE_WORLD;
    this.navMesh.origin = [this.originX, 0, this.originZ];
  }

  // --- Pathfinder seam -------------------------------------------------------

  findPath(ax: number, az: number, bx: number, bz: number): Waypoint[] | null {
    const start: [number, number, number] = [ax, this.statics.heightAt(ax, az), az];
    const end: [number, number, number] = [bx, this.statics.heightAt(bx, bz), bz];
    const res = findPath(this.navMesh, start, end, QUERY_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!res.success || res.path.length === 0) return null;
    // Touch the tiles the path touches so LRU keeps a live route resident.
    this.touch(this.tileIndexAt(ax, az));
    this.touch(this.tileIndexAt(bx, bz));
    return res.path.map((p) => ({ x: p.position[0], z: p.position[2] }));
  }

  ensureBuilt(x: number, z: number, radius: number): void {
    const minTx = this.clampTile(this.tileCoord(x - radius, this.originX));
    const maxTx = this.clampTile(this.tileCoord(x + radius, this.originX));
    const minTy = this.clampTile(this.tileCoord(z - radius, this.originZ));
    const maxTy = this.clampTile(this.tileCoord(z + radius, this.originZ));
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const idx = ty * this.tilesPerSide + tx;
        const state = this.tiles.get(idx);
        if (state?.built) {
          this.touch(idx);
          continue;
        }
        this.enqueue(idx);
      }
    }
  }

  dirtyTile(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const minTx = this.clampTile(this.tileCoord(minX, this.originX));
    const maxTx = this.clampTile(this.tileCoord(maxX, this.originX));
    const minTy = this.clampTile(this.tileCoord(minZ, this.originZ));
    const maxTy = this.clampTile(this.tileCoord(maxZ, this.originZ));
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const idx = ty * this.tilesPerSide + tx;
        // Only re-carve tiles we've actually built — a dirty edit in an
        // unbuilt region is picked up when that region first builds.
        if (this.tiles.get(idx)?.built) this.enqueue(idx);
      }
    }
  }

  stepBuild(maxTiles: number): void {
    let built = 0;
    while (built < maxTiles && this.buildQueue.length > 0) {
      const idx = this.buildQueue.shift()!;
      this.queued.delete(idx);
      const tx = idx % this.tilesPerSide;
      const ty = Math.floor(idx / this.tilesPerSide);
      this.carveTile(tx, ty);
      built++;
    }
    this.evict();
  }

  // --- test / consumer helper ------------------------------------------------

  /** True if (x,z) lands on the current navmesh within a cell — used by the
   *  compare-to-sim walkability check and by consumers probing reachability. */
  isWalkable(x: number, z: number): boolean {
    const groundY = this.statics.heightAt(x, z);
    const center: [number, number, number] = [x, groundY, z];
    // Fresh result each call — findNearestPoly does not reliably reset a shared
    // result to failure, so reusing one leaks a prior "walkable" verdict.
    const res = findNearestPoly(createFindNearestPolyResult(), this.navMesh, center, QUERY_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!res.success) return false;
    const dx = res.position[0] - x;
    const dz = res.position[2] - z;
    // Horizontal snap within a cell AND near ground level — a solid obstacle's
    // walkable ROOF (directly overhead) must not read as ground-walkable.
    return dx * dx + dz * dz <= CELL_SIZE * CELL_SIZE && Math.abs(res.position[1] - groundY) <= PLAYER_HEIGHT;
  }

  /** FNV-1a over the covering tile's vertices + poly indices/areas/flags —
   *  the generate-twice self-consistency signature (doc 14 §5). `""` if the
   *  tile has no polys. Floats are quantized to 1 cm so it is a geometric, not
   *  bit-exact, hash (bit-exactness across machines is not required — the mesh
   *  is server-private and regenerated on wake). */
  debugTileHash(x: number, z: number): string {
    const tx = this.clampTile(this.tileCoord(x, this.originX));
    const ty = this.clampTile(this.tileCoord(z, this.originZ));
    let h = 0x811c9dc5;
    const mix = (n: number) => {
      const q = Math.round(n * 100) | 0;
      for (let s = 0; s < 32; s += 8) {
        h ^= (q >>> s) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    };
    for (const tile of Object.values(this.navMesh.tiles)) {
      if (tile.tileX !== tx || tile.tileY !== ty || tile.tileLayer !== 0) continue;
      for (const v of tile.vertices) mix(v);
      for (const p of tile.polys) {
        for (const vi of p.vertices) mix(vi);
        mix(p.area);
        mix(p.flags);
      }
      return (h >>> 0).toString(16);
    }
    return "";
  }

  /** Built (non-empty) tile count — for memory/telemetry assertions. */
  get builtTileCount(): number {
    let c = 0;
    for (const t of this.tiles.values()) if (t.built) c++;
    return c;
  }

  // --- internals -------------------------------------------------------------

  private enqueue(idx: number): void {
    if (this.queued.has(idx)) return;
    this.queued.add(idx);
    this.buildQueue.push(idx);
  }

  private touch(idx: number): void {
    const t = this.tiles.get(idx);
    if (t) t.lastUsed = ++this.useClock;
  }

  private tileCoord(world: number, origin: number): number {
    return Math.floor((world - origin) / TILE_SIZE_WORLD);
  }
  private clampTile(t: number): number {
    return Math.max(0, Math.min(this.tilesPerSide - 1, t));
  }
  private tileIndexAt(x: number, z: number): number {
    return this.clampTile(this.tileCoord(z, this.originZ)) * this.tilesPerSide + this.clampTile(this.tileCoord(x, this.originX));
  }

  /** World X of heightfield column `col` — PhysicsSystem's exact formula. */
  private gridX(col: number): number {
    return (col / (this.n - 1) - 0.5) * this.statics.size;
  }
  /** Heightfield column covering world X (inverse of gridX), unclamped. */
  private colOf(world: number): number {
    return (world / this.statics.size + 0.5) * (this.n - 1);
  }

  /**
   * Carve one tile: gather its local terrain + static geometry, run the recast
   * pipeline, and swap it into the navmesh. Empty output (all water/solid) still
   * marks the tile built so it isn't re-attempted every tick.
   */
  private carveTile(tx: number, ty: number): void {
    const tileMinX = this.originX + tx * TILE_SIZE_WORLD;
    const tileMinZ = this.originZ + ty * TILE_SIZE_WORLD;
    const border = BORDER_VOXELS * CELL_SIZE;
    const exMinX = tileMinX - border;
    const exMinZ = tileMinZ - border;
    const exMaxX = tileMinX + TILE_SIZE_WORLD + border;
    const exMaxZ = tileMinZ + TILE_SIZE_WORLD + border;

    const positions: number[] = [];
    const indices: number[] = [];

    // Terrain: sample world-grid-aligned 4 m points covering the expanded tile
    // (identical positions to PhysicsSystem's heightfield → collision parity).
    const c0 = Math.max(0, Math.floor(this.colOf(exMinX)));
    const c1 = Math.min(this.n - 1, Math.ceil(this.colOf(exMaxX)));
    const r0 = Math.max(0, Math.floor(this.colOf(exMinZ)));
    const r1 = Math.min(this.n - 1, Math.ceil(this.colOf(exMaxZ)));
    const cols = c1 - c0 + 1;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let r = r0; r <= r1; r++) {
      const z = this.gridX(r);
      for (let c = c0; c <= c1; c++) {
        const x = this.gridX(c);
        const y = Math.fround(this.statics.heightAt(x, z));
        positions.push(x, y, z);
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const vAt = (c: number, r: number) => (r - r0) * cols + (c - c0);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const v00 = vAt(c, r);
        const v10 = vAt(c + 1, r);
        const v01 = vAt(c, r + 1);
        const v11 = vAt(c + 1, r + 1);
        indices.push(v00, v01, v11, v00, v11, v10); // both +Y
      }
    }
    const terrainTris = indices.length / 3;

    // Statics in the expanded tile — the exact kinematic walls/trees.
    const cx = (exMinX + exMaxX) / 2;
    const cz = (exMinZ + exMaxZ) / 2;
    const qr = Math.hypot(exMaxX - cx, exMaxZ - cz) + 1;
    const q = this.statics.queryStatics(cx, cz, qr);
    for (const w of q.walls) {
      this.pushBox(positions, indices, w.minX, w.y0, w.minZ, w.maxX, w.y1, w.maxZ);
      yMin = Math.min(yMin, w.y0);
      yMax = Math.max(yMax, w.y1);
    }
    for (const t of q.trees) {
      const y0 = this.statics.heightAt(t.x, t.z);
      this.pushBox(positions, indices, t.x - t.r, y0, t.z - t.r, t.x + t.r, y0 + t.height, t.z + t.r);
      yMax = Math.max(yMax, y0 + t.height);
    }

    const state: TileState = this.tiles.get(ty * this.tilesPerSide + tx) ?? {
      x: tx,
      y: ty,
      lastUsed: this.useClock,
      built: false,
    };
    state.built = true;
    state.lastUsed = ++this.useClock;
    this.tiles.set(ty * this.tilesPerSide + tx, state);

    if (terrainTris === 0 || !Number.isFinite(yMin)) {
      removeTile(this.navMesh, tx, ty, 0);
      return;
    }

    const meshPositions = new Float32Array(positions);
    const meshIndices = new Uint32Array(indices);
    const triAreaIds = new Uint8Array(meshIndices.length / 3);
    markWalkableTriangles(meshPositions, meshIndices, triAreaIds, WALKABLE_SLOPE_DEG);
    // Water cut: terrain below WATER_WALK_MIN is a full-stop for the mover, so
    // it must not be walkable in the mesh either (doc 14 §2). Terrain tris are
    // the first `terrainTris`; box tris are never water-masked.
    for (let i = 0; i < terrainTris; i++) {
      const a = meshIndices[i * 3];
      const b = meshIndices[i * 3 + 1];
      const c = meshIndices[i * 3 + 2];
      const yc = (meshPositions[a * 3 + 1] + meshPositions[b * 3 + 1] + meshPositions[c * 3 + 1]) / 3;
      if (yc < WATER_WALK_MIN) triAreaIds[i] = 0;
    }

    const expanded: [number, number, number, number, number, number] = [
      exMinX,
      yMin - 1,
      exMinZ,
      exMaxX,
      yMax + 1,
      exMaxZ,
    ];
    const side = TILE_SIZE_VOXELS + BORDER_VOXELS * 2;
    const ctx = BuildContext.create();
    const heightfield = createHeightfield(side, side, expanded, CELL_SIZE, CELL_HEIGHT);
    rasterizeTriangles(ctx, heightfield, meshPositions, meshIndices, triAreaIds, WALKABLE_CLIMB_VOXELS);
    filterLowHangingWalkableObstacles(heightfield, WALKABLE_CLIMB_VOXELS);
    filterLedgeSpans(heightfield, WALKABLE_HEIGHT_VOXELS, WALKABLE_CLIMB_VOXELS);
    filterWalkableLowHeightSpans(heightfield, WALKABLE_HEIGHT_VOXELS);
    const chf = buildCompactHeightfield(ctx, WALKABLE_HEIGHT_VOXELS, WALKABLE_CLIMB_VOXELS, heightfield);
    erodeWalkableArea(WALKABLE_RADIUS_VOXELS, chf);
    buildDistanceField(chf);
    buildRegions(ctx, chf, BORDER_VOXELS, BUILD_CONFIG.minRegionArea, BUILD_CONFIG.mergeRegionArea);
    const contourSet = buildContours(
      ctx,
      chf,
      BUILD_CONFIG.maxSimplificationError,
      BUILD_CONFIG.maxEdgeLength,
      ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );
    const polyMesh = buildPolyMesh(ctx, contourSet, BUILD_CONFIG.maxVerticesPerPoly);
    for (let i = 0; i < polyMesh.nPolys; i++) {
      if (polyMesh.areas[i] === WALKABLE_AREA) polyMesh.areas[i] = 0;
      if (polyMesh.areas[i] === 0) polyMesh.flags[i] = 1;
    }
    const polyMeshDetail = buildPolyMeshDetail(
      ctx,
      polyMesh,
      chf,
      BUILD_CONFIG.detailSampleDistance,
      BUILD_CONFIG.detailSampleMaxError,
    );

    removeTile(this.navMesh, tx, ty, 0);
    if (polyMesh.vertices.length === 0) return; // all-solid/water tile: built, empty
    const tilePolys = polyMeshToTilePolys(polyMesh);
    const tileDetailMesh = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);
    addTile(
      this.navMesh,
      buildTile({
        bounds: polyMesh.bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetailMesh.detailMeshes,
        detailVertices: tileDetailMesh.detailVertices,
        detailTriangles: tileDetailMesh.detailTriangles,
        tileX: tx,
        tileY: ty,
        tileLayer: 0,
        cellSize: CELL_SIZE,
        cellHeight: CELL_HEIGHT,
        walkableHeight: PLAYER_HEIGHT,
        walkableRadius: PLAYER_RADIUS,
        walkableClimb: STEP_UP_MAX,
      }),
    );
  }

  /** Evict the least-recently-used built tiles over the cap (drop their polys;
   *  the tile re-carves on demand). Empty tiles cost nothing but count toward
   *  the cache so a wandering pointer doesn't thrash. */
  private evict(): void {
    if (this.tiles.size <= this.tileCap) return;
    const sorted = [...this.tiles.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    const over = this.tiles.size - this.tileCap;
    for (let i = 0; i < over; i++) {
      const t = sorted[i];
      removeTile(this.navMesh, t.x, t.y, 0);
      this.tiles.delete(t.y * this.tilesPerSide + t.x);
    }
  }

  /** Append an axis-aligned cuboid as surface triangles — mirrors PhysicsSystem
   *  addAabb's degenerate guard and winding. */
  private pushBox(
    pos: number[],
    idx: number[],
    minX: number,
    y0: number,
    minZ: number,
    maxX: number,
    y1: number,
    maxZ: number,
  ): void {
    if (maxX - minX <= 0 || y1 - y0 <= 0 || maxZ - minZ <= 0) return;
    const b = pos.length / 3;
    pos.push(
      minX, y0, minZ, maxX, y0, minZ, maxX, y0, maxZ, minX, y0, maxZ, // 0-3 bottom
      minX, y1, minZ, maxX, y1, minZ, maxX, y1, maxZ, minX, y1, maxZ, // 4-7 top
    );
    idx.push(
      b + 4, b + 7, b + 6, b + 4, b + 6, b + 5, // top +Y
      b + 0, b + 1, b + 2, b + 0, b + 2, b + 3, // bottom -Y
      b + 0, b + 4, b + 5, b + 0, b + 5, b + 1, // -Z
      b + 3, b + 2, b + 6, b + 3, b + 6, b + 7, // +Z
      b + 0, b + 3, b + 7, b + 0, b + 7, b + 4, // -X
      b + 1, b + 5, b + 6, b + 1, b + 6, b + 2, // +X
    );
  }
}
