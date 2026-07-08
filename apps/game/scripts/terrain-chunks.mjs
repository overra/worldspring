#!/usr/bin/env node
// Chunked-terrain harness (doc 07 §4) — CI-run via `pnpm test`.
//
//   node --experimental-strip-types apps/game/scripts/terrain-chunks.mjs
//
// Four layers over src/client/render/world/terrainChunks.ts (a leaf module —
// no JSX, no React — so strip-types imports it directly; three's scene-graph
// objects run fine headless in node):
//   1. GRID — per-tier chunk counts (7/13/25), world coverage, and the
//      4m-lattice alignment that keeps LOD0 verts on EXACTLY the old
//      monolithic mesh's sample points (the anti-floating-entity guarantee).
//   2. SELECT — fresh-selection radii, the ±16m hysteresis dead band on both
//      the LOD and draw boundaries, and the load-bearing invariant under a
//      seeded random camera walk: every chunk whose center is within
//      INTEREST_RADIUS + 64·√2 of the camera is LOD0 (full density under
//      every entity the server can send).
//   3. GEOMETRY — vertex/index counts (33×33 / 17×17 per spec), world-space
//      positions on the spacing lattice, bit-level vertex-color parity with
//      the pre-chunking Terrain.tsx formula (copied verbatim below), skirt
//      shape (top ring − 3m, colors copied), index validity, upward interior
//      winding with PlaneGeometry's diagonal, and outward skirt winding.
//   4. STREAMING — the real ChunkRenderer driven across a huge-tier island
//      tour: ≤2 builds/frame, mesh set converges to the selection, LRU cache
//      stays ≤ cap, evictions dispose geometries (the GPU-leak guard), no
//      in-use geometry is ever disposed, and disposeChunkRenderer frees all.

import * as THREE from "three";
import { INTEREST_RADIUS } from "@worldspring/shared/constants";
import { clamp } from "@worldspring/shared/math";
import { MAP_BIOME, MAP_PALETTE } from "@worldspring/shared/map/palette";
import {
  buildChunkArrays,
  chunkFromKey,
  chunkGridFor,
  chunkKey,
  chunkOriginOf,
  createChunkRenderer,
  disposeChunkRenderer,
  selectChunks,
  updateChunks,
  CHUNK_CACHE_CAP,
  CHUNK_DRAW_RADIUS,
  LOD0_RADIUS,
  LOD_HYSTERESIS,
  LOD_SPACINGS,
  MAX_CHUNK_BUILDS_PER_FRAME,
  SKIRT_DEPTH,
  TERRAIN_CHUNK_SIZE,
} from "../src/client/render/world/terrainChunks.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log("GRID — tier sizing, coverage, lattice alignment");
// ---------------------------------------------------------------------------

const TIERS = [
  { size: 800, count: 7, origin: -448 },
  { size: 1600, count: 13, origin: -832 },
  { size: 3200, count: 25, origin: -1600 },
];
for (const { size, count, origin } of TIERS) {
  const grid = chunkGridFor(size);
  check(grid.count === count && grid.origin === origin, `${size}m -> ${count}x${count} @ ${origin}`);
  check(
    grid.origin <= -size / 2 && grid.origin + grid.count * TERRAIN_CHUNK_SIZE >= size / 2,
    `${size}m grid covers the world square`,
  );
  // Old monolithic mesh sampled x,z = -size/2 + 4k. LOD0 verts are
  // grid.origin + 128*c + 4i. Both lattices coincide iff the offset between
  // them is a multiple of the 4m spacing.
  const offset = grid.origin - -size / 2;
  check(((offset % LOD_SPACINGS[0]) + LOD_SPACINGS[0]) % LOD_SPACINGS[0] === 0, `${size}m LOD0 lattice matches the monolithic mesh lattice`);
}

// ---------------------------------------------------------------------------
console.log("SELECT — fresh radii");
// ---------------------------------------------------------------------------

