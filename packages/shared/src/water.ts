// Deterministic fresh-water generation (doc 07 §5). Rivers are gradient-descent
// splines marched down the BASE heightfield from highland sources; ponds are
// stamped basins. Both CARVE the terrain (lower heightAt), which is
// world-fingerprint-breaking BY DESIGN — so every path here is reached ONLY on
// a water world (config.world.waterFeatures === true). The default dry world
// never constructs a WaterField, so createWorld's output stays byte-identical
// (proved by the committed world.fingerprint.txt dry rows).
//
// DETERMINISM (the whole point):
//   • Draws come ONLY from two NEW hash-salted streams — createRng(hashString(
//     "river|<seed>")) and createRng(hashString("pond|<seed>")). They never
//     touch the nine sequential worldgen streams in world.ts, so adding/removing
//     a draw here cannot shift towns/buildings/loot/trees. (world.ts also only
//     builds this AFTER the base heightfield, before those streams.)
//   • Every candidate loop is FIXED-iteration (200 river sources, 300 pond
//     candidates) and draws a fixed number of values per iteration regardless of
//     acceptance — the military-site precedent. Selection is deterministic
//     post-processing (zero draws).
//   • GEN uses transcendentals (sin for the bed profile, central-difference
//     gradients for the march) → the records are Linux-canonical, exactly like
//     the huge-tier fingerprint rows. But QUERY-time carve (carvedHeight /
//     freshSurfaceAt) is pure +,−,*,/,√,min — all IEEE-754 correctly-rounded, so
//     the same records yield bit-identical heightAt on client and server. There
//     is ONE query carve implementation (used by heightAt AND waterAt) so the
//     two can never disagree (the doc §Threatens mitigation).

import {
  RIVER_FORD_DEPTH,
  RIVER_HALFW_MAX,
  RIVER_HALFW_MIN,
  RIVER_POOL_DEPTH,
  POND_DEPTH_MAX,
  POND_DEPTH_MIN,
  POND_RADIUS_MAX,
  POND_RADIUS_MIN,
  WATER_GRID_CELL,
  WATER_LEVEL,
  WORLD_SIZE,
} from "./constants";
import { clamp, lerp } from "./math";
import { createRng, hashString, type Rng } from "./rng";

/** One sample along a river polyline. surfY is the local water-surface y;
 * bedDepth is how far the channel bed sits below surfY at the centreline. */
export interface RiverVertex {
  x: number;
  z: number;
  halfW: number;
  surfY: number;
  bedDepth: number;
}

export interface River {
  verts: RiverVertex[];
}

/** A circular basin. depth is the centre carve below surfY; the radial profile
 * matches the river cross-section. surfY = (min of the rim samples) − 0.25. */
export interface Pond {
  cx: number;
  cz: number;
  radius: number;
  surfY: number;
  depth: number;
}

/** The pure worldgen geometry (what the client renders + the fingerprint pins). */
export interface WaterFeatures {
  rivers: River[];
  ponds: Pond[];
}

/** WaterFeatures plus the deterministic query functions createWorld composes
 * into heightAt / waterAt. Not exposed on World directly — World re-exports only
 * the plain `WaterFeatures` (rivers/ponds) so its serialized shape stays clean. */
export interface WaterField extends WaterFeatures {
  /** Base terrain height carved by any river/pond covering (x,z). THE HOT PATH:
   * one grid Map.get; an empty cell (the vast majority) returns baseH untouched.
   * Pass the point's pre-carve base height (createWorld already has it). */
  carvedHeight(x: number, z: number, baseH: number): number;
  /** Fresh water at (x,z): the surface y + depth of the feature submerging the
   * point the MOST (max bed·profile), or null when no river/pond covers it.
   * "Deepest submersion" (not deepest carve / highest surface) is what keeps a
   * ford shallow and a pool deep even where channels overlap. Ocean is the
   * caller's job (WATER_LEVEL). */
  freshAt(x: number, z: number): { surface: number; depth: number } | null;
}

