// Player-built structures (doc 06). One shared module owns the piece types,
// the deterministic geometry (`pieceAabbs`), the mutable spatial index every
// World object carries, and the `canPlace` validation both the client ghost
// and the server run verbatim.
//
// DETERMINISM CONTRACT (doc 06 §Threatens): client and server must derive
// IDENTICAL collision boxes from the same piece record. Everything here is
// pure arithmetic over the record's integer grid coords plus the
// server-computed, quantized `floorY` that rides the wire — there is no
// float-ordering surface. The index is created EMPTY inside createWorld
// (zero rng draws; the worldgen streams and the burn at the end of
// createWorld are untouched).

import {
  BUILD_CELL,
  BUILD_DENSITY_CAP,
  BUILD_DENSITY_RADIUS,
  BUILD_FOUNDATION_MAX_SLOPE,
  BUILD_MIN_TERRAIN_H,
  BUILD_WALL_HEIGHT,
  BUILD_WALL_THICKNESS,
  NO_BUILD_BUILDING_MARGIN,
  NO_BUILD_MILITARY_MARGIN,
  NO_BUILD_SPAWN_RADIUS,
  NO_BUILD_TOWN_MARGIN,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STEP_UP_MAX,
} from "./constants";
import { distSq2D, rayAabb, type Aabb, type Vec3 } from "./math";
import type { World } from "./world";

// --- Piece types (doc 06 §Piece data) ---

export type PieceKind =
  | "foundation"
  | "wall"
  | "doorway"
  | "window"
  | "door"
  | "gate"
  | "crate";
export type PieceTier = 0 | 1; // 0 = wood, 1 = scrap

/** Every placeable kind (doc 06 M6 added the crate — the full 7-kind set). */
export const PLACEABLE_KINDS: readonly PieceKind[] = [
  "foundation",
  "wall",
  "doorway",
  "window",
  "door",
  "gate",
  "crate",
];

/** The wire/client/persisted piece shape. `ownerHash`/`placedAtMs`/`code`/
 * `authorized`/`contents` are SERVER-ONLY — they live in the server system's
 * meta map (game.structureMeta), never in this record, never in this index. */
export interface StructurePiece {
  /** From game.nextEntityId — the ONE shared id space. */
  id: number;
  kind: PieceKind;
  tier: PieceTier;
  gx: number;
  gz: number;
  /** Canonical edge (0 = +Z, 2 = +X) for edge/attachment pieces; absent for
   * cell pieces. Side 1/-Z of (gx,gz) is stored as edge 0 of (gx, gz-1);
   * side 3/-X as edge 2 of (gx-1, gz). */
  edge?: 0 | 2;
  /** Free position within the cell — crates only (doc 06 M6). Must fall
   * inside cell (gx,gz); absent reads as the cell center. */
  x?: number;
  z?: number;
  /** Computed ONCE at placement on the server (max of the anchoring cell's 4
   * corner heights + 0.18, quantized to 0.05 m), carried on the wire and in
   * persistence thereafter — the determinism-drift kill. */
  floorY: number;
  /** PIECE_DEFS hp at placement; inert this slice (raiding is a follow-up). */
  hp: number;
  /** Door/gate open state — open swaps the collision boxes out. */
  open?: boolean;
}

export interface PieceDef {
  kind: PieceKind;
  /** Wood units (tier 0) / scrap units (tier 1) consumed — same count. */
  cost: number;
  /** Base hp per tier: [wood, scrap]. */
  hp: [number, number];
}

export const PIECE_DEFS: Record<PieceKind, PieceDef> = {
  foundation: { kind: "foundation", cost: 8, hp: [600, 1800] },
  wall: { kind: "wall", cost: 6, hp: [400, 1200] },
  doorway: { kind: "doorway", cost: 6, hp: [400, 1200] },
  window: { kind: "window", cost: 6, hp: [350, 1050] },
  door: { kind: "door", cost: 4, hp: [250, 750] },
  gate: { kind: "gate", cost: 8, hp: [450, 1350] },
  crate: { kind: "crate", cost: 6, hp: [200, 200] }, // wood-only in v1
};

