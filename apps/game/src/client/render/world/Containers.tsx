// Searchable containers (doc 05 §3): placeholder per-kind boxes rendered
// instanced, one InstancedMesh per ContainerKind. Same structure as
// BuildingTrim.tsx — geometry/material built once, all matrices written on
// mount, fully static (no per-frame work). Positions/kinds come straight from
// the deterministic worldgen `world.containers` array (client and server agree
// bit-for-bit), so there is no rng here.
//
// These are render-only: worldgen attaches no collision AABB. Art (a real GLB
// per kind) can replace the boxes later without touching placement.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import type { ContainerKind, World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";

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
  root: THREE.Group;
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

function buildContainers(world: World): ContainersBuild {
  const byKind = new Map<ContainerKind, World["containers"]>();
  for (const c of world.containers) {
    const list = byKind.get(c.kind);
    if (list) list.push(c);
    else byKind.set(c.kind, [c]);
  }

  const root = new THREE.Group();
  const meshes: THREE.InstancedMesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  for (const kind of KINDS) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    const box = KIND_BOX[kind];
    // Unit box translated so its origin is the base center (sits on the floor).
    const geom = new THREE.BoxGeometry(box.w, box.h, box.d);
    geom.translate(0, box.h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color: box.color, flatShading: true });
    const mesh = new THREE.InstancedMesh(geom, mat, list.length);
    mesh.name = `containers-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    list.forEach((c, slot) => {
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(0, c.yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    meshes.push(mesh);
    geometries.push(geom);
    materials.push(mat);
  }
  return { root, meshes, geometries, materials };
}

export function Containers(): ReactElement | null {
  const world = clientWorld.world;

  const build = useMemo(() => (world ? buildContainers(world) : null), [world]);

  useEffect(() => {
    if (!build) return;
    return () => {
      // Geometry + materials are owned here (not the shared GLTF cache), so
      // free them all on unmount.
      for (const mesh of build.meshes) mesh.dispose();
      for (const geom of build.geometries) geom.dispose();
      for (const mat of build.materials) mat.dispose();
    };
  }, [build]);

  if (!build) return null;
  return <primitive object={build.root} />;
}
