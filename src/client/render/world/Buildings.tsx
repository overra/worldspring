// Static building shells: every wall AABB from world gen becomes a box (door
// gaps are already encoded in the wall layout), plus a floor slab and a roof
// slab per building, plus the military perimeter. That is ~300 boxes; they
// never move, so all boxes sharing a material are merged into a single
// BufferGeometry — 8 draw calls total instead of ~300 individual meshes.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Aabb } from "@/shared/math";
import type { BuildingKind, World } from "@/shared/world";
import { clientWorld } from "@/client/runtime";

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
  // world gen — this is rendering only. Merged like everything else.
  for (const wall of world.militaryWalls) {
    boxes.push(aabbToBox("milwall", wall));
  }
  return boxes;
}

/**
 * One mesh per material: every box sharing a material is baked (scaled +
 * translated unit cube) into a single merged BufferGeometry. Exact positions,
 * dimensions and colors match the old per-box meshes — only the draw-call
 * count changes (~300 -> 8).
 */
function buildMergedMeshes(
  world: World,
  materials: Record<MaterialKey, THREE.MeshStandardMaterial>,
): THREE.Mesh[] {
  const byMaterial = new Map<MaterialKey, BoxSpec[]>();
  for (const box of buildBoxes(world)) {
    const list = byMaterial.get(box.material);
    if (list) list.push(box);
    else byMaterial.set(box.material, [box]);
  }

  const unit = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();
  const meshes: THREE.Mesh[] = [];
  for (const [key, specs] of byMaterial) {
    const parts = specs.map((spec) => {
      const part = unit.clone();
      matrix
        .makeScale(spec.scale[0], spec.scale[1], spec.scale[2])
        .setPosition(spec.position[0], spec.position[1], spec.position[2]);
      part.applyMatrix4(matrix);
      return part;
    });
    const merged: THREE.BufferGeometry | null = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (!merged) continue; // identical attribute layouts — should not happen

    const mesh = new THREE.Mesh(merged, materials[key]);
    mesh.name = `buildings-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  unit.dispose();
  return meshes;
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

  const meshes = useMemo(
    () => (world ? buildMergedMeshes(world, materials) : null),
    [world, materials],
  );

  useEffect(() => {
    return () => {
      for (const mat of Object.values(materials)) mat.dispose();
    };
  }, [materials]);

  useEffect(() => {
    if (!meshes) return;
    return () => {
      for (const mesh of meshes) mesh.geometry.dispose();
    };
  }, [meshes]);

  if (!meshes) return null;
  return (
    <group>
      {meshes.map((mesh) => (
        <primitive key={mesh.name} object={mesh} />
      ))}
    </group>
  );
}