type BaseHeightFn = (x: number, z: number) => number;

// --- Tunables local to the algorithm (doc §5 numbers; not gameplay dials) ---
const RIVER_COUNT = { standard: 2, large: 4, huge: 8 };
const POND_COUNT = { standard: 3, large: 8, huge: 18 };
/** Fixed source-candidate draws; keep the N highest with h≥10, pairwise ≥size/8. */
const SOURCE_CANDIDATES = 200;
const SOURCE_MIN_HEIGHT = 10;
/** March: step 6m, ≤400 steps, one meander draw/step. */
const MARCH_STEP = 6;
const MARCH_MAX_STEPS = 400;
const MEANDER_MAX = 0.25; // riverRng.range(−0.25, 0.25) rotation per step
const DIR_INERTIA = 0.65; // dir_i = normalize(0.65·dir_{i−1} + 0.35·(−∇baseH)) …
const DIR_DOWNHILL = 0.35;
const GRAD_EPS = 1.0; // central-difference half-step for ∇baseH
const FLAT_GRAD = 0.005; // |∇| below this for 8 steps ⇒ basin ⇒ terminus pond
const FLAT_STEPS_TERMINATE = 8;
const SEA_MARGIN = 0.2; // terminate once baseH ≤ WATER_LEVEL + this (reached sea)
const SURF_DROP = 0.45; // surfY_i = min(surfY_{i−1}, baseH_i − this)
const BED_PHASE_FREQ = 0.35; // bedDepth sinusoid frequency along the march
const RIVER_R_MULT = 2.2; // carve influence radius R = halfW · this
/** Ponds: 300 fixed candidates; accept low-slope base h∈[3,12], ≥40m clear. */
const POND_CANDIDATES = 300;
const POND_MIN_BASE_H = 3;
const POND_MAX_BASE_H = 12;
const POND_SEPARATION = 40;
const POND_SLOPE_R = 8;
const POND_SLOPE_MAX = 3.5;
const POND_RIM_SAMPLES = 16;
const POND_SURF_DROP = 0.25;

// --- Gradient + geometry helpers (pure) ---

/** Central-difference gradient of the BASE height at (x,z). */
function gradient(baseH: BaseHeightFn, x: number, z: number): [number, number] {
  const gx = (baseH(x + GRAD_EPS, z) - baseH(x - GRAD_EPS, z)) / (2 * GRAD_EPS);
  const gz = (baseH(x, z + GRAD_EPS) - baseH(x, z - GRAD_EPS)) / (2 * GRAD_EPS);
  return [gx, gz];
}

/** Clamped projection parameter t∈[0,1] of (px,pz) onto segment a→b, plus the
 * squared perpendicular distance. Shared by every carve/surface query so the
 * distance math exists once. Pure IEEE ops → drift-free across platforms. */
function projectToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { t: number; dSq: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return { t, dSq: dx * dx + dz * dz };
}

/** Local slope proxy for pond siting: max |Δbase| across ±r on each axis. */
function slopeAt(baseH: BaseHeightFn, x: number, z: number, r: number): number {
  const h0 = baseH(x, z);
  return Math.max(
    Math.abs(baseH(x + r, z) - h0),
    Math.abs(baseH(x - r, z) - h0),
    Math.abs(baseH(x, z + r) - h0),
    Math.abs(baseH(x, z - r) - h0),
  );
}

// --- Rivers ---

interface Source {
  x: number;
  z: number;
}

/** Fixed 200-candidate loop (2 draws each, always) → keep the highest-base-height
 * points with h≥10 and pairwise separation ≥ size/8. Selection is deterministic
 * (sort by height desc, index tiebreak → total order; zero draws). */
