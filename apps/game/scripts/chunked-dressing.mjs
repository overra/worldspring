#!/usr/bin/env node
// Chunked-dressing harness (CI-run via `pnpm test`) — drives the REAL
// chunkedDressing.ts (three's scene-graph objects run headless in node, the
// terrain-chunks.mjs precedent) and pins the invariants the renderers rely on:
//
//   1. PARTITIONING — instances land in one InstancedMesh per non-empty
//      (cell x bucket) group; per-mesh counts sum back to the entry count.
//   2. BOUNDING SPHERES — every chunk sphere contains all of its instance
//      positions AND stays chunk-sized (the whole point: a world-spanning
//      sphere would defeat frustum culling), and frustumCulled is ON.
//   3. REF SLOTS — every ref maps to exactly its entries' (mesh, slot) pairs,
//      and zero-scaling via refSlots leaves the sphere untouched (a recompute
//      would union the world origin — the documented hazard).
//   4. VISIBILITY GATE — radius hide/show with hysteresis: no flip inside the
//      dead band, correct flips outside it, sphere-edge (not center) distance.
//   5. COLORS + DISPOSE — per-instance colors allocate only where used;
//      dispose empties the group and clears refSlots.

import * as THREE from "three";
import {
  buildChunkedDressing,
  DRESSING_CHUNK_SIZE,
  DRESSING_DRAW_RADIUS,
  DRESSING_HYSTERESIS,
} from "../src/client/render/world/chunkedDressing.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const BOX = new THREE.BoxGeometry(1, 1, 1);
const MAT = new THREE.MeshBasicMaterial();
const buckets = [
  { geometry: BOX, material: MAT, castShadow: true, receiveShadow: false },
  { geometry: BOX, material: MAT, castShadow: true, receiveShadow: true },
];

const m = (x, y, z, s = 1) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion(),
    new THREE.Vector3(s, s, s),
  );

// --- 1. partitioning ---------------------------------------------------------
{
  // 3 cells x 2 buckets, deliberately unbalanced; cell size 256 (default).
  const entries = [
    { bucket: 0, matrix: m(10, 0, 10), ref: 0 },
    { bucket: 0, matrix: m(200, 0, 40), ref: 1 }, // same cell (0,0)
    { bucket: 1, matrix: m(40, 0, 200), ref: 1 }, // same cell, other bucket
    { bucket: 0, matrix: m(300, 0, 10), ref: 2 }, // cell (1,0)
    { bucket: 0, matrix: m(-10, 0, -10), ref: 3 }, // cell (-1,-1) — negative coords
  ];
  const d = buildChunkedDressing(buckets, entries);
  check(d.meshes.length === 4, `4 non-empty (cell x bucket) meshes (got ${d.meshes.length})`);
  const total = d.meshes.reduce((acc, mesh) => acc + mesh.count, 0);
  check(total === entries.length, `per-mesh counts sum to ${entries.length} entries (got ${total})`);
  check(
    d.meshes.every((mesh) => mesh.frustumCulled === true),
    "every chunk mesh has frustumCulled=true",
  );
  check(
    d.meshes.every((mesh) => mesh.matrixAutoUpdate === false) && d.group.matrixAutoUpdate === false,
    "chunk meshes + group skip per-frame matrix recompose",
  );
  const shadowOk = d.meshes.every((mesh) => {
    const isBucket1 = mesh.receiveShadow === true;
    return mesh.castShadow === true && (isBucket1 || mesh.receiveShadow === false);
  });
  check(shadowOk, "cast/receiveShadow follow the bucket spec");
  d.dispose();
}

// --- 2. bounding spheres -----------------------------------------------------
{
  const entries = [];
  // A tight cluster in cell (0,0) and one in cell (3,3) — far apart.
  for (let i = 0; i < 20; i++) entries.push({ bucket: 0, matrix: m(20 + i, 5, 30 + i) });
  for (let i = 0; i < 20; i++) entries.push({ bucket: 0, matrix: m(800 + i, 5, 800 + i) });
  const d = buildChunkedDressing(buckets, entries);
  check(d.meshes.length === 2, "two far-apart clusters -> two chunk meshes");
  let containsAll = true;
  let chunkSized = true;
  const pos = new THREE.Vector3();
  for (const mesh of d.meshes) {
    const sphere = mesh.boundingSphere;
    if (!sphere) {
      containsAll = false;
      continue;
    }
    for (let s = 0; s < mesh.count; s++) {
      const em = new THREE.Matrix4();
      mesh.getMatrixAt(s, em);
      pos.setFromMatrixPosition(em);
      if (sphere.center.distanceTo(pos) > sphere.radius + 1e-6) containsAll = false;
    }
    // Chunk-local, not world-spanning: instance spread within one 256m cell
    // plus geometry extents stays well under a cell diagonal.
    if (sphere.radius > DRESSING_CHUNK_SIZE * Math.SQRT2) chunkSized = false;
  }
  check(containsAll, "every chunk sphere contains all its instance positions");
  check(chunkSized, "chunk spheres stay chunk-sized (culling stays effective)");
  d.dispose();
}

