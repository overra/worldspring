// Stumps — the visible remainder of every felled tree, natural AND planted.
//
// Natural: derived entirely client-side from the felled set (welcome.felled +
// snap.felled → clientWorld.felledTrees) crossed with world.trees — zero wire
// surface of its own. This finally EXPLAINS the doc 13 M2 posture the sim
// already had: a felled natural tree's trunk circle stays kinematic-solid in
// the shared queryStatics, and now there's a stump standing in it.
//
// Planted: stump-STAGE records in world.plantedTrees (fell re-stages instead of
// removing — see server trees.ts fellPlantedTree). PlantedTrees.tsx skips
// stump-stage records so this is their sole renderer. Cleared stumps leave via
// the normal remove delta.
//
// One InstancedMesh per world cell (tapered cylinder, bark side + cut top
// materials — chunkedDressing.ts) rebuilt whenever EITHER source changes
// (felledVersion / plantedVersion bump) — both are chop-rate integers, and
// the instance count is bounded by felled naturals + PLANTED_TREE_CAP, so
// rebuilds are trivially cheap.

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { STUMP_HEIGHT } from "@worldspring/shared/trees";
import { clientWorld } from "@/client/runtime";
import { buildChunkedDressing, type ChunkedDressing, type DressingEntry } from "./chunkedDressing";

// Unit tapered cylinder (wider at the root), origin at its base so instance
// scale maps (r, STUMP_HEIGHT, r) directly. Groups: 0 = side, 1 = top, 2 = bottom.
const STUMP_GEOMETRY = new THREE.CylinderGeometry(1, 1.18, 1, 9, 1);
STUMP_GEOMETRY.translate(0, 0.5, 0);
const BARK_MATERIAL = new THREE.MeshStandardMaterial({ color: "#5d4430", roughness: 0.95 });
const CUT_MATERIAL = new THREE.MeshStandardMaterial({ color: "#c9a06a", roughness: 0.85 });
const STUMP_MATERIALS = [BARK_MATERIAL, CUT_MATERIAL, BARK_MATERIAL];

const dummy = new THREE.Object3D();

interface StumpSpot {
  x: number;
  z: number;
  groundY: number;
  r: number;
}

function collectStumps(): StumpSpot[] {
  const world = clientWorld.world;
  if (!world) return [];
  const out: StumpSpot[] = [];
  for (const index of clientWorld.felledTrees) {
    const tree = world.trees[index];
    if (tree) out.push({ x: tree.x, z: tree.z, groundY: tree.groundY, r: tree.r });
  }
  for (const tree of world.plantedTrees.trees.values()) {
    if (tree.stage === "stump") out.push({ x: tree.x, z: tree.z, groundY: tree.groundY, r: tree.r });
  }
  return out;
}

export function Stumps(): ReactElement {
  const rootRef = useRef<THREE.Group | null>(null);
  if (rootRef.current === null) rootRef.current = new THREE.Group();
  const dressingRef = useRef<ChunkedDressing | null>(null);
  const appliedFelled = useRef(-1);
  const appliedPlanted = useRef(-1);

  useFrame((state) => {
    dressingRef.current?.updateVisibility(state.camera.position.x, state.camera.position.z);
    if (
      appliedFelled.current === clientWorld.felledVersion &&
      appliedPlanted.current === clientWorld.plantedVersion
    ) {
      return;
    }
    appliedFelled.current = clientWorld.felledVersion;
    appliedPlanted.current = clientWorld.plantedVersion;
    const root = rootRef.current;
    if (!root) return;
    // Instance buffers only; geometry/materials are module-shared.
    dressingRef.current?.dispose();
    dressingRef.current = null;
    root.clear();
    const stumps = collectStumps();
    if (stumps.length === 0) return;
    const entries: DressingEntry[] = stumps.map((s) => {
      dummy.position.set(s.x, s.groundY, s.z);
      // Deterministic yaw from position so the 9-gon silhouettes vary.
      dummy.rotation.set(0, (s.x * 7.13 + s.z * 3.71) % (Math.PI * 2), 0);
      dummy.scale.set(s.r, STUMP_HEIGHT, s.r);
      dummy.updateMatrix();
      return { bucket: 0, matrix: dummy.matrix.clone() };
    });
    const dressing = buildChunkedDressing(
      [{ geometry: STUMP_GEOMETRY, material: STUMP_MATERIALS, castShadow: true, receiveShadow: true }],
      entries,
    );
    root.add(dressing.group);
    dressingRef.current = dressing;
  });

  useEffect(
    () => () => {
      dressingRef.current?.dispose();
      dressingRef.current = null;
      // Reset the applied versions too: a Strict-Mode remount preserves refs,
      // and matching versions would skip the rebuild — stumps gone until the
      // next chop bumps a version.
      appliedFelled.current = -1;
      appliedPlanted.current = -1;
    },
    [],
  );

  return <primitive object={rootRef.current} />;
}
