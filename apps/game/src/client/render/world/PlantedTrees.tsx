// Player-planted trees — the dynamic sibling of the static natural forest
// (Trees.tsx). Same four EZ-Tree GLB variants (tree_conifer_a/b, tree_oak_a/b)
// and the same one-InstancedMesh-per-(variant × GLB primitive) buckets, but the
// instance set is MUTABLE: planting adds, growth rescales, felling removes. So
// where Trees.tsx writes its matrices once and only zero-scales felled slots,
// this component REBUILDS its buckets whenever clientWorld.plantedVersion bumps
// (welcome.planted + snap.planted plant/grow/remove deltas). The planted count
// is cap-bounded (PLANTED_TREE_CAP), and version bumps are chop/plant-rate, not
// frame-rate, so the rebuild cost is negligible.
//
// Appearance is driven by each tree's persisted appearanceSeed (variant a/b,
// yaw, oak lean) so a planted tree looks identical for every client and across
// rejoins. Stage lives in the tree's materialized height (sapling 0.16× / young
// 0.52× / mature 1× — see shared plantedTreeGeometry), so a growth transition
// simply rescales the instance on the next rebuild. Collision is handled
// entirely by the shared world.plantedTrees index (queryStatics); this file is
// render-only.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { PlantedTree } from "@worldspring/shared/trees";
import { clientWorld } from "@/client/runtime";
import { extractVariant, TREES_MODEL_URL, VARIANT_NODES, type VariantAssets } from "./Trees";

type VariantTable = Record<"conifer" | "oak", Array<VariantAssets | null>>;

const dummy = new THREE.Object3D();

/** Deterministic variant (0..count-1) from the persisted appearance seed's low
 * bits. Bits 3-12 drive yaw and 8-23 drive size (plantedTreeGeometry), so the
 * selector stays in the low byte — uniform for any count ≤ 256. */
function variantOf(seed: number, count: number): number {
  return (seed & 0xff) % count;
}

/** Build one InstancedMesh per (kind × variant × GLB primitive) for the current
 * planted set. Mirrors Trees.buildBucketMeshes, but keyed on appearanceSeed
 * (not a world.trees index) and with no felled bookkeeping — a felled planted
 * tree is simply absent from the next rebuild. */
function buildPlanted(variants: VariantTable, trees: Iterable<PlantedTree>): THREE.InstancedMesh[] {
  const buckets: Record<"conifer" | "oak", PlantedTree[][]> = {
    conifer: variants.conifer.map(() => []),
    oak: variants.oak.map(() => []),
  };
  for (const tree of trees) {
    // Stumps are drawn by Stumps.tsx (shared with natural felled stumps) — a
    // stump-stage record must NOT render as a miniature full tree here.
    if (tree.stage === "stump") continue;
    const pool = variants[tree.kind];
    let v = variantOf(tree.appearanceSeed, pool.length);
    for (let step = 0; step < pool.length && !pool[v]; step++) v = (v + 1) % pool.length;
    if (!pool[v]) continue; // every node missing — kind unrenderable
    buckets[tree.kind][v].push(tree);
  }

  const meshes: THREE.InstancedMesh[] = [];
  for (const kind of ["conifer", "oak"] as const) {
    const tiltable = kind === "oak";
    for (let v = 0; v < variants[kind].length; v++) {
      const assets = variants[kind][v];
      const instances = buckets[kind][v];
      if (!assets || instances.length === 0) continue;
      assets.parts.forEach((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, instances.length);
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = part.role === "branches";
        instances.forEach((tree, slot) => {
          // Stage-scaled height already baked into tree.height by
          // plantedTreeGeometry; a growth transition just changes this scale.
          const s = tree.height / assets.nativeHeight;
          const seed = tree.appearanceSeed;
          const yaw = (((seed >>> 3) & 0x3ff) / 0x3ff) * Math.PI * 2;
          // Deterministic lean (oaks only), origin at the trunk base so the
          // lean never unroots the tree — matches the natural forest.
          const tilt = tiltable ? Math.sin(seed * 1.7) * 0.08 : 0;
          dummy.position.set(tree.x, tree.groundY, tree.z);
          dummy.rotation.set(tilt, yaw, -tilt);
          dummy.scale.setScalar(s);
          dummy.updateMatrix();
          mesh.setMatrixAt(slot, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        meshes.push(mesh);
      });
    }
  }
  return meshes;
}

export function PlantedTrees(): ReactElement {
  const gltf = useGLTF(TREES_MODEL_URL);
  const rootRef = useRef<THREE.Group | null>(null);
  if (rootRef.current === null) rootRef.current = new THREE.Group();
  const meshesRef = useRef<THREE.InstancedMesh[]>([]);
  // -1 forces a rebuild on the first frame after mount (and after any GLB/world
  // swap resets it), stamping the welcome's full planted set.
  const appliedVersion = useRef(-1);

  const variants = useMemo<VariantTable>(
    () => ({
      conifer: VARIANT_NODES.conifer.map((n) => extractVariant(gltf.scene, n)),
      oak: VARIANT_NODES.oak.map((n) => extractVariant(gltf.scene, n)),
    }),
    [gltf.scene],
  );

  // A new GLB (or hot reload) invalidates cached geometry — force a rebuild.
  useEffect(() => {
    appliedVersion.current = -1;
  }, [variants]);

  useFrame(() => {
    if (appliedVersion.current === clientWorld.plantedVersion) return;
    appliedVersion.current = clientWorld.plantedVersion;
    const root = rootRef.current;
    if (!root) return;
    for (const mesh of meshesRef.current) {
      root.remove(mesh);
      // Frees instance buffers only — geometry/materials belong to the shared
      // GLTF cache and must outlive this component (the Trees.tsx contract).
      mesh.dispose();
    }
    meshesRef.current = [];
    // Read the world FRESH: a rejoin swaps clientWorld.world without necessarily
    // re-rendering this component, and the welcome bump lands us here.
    const world = clientWorld.world;
    if (!world) return;
    const meshes = buildPlanted(variants, world.plantedTrees.trees.values());
    for (const mesh of meshes) root.add(mesh);
    meshesRef.current = meshes;
  });

  useEffect(
    () => () => {
      for (const mesh of meshesRef.current) mesh.dispose();
      meshesRef.current = [];
    },
    [],
  );

  return <primitive object={rootRef.current} />;
}