// --- 3. refSlots + zero-scale mutation ---------------------------------------
{
  // One logical object with parts in BOTH buckets (the Trees branches+leaves
  // shape) plus a second object sharing the first's cell.
  const shared = m(50, 0, 50);
  const entries = [
    { bucket: 0, matrix: shared, ref: 7 },
    { bucket: 1, matrix: shared, ref: 7 },
    { bucket: 0, matrix: m(60, 0, 60), ref: 8 },
  ];
  const d = buildChunkedDressing(buckets, entries);
  const slots7 = d.refSlots.get(7) ?? [];
  const slots8 = d.refSlots.get(8) ?? [];
  check(slots7.length === 2 && slots8.length === 1, "refSlots map each ref to its entries");
  const sphereBefore = slots7[0].mesh.boundingSphere.clone();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const { mesh, slot } of slots7) {
    mesh.setMatrixAt(slot, ZERO);
    mesh.instanceMatrix.needsUpdate = true;
  }
  const sphereAfter = slots7[0].mesh.boundingSphere;
  check(
    sphereBefore.center.equals(sphereAfter.center) && sphereBefore.radius === sphereAfter.radius,
    "zero-scaling via refSlots leaves the chunk sphere untouched",
  );
  const zeroed = new THREE.Matrix4();
  slots7[0].mesh.getMatrixAt(slots7[0].slot, zeroed);
  check(
    zeroed.elements[0] === 0 && zeroed.elements[5] === 0 && zeroed.elements[10] === 0,
    "the zero matrix landed in the instance buffer",
  );
  d.dispose();
}

// --- 4. visibility gate ------------------------------------------------------
{
  const entries = [{ bucket: 0, matrix: m(0, 0, 0) }];
  const d = buildChunkedDressing(buckets, entries);
  const mesh = d.meshes[0];
  const r = mesh.boundingSphere.radius;
  const R = DRESSING_DRAW_RADIUS;
  const H = DRESSING_HYSTERESIS;
  // Camera distances are to the sphere EDGE (subtract r).
  d.updateVisibility(R + H + r + 1, 0); // just past the hide edge
  check(mesh.visible === false, "chunk hides past radius+hysteresis");
  d.updateVisibility(R + r, 0); // inside the dead band — must NOT re-show
  check(mesh.visible === false, "no flip inside the dead band (hidden side)");
  d.updateVisibility(R - H + r - 1, 0); // inside the show edge
  check(mesh.visible === true, "chunk shows again inside radius-hysteresis");
  d.updateVisibility(R + r, 0); // dead band again — must stay shown
  check(mesh.visible === true, "no flip inside the dead band (shown side)");
  d.dispose();
}

// --- 5. colors + dispose -----------------------------------------------------
{
  const entries = [
    { bucket: 0, matrix: m(1, 0, 1), color: new THREE.Color(0.5, 0.5, 0.5) },
    { bucket: 0, matrix: m(2, 0, 2) }, // no color -> defaults white in same mesh
    { bucket: 1, matrix: m(3, 0, 3) }, // colorless bucket -> no instanceColor
  ];
  const d = buildChunkedDressing(buckets, entries);
  const colored = d.meshes.find((mesh) => mesh.count === 2);
  const plain = d.meshes.find((mesh) => mesh.count === 1);
  check(colored?.instanceColor !== null, "mesh with any colored entry allocates instanceColor");
  check(plain?.instanceColor === null, "colorless mesh allocates no instanceColor");
  const c = new THREE.Color();
  colored?.getColorAt(1, c);
  check(c.r === 1 && c.g === 1 && c.b === 1, "uncolored entries default to white");
  const group = d.group;
  d.dispose();
  check(group.children.length === 0 && d.refSlots.size === 0, "dispose empties group + refSlots");
}

console.log(failures === 0 ? "\nchunked-dressing: ALL OK" : `\nchunked-dressing: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