/** Incoming structure damage multiplier per tier: [melee, bullet] (doc 06
 * §Piece data). Wood falls to a patient axe; scrap effectively waits for
 * future explosives. */
export const TIER_DMG_MULT: Record<PieceTier, [number, number]> = {
  0: [1.0, 0.5],
  1: [0.25, 0.25],
};

// --- Geometry (doc 06 §Build grid table) ---
// Local constants: geometry details live WITH pieceAabbs (the shared-module
// parity guarantee); gameplay tunables live in constants.ts per house rules.

/** Foundation slab skirt below the top surface (the FOUNDATION_DEPTH
 * precedent, world.ts) — reads as founded on slopes; y-aware movement
 * ignores the below-ground portion. */
const FOUNDATION_SKIRT = 3;
/** Edge pieces (walls/doorways/windows/gates) skirt below floorY so the gap
 * over sloped terrain outside the foundation can't be shot/crawled under —
 * "exactly like building walls" (doc 06:62). */
const EDGE_SKIRT = 1.5;
/** Door/gate opening width — mirrors worldgen DOOR_WIDTH. */
const DOOR_GAP = 1.6;
/** Door panel + doorway header height — mirrors worldgen DOOR_HEIGHT. */
const DOOR_HEIGHT = 2.2;
/** Window opening: worldgen sill/head geometry. Deliberately IMPASSABLE to
 * movement (the 1.1 m opening is under PLAYER_HEIGHT - STEP_UP_MAX = 1.2 m);
 * sight and shots pass. A vaultable window would be a free raid entry. */
const WINDOW_SILL = 0.75;
const WINDOW_HEAD = 1.85;
/** Foundation top sits this far above the highest cell corner. */
const FLOOR_LIFT = 0.18;

/** Quantize a floor height to 0.05 m — kills any float-representation doubt
 * on a value that is computed once and carried (doc 06:64). */
export function quantizeFloorY(y: number): number {
  return Math.round(y * 20) / 20;
}

/** Foundation floorY for cell (gx,gz): max terrain height at the 4 corners
 * + FLOOR_LIFT, quantized. Server-authoritative at placement; the client
 * calls it only for ghost preview. */
export function computeFoundationFloorY(
  world: Pick<World, "heightAt">,
  gx: number,
  gz: number,
): number {
  const x0 = gx * BUILD_CELL;
  const z0 = gz * BUILD_CELL;
  let h = -Infinity;
  for (const [sx, sz] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    h = Math.max(h, world.heightAt(x0 + sx * BUILD_CELL, z0 + sz * BUILD_CELL));
  }
  return quantizeFloorY(h + FLOOR_LIFT);
}

/** The two cells an edge borders: the home cell and its +Z / +X neighbor. */
function edgeCells(gx: number, gz: number, edge: 0 | 2): [[number, number], [number, number]] {
  return edge === 0
    ? [
        [gx, gz],
        [gx, gz + 1],
      ]
    : [
        [gx, gz],
        [gx + 1, gz],
      ];
}

/** Edge-piece floorY: inherited from the anchoring foundation(s) — the higher
 * one when both cells carry foundations (doc 06:64). Null with no anchor. */
export function edgeFloorY(
  index: StructureIndex,
  gx: number,
  gz: number,
  edge: 0 | 2,
): number | null {
  let best: number | null = null;
  for (const [cx, cz] of edgeCells(gx, gz, edge)) {
    const p = index.cellPiece(cx, cz);
    if (p && p.kind === "foundation" && (best === null || p.floorY > best)) best = p.floorY;
  }
  return best;
}

/** World-space center of a piece's footprint (cell center / edge midpoint /
 * a crate's free position when it carries one). */