const grid = chunkGridFor(3200);
const HALF = TERRAIN_CHUNK_SIZE / 2;
const ENTER_R = CHUNK_DRAW_RADIUS - LOD_HYSTERESIS; // 432
const EXIT_R = CHUNK_DRAW_RADIUS + LOD_HYSTERESIS; // 464
const PROMOTE_R = LOD0_RADIUS - LOD_HYSTERESIS; // 320
const DEMOTE_R = LOD0_RADIUS + LOD_HYSTERESIS; // 352

const centerDist = (key, camX, camZ) => {
  const { cx, cz } = chunkFromKey(grid, key);
  const { x, z } = chunkOriginOf(grid, cx, cz);
  return Math.hypot(x + HALF - camX, z + HALF - camZ);
};

{
  const sel = selectChunks(grid, 0, 0, new Map());
  let radiiOk = true;
  let lodOk = true;
  for (const [key, lod] of sel) {
    const d = centerDist(key, 0, 0);
    if (d > ENTER_R + 1e-9) radiiOk = false;
    if ((lod === 0) !== (d <= LOD0_RADIUS)) lodOk = false;
  }
  // Completeness: every chunk within the enter radius is selected.
  let complete = true;
  for (let cz = 0; cz < grid.count; cz++) {
    for (let cx = 0; cx < grid.count; cx++) {
      const key = chunkKey(grid, cx, cz);
      if (centerDist(key, 0, 0) <= ENTER_R && !sel.has(key)) complete = false;
    }
  }
  check(sel.size > 0 && radiiOk, `fresh selection stays within ${ENTER_R}m (${sel.size} chunks)`);
  check(lodOk, `fresh LOD split at raw ${LOD0_RADIUS}m boundary`);
  check(complete, "every chunk within the enter radius is selected");
  // Determinism: same inputs, same output.
  const again = selectChunks(grid, 0, 0, new Map());
  check(
    again.size === sel.size && [...sel].every(([k, v]) => again.get(k) === v),
    "selection is deterministic",
  );
  // Worst-case chunk count sanity (spec: ~45 in the 448m disc).
  check(sel.size <= 52, `fresh selection count ${sel.size} <= 52`);
}

// ---------------------------------------------------------------------------
console.log("SELECT — hysteresis dead bands");
// ---------------------------------------------------------------------------

{
  // Chunk (12,12) of the 25x25 grid is centered on the world origin; walk
  // the camera along +X so camX IS the center distance.
  const key = chunkKey(grid, 12, 12);
  const at = (d, prev) => selectChunks(grid, d, 0, prev);

  let sel = at(344, new Map()); // fresh between 336 and 432
  check(sel.get(key) === 1, "fresh at 344m -> LOD1");
  sel = at(330, sel);
  check(sel.get(key) === 1, "330m (inside dead band) stays LOD1");
  sel = at(PROMOTE_R - 1, sel);
  check(sel.get(key) === 0, `${PROMOTE_R - 1}m promotes to LOD0`);
  sel = at(DEMOTE_R - 1, sel);
  check(sel.get(key) === 0, `${DEMOTE_R - 1}m (inside dead band) stays LOD0`);
  sel = at(DEMOTE_R + 1, sel);
  check(sel.get(key) === 1, `${DEMOTE_R + 1}m demotes to LOD1`);

  sel = at(440, new Map());
  check(!sel.has(key), "fresh at 440m -> hidden (enter needs <=432m)");
  sel = at(ENTER_R - 1, sel);
  check(sel.get(key) === 1, `${ENTER_R - 1}m enters as LOD1`);
  sel = at(EXIT_R - 1, sel);
  check(sel.has(key), `${EXIT_R - 1}m (inside dead band) stays visible`);
  sel = at(EXIT_R + 1, sel);
  check(!sel.has(key), `${EXIT_R + 1}m exits`);
  sel = at(ENTER_R + 1, sel);
  check(!sel.has(key), "re-enter needs to cross back under the enter radius");
  sel = at(ENTER_R, sel);
  check(sel.has(key), `${ENTER_R}m re-enters`);
}

// ---------------------------------------------------------------------------
console.log("SELECT — LOD0 coverage invariant under a random camera walk");
// ---------------------------------------------------------------------------

