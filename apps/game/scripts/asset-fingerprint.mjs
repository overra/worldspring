#!/usr/bin/env node
// Asset-size fingerprint — a HARD GATE on the authored SIZE of every model piece.
//
//   node scripts/asset-fingerprint.mjs             # verify against the baseline
//   node scripts/asset-fingerprint.mjs --write     # regenerate the baseline
//   node scripts/asset-fingerprint.mjs [dir]       # check a different models dir
//
// WHY THIS EXISTS
// ---------------
// PR #88 wired gltf-transform's `optimize` into `models:export`. Its meshopt pass
// QUANTIZES vertex positions to normalized int16 and compensates by writing a
// scale/translation onto the GLB NODE. Every mesh node in building_kit.glb (5/5),
// props.glb (18/18) and items.glb (31/31) flipped from identity to non-identity —
// e.g. fascia_strip became "geometry in a unit-ish space + node scale 0.5".
//
// Two renderers (BuildingTrim, Scatter) instanced a node's RAW geometry and
// dropped the node transform, so fascia_strip rendered at 1.0 instead of 0.5 —
// exactly 2x, spearing roof beams out past the walls. It shipped undetected for
// days: typecheck, tests and code review ALL pass, because nothing changed in the
// code. The *asset* moved under a renderer's unstated assumption.
//
// So this hashes DIMENSIONS, not bytes. For every mesh node we take the POSITION
// accessor bounds, dequantize them, and apply the node's full parent-chain
// transform — giving the piece's true authored extents in metres. Recompression
// or requantization changes every byte in the file but MUST NOT move these
// numbers by a millimetre. That is precisely the invariant worth pinning, and the
// one a byte-level hash could never express.
//
// Same shape as the worldgen fingerprint (packages/shared/scripts/world.fingerprint.txt).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";

const ROOT = join(import.meta.dirname, "..");
const BASELINE = join(ROOT, "scripts", "assets.fingerprint.txt");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const MODELS_DIR = argv.find((a) => !a.startsWith("--")) ?? join(ROOT, "public", "models");

/** Every GLB the game ships. A new model MUST be added here (and to the baseline). */
const MODELS = ["building_kit", "items", "props", "trees"];

/** glTF componentType -> the divisor that turns a normalized integer back into
 *  its real value (KHR_mesh_quantization / meshopt). */
const DEQUANTIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Parse a GLB's JSON chunk with no dependencies (@gltf-transform/core is not installed). */
function readGltfJson(file) {
  const buf = readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== CHUNK_JSON) throw new Error(`${file}: first chunk is not JSON`);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
}

function localMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
  );
}

/** World matrix per node index — accumulates the whole parent chain, so a piece
 *  nested under a transformed parent is still measured in true world units. */
function worldMatrixFn(gltf) {
  const nodes = gltf.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const cache = new Map();
  const world = (i) => {
    const hit = cache.get(i);
    if (hit) return hit;
    const local = localMatrix(nodes[i]);
    const p = parentOf.get(i);
    const m = p === undefined ? local : new THREE.Matrix4().multiplyMatrices(world(p), local);
    cache.set(i, m);
    return m;
  };
  return world;
}

/** A mesh node's AUTHORED bounds: dequantized accessor extents, run through the
 *  node's world transform. All 8 corners are transformed (a rotation makes the
 *  naive min/max wrong). */
function authoredBounds(gltf, index, world) {
  const node = gltf.nodes[index];
  const mesh = gltf.meshes[node.mesh];
  const m = world(index);
  const box = new THREE.Box3().makeEmpty();
  const v = new THREE.Vector3();
  for (const prim of mesh.primitives ?? []) {
    const acc = gltf.accessors?.[prim.attributes?.POSITION];
    if (!acc?.min || !acc?.max) continue;
    const div = acc.normalized ? (DEQUANTIZE[acc.componentType] ?? 1) : 1;
    const lo = acc.min.map((x) => x / div);
    const hi = acc.max.map((x) => x / div);
    for (let c = 0; c < 8; c++) {
      v.set(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]).applyMatrix4(m);
      box.expandByPoint(v);
    }
  }
  return box;
}

