// doc 12 M5/M6 — server-authoritative fog-of-war: a per-character "explored"
// grid. Honest scope: this CANNOT hide static terrain (the seed is public and
// the client regenerates the whole island via createWorld). Its value is a
// persisted, server-blessed explored set that survives relog and is consistent
// across sessions. Shared so client and server share ONE index scheme.
//
// A square bitset over the origin-centered world: cell (cx,cz) -> index
// cz*dim+cx. Independent of world.ts's GRID_CELL (the collision hash) — this is
// its own, coarser cell. `size` is passed in (WORLD_SIZE today; world.size once
// doc 07 lands tiers) so the module never imports the constant.

/** Fog cell edge length, meters. 32 keeps the bitset tiny: 800/32 = 25x25 = 625
 *  bits (~79 B) standard; 3200/32 = 100x100 (~1.25 KB) huge. */
export const FOG_CELL_M = 32;
/** Radius (m) revealed around a player each time they cross into a new cell. */
export const FOG_REVEAL_RADIUS_M = 96;

export interface ExploredGrid {
  /** world extent (m) this grid was sized for — both ends MUST match. */
  size: number;
  /** cells per side. */
  dim: number;
  /** packed bitset, ceil(dim*dim/8) bytes. */
  bits: Uint8Array;
}

export function createExploredGrid(size: number): ExploredGrid {
  const dim = Math.max(1, Math.ceil(size / FOG_CELL_M));
  return { size, dim, bits: new Uint8Array(Math.ceil((dim * dim) / 8)) };
}

/** Cell index for a world point, or -1 if outside the grid. */
export function exploredCellAt(g: ExploredGrid, x: number, z: number): number {
  const half = g.size / 2;
  const cx = Math.floor((x + half) / FOG_CELL_M);
  const cz = Math.floor((z + half) / FOG_CELL_M);
  if (cx < 0 || cz < 0 || cx >= g.dim || cz >= g.dim) return -1;
  return cz * g.dim + cx;
}

export function hasExploredIndex(g: ExploredGrid, index: number): boolean {
  return index >= 0 && (g.bits[index >> 3] & (1 << (index & 7))) !== 0;
}

export function hasExploredAt(g: ExploredGrid, x: number, z: number): boolean {
  return hasExploredIndex(g, exploredCellAt(g, x, z));
}

/** Set a cell; returns true iff it was newly set (for delta tracking). Rejects
 * out-of-range indices (a stray high index from a buggy/hostile delta must not
 * report "newly set" while writing nothing — typed-array OOB writes are
 * silently dropped). */
function setIndex(g: ExploredGrid, index: number): boolean {
  if (index < 0 || index >= g.dim * g.dim) return false;
  const byte = index >> 3;
  const mask = 1 << (index & 7);
  if (g.bits[byte] & mask) return false;
  g.bits[byte] |= mask;
  return true;
}

/** Apply a wire delta (newly-revealed indices) — used by the client. */
export function setExploredIndices(g: ExploredGrid, indices: number[]): void {
  for (const i of indices) setIndex(g, i);
}

/**
 * Reveal every cell whose CENTER is within `radius` of (x,z). Returns the
 * indices that were newly set (the snapshot delta). O(cells in the radius box).
 */
export function markExploredDisk(g: ExploredGrid, x: number, z: number, radius: number): number[] {
  const half = g.size / 2;
  const r2 = radius * radius;
  const minCx = Math.max(0, Math.floor((x - radius + half) / FOG_CELL_M));
  const maxCx = Math.min(g.dim - 1, Math.floor((x + radius + half) / FOG_CELL_M));
  const minCz = Math.max(0, Math.floor((z - radius + half) / FOG_CELL_M));
  const maxCz = Math.min(g.dim - 1, Math.floor((z + radius + half) / FOG_CELL_M));
  const newly: number[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const wx = (cx + 0.5) * FOG_CELL_M - half;
      const wz = (cz + 0.5) * FOG_CELL_M - half;
      const dx = wx - x;
      const dz = wz - z;
      if (dx * dx + dz * dz > r2) continue;
      const index = cz * g.dim + cx;
      if (setIndex(g, index)) newly.push(index);
    }
  }
  return newly;
}

// --- base64 (btoa/atob exist in workerd, the browser, and Node) ---

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function encodeExplored(g: ExploredGrid): string {
  return bytesToB64(g.bits);
}

/**
 * Decode an explored set for a grid of `size`. DEFENSIVE: a base64 whose byte
 * length doesn't match the grid (corruption, or a tier change that somehow
 * dodged the wipe) is rejected to all-unexplored rather than misread.
 */
export function decodeExplored(size: number, b64: string | undefined): ExploredGrid {
  const g = createExploredGrid(size);
  if (b64) {
    try {
      const bytes = b64ToBytes(b64);
      if (bytes.length === g.bits.length) g.bits.set(bytes);
    } catch {
      // corrupt -> all-unexplored
    }
  }
  return g;
}