function pickSources(rng: Rng, baseH: BaseHeightFn, size: number, count: number): Source[] {
  const bound = size * 0.4;
  const cands: Array<{ x: number; z: number; h: number; idx: number }> = [];
  for (let i = 0; i < SOURCE_CANDIDATES; i++) {
    const x = rng.range(-bound, bound);
    const z = rng.range(-bound, bound);
    cands.push({ x, z, h: baseH(x, z), idx: i });
  }
  const eligible = cands.filter((c) => c.h >= SOURCE_MIN_HEIGHT);
  eligible.sort((a, b) => b.h - a.h || a.idx - b.idx);
  const sepSq = (size / 8) ** 2;
  const chosen: Source[] = [];
  for (const c of eligible) {
    if (chosen.length >= count) break;
    if (chosen.every((s) => (s.x - c.x) ** 2 + (s.z - c.z) ** 2 >= sepSq)) {
      chosen.push({ x: c.x, z: c.z });
    }
  }
  return chosen;
}

interface MarchResult {
  river: River;
  /** A basin terminus (flat run) stamps a terminus pond; null when the river
   * reached the sea or hit the step cap. */
  terminus: Pond | null;
}

/** March one river: φ (bed phase, 1 draw) then per-step meander (1 draw/step).
 * The step count is fixed by the deterministic terrain, so both sides walk the
 * same stream. Pass 1 collects the path (consumes rng); pass 2 assigns per-vertex
 * attrs (halfW/surfY/bedDepth) with zero draws. */
function marchRiver(rng: Rng, baseH: BaseHeightFn, src: Source): MarchResult {
  const phi = rng.range(0, Math.PI * 2);

  // Initial heading: straight downhill (fall back to outward toward the coast on
  // a degenerate gradient so a source on a plateau still departs).
  let [gx, gz] = gradient(baseH, src.x, src.z);
  let dirx = -gx;
  let dirz = -gz;
  let dl = Math.hypot(dirx, dirz);
  if (dl < 1e-6) {
    const rl = Math.hypot(src.x, src.z) || 1;
    dirx = src.x / rl;
    dirz = src.z / rl;
  } else {
    dirx /= dl;
    dirz /= dl;
  }

  let x = src.x;
  let z = src.z;
  let bh = baseH(x, z);
  const path: Array<{ x: number; z: number; baseH: number }> = [{ x, z, baseH: bh }];
  let flatRun = 0;
  let reachedSea = false;

  for (let i = 0; i < MARCH_MAX_STEPS; i++) {
    if (bh <= WATER_LEVEL + SEA_MARGIN) {
      reachedSea = true; // flowed into the ocean — no terminus pool needed
      break;
    }
    [gx, gz] = gradient(baseH, x, z);
    const gmag = Math.hypot(gx, gz);
    if (gmag < FLAT_GRAD) {
      if (++flatRun >= FLAT_STEPS_TERMINATE) break; // basin — stop, pool below
    } else {
      flatRun = 0;
    }
    // Downhill unit vector (reuse the previous heading if the gradient vanished
    // this step but the flat-run hasn't tripped yet).
    let ndx = -gx;
    let ndz = -gz;
    const nl = Math.hypot(ndx, ndz);
    if (nl > 1e-6) {
      ndx /= nl;
      ndz /= nl;
    } else {
      ndx = dirx;
      ndz = dirz;
    }
    let bx = DIR_INERTIA * dirx + DIR_DOWNHILL * ndx;
    let bz = DIR_INERTIA * dirz + DIR_DOWNHILL * ndz;
    const bl = Math.hypot(bx, bz);
    if (bl > 1e-6) {
      bx /= bl;
      bz /= bl;
    } else {
      bx = dirx;
      bz = dirz;
    }
    // Meander: one rotation draw per step.
    const theta = rng.range(-MEANDER_MAX, MEANDER_MAX);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    dirx = bx * c - bz * s;
    dirz = bx * s + bz * c;

    x += dirx * MARCH_STEP;
    z += dirz * MARCH_STEP;
    bh = baseH(x, z);
    path.push({ x, z, baseH: bh });
  }

  // Pass 2 — per-vertex attrs (no draws).
  const n = path.length;
  const verts: RiverVertex[] = [];
  let surfY = Infinity;
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const halfW = lerp(RIVER_HALFW_MIN, RIVER_HALFW_MAX, n > 1 ? i / (n - 1) : 0);
    surfY = Math.min(surfY, p.baseH - SURF_DROP); // monotonic — water never climbs
    const bedDepth =
      RIVER_FORD_DEPTH +
      (RIVER_POOL_DEPTH - RIVER_FORD_DEPTH) * ((1 + Math.sin(i * BED_PHASE_FREQ + phi)) / 2);
    verts.push({ x: p.x, z: p.z, halfW, surfY, bedDepth });
  }

  // Any river that stopped INLAND (a flat basin OR the 400-step march cap) pools
  // into a terminus lake instead of ending in a dead-end trench — so every river
  // resolves to "reaches the sea OR a terminus pond" (doc §5 acceptance). Only a
  // sea-terminating river skips it. Deterministic, zero draws (law #4).
  let terminus: Pond | null = null;
  if (!reachedSea && n >= 2) {
    const last = verts[n - 1];
    terminus = {
      cx: last.x,
      cz: last.z,
      radius: clamp(last.halfW * 3, POND_RADIUS_MIN, POND_RADIUS_MAX),
      surfY: last.surfY,
      depth: RIVER_POOL_DEPTH,
    };
  }
  return { river: { verts }, terminus };
}

