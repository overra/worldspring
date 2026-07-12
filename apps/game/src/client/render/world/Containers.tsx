// Searchable containers (doc 05 §3): placeholder per-kind boxes rendered
// instanced, one InstancedMesh per (world cell x ContainerKind) via
// chunkedDressing.ts. Geometry/material built once, all matrices written on
// mount, fully static. Positions/kinds come straight from the deterministic
// worldgen `world.containers` array (client and server agree bit-for-bit), so
// there is no rng here.
//
// These are render-only: worldgen attaches no collision AABB. Art (a real GLB
// per kind) can replace the boxes later without touching placement.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ContainerKind, World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingEntry,
} from "./chunkedDressing";

const KINDS: readonly ContainerKind[] = ["wardrobe", "cabinet", "toolbox", "locker"];

/** Placeholder footprint + tint per kind. The box origin is its base center,
 * so y sits on the floor; depth (z, local) faces into the room. */
const KIND_BOX: Record<ContainerKind, { w: number; h: number; d: number; color: string }> = {
  wardrobe: { w: 1.0, h: 1.9, d: 0.6, color: "#6b5638" },
  cabinet: { w: 1.1, h: 1.0, d: 0.5, color: "#7a6a4a" },
  toolbox: { w: 0.8, h: 0.7, d: 0.55, color: "#9a4a2a" },
  locker: { w: 0.9, h: 1.95, d: 0.55, color: "#4a5560" },
};

const dummy = new THREE.Object3D();

interface ContainersBuild {
  dressing: ChunkedDressing;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

function buildContainers(world: World): ContainersBuild {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const bucketOf = new Map<ContainerKind, number>();
  KINDS.forEach((kind, i) => {
    const box = KIND_BOX[kind];
    // Unit box translated so its origin is the base center (sits on the floor).
    const geom = new THREE.BoxGeometry(box.w, box.h, box.d);
    geom.translate(0, box.h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color: box.color, flatShading: true });
    geometries.push(geom);
    materials.push(mat);
    bucketOf.set(kind, i);
  });

  const entries: DressingEntry[] = [];
  for (const c of world.containers) {
    const bucket = bucketOf.get(c.kind);
    if (bucket === undefined) continue;
    dummy.position.set(c.x, c.y, c.z);
    dummy.rotation.set(0, c.yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    entries.push({ bucket, matrix: dummy.matrix.clone() });
  }
  const dressing = buildChunkedDressing(
    KINDS.map((kind, i) => ({
      geometry: geometries[i],
      material: materials[i],
      castShadow: true,
      receiveShadow: true,
    })),
    entries,
  );
  return { dressing, geometries, materials };
}

export function Containers(): ReactElement | null {
  const world = clientWorld.world;

  const build = useMemo(() => (world ? buildContainers(world) : null), [world]);

  useEffect(() => {
    if (!build) return;
    return () => {
      // Geometry + materials are owned here (not the shared GLTF cache), so
      // free them all on unmount.
      build.dressing.dispose();
      for (const geom of build.geometries) geom.dispose();
      for (const mat of build.materials) mat.dispose();
    };
  }, [build]);

  useFrame((state) => {
    build?.dressing.updateVisibility(state.camera.position.x, state.camera.position.z);
  });

  if (!build) return null;
  return <primitive object={build.dressing.group} />;
}