{
  // Any chunk that can contain an entity within INTEREST_RADIUS of the
  // camera has its center within INTEREST_RADIUS + 64*sqrt(2). The promote
  // threshold (320m) must exceed that, and the walk must never catch a
  // qualifying chunk below full density.
  const slack = (TERRAIN_CHUNK_SIZE / 2) * Math.SQRT2;
  const coverR = INTEREST_RADIUS + slack; // ~310.5
  check(coverR < PROMOTE_R, `INTEREST_RADIUS + corner slack (${coverR.toFixed(1)}m) < promote threshold ${PROMOTE_R}m`);

  let rngState = 0xdecafbad >>> 0;
  const rng = () => {
    // LCG — deterministic across runs/platforms.
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  let camX = 0;
  let camZ = 0;
  let prev = new Map();
  let violations = 0;
  let keysValid = true;
  for (let step = 0; step < 500; step++) {
    if (rng() < 0.15) {
      camX = (rng() - 0.5) * 3200; // teleport (respawn/portal)
      camZ = (rng() - 0.5) * 3200;
    } else {
      camX += (rng() - 0.5) * 48; // sprint-scale wander
      camZ += (rng() - 0.5) * 48;
    }
    prev = selectChunks(grid, camX, camZ, prev);
    for (const [key, lod] of prev) {
      const { cx, cz } = chunkFromKey(grid, key);
      if (cx < 0 || cx >= grid.count || cz < 0 || cz >= grid.count) keysValid = false;
      const d = centerDist(key, camX, camZ);
      if (d > EXIT_R + 1e-9) violations++;
      if (d <= coverR && lod !== 0) violations++;
    }
    // Completeness near the camera: chunks under the interest disc exist.
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const cx = Math.floor((camX - grid.origin) / TERRAIN_CHUNK_SIZE) + dx;
        const cz = Math.floor((camZ - grid.origin) / TERRAIN_CHUNK_SIZE) + dz;
        if (cx < 0 || cx >= grid.count || cz < 0 || cz >= grid.count) continue;
        const key = chunkKey(grid, cx, cz);
        if (centerDist(key, camX, camZ) <= coverR && prev.get(key) !== 0) violations++;
      }
    }
  }
  check(violations === 0, `500-step walk: 0 coverage/radius violations (got ${violations})`);
  check(keysValid, "all selected keys map to in-grid chunks");
}

// ---------------------------------------------------------------------------
console.log("GEOMETRY — counts, lattice, parity, skirts, winding");
// ---------------------------------------------------------------------------

// Synthetic analytic heightfield exercising every color branch: rolling
// grass, a beach band, and a steep rocky knoll.
const heightAt = (x, z) =>
  6 +
  5 * Math.sin(x * 0.02) * Math.cos(z * 0.017) +
  11 * Math.exp(-((x - 40) ** 2 + (z - 40) ** 2) / 900) -
  0.004 * x;