/** Min squared distance from (x,z) to any river polyline segment. */
function distSqToRivers(x: number, z: number, rivers: River[]): number {
  let best = Infinity;
  for (const river of rivers) {
    const v = river.verts;
    for (let i = 0; i < v.length - 1; i++) {
      const { dSq } = projectToSegment(x, z, v[i].x, v[i].z, v[i + 1].x, v[i + 1].z);
      if (dSq < best) best = dSq;
    }
  }
  return best;
}

// --- Ponds ---

/** Fixed 300-candidate loop (4 draws each, always: x,z,radius,depth). Accept
 * low-slope base h∈[3,12], ≥40m from rivers and existing ponds. `existing`
 * (river terminus ponds) is avoided but does NOT consume the `count` budget. */
function pickPonds(
  rng: Rng,
  baseH: BaseHeightFn,
  size: number,
  count: number,
  rivers: River[],
  existing: Pond[],
): Pond[] {
  const bound = size * 0.44;
  const sepSq = POND_SEPARATION ** 2;
  const avoid = [...existing];
  const stamped: Pond[] = [];
  for (let i = 0; i < POND_CANDIDATES; i++) {
    const x = rng.range(-bound, bound);
    const z = rng.range(-bound, bound);
    const radius = rng.range(POND_RADIUS_MIN, POND_RADIUS_MAX);
    const depth = rng.range(POND_DEPTH_MIN, POND_DEPTH_MAX);
    if (stamped.length >= count) continue; // still drew 4 — stream stays fixed
    const h = baseH(x, z);
    if (h < POND_MIN_BASE_H || h > POND_MAX_BASE_H) continue;
    if (slopeAt(baseH, x, z, POND_SLOPE_R) > POND_SLOPE_MAX) continue;
    if (distSqToRivers(x, z, rivers) < sepSq) continue;
    if (avoid.some((p) => (p.cx - x) ** 2 + (p.cz - z) ** 2 < sepSq)) continue;
    // surfY = (min of 16 fixed rim samples) − 0.25.
    let rimMin = Infinity;
    for (let k = 0; k < POND_RIM_SAMPLES; k++) {
      const a = (k / POND_RIM_SAMPLES) * Math.PI * 2;
      const rh = baseH(x + Math.cos(a) * radius, z + Math.sin(a) * radius);
      if (rh < rimMin) rimMin = rh;
    }
    const pond: Pond = { cx: x, cz: z, radius, surfY: rimMin - POND_SURF_DROP, depth };
    stamped.push(pond);
    avoid.push(pond);
  }
  return stamped;
}