export function pieceCenter(piece: {
  kind: PieceKind;
  gx: number;
  gz: number;
  edge?: 0 | 2;
  x?: number;
  z?: number;
}): [number, number] {
  const x0 = piece.gx * BUILD_CELL;
  const z0 = piece.gz * BUILD_CELL;
  if (piece.kind === "crate" && piece.x !== undefined && piece.z !== undefined) {
    return [piece.x, piece.z];
  }
  if (piece.edge === 0) return [x0 + BUILD_CELL / 2, z0 + BUILD_CELL];
  if (piece.edge === 2) return [x0 + BUILD_CELL, z0 + BUILD_CELL / 2];
  return [x0 + BUILD_CELL / 2, z0 + BUILD_CELL / 2];
}

/**
 * Deterministic collision boxes from the piece record ALONE (doc 06 table).
 * The only AABB source on both sides; AABBs never travel on the wire or into
 * storage. Open doors/gates derive ZERO boxes (the collision swap).
 */
export function pieceAabbs(piece: StructurePiece): Aabb[] {
  const c = BUILD_CELL;
  const x0 = piece.gx * c;
  const z0 = piece.gz * c;
  const fy = piece.floorY;

  if (piece.kind === "foundation") {
    return [
      { minX: x0, minZ: z0, maxX: x0 + c, maxZ: z0 + c, y0: fy - FOUNDATION_SKIRT, y1: fy },
    ];
  }
  // Crates are NON-COLLIDING (doc 06 open Q1's decided recommendation — the
  // campfire precedent): zero boxes keeps them out of the collision-sync
  // surface and kills crate-stair exploits.
  if (piece.kind === "crate") return [];

  const edge = piece.edge;
  if (edge === undefined) return [];

  // Edge line: +Z edge runs along X at z = z0 + c; +X edge along Z at x = x0 + c.
  const horizontal = edge === 0;
  const ht = BUILD_WALL_THICKNESS / 2;
  const lo = horizontal ? x0 : z0;
  const hi = lo + c;
  const mid = (lo + hi) / 2;
  const nLo = (horizontal ? z0 : x0) + c - ht;
  const nHi = nLo + BUILD_WALL_THICKNESS;
  /** A segment [a, b] along the edge with vertical extent [y0, y1]. */
  const seg = (a: number, b: number, y0: number, y1: number): Aabb =>
    horizontal
      ? { minX: a, minZ: nLo, maxX: b, maxZ: nHi, y0, y1 }
      : { minX: nLo, minZ: a, maxX: nHi, maxZ: b, y0, y1 };

  const skirtY = fy - EDGE_SKIRT;
  const topY = fy + BUILD_WALL_HEIGHT;
  const g = DOOR_GAP / 2;

  switch (piece.kind) {
    case "wall":
      return [seg(lo, hi, skirtY, topY)];
    case "doorway":
      return [
        seg(lo, mid - g, skirtY, topY),
        seg(mid + g, hi, skirtY, topY),
        seg(mid - g, mid + g, fy + DOOR_HEIGHT, topY), // header — walk-under (y-aware)
      ];
    case "window":
      // 4 boxes: reliably solid to movement, see-through/shoot-through at
      // sight height (worldgen window geometry).
      return [
        seg(lo, mid - g, skirtY, topY),
        seg(mid + g, hi, skirtY, topY),
        seg(mid - g, mid + g, skirtY, fy + WINDOW_SILL),
        seg(mid - g, mid + g, fy + WINDOW_HEAD, topY),
      ];
    case "door":
      return piece.open === true ? [] : [seg(mid - g, mid + g, fy, fy + DOOR_HEIGHT)];
    case "gate":
      return piece.open === true ? [] : [seg(lo, hi, skirtY, topY)];
    default:
      return [];
  }
}

// --- StructureIndex (doc 06 §The StructureIndex) ---

export interface PieceRayHit {
  t: number;
  /** Piece id — attribution for the raiding follow-up (and the demolish aim). */
  id: number;
}

