#!/usr/bin/env node
// Deterministic EZ-Tree asset baker. EZ-Tree is deliberately a dev-only tool:
// the shipped game loads only the compact GLB produced here. The v1.1.0 ESM
// bundle eagerly creates browser textures, so a tiny inert DOM shim lets its
// geometry generator run in Node; all library materials/textures are replaced
// with the game's flat, untextured materials before export.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESET_DIR = join(APP_DIR, "assets", "trees");
const OUTPUT_PATH = join(APP_DIR, "public", "models", "trees.glb");
const PINNED_NODE_VERSION = (await readFile(join(APP_DIR, "..", "..", ".nvmrc"), "utf8")).trim();
// Export order = byte order: append-only, never reorder (the committed GLB is
// byte-compared by --check; clients pick variants by hashing into VARIANT_NODES).
const NAMES = [
  "tree_conifer_a",
  "tree_conifer_b",
  "tree_conifer_c",
  "tree_conifer_d",
  "tree_oak_a",
  "tree_oak_b",
  "tree_oak_c",
  "tree_oak_d",
];
const MAX_WEIGHTED_TRIANGLES = 300;
const MAX_GLB_BYTES = 250 * 1024;

// EZ-Tree relies on V8 transcendental math while constructing its vertices.
// Those last-bit results can drift between Node/V8 releases, so deterministic
// GLB bytes use the same exact runtime pin as worldgen and CI.
if (process.versions.node !== PINNED_NODE_VERSION) {
  throw new Error(
    `tree assets require Node ${PINNED_NODE_VERSION} from .nvmrc; running ${process.versions.node}`,
  );
}

// TextureLoader only needs an image-shaped object during module evaluation;
// generated materials are discarded before serialization.
globalThis.document ??= {
  createElementNS() {
    return {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      set src(_value) {},
    };
  },
};

// GLTFExporter uses FileReader for Blob -> ArrayBuffer in binary mode.
globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob) {
    void blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString("base64")}`;
      this.onloadend?.();
    });
  }
};

const [{ Tree, TreePreset }, THREE, { GLTFExporter }] = await Promise.all([
  import("@dgreenheck/ez-tree"),
  import("three"),
  import("three/addons/exporters/GLTFExporter.js"),
]);

function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const child = target[key];
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        throw new Error(`invalid EZ-Tree override path: ${key}`);
      }
      merge(child, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function triangleCount(mesh) {
  const position = mesh.geometry.getAttribute("position");
  return (mesh.geometry.index?.count ?? position.count) / 3;
}

function validateMesh(mesh, expectedName) {
  if (!mesh.isMesh || mesh.name !== expectedName) {
    throw new Error(`missing generated mesh ${expectedName}`);
  }
  const position = mesh.geometry.getAttribute("position");
  if (!position || position.count === 0) throw new Error(`${expectedName} is empty`);
  let minY = Infinity;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`${expectedName} contains non-finite vertices`);
    }
    minY = Math.min(minY, y);
  }
  if (minY < -1e-4) throw new Error(`${expectedName} extends below its grounded origin (${minY})`);
}

const root = new THREE.Group();
root.name = "generated_trees";
const stats = [];

for (const name of NAMES) {
  const manifest = JSON.parse(await readFile(join(PRESET_DIR, `${name}.json`), "utf8"));
  if (manifest.name !== name) throw new Error(`${name}.json names ${manifest.name}`);
  const base = TreePreset[manifest.basePreset];
  if (!base) throw new Error(`${name}: unknown base preset ${manifest.basePreset}`);

  const options = merge(structuredClone(base), manifest.options);
  options.bark.textured = false;
  const tree = new Tree();
  tree.loadFromJson(options);
  tree.name = name;
  tree.branchesMesh.name = `${name}_branches`;
  tree.leavesMesh.name = `${name}_leaves`;

  tree.branchesMesh.material.dispose();
  tree.leavesMesh.material.dispose();
  tree.branchesMesh.material = new THREE.MeshStandardMaterial({
    name: `${name}_branches_mat`,
    color: manifest.materials.branches,
    roughness: 0.95,
    flatShading: true,
  });
  tree.leavesMesh.material = new THREE.MeshStandardMaterial({
    name: `${name}_leaves_mat`,
    color: manifest.materials.leaves,
    roughness: 1,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  validateMesh(tree.branchesMesh, `${name}_branches`);
  validateMesh(tree.leavesMesh, `${name}_leaves`);
  if (tree.children.length !== 2) throw new Error(`${name} must contain exactly two render meshes`);
  const triangles = triangleCount(tree.branchesMesh) + triangleCount(tree.leavesMesh);
  if (triangles > manifest.maxTriangles) {
    throw new Error(`${name}: ${triangles} triangles exceeds ${manifest.maxTriangles}`);
  }
  stats.push({ name, kind: manifest.kind, triangles });
  root.add(tree);
}

const mean = (kind) => {
  const matches = stats.filter((entry) => entry.kind === kind);
  return matches.reduce((sum, entry) => sum + entry.triangles, 0) / matches.length;
};
const weighted = mean("conifer") * 0.65 + mean("oak") * 0.35;
if (weighted > MAX_WEIGHTED_TRIANGLES) {
  throw new Error(`weighted tree mean ${weighted.toFixed(1)} exceeds ${MAX_WEIGHTED_TRIANGLES}`);
}

const arrayBuffer = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
const output = Buffer.from(arrayBuffer);
if (output.byteLength > MAX_GLB_BYTES) {
  throw new Error(`trees.glb is ${output.byteLength} bytes; cap is ${MAX_GLB_BYTES}`);
}

if (process.argv.includes("--check")) {
  const existing = await readFile(OUTPUT_PATH).catch(() => null);
  if (!existing || !existing.equals(output)) {
    throw new Error("trees.glb is missing or stale; run pnpm models:trees");
  }
} else {
  await writeFile(OUTPUT_PATH, output);
}

console.log(
  `[trees] ${stats.map((entry) => `${entry.name}:${entry.triangles}`).join(" ")} ` +
    `weighted:${weighted.toFixed(1)} glb:${output.byteLength}B${process.argv.includes("--check") ? " (verified)" : ""}`,
);
