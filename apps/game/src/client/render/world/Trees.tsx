// Forest: the EZ-Tree-generated trees.glb variants drawn with one
// InstancedMesh per (world cell x variant x GLB primitive) via
// chunkedDressing.ts — per-chunk bounding spheres let three frustum-cull the
// forest per camera (view AND shadow pass) instead of vertex-processing all
// ~190K forest triangles every frame, and far chunks radius-hide past the
// fog. Geometry and materials come straight from the shared GLTF cache
// (never cloned per instance); matrices are written once per world — fully
// static, no sway. Variant choice hashes the tree's index in world.trees,
// which is seed-deterministic, so every client sees the same forest.
//
// doc 13 M2 — felled trees: the server ships felled indices (welcome.felled +
// snap.felled deltas → clientWorld.felledTrees); this component zero-scales
// those instances' matrices, keeping the buckets intact (no rebuild, no
// draw-count change). The dynamic falling trunk renders via PhysicsBodies.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Tree } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingBucket,
  type DressingEntry,
} from "./chunkedDressing";

export const TREES_MODEL_URL = "/models/trees.glb";
useGLTF.preload(TREES_MODEL_URL);

// Golden-angle increment gives a deterministic, non-repeating yaw per index.
const YAW_STEP = 2.3999632;

// Shared by the static natural forest (this file) and the dynamic planted-tree
// renderer (PlantedTrees.tsx) — both pull variant geometry from the same GLB.
// Order must mirror generate-trees.mjs NAMES (append-only): variant selection
// hashes into this array, so reordering reshuffles every client's forest.
export const VARIANT_NODES = {
  conifer: ["tree_conifer_a", "tree_conifer_b", "tree_conifer_c", "tree_conifer_d"],
  oak: ["tree_oak_a", "tree_oak_b", "tree_oak_c", "tree_oak_d"],
} as const;

export interface VariantPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  role: "branches" | "leaves";
}

export interface VariantAssets {
  parts: VariantPart[];
  /** Native model height (m) — per-instance scale = tree.height / native. */
  nativeHeight: number;
}

/** Deterministic variant pick per tree (0..count-1). world.trees is
 * seed-derived and index-stable across joins, so every client agrees.
 * Bit-mixed so variants cluster irregularly instead of cycling by index. */
function variantOf(index: number, count: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % count;
}

/** Pulls the generated branches/leaves pair out of a variant node. Role comes
 * from the generator's stable node suffixes, never traversal order. */
export function extractVariant(scene: THREE.Group, name: string): VariantAssets | null {
  const node = scene.getObjectByName(name);
  if (!node) return null;
  const parts: VariantPart[] = [];
  node.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const role = obj.name.endsWith("_branches")
      ? "branches"
      : obj.name.endsWith("_leaves")
        ? "leaves"
        : null;
    if (role) parts.push({ geometry: obj.geometry, material: obj.material, role });
  });
  if (parts.length !== 2) return null;
  const box = new THREE.Box3().setFromObject(node);
  return { parts, nativeHeight: Math.max(box.max.y, 1e-3) };
}

const dummy = new THREE.Object3D();
/** All-zero-scale matrix — collapses a felled tree's instance to nothing. */
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

function buildForest(scene: THREE.Group, trees: readonly Tree[]): ChunkedDressing {
  // N variants per kind (VARIANT_NODES-driven); a missing node falls back to
  // the next available sibling (skip the kind only if every node is gone).
  const variants: Record<"conifer" | "oak", Array<VariantAssets | null>> = {
    conifer: VARIANT_NODES.conifer.map((name) => extractVariant(scene, name)),
    oak: VARIANT_NODES.oak.map((name) => extractVariant(scene, name)),
  };

  // One dressing bucket per (variant x GLB primitive); the chunker splits
  // each into per-cell InstancedMeshes with real bounding spheres.
  const buckets: DressingBucket[] = [];
  const partBuckets: Record<"conifer" | "oak", Array<number[] | null>> = {
    conifer: variants.conifer.map(() => null),
    oak: variants.oak.map(() => null),
  };
  for (const kind of ["conifer", "oak"] as const) {
    variants[kind].forEach((assets, v) => {
      if (!assets) return;
      partBuckets[kind][v] = assets.parts.map((part) => {
        buckets.push({
          geometry: part.geometry,
          material: part.material,
          castShadow: true,
          receiveShadow: part.role === "branches",
        });
        return buckets.length - 1;
      });
    });
  }

  const entries: DressingEntry[] = [];
  trees.forEach((tree, index) => {
    const pool = variants[tree.kind];
    let v = variantOf(index, pool.length);
    for (let step = 0; step < pool.length && !pool[v]; step++) v = (v + 1) % pool.length;
    const assets = pool[v];
    const ids = partBuckets[tree.kind][v];
    if (!assets || !ids) return; // every node missing — kind unrenderable
    const s = tree.height / assets.nativeHeight;
    const yaw = (index * YAW_STEP) % (Math.PI * 2);
    // Slight deterministic lean (oaks only, like the old blob canopy);
    // origin is at the trunk base so the lean never unroots the tree.
    const tilt = tree.kind === "oak" ? Math.sin(index * 1.7) * 0.08 : 0;
    dummy.position.set(tree.x, tree.groundY, tree.z);
    dummy.rotation.set(tilt, yaw, -tilt);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    // One matrix shared by the tree's branches + leaves entries; ref = the
    // world.trees index so fells can zero exactly this tree's slots.
    const matrix = dummy.matrix.clone();
    for (const bucket of ids) entries.push({ bucket, matrix, ref: index });
  });

  return buildChunkedDressing(buckets, entries);
}

export function Trees(): ReactElement | null {
  const gltf = useGLTF(TREES_MODEL_URL);
  const world = clientWorld.world;

  const forest = useMemo(() => {
    if (!world) return null;
    return buildForest(gltf.scene, world.trees);
  }, [gltf.scene, world]);

  useEffect(() => {
    if (!forest) return;
    // Frees instance buffers only — geometry/materials belong to the
    // shared GLTF cache and must outlive this component.
    return () => forest.dispose();
  }, [forest]);

  // doc 13 M2 — hide felled trees. A fresh forest (new world / rejoin) starts
  // unapplied so the welcome's full felled set stamps it on the next frame.
  const appliedVersion = useRef(-1);
  useEffect(() => {
    appliedVersion.current = -1;
  }, [forest]);

  useFrame((state) => {
    if (!forest) return;
    forest.updateVisibility(state.camera.position.x, state.camera.position.z);
    if (appliedVersion.current === clientWorld.felledVersion) return;
    appliedVersion.current = clientWorld.felledVersion;
    // Re-stamps every felled index each change — idempotent and ≤ TREE_COUNT
    // matrix writes, at chop rate (not frame rate). The chunk bounding
    // spheres are deliberately NOT recomputed (see refSlots docs).
    for (const index of clientWorld.felledTrees) {
      const slots = forest.refSlots.get(index);
      if (!slots) continue;
      for (const { mesh, slot } of slots) {
        mesh.setMatrixAt(slot, ZERO_MATRIX);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  });

  if (!forest) return null;
  return <primitive object={forest.group} />;
}