export interface StructureIndex {
  pieces: Map<number, StructurePiece>;
  /** Derives AABBs via pieceAabbs() and inserts them into an own 16 m grid. */
  add(piece: StructurePiece): void;
  remove(id: number): void;
  /** Door/gate toggles swap collision boxes in/out of the grid. */
  setOpen(id: number, open: boolean): void;
  /** Walls near a point — merged into World.queryStatics results. */
  queryWalls(x: number, z: number, r: number): Aabb[];
  /** Foundation top of the cell containing (x,z), or null. */
  floorAt(x: number, z: number): number | null;
  /** Nearest piece hit WITH attribution. dir must be normalized. */
  raycastPiece(origin: Vec3, dir: Vec3, maxDist: number): PieceRayHit | null;
  /** Cell occupancy — FOUNDATIONS (a crate can share a foundation's cell,
   * so it tracks its own map; see cratePiece). canPlace support. */
  cellPiece(gx: number, gz: number): StructurePiece | null;
  /** Crate occupancy: the one crate in cell (gx,gz), or null (doc 06 M6). */
  cratePiece(gx: number, gz: number): StructurePiece | null;
  /** Edge occupancy: the wall-class piece and the door attachment. */
  edgePieces(
    gx: number,
    gz: number,
    edge: 0 | 2,
  ): { wall: StructurePiece | null; door: StructurePiece | null };
  /** Pieces whose footprint center is within r of (x,z) — the density cap. */
  countNear(x: number, z: number, r: number): number;
  clear(): void;
}

/** Spatial grid cell size — matches world.ts GRID_CELL. */
const GRID_CELL = 16;
/**
 * Grid key: (ix+2048)*4096 + (iz+2048). ±2048 cells covers ±32 km of 16 m
 * cells AND doubles as the build-cell key range (huge tier: ±533 build cells
 * of 3 m — far inside ±2048). Deliberately NOT world.ts's (ix+512) scheme,
 * which would collide at huge-tier build-cell addressing (doc 07).
 */
function gridKey(ix: number, iz: number): number {
  return (ix + 2048) * 4096 + (iz + 2048);
}

function cellKey(gx: number, gz: number): number {
  return (gx + 2048) * 4096 + (gz + 2048);
}

function edgeKey(gx: number, gz: number, edge: 0 | 2): number {
  return cellKey(gx, gz) * 2 + (edge === 2 ? 1 : 0);
}

/** A grid entry: one collision box + the piece it belongs to. */
interface BoxEntry {
  id: number;
  box: Aabb;
}

const WALL_CLASS: ReadonlySet<PieceKind> = new Set(["wall", "doorway", "window", "gate"]);

