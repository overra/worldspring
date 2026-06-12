// Forest: four modeled props.glb variants (tree_conifer_a/b, tree_oak_a/b)
// drawn with one InstancedMesh per (variant x GLB primitive) — trunk +
// foliage, so 8 instanced draws for the whole ~700-tree forest. Geometry and
// materials come straight from the shared GLTF cache (never cloned per
// instance); matrices are written once per world — fully static, no sway.
// Variant choice hashes the tree's index in world.trees, which is
// seed-deterministic, so every client sees the same forest.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Tree } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";

const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);

// Golden-angle increment gives a deterministic, non-repeating yaw per index.
const YAW_STEP = 2.3999632;

const VARIANT_NODES = {
  conifer: ["tree_conifer_a", "tree_conifer_b"],
  oak: ["tree_oak_a", "tree_oak_b"],
} as const;

interface TreeInstance {
  tree: Tree;
  /** Index in world.trees — drives deterministic yaw/tilt/variant variance. */
  index: number;
}

interface VariantPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

interface VariantAssets {
  parts: VariantPart[];
  /** Native model height (m) — per-instance scale = tree.height / native. */
  nativeHeight: number;
}

/** Deterministic 0/1 pick per tree. world.trees is seed-derived and
 * index-stable across joins, so every client agrees. Bit-mixed so variants
 * cluster irregularly instead of alternating by index parity. */
function variantOf(index: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h & 1;
}

/** Pulls shared geometry + material pairs out of a GLB node's mesh children
 * (multi-primitive nodes load as Groups of Meshes). Nothing is cloned. */
function extractVariant(scene: THREE.Group, name: string): VariantAssets | null {
  const node = scene.getObjectByName(name);
  if (!node) return null;
  const parts: VariantPart[] = [];
  node.traverse((obj) => {
    if (obj instanceof THREE.Mesh) parts.push({ geometry: obj.geometry, material: obj.material });
  });
  if (parts.length === 0) return null;
  const box = new THREE.Box3().setFromObject(node);
  return { parts, nativeHeight: Math.max(box.max.y, 1e-3) };
}

const dummy = new THREE.Object3D();

function buildBucketMeshes(
  assets: VariantAssets,
  instances: TreeInstance[],
  tiltable: boolean,
): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = [];
  assets.parts.forEach((part, partIndex) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, instances.length);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    // Part 0 is the trunk (matches the old trunk mesh's receiveShadow).
    mesh.receiveShadow = partIndex === 0;
    instances.forEach(({ tree, index }, slot) => {
      const s = tree.height / assets.nativeHeight;
      const yaw = (index * YAW_STEP) % (Math.PI * 2);
      // Slight deterministic lean (oaks only, like the old blob canopy);
      // origin is at the trunk base so the lean never unroots the tree.
      const tilt = tiltable ? Math.sin(index * 1.7) * 0.08 : 0;
      dummy.position.set(tree.x, tree.groundY, tree.z);
      dummy.rotation.set(tilt, yaw, -tilt);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  });
  return meshes;
}

interface Forest {
  root: THREE.Group;
  meshes: THREE.InstancedMesh[];
}

function buildForest(scene: THREE.Group, trees: readonly Tree[]): Forest {
  // Two variants per kind; if one node is missing, fall back to its sibling
  // (and skip the kind entirely only if both are gone).
  const variants: Record<"conifer" | "oak", Array<VariantAssets | null>> = {
    conifer: VARIANT_NODES.conifer.map((name) => extractVariant(scene, name)),
    oak: VARIANT_NODES.oak.map((name) => extractVariant(scene, name)),
  };

  const buckets: Record<"conifer" | "oak", [TreeInstance[], TreeInstance[]]> = {
    conifer: [[], []],
    oak: [[], []],
  };
  trees.forEach((tree, index) => {
    const pair = variants[tree.kind];
    let v = variantOf(index);
    if (!pair[v]) v = 1 - v; // missing node — sibling variant covers
    if (!pair[v]) return; // both missing — kind unrenderable
    buckets[tree.kind][v].push({ tree, index });
  });

  const root = new THREE.Group();
  const meshes: THREE.InstancedMesh[] = [];
  for (const kind of ["conifer", "oak"] as const) {
    for (let v = 0; v < 2; v++) {
      const assets = variants[kind][v];
      const instances = buckets[kind][v];
      if (!assets || instances.length === 0) continue;
      for (const mesh of buildBucketMeshes(assets, instances, kind === "oak")) {
        root.add(mesh);
        meshes.push(mesh);
      }
    }
  }
  return { root, meshes };
}

export function Trees(): ReactElement | null {
  const gltf = useGLTF(PROPS_MODEL_URL);
  const world = clientWorld.world;

  const forest = useMemo(() => {
    if (!world) return null;
    return buildForest(gltf.scene, world.trees);
  }, [gltf.scene, world]);

  useEffect(() => {
    if (!forest) return;
    return () => {
      // Frees instance buffers only — geometry/materials belong to the
      // shared GLTF cache and must outlive this component.
      for (const mesh of forest.meshes) mesh.dispose();
    };
  }, [forest]);

  if (!forest) return null;
  return <primitive object={forest.root} />;
}