// The pre-chunking Terrain.tsx color formula, copied VERBATIM (constants
// resolved through the same shared palette) — the parity oracle.
const SAND = new THREE.Color(MAP_PALETTE.sand);
const GRASS_LOW = new THREE.Color(MAP_PALETTE.grassLow);
const GRASS_HIGH = new THREE.Color(MAP_PALETTE.grassHigh);
const ROCK = new THREE.Color(MAP_PALETTE.rock);
const oracle = new THREE.Color();
const oracleColorAt = (x, z, h) => {
  const dhdx = (heightAt(x + 2, z) - heightAt(x - 2, z)) / 4;
  const dhdz = (heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
  const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
  oracle.copy(GRASS_LOW).lerp(GRASS_HIGH, clamp((h - 2) / 14, 0, 1));
  oracle.lerp(SAND, clamp((MAP_BIOME.sandMaxH + 0.3 - h) / 0.6, 0, 1));
  const rockT = Math.max(
    clamp((slope - MAP_BIOME.rockSlopeStart) / (MAP_BIOME.rockSlopeFull - MAP_BIOME.rockSlopeStart), 0, 1),
    clamp((h - MAP_BIOME.rockHeight) / 2.5, 0, 1),
  );
  oracle.lerp(ROCK, rockT);
  return [oracle.r, oracle.g, oracle.b];
};

for (const lod of [0, 1]) {
  const spacing = LOD_SPACINGS[lod];
  const n = TERRAIN_CHUNK_SIZE / spacing;
  const w = n + 1;
  const originX = -64;
  const originZ = 64;
  const { positions, colors, indices } = buildChunkArrays(heightAt, originX, originZ, lod);

  const gridCount = w * w;
  const vertCount = gridCount + 4 * w;
  check(
    positions.length === vertCount * 3 && colors.length === vertCount * 3,
    `LOD${lod}: ${w}x${w} grid + ${4 * w} skirt verts (${vertCount})`,
  );
  check(indices.length === (2 * n * n + 8 * n) * 3, `LOD${lod}: index count ${indices.length}`);

  // Grid verts: on the spacing lattice, displaced by heightAt, colors ==
  // the verbatim old formula (identical op order => identical floats after
  // the Float32 round-trip).
  let posOk = true;
  let colorOk = true;
  for (let iz = 0; iz < w; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const o = (iz * w + ix) * 3;
      const x = originX + ix * spacing;
      const z = originZ + iz * spacing;
      if (positions[o] !== Math.fround(x) || positions[o + 2] !== Math.fround(z)) posOk = false;
      if (positions[o + 1] !== Math.fround(heightAt(x, z))) posOk = false;
      const [r, g, b] = oracleColorAt(x, z, heightAt(x, z));
      if (
        colors[o] !== Math.fround(r) ||
        colors[o + 1] !== Math.fround(g) ||
        colors[o + 2] !== Math.fround(b)
      )
        colorOk = false;
    }
  }
  check(posOk, `LOD${lod}: grid verts on the ${spacing}m lattice at heightAt`);
  check(colorOk, `LOD${lod}: vertex colors bit-identical to the old formula`);

  // Skirts: same x/z + color as their top vertex, y exactly SKIRT_DEPTH down.
  const sideTop = [(j) => j, (j) => n * w + j, (j) => j * w, (j) => j * w + n];
  let skirtOk = true;
  for (let side = 0; side < 4; side++) {
    for (let j = 0; j < w; j++) {
      const t = sideTop[side](j) * 3;
      const s = (gridCount + side * w + j) * 3;
      if (positions[s] !== positions[t] || positions[s + 2] !== positions[t + 2]) skirtOk = false;
      if (positions[s + 1] !== Math.fround(positions[t + 1] - SKIRT_DEPTH)) skirtOk = false;
      if (colors[s] !== colors[t] || colors[s + 1] !== colors[t + 1] || colors[s + 2] !== colors[t + 2])
        skirtOk = false;
    }
  }
  check(skirtOk, `LOD${lod}: skirt ring = edge ring dropped ${SKIRT_DEPTH}m, colors copied`);

  // Index validity + winding. Interior triangles must face up (+Y) and use
  // PlaneGeometry's "/" diagonal; skirt triangles must face outward.
  let indexOk = true;
  for (const i of indices) if (i >= vertCount) indexOk = false;
  check(indexOk, `LOD${lod}: all indices in range`);

  const triNormal = (t) => {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
  };

  let upOk = true;
  const interiorTris = 2 * n * n;
  for (let t = 0; t < interiorTris * 3; t += 3) {
    if (triNormal(t)[1] <= 0) upOk = false;
  }
  check(upOk, `LOD${lod}: all ${interiorTris} interior triangles face up`);

  // Diagonal orientation parity with PlaneGeometry: the first cell's first
  // triangle is (a, b, d) = (0, w, 1).
  check(
    indices[0] === 0 && indices[1] === w && indices[2] === 1,
    `LOD${lod}: PlaneGeometry-identical diagonal/winding`,
  );

  const OUTWARD = [
    [0, -1], // side 0: -Z
    [0, 1], // side 1: +Z
    [-1, 0], // side 2: -X
    [1, 0], // side 3: +X
  ];
  let skirtWindOk = true;
  for (let side = 0; side < 4; side++) {
    const start = (interiorTris + side * 2 * n) * 3;
    for (let t = start; t < start + 2 * n * 3; t += 3) {
      const nrm = triNormal(t);
      const dot = nrm[0] * OUTWARD[side][0] + nrm[2] * OUTWARD[side][1];
      if (dot <= 0) skirtWindOk = false;
    }
  }
  check(skirtWindOk, `LOD${lod}: skirt triangles face outward`);
}