export function createStructureIndex(): StructureIndex {
  const pieces = new Map<number, StructurePiece>();
  const grid = new Map<number, BoxEntry[]>();
  /** Boxes currently in the grid per piece (for removal / open-swap). */
  const boxesById = new Map<number, Aabb[]>();
  /** cellKey -> piece id (foundations). */
  const cellOcc = new Map<number, number>();
  /** cellKey -> piece id (crates) — separate from cellOcc because a crate can
   * stand ON a foundation in the same cell (doc 06 M6). */
  const crateOcc = new Map<number, number>();
  /** edgeKey -> occupancy (wall-class piece + door attachment). */
  const edgeOcc = new Map<number, { wall: number | null; door: number | null }>();

  const gridOf = (v: number): number => Math.floor(v / GRID_CELL);

  const insertBoxes = (id: number, boxes: Aabb[]): void => {
    boxesById.set(id, boxes);
    for (const box of boxes) {
      for (let ix = gridOf(box.minX); ix <= gridOf(box.maxX); ix++) {
        for (let iz = gridOf(box.minZ); iz <= gridOf(box.maxZ); iz++) {
          const key = gridKey(ix, iz);
          let cell = grid.get(key);
          if (!cell) {
            cell = [];
            grid.set(key, cell);
          }
          cell.push({ id, box });
        }
      }
    }
  };

  const removeBoxes = (id: number): void => {
    const boxes = boxesById.get(id);
    if (!boxes) return;
    boxesById.delete(id);
    for (const box of boxes) {
      for (let ix = gridOf(box.minX); ix <= gridOf(box.maxX); ix++) {
        for (let iz = gridOf(box.minZ); iz <= gridOf(box.maxZ); iz++) {
          const key = gridKey(ix, iz);
          const cell = grid.get(key);
          if (!cell) continue;
          const next = cell.filter((e) => e.id !== id);
          if (next.length === 0) grid.delete(key);
          else grid.set(key, next);
        }
      }
    }
  };

  const edgeSlot = (gx: number, gz: number, edge: 0 | 2): { wall: number | null; door: number | null } => {
    const key = edgeKey(gx, gz, edge);
    let slot = edgeOcc.get(key);
    if (!slot) {
      slot = { wall: null, door: null };
      edgeOcc.set(key, slot);
    }
    return slot;
  };

  const index: StructureIndex = {
    pieces,

    add(piece: StructurePiece): void {
      if (pieces.has(piece.id)) return;
      pieces.set(piece.id, piece);
      if (piece.kind === "foundation") {
        cellOcc.set(cellKey(piece.gx, piece.gz), piece.id);
      } else if (piece.kind === "crate") {
        crateOcc.set(cellKey(piece.gx, piece.gz), piece.id);
      } else if (piece.edge !== undefined) {
        const slot = edgeSlot(piece.gx, piece.gz, piece.edge);
        if (piece.kind === "door") slot.door = piece.id;
        else if (WALL_CLASS.has(piece.kind)) slot.wall = piece.id;
      }
      insertBoxes(piece.id, pieceAabbs(piece));
    },

    remove(id: number): void {
      const piece = pieces.get(id);
      if (!piece) return;
      removeBoxes(id);
      pieces.delete(id);
      if (piece.kind === "foundation") {
        cellOcc.delete(cellKey(piece.gx, piece.gz));
      } else if (piece.kind === "crate") {
        crateOcc.delete(cellKey(piece.gx, piece.gz));
      } else if (piece.edge !== undefined) {
        const slot = edgeOcc.get(edgeKey(piece.gx, piece.gz, piece.edge));
        if (slot) {
          if (slot.wall === id) slot.wall = null;
          if (slot.door === id) slot.door = null;
          if (slot.wall === null && slot.door === null) {
            edgeOcc.delete(edgeKey(piece.gx, piece.gz, piece.edge));
          }
        }
      }
    },

    setOpen(id: number, open: boolean): void {
      const piece = pieces.get(id);
      if (!piece || (piece.kind !== "door" && piece.kind !== "gate")) return;
      if (piece.open === open) return;
      removeBoxes(id);
      piece.open = open;
      insertBoxes(id, pieceAabbs(piece));
    },

    queryWalls(x: number, z: number, r: number): Aabb[] {
      const out: Aabb[] = [];
      const seen = new Set<Aabb>();
      for (let ix = gridOf(x - r); ix <= gridOf(x + r); ix++) {
        for (let iz = gridOf(z - r); iz <= gridOf(z + r); iz++) {
          const cell = grid.get(gridKey(ix, iz));
          if (!cell) continue;
          for (const e of cell) {
            if (!seen.has(e.box)) {
              seen.add(e.box);
              out.push(e.box);
            }
          }
        }
      }
      return out;
    },

    floorAt(x: number, z: number): number | null {
      const id = cellOcc.get(cellKey(Math.floor(x / BUILD_CELL), Math.floor(z / BUILD_CELL)));
      if (id === undefined) return null;
      const piece = pieces.get(id);
      return piece ? piece.floorY : null;
    },

    raycastPiece(origin: Vec3, dir: Vec3, maxDist: number): PieceRayHit | null {
      // Same half-cell march + 3x3 ring as world.raycastStatics so diagonal
      // rays can't slip a cell between samples.
      let best: PieceRayHit | null = null;
      const seen = new Set<Aabb>();
      for (let d = 0; d <= maxDist + GRID_CELL * 0.5; d += GRID_CELL * 0.5) {
        const sampleD = Math.min(d, maxDist);
        const cx = gridOf(origin.x + dir.x * sampleD);
        const cz = gridOf(origin.z + dir.z * sampleD);
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
          for (let iz = cz - 1; iz <= cz + 1; iz++) {
            const cell = grid.get(gridKey(ix, iz));
            if (!cell) continue;
            for (const e of cell) {
              if (seen.has(e.box)) continue;
              seen.add(e.box);
              const t = rayAabb(origin, dir, e.box, maxDist);
              if (t !== null && (best === null || t < best.t)) best = { t, id: e.id };
            }
          }
        }
      }
      return best;
    },

    cellPiece(gx: number, gz: number): StructurePiece | null {
      const id = cellOcc.get(cellKey(gx, gz));
      return id === undefined ? null : (pieces.get(id) ?? null);
    },

    cratePiece(gx: number, gz: number): StructurePiece | null {
      const id = crateOcc.get(cellKey(gx, gz));
      return id === undefined ? null : (pieces.get(id) ?? null);
    },

    edgePieces(
      gx: number,
      gz: number,
      edge: 0 | 2,
    ): { wall: StructurePiece | null; door: StructurePiece | null } {
      const slot = edgeOcc.get(edgeKey(gx, gz, edge));
      if (!slot) return { wall: null, door: null };
      return {
        wall: slot.wall === null ? null : (pieces.get(slot.wall) ?? null),
        door: slot.door === null ? null : (pieces.get(slot.door) ?? null),
      };
    },

    countNear(x: number, z: number, r: number): number {
      // O(pieces) — called at placement rate only, never per tick.
      const rSq = r * r;
      let n = 0;
      for (const piece of pieces.values()) {
        const [cx, cz] = pieceCenter(piece);
        if (distSq2D(x, z, cx, cz) <= rSq) n++;
      }
      return n;
    },

    clear(): void {
      pieces.clear();
      grid.clear();
      boxesById.clear();
      cellOcc.clear();
      crateOcc.clear();
      edgeOcc.clear();
    },
  };
  return index;
}

