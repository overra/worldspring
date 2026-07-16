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
import { extractVariant, tintOf, TREES_MODEL_URL, VARIANT_NODES, type VariantAssets } from "./Trees";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingBucket,
  type DressingEntry,
} from "./chunkedDressing";

type VariantTable = Record<"conifer" | "oak", Array<VariantAssets | null>>;

const dummy = new THREE.Object3D();

/** Deterministic variant (0..count-1) from the persisted appearance seed's low
 * bits. Bits 3-12 drive yaw and 8-23 drive size (plantedTreeGeometry), so the
 * selector stays in the low byte — uniform for any count ≤ 256. */
function variantOf(seed: number, count: number): number {
  return (seed & 0xff) % count;
}

/** Build the chunked dressing for the current planted set — one InstancedMesh
 * per (world cell × kind × variant × GLB primitive), per-chunk bounding
 * spheres (chunkedDressing.ts). Keyed on appearanceSeed (not a world.trees
 * index) and with no felled bookkeeping — a felled planted tree is simply
 * absent from the next rebuild. */
function buildPlanted(variants: VariantTable, trees: Iterable<PlantedTree>): ChunkedDressing {
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
  for (const tree of trees) {
    // Stumps are drawn by Stumps.tsx (shared with natural felled stumps) — a
    // stump-stage record must NOT render as a miniature full tree here.
    if (tree.stage === "stump") continue;
    const pool = variants[tree.kind];
    let v = variantOf(tree.appearanceSeed, pool.length);
    for (let step = 0; step < pool.length && !pool[v]; step++) v = (v + 1) % pool.length;
    const assets = pool[v];
    const ids = partBuckets[tree.kind][v];
    if (!assets || !ids) continue; // every node missing — kind unrenderable
    // Stage-scaled height already baked into tree.height by
    // plantedTreeGeometry; a growth transition just changes this scale.
    const s = tree.height / assets.nativeHeight;
    const seed = tree.appearanceSeed;
    const yaw = (((seed >>> 3) & 0x3ff) / 0x3ff) * Math.PI * 2;
    // Deterministic lean (oaks only), origin at the trunk base so the
    // lean never unroots the tree — matches the natural forest.
    const tilt = tree.kind === "oak" ? Math.sin(seed * 1.7) * 0.08 : 0;
    dummy.position.set(tree.x, tree.groundY, tree.z);
    dummy.rotation.set(tilt, yaw, -tilt);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    const matrix = dummy.matrix.clone();
    // Per-tree tint (seed-stable), matching the natural forest so planted and
    // wild trees share the same varied look instead of reading as flat clones.
    const color = tintOf(seed);
    for (const bucket of ids) entries.push({ bucket, matrix, color });
  }
  return buildChunkedDressing(buckets, entries);
}

export function PlantedTrees(): ReactElement {
  const gltf = useGLTF(TREES_MODEL_URL);
  const rootRef = useRef<THREE.Group | null>(null);
  if (rootRef.current === null) rootRef.current = new THREE.Group();
  const dressingRef = useRef<ChunkedDressing | null>(null);
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

  useFrame((state) => {
    dressingRef.current?.updateVisibility(state.camera.position.x, state.camera.position.z);
    if (appliedVersion.current === clientWorld.plantedVersion) return;
    appliedVersion.current = clientWorld.plantedVersion;
    const root = rootRef.current;
    if (!root) return;
    // Frees instance buffers only — geometry/materials belong to the shared
    // GLTF cache and must outlive this component (the Trees.tsx contract).
    dressingRef.current?.dispose();
    dressingRef.current = null;
    root.clear();
    // Read the world FRESH: a rejoin swaps clientWorld.world without necessarily
    // re-rendering this component, and the welcome bump lands us here.
    const world = clientWorld.world;
    if (!world) return;
    const dressing = buildPlanted(variants, world.plantedTrees.trees.values());
    root.add(dressing.group);
    dressingRef.current = dressing;
  });

  useEffect(
    () => () => {
      dressingRef.current?.dispose();
      dressingRef.current = null;
      // Same Strict-Mode-remount hardening as Stumps.tsx: preserved refs with a
      // matching version would skip the rebuild and leave the forest empty.
      appliedVersion.current = -1;
    },
    [],
  );

  return <primitive object={rootRef.current} />;
}