// --- Carve query (shared by heightAt + waterAt) ---

function tierOf(size: number): "standard" | "large" | "huge" {
  const scale = size / WORLD_SIZE;
  return scale <= 1 ? "standard" : scale <= 2 ? "large" : "huge";
}

interface Cell {
  /** [riverIndex, vertIndex] for the segment verts[vertIndex]→verts[vertIndex+1]. */
  segs: Array<[number, number]>;
  ponds: number[];
}

/**
 * Build a water world's rivers/ponds, the 32m spatial index, and the query
 * functions. Called ONLY when waterFeatures is true. baseH is the pre-carve
 * heightfield (createWorld's makeHeightFn) the march and stamps read.
 */
export function buildWaterField(
  params: { seed: number; size: number },
  baseH: BaseHeightFn,
): WaterField {
  const { seed, size } = params;
  const tier = tierOf(size);
  const riverRng = createRng(hashString(`river|${seed}`));
  const pondRng = createRng(hashString(`pond|${seed}`));

  const sources = pickSources(riverRng, baseH, size, RIVER_COUNT[tier]);
  const rivers: River[] = [];
  const terminusPonds: Pond[] = [];
  for (const src of sources) {
    const { river, terminus } = marchRiver(riverRng, baseH, src);
    if (river.verts.length < 2) continue; // defensive — sources start at h≥10
    rivers.push(river);
    if (terminus) terminusPonds.push(terminus);
  }

  const stamped = pickPonds(pondRng, baseH, size, POND_COUNT[tier], rivers, terminusPonds);
  const ponds = [...terminusPonds, ...stamped];

  // --- 32m spatial index: cell → influencing segments/ponds ---
  const grid = new Map<number, Cell>();
  const cellOf = (v: number): number => Math.floor(v / WATER_GRID_CELL);
  const cellKey = (ix: number, iz: number): number => (ix + 512) * 4096 + (iz + 512);
  const cellAt = (ix: number, iz: number): Cell => {
    const key = cellKey(ix, iz);
    let cell = grid.get(key);
    if (!cell) {
      cell = { segs: [], ponds: [] };
      grid.set(key, cell);
    }
    return cell;
  };
  const register = (
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    add: (cell: Cell) => void,
  ): void => {
    for (let ix = cellOf(minX); ix <= cellOf(maxX); ix++) {
      for (let iz = cellOf(minZ); iz <= cellOf(maxZ); iz++) add(cellAt(ix, iz));
    }
  };
  for (let ri = 0; ri < rivers.length; ri++) {
    const v = rivers[ri].verts;
    for (let vi = 0; vi < v.length - 1; vi++) {
      const a = v[vi];
      const b = v[vi + 1];
      const r = Math.max(a.halfW, b.halfW) * RIVER_R_MULT;
      register(
        Math.min(a.x, b.x) - r,
        Math.min(a.z, b.z) - r,
        Math.max(a.x, b.x) + r,
        Math.max(a.z, b.z) + r,
        (cell) => cell.segs.push([ri, vi]),
      );
    }
  }
  for (let pi = 0; pi < ponds.length; pi++) {
    const p = ponds[pi];
    register(p.cx - p.radius, p.cz - p.radius, p.cx + p.radius, p.cz + p.radius, (cell) =>
      cell.ponds.push(pi),
    );
  }

  /** Carve contribution of one river segment: surfY − bedDepth·clamp(1−(d/R)²),
   * or Infinity when the point is outside the segment's influence radius R. */
  const riverCarve = (x: number, z: number, ri: number, vi: number): number => {
    const a = rivers[ri].verts[vi];
    const b = rivers[ri].verts[vi + 1];
    const { t, dSq } = projectToSegment(x, z, a.x, a.z, b.x, b.z);
    const halfW = a.halfW + (b.halfW - a.halfW) * t;
    const R = halfW * RIVER_R_MULT;
    if (dSq >= R * R) return Infinity;
    const d = Math.sqrt(dSq);
    const surfY = a.surfY + (b.surfY - a.surfY) * t;
    const bedDepth = a.bedDepth + (b.bedDepth - a.bedDepth) * t;
    const profile = clamp(1 - (d / R) * (d / R), 0, 1);
    return surfY - bedDepth * profile;
  };

  const pondCarve = (x: number, z: number, pi: number): number => {
    const p = ponds[pi];
    const dSq = (x - p.cx) ** 2 + (z - p.cz) ** 2;
    if (dSq >= p.radius * p.radius) return Infinity;
    const d = Math.sqrt(dSq);
    const profile = clamp(1 - (d / p.radius) * (d / p.radius), 0, 1);
    return p.surfY - p.depth * profile;
  };

  const carvedHeight = (x: number, z: number, base: number): number => {
    const cell = grid.get(cellKey(cellOf(x), cellOf(z)));
    if (cell === undefined) return base; // empty cell — straight through
    let h = base;
    for (const [ri, vi] of cell.segs) {
      const c = riverCarve(x, z, ri, vi);
      if (c < h) h = c;
    }
    for (const pi of cell.ponds) {
      const c = pondCarve(x, z, pi);
      if (c < h) h = c;
    }
    return h;
  };

  // Fresh water at (x,z): the depth + surface of the NEAREST covering feature —
  // the channel the point actually sits in. Nearest (not deepest-carve, not
  // max-surface, not max-submersion) is what preserves crossability: a ford
  // reads its OWN shallow bed even when a deeper pool/meander passes just within
  // range, so the wade hook (doc §6) sees a crossing every ~100m by design. depth
  // is that feature's local channel depth (bed·profile → bedDepth at the centre,
  // tapering to 0 at the influence edge); surface is its water level. null when
  // no river/pond covers the point. Rivers vs ponds barely overlap (ponds sit
  // ≥40m from rivers/each other), so the cross-type tie is effectively unused.
  const freshAt = (x: number, z: number): { surface: number; depth: number } | null => {
    const cell = grid.get(cellKey(cellOf(x), cellOf(z)));
    if (cell === undefined) return null;
    let nearest = Infinity;
    let depth = 0;
    let surf = 0;
    for (const [ri, vi] of cell.segs) {
      const a = rivers[ri].verts[vi];
      const b = rivers[ri].verts[vi + 1];
      const { t, dSq } = projectToSegment(x, z, a.x, a.z, b.x, b.z);
      const halfW = a.halfW + (b.halfW - a.halfW) * t;
      const R = halfW * RIVER_R_MULT;
      if (dSq >= R * R || dSq >= nearest) continue;
      nearest = dSq;
      const d = Math.sqrt(dSq);
      const profile = clamp(1 - (d / R) * (d / R), 0, 1);
      depth = (a.bedDepth + (b.bedDepth - a.bedDepth) * t) * profile;
      surf = a.surfY + (b.surfY - a.surfY) * t;
    }
    for (const pi of cell.ponds) {
      const p = ponds[pi];
      const dSq = (x - p.cx) ** 2 + (z - p.cz) ** 2;
      if (dSq >= p.radius * p.radius || dSq >= nearest) continue;
      nearest = dSq;
      const d = Math.sqrt(dSq);
      const profile = clamp(1 - (d / p.radius) * (d / p.radius), 0, 1);
      depth = p.depth * profile;
      surf = p.surfY;
    }
    return nearest === Infinity ? null : { surface: surf, depth };
  };

  return { rivers, ponds, carvedHeight, freshAt };
}