// ---------------------------------------------------------------------------
console.log("STREAMING — ChunkRenderer island tour (huge tier)");
// ---------------------------------------------------------------------------

{
  // Count disposals via a prototype patch (same three instance as the module).
  const disposed = new Set();
  const origDispose = THREE.BufferGeometry.prototype.dispose;
  THREE.BufferGeometry.prototype.dispose = function patchedDispose() {
    disposed.add(this);
    return origDispose.call(this);
  };

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true });
  const r = createChunkRenderer(3200, heightAt, material);

  let maxBuilds = 0;
  let totalBuilds = 0;
  let cacheOverCap = 0;
  let disposedInUse = 0;
  let meshNotSelected = 0;

  const frame = (x, z) => {
    const builds = updateChunks(r, x, z);
    maxBuilds = Math.max(maxBuilds, builds);
    totalBuilds += builds;
    if (r.cache.size > CHUNK_CACHE_CAP) cacheOverCap++;
    for (const [key, mesh] of r.meshes) {
      if (!r.lodState.has(key)) meshNotSelected++;
      if (disposed.has(mesh.geometry)) disposedInUse++;
    }
  };

  // Diagonal tour across the whole huge island (forces far more than
  // CHUNK_CACHE_CAP distinct chunk geometries), then settle in the corner.
  for (let i = 0; i <= 700; i++) {
    const t = i / 700;
    frame(-1500 + 3000 * t, -1500 + 3000 * t);
  }
  // Settle: with the camera still, the queue must drain and converge.
  let settleFrames = 0;
  while (updateChunks(r, 1500, 1500) > 0 && settleFrames < 200) settleFrames++;

  const selection = r.lodState;
  let converged = r.meshes.size === selection.size;
  for (const [key, lod] of selection) {
    const mesh = r.meshes.get(key);
    if (!mesh) { converged = false; continue; }
    const want = lod === 0 ? 1221 : 357;
    if (mesh.geometry.getAttribute("position").count !== want) converged = false;
  }

  check(maxBuilds <= MAX_CHUNK_BUILDS_PER_FRAME, `builds/frame capped at ${MAX_CHUNK_BUILDS_PER_FRAME} (max seen ${maxBuilds})`);
  check(totalBuilds > CHUNK_CACHE_CAP, `tour built ${totalBuilds} geometries (> cache cap, eviction exercised)`);
  check(cacheOverCap === 0, "cache never exceeds the cap after an update");
  check(disposed.size > 0, `evictions disposed ${disposed.size} geometries (GPU-leak guard)`);
  check(disposedInUse === 0, "no disposed geometry was ever on a live mesh");
  check(meshNotSelected === 0, "every live mesh is a selected chunk");
  check(converged, `settled meshes converge to the selection at desired LODs (${r.meshes.size} chunks, ${settleFrames} settle frames)`);
  check(r.group.children.length === r.meshes.size, "group children mirror the mesh map");

  const cachedBeforeDispose = r.cache.size;
  disposeChunkRenderer(r);
  check(
    r.cache.size === 0 && r.meshes.size === 0 && r.group.children.length === 0,
    `disposeChunkRenderer clears everything (freed ${cachedBeforeDispose} cached geometries)`,
  );

  THREE.BufferGeometry.prototype.dispose = origDispose;
}

// Spec literals (doc 07 §4) — fail loudly if anyone "tidies" them.
check(TERRAIN_CHUNK_SIZE === 128, "chunk size 128m");
check(CHUNK_DRAW_RADIUS === 448 && LOD0_RADIUS === 336 && LOD_HYSTERESIS === 16, "radii 448/336 ±16");
check(LOD_SPACINGS[0] === 4 && LOD_SPACINGS[1] === 8, "LOD spacings 4m/8m");
check(SKIRT_DEPTH === 3, "skirt depth 3m");

console.log(failures === 0 ? "\nterrain-chunks: ALL OK" : `\nterrain-chunks: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