// --- canPlace (doc 06 §Placement mechanics) ---

export interface PlaceTarget {
  kind: PieceKind;
  tier: PieceTier;
  gx: number;
  gz: number;
  edge?: 0 | 2;
  x?: number;
  z?: number;
}

export type PlaceRejection =
  | "kind"
  | "occupied"
  | "no-foundation"
  | "no-doorway"
  | "slope"
  | "water"
  | "zone"
  | "overlap"
  | "blocked"
  | "density"
  | "bounds";

/** Human-readable rejection text for HUD/notices — one shared source. */
export const PLACE_REJECTION_TEXT: Record<PlaceRejection, string> = {
  kind: "cannot place that",
  occupied: "space occupied",
  "no-foundation": "needs an adjacent foundation",
  "no-doorway": "needs an empty doorway",
  slope: "ground too steep",
  water: "too close to water",
  zone: "building is not allowed here",
  overlap: "overlaps the world",
  blocked: "someone is in the way",
  density: "too many structures nearby",
  bounds: "out of bounds",
};

/** 2D circle-vs-box overlap (strict). */
function circleOverlapsBox(x: number, z: number, r: number, box: Aabb): boolean {
  const cx = Math.max(box.minX, Math.min(x, box.maxX));
  const cz = Math.max(box.minZ, Math.min(z, box.maxZ));
  return distSq2D(x, z, cx, cz) < r * r;
}

function boxesIntersect(a: Aabb, b: Aabb): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ &&
    a.y0 < b.y1 &&
    a.y1 > b.y0
  );
}

/** Resolve the candidate floorY canPlace/the server both use. Null when the
 * target has no anchor (edge pieces without a foundation / door without a
 * doorway) — canPlace turns that into the right rejection. */
export function targetFloorY(world: World, t: PlaceTarget): number | null {
  if (t.kind === "foundation") return computeFoundationFloorY(world, t.gx, t.gz);
  if (t.kind === "crate") {
    // On a foundation the crate sits on the slab top; on bare terrain it sits
    // on quantized ground at its free position (doc 06 table: "on foundation
    // or terrain"). Same derivation on both sides — ghost parity.
    const cell = world.structures.cellPiece(t.gx, t.gz);
    if (cell && cell.kind === "foundation") return cell.floorY;
    const [cx, cz] = pieceCenter(t);
    return quantizeFloorY(world.heightAt(cx, cz));
  }
  if (t.edge === undefined) return null;
  if (t.kind === "door") {
    const { wall } = world.structures.edgePieces(t.gx, t.gz, t.edge);
    return wall && wall.kind === "doorway" ? wall.floorY : null;
  }
  return edgeFloorY(world.structures, t.gx, t.gz, t.edge);
}