const r3 = (n) => (Math.abs(n) < 5e-4 ? 0 : n).toFixed(3); // kill -0.000

function fingerprint() {
  const lines = [];
  for (const name of MODELS) {
    const gltf = readGltfJson(join(MODELS_DIR, `${name}.glb`));
    const world = worldMatrixFn(gltf);
    const rows = [];
    (gltf.nodes ?? []).forEach((node, i) => {
      if (node.mesh === undefined) return;
      const b = authoredBounds(gltf, i, world);
      if (b.isEmpty()) return;
      const label = node.name ?? `node${i}`;
      rows.push(
        `${name} ${label.padEnd(22)} : ` +
          `min[${r3(b.min.x)},${r3(b.min.y)},${r3(b.min.z)}] ` +
          `max[${r3(b.max.x)},${r3(b.max.y)},${r3(b.max.z)}]`,
      );
    });
    rows.sort(); // stable regardless of node ordering in the file
    lines.push(...rows);
  }
  return lines;
}

/** Pull the size out of a fingerprint line so a failure can report a real delta. */
function sizeOf(line) {
  const nums = line.match(/-?\d+\.\d+/g)?.map(Number);
    if (!nums || nums.length < 6) return null;
  return [nums[3] - nums[0], nums[4] - nums[1], nums[5] - nums[2]];
}
const keyOf = (line) => line.split(" : ")[0].trim();

const current = fingerprint();

if (WRITE) {
  writeFileSync(BASELINE, current.join("\n") + "\n");
  console.log(`asset-fingerprint: wrote ${current.length} pieces -> ${BASELINE}`);
  process.exit(0);
}

let baseline;
try {
  baseline = readFileSync(BASELINE, "utf8").split("\n").filter(Boolean);
} catch {
  console.error(`asset-fingerprint: no baseline at ${BASELINE}`);
  console.error("  create it with:  pnpm --filter @worldspring/game assets:fingerprint --write");
  process.exit(1);
}

const curByKey = new Map(current.map((l) => [keyOf(l), l]));
const baseByKey = new Map(baseline.map((l) => [keyOf(l), l]));
const problems = [];

for (const [key, was] of baseByKey) {
  const now = curByKey.get(key);
  if (now === undefined) {
    problems.push(`  REMOVED  ${key}\n      was ${was.split(" : ")[1]}`);
    continue;
  }
  if (now === was) continue;
  const a = sizeOf(was);
  const b = sizeOf(now);
  const delta =
    a && b
      ? `  (size ${a.map((n) => n.toFixed(2)).join(" x ")}  ->  ${b
          .map((n) => n.toFixed(2))
          .join(" x ")}  =  ${b.map((n, i) => `${(n / (a[i] || 1)).toFixed(2)}x`).join(", ")})`
      : "";
  problems.push(
    `  RESIZED  ${key}${delta}\n      was ${was.split(" : ")[1]}\n      now ${now.split(" : ")[1]}`,
  );
}
for (const key of curByKey.keys()) {
  if (!baseByKey.has(key)) problems.push(`  NEW      ${key}\n      ${curByKey.get(key).split(" : ")[1]}`);
}

if (problems.length === 0) {
  console.log(`asset-fingerprint: ${current.length} pieces, all authored sizes byte-identical to baseline ✓`);
  process.exit(0);
}

console.error("asset-fingerprint: AUTHORED MODEL SIZES CHANGED\n");
for (const p of problems) console.error(p);
console.error(`
A model's real-world size moved. Renderers instance these pieces by name and
place them with hand-tuned offsets (BuildingTrim's fascia/posts, Scatter's props),
so a resize is a GAMEPLAY-VISIBLE change, not a cosmetic one — this is the exact
failure PR #88 shipped silently (meshopt quantization pushed a compensating scale
onto every node; trim rendered 2x).

If the asset change was INTENTIONAL, re-render the pieces in-game, confirm they
still sit right, then regenerate the baseline:

    pnpm --filter @worldspring/game assets:fingerprint --write

If it was NOT intentional, your export pipeline changed the geometry. Compression
and requantization are fine (they move every byte in the file) — but they must
never move these numbers.
`);
process.exit(1);
