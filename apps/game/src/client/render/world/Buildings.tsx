// Static building shells: every wall AABB from world gen becomes a box (door
// gaps are already encoded in the wall layout), plus a floor slab and a roof
// slab per building, plus the military perimeter — ~300 boxes that never move.
//
// Each box is one instance of a shared unit cube, scaled + positioned by its
// per-instance matrix, partitioned into per-256m-cell InstancedMeshes via
// chunkedDressing.ts. Real per-chunk bounding spheres let three frustum-cull
// each town / compound / lone cabin independently in BOTH the camera and shadow
// passes, and updateVisibility() radius-hides distant cells past the fog. (The
// old build merged every box of a material into one world-spanning mesh — 8
// draw calls, but each spanned the whole island so its bounds defeated culling
// and all ~300 boxes were vertex-processed every frame in both passes.)

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Aabb } from "@worldspring/shared/math";
import type { BuildingKind, World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingBucket,
  type DressingEntry,
} from "./chunkedDressing";

const WALL_COLORS: Record<BuildingKind, string> = {
  house: "#8a7f6a",
  shed: "#6e6a5e",
  barn: "#7a4a3a",
  barracks: "#5c6152",
  hangar: "#565b54",
};
const ROOF_COLOR = "#4a4440";
const FLOOR_COLOR = "#5b5248";
// Military perimeter walls + corner towers: concrete grey-green.
const MILWALL_COLOR = "#6a6d62";
const FLOOR_THICKNESS = 0.2;
// Pull the floor slab inside the wall faces (wall thickness is 0.35 in world
// gen). The walls now extend below floor level as foundation skirts, so a
// full-footprint slab would share planes with them and z-fight.
const FLOOR_INSET = 0.36;

type MaterialKey = BuildingKind | "roof" | "floor" | "milwall";

// Each MaterialKey's stable DressingBucket index. A Record literal is
// exhaustive by construction: a new BuildingKind that isn't added here is a
// compile error, never a silent mis-bucket into another material's mesh.
// Unused keys (no boxes) simply produce no chunk meshes.
const MATERIAL_BUCKET: Record<MaterialKey, number> = {
  house: 0,
  shed: 1,
  barn: 2,
  barracks: 3,
  hangar: 4,
  milwall: 5,
  roof: 6,
  floor: 7,
};

interface BoxSpec {
  material: MaterialKey;
  position: [number, number, number];
  scale: [number, number, number];
}

function aabbToBox(material: MaterialKey, box: Aabb): BoxSpec {
  return {
    material,
    position: [(box.minX + box.maxX) / 2, (box.y0 + box.y1) / 2, (box.minZ + box.maxZ) / 2],
    scale: [box.maxX - box.minX, box.y1 - box.y0, box.maxZ - box.minZ],
  };
}

function buildBoxes(world: World): BoxSpec[] {
  const boxes: BoxSpec[] = [];
  for (const b of world.buildings) {
    for (const wall of b.walls) {
      boxes.push(aabbToBox(b.kind, wall));
    }
    boxes.push(aabbToBox("roof", b.roof));
    boxes.push({
      material: "floor",
      position: [b.cx, b.floorY - FLOOR_THICKNESS / 2, b.cz],
      scale: [b.halfW * 2 - FLOOR_INSET * 2, FLOOR_THICKNESS, b.halfD * 2 - FLOOR_INSET * 2],
    });
  }
  // Military compound perimeter (walls + corner towers). Already colliders in
  // world gen — this is rendering only.
  for (const wall of world.militaryWalls) {
    boxes.push(aabbToBox("milwall", wall));
  }
  return boxes;
}

// Shared unit cube: every box is this geometry scaled non-uniformly by its
// instance matrix. Module-level + app-lifetime (Stumps' STUMP_GEOMETRY
// precedent) — chunkedDressing frees only the instance buffers, never the
// caller's geometry. flatShading derives normals per-fragment from screen
// derivatives, so non-uniform per-instance scale renders identically to the
// old merged boxes.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const dummy = new THREE.Object3D();

/**
 * One DressingBucket per MaterialKey (all sharing the unit cube); each box
 * becomes a DressingEntry whose matrix carries its center + extents. The
 * chunker splits them into per-(cell x material) InstancedMeshes with real
 * bounding spheres. Exact positions, dimensions and colors match the old
 * per-box meshes — only the draw-call / culling model changes.
 */
function buildBuildings(
  world: World,
  materials: Record<MaterialKey, THREE.MeshStandardMaterial>,
): ChunkedDressing {
  const buckets: DressingBucket[] = [];
  for (const key of Object.keys(MATERIAL_BUCKET) as MaterialKey[]) {
    buckets[MATERIAL_BUCKET[key]] = {
      geometry: UNIT_BOX,
      material: materials[key],
      castShadow: true,
      receiveShadow: true,
    };
  }

  const entries: DressingEntry[] = buildBoxes(world).map((box) => {
    dummy.position.set(box.position[0], box.position[1], box.position[2]);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(box.scale[0], box.scale[1], box.scale[2]);
    dummy.updateMatrix();
    return { bucket: MATERIAL_BUCKET[box.material], matrix: dummy.matrix.clone() };
  });

  return buildChunkedDressing(buckets, entries);
}

export function Buildings(): ReactElement | null {
  const world = clientWorld.world;

  const materials = useMemo<Record<MaterialKey, THREE.MeshStandardMaterial>>(
    () => ({
      house: new THREE.MeshStandardMaterial({ color: WALL_COLORS.house, flatShading: true }),
      shed: new THREE.MeshStandardMaterial({ color: WALL_COLORS.shed, flatShading: true }),
      barn: new THREE.MeshStandardMaterial({ color: WALL_COLORS.barn, flatShading: true }),
      barracks: new THREE.MeshStandardMaterial({ color: WALL_COLORS.barracks, flatShading: true }),
      hangar: new THREE.MeshStandardMaterial({ color: WALL_COLORS.hangar, flatShading: true }),
      milwall: new THREE.MeshStandardMaterial({ color: MILWALL_COLOR, flatShading: true }),
      roof: new THREE.MeshStandardMaterial({ color: ROOF_COLOR, flatShading: true }),
      floor: new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, flatShading: true }),
    }),
    [],
  );

  const dressing = useMemo(
    () => (world ? buildBuildings(world, materials) : null),
    [world, materials],
  );

  // Frees instance buffers only; UNIT_BOX + materials are caller-owned.
  useEffect(() => {
    if (!dressing) return;
    return () => dressing.dispose();
  }, [dressing]);

  useEffect(() => {
    return () => {
      for (const mat of Object.values(materials)) mat.dispose();
    };
  }, [materials]);

  useFrame((state) => {
    dressing?.updateVisibility(state.camera.position.x, state.camera.position.z);
  });

  if (!dressing) return null;
  return <primitive object={dressing.group} />;
}