/**
 * Shared placement validation — the client ghost (green/red) and the server
 * run EXACTLY this, ordered early-return checks (doc 06:183-198). `occupants`
 * = capsules that must not be trapped inside the new boxes; the server passes
 * every game.players core, the client its predicted self + interpolated
 * remotes (an approximation — a racing sprinter can turn a green ghost into a
 * server rejection, carved out by the doc).
 *
 * Bounds are checked against `world.size` (doc 07: World.size is
 * authoritative — huge-tier worlds reach ±533 build cells; the WORLD_SIZE
 * constant must never appear here).
 */
export function canPlace(
  world: World,
  t: PlaceTarget,
  occupants?: Iterable<{ x: number; y: number; z: number }>,
): PlaceRejection | null {
  // Kind whitelist (anything future is not placeable here). Crates are
  // wood-only in v1 (PIECE_DEFS hp [200, 200]) — parity with the parser, so
  // a scrap-tier crate ghost can never read green.
  if (!PLACEABLE_KINDS.includes(t.kind)) return "kind";
  if (t.kind === "crate" && t.tier !== 0) return "kind";
  if (!Number.isInteger(t.gx) || !Number.isInteger(t.gz)) return "bounds";
  const isEdgePiece = t.kind !== "foundation" && t.kind !== "crate";
  if (isEdgePiece && t.edge !== 0 && t.edge !== 2) return "bounds";
  // A cell piece must not carry an edge: pieceCenter would shift 1.5m and
  // every center-based check below (zones, density — and the server's
  // BUILD_RANGE) would be evaluated at the wrong point. The parser rejects
  // this on the wire; this guard covers every other path.
  if (!isEdgePiece && t.edge !== undefined) return "bounds";
  // Free position (crates only): both coords or neither, and inside the cell —
  // an out-of-cell x/z would shift every center-based check off-address.
  if (t.kind === "crate") {
    if ((t.x === undefined) !== (t.z === undefined)) return "bounds";
    if (t.x !== undefined && t.z !== undefined) {
      if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) return "bounds";
      if (Math.floor(t.x / BUILD_CELL) !== t.gx || Math.floor(t.z / BUILD_CELL) !== t.gz) {
        return "bounds";
      }
    }
  } else if (t.x !== undefined || t.z !== undefined) {
    return "bounds";
  }

  // Bounds: the whole footprint inside ±world.size * 0.48.
  const half = world.size * 0.48;
  {
    const x0 = t.gx * BUILD_CELL;
    const z0 = t.gz * BUILD_CELL;
    if (x0 < -half || z0 < -half || x0 + BUILD_CELL > half || z0 + BUILD_CELL > half) {
      return "bounds";
    }
  }

  const index = world.structures;

  // Occupancy: one foundation per cell / one crate per cell / wall-class per
  // edge / door per edge.
  if (t.kind === "foundation") {
    if (index.cellPiece(t.gx, t.gz)) return "occupied";
  } else if (t.kind === "crate") {
    if (index.cratePiece(t.gx, t.gz)) return "occupied";
  } else {
    const edge = t.edge as 0 | 2;
    const { wall, door } = index.edgePieces(t.gx, t.gz, edge);
    if (t.kind === "door") {
      if (door) return "occupied";
      // Support: a door needs a doorway on its edge.
      if (!wall || wall.kind !== "doorway") return "no-doorway";
    } else {
      if (wall) return "occupied";
      // Support: edge pieces need an adjacent foundation.
      if (edgeFloorY(index, t.gx, t.gz, edge) === null) return "no-foundation";
    }
  }

  // Terrain fit (foundations only): dry land, bounded corner spread.
  if (t.kind === "foundation") {
    const x0 = t.gx * BUILD_CELL;
    const z0 = t.gz * BUILD_CELL;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [sx, sz] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const h = world.heightAt(x0 + sx * BUILD_CELL, z0 + sz * BUILD_CELL);
      if (h <= BUILD_MIN_TERRAIN_H) return "water";
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > BUILD_FOUNDATION_MAX_SLOPE) return "slope";
  }

  const [cx, cz] = pieceCenter(t);

  // Crates on bare terrain (no foundation in the cell) need dry land at their
  // free position — the foundation water rule at a point (doc 06 M6).
  if (t.kind === "crate") {
    const cell = index.cellPiece(t.gx, t.gz);
    const onFoundation = cell !== null && cell.kind === "foundation";
    if (!onFoundation && world.heightAt(cx, cz) <= BUILD_MIN_TERRAIN_H) return "water";
  }

  // No-build zones — all derived from existing World data (doc 06:41).
  for (const town of world.towns) {
    const r = town.radius + NO_BUILD_TOWN_MARGIN;
    if (distSq2D(cx, cz, town.cx, town.cz) < r * r) return "zone";
  }
  {
    const r = world.military.radius + NO_BUILD_MILITARY_MARGIN;
    if (distSq2D(cx, cz, world.military.cx, world.military.cz) < r * r) return "zone";
  }
  for (const b of world.buildings) {
    if (
      Math.abs(cx - b.cx) < b.halfW + NO_BUILD_BUILDING_MARGIN + BUILD_CELL &&
      Math.abs(cz - b.cz) < b.halfD + NO_BUILD_BUILDING_MARGIN + BUILD_CELL
    ) {
      return "zone";
    }
  }
  for (const sp of world.spawnPoints) {
    if (distSq2D(cx, cz, sp.x, sp.z) < NO_BUILD_SPAWN_RADIUS * NO_BUILD_SPAWN_RADIUS) {
      return "zone";
    }
  }

  // Candidate geometry (closed state — doors/gates spawn closed).
  const floorY = targetFloorY(world, t);
  if (floorY === null) return t.kind === "door" ? "no-doorway" : "no-foundation";
  const candidate: StructurePiece = {
    id: -1,
    kind: t.kind,
    tier: t.tier,
    gx: t.gx,
    gz: t.gz,
    ...(isEdgePiece ? { edge: t.edge as 0 | 2 } : {}),
    ...(t.kind === "crate" && t.x !== undefined && t.z !== undefined
      ? { x: t.x, z: t.z }
      : {}),
    floorY,
    hp: 0,
    ...(t.kind === "door" || t.kind === "gate" ? { open: false } : {}),
  };
  const boxes = pieceAabbs(candidate);

  // Physical overlap vs WORLDGEN statics only. world.queryStatics also
  // returns already-placed structure boxes (same object references the index
  // hands out), so subtract those — adjacency to own walls is legal; address
  // collisions were already rejected above.
  {
    const own = new Set(index.queryWalls(cx, cz, BUILD_CELL * 2 + 2));
    const statics = world.queryStatics(cx, cz, BUILD_CELL * 2 + 2);
    for (const wall of statics.walls) {
      if (own.has(wall)) continue;
      for (const box of boxes) {
        if (boxesIntersect(box, wall)) return "overlap";
      }
    }
    for (const tree of statics.trees) {
      for (const box of boxes) {
        if (
          circleOverlapsBox(tree.x, tree.z, tree.r, box) &&
          box.y0 < tree.groundY + tree.height &&
          box.y1 > tree.groundY
        ) {
          return "overlap";
        }
      }
    }
  }

  // Anti-trap: no occupant capsule may stand inside the new boxes, using the
  // exact y-aware rule movement applies (movement.ts).
  if (occupants) {
    for (const o of occupants) {
      for (const box of boxes) {
        if (box.y1 <= o.y + STEP_UP_MAX || box.y0 >= o.y + PLAYER_HEIGHT) continue;
        if (circleOverlapsBox(o.x, o.z, PLAYER_RADIUS, box)) return "blocked";
      }
    }
  }

  // Density cap.
  if (index.countNear(cx, cz, BUILD_DENSITY_RADIUS) >= BUILD_DENSITY_CAP) return "density";

  return null;
}
