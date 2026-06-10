// Static building shells: every wall AABB from world gen becomes a box mesh
// (door gaps are already encoded in the wall layout), plus a floor slab and a
// roof slab per building. ~36 buildings x ~7 boxes — plain meshes are fine.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import type { Aabb } from "@/shared/math";
import type { BuildingKind, World } from "@/shared/world";
import { clientWorld } from "@/client/runtime";

const WALL_COLORS: Record<BuildingKind, string> = {
  house: "#8a7f6a",
  shed: "#6e6a5e",
  barn: "#7a4a3a",
};
const ROOF_COLOR = "#4a4440";
const FLOOR_COLOR = "#5b5248";
const FLOOR_THICKNESS = 0.2;
// Pull the floor slab inside the wall faces (wall thickness is 0.35 in world
// gen). The walls now extend below floor level as foundation skirts, so a
// full-footprint slab would share planes with them and z-fight.
const FLOOR_INSET = 0.36;

type MaterialKey = BuildingKind | "roof" | "floor";

interface BoxSpec {
  key: string;
  material: MaterialKey;
  position: [number, number, number];
  scale: [number, number, number];
}

function aabbToBox(key: string, material: MaterialKey, box: Aabb): BoxSpec {
  return {
    key,
    material,
    position: [(box.minX + box.maxX) / 2, (box.y0 + box.y1) / 2, (box.minZ + box.maxZ) / 2],
    scale: [box.maxX - box.minX, box.y1 - box.y0, box.maxZ - box.minZ],
  };
}

function buildBoxes(world: World): BoxSpec[] {
  const boxes: BoxSpec[] = [];
  for (const b of world.buildings) {
    b.walls.forEach((wall, i) => {
      boxes.push(aabbToBox(`b${b.id}-w${i}`, b.kind, wall));
    });
    boxes.push(aabbToBox(`b${b.id}-roof`, "roof", b.roof));
    boxes.push({
      key: `b${b.id}-floor`,
      material: "floor",
      position: [b.cx, b.floorY - FLOOR_THICKNESS / 2, b.cz],
      scale: [b.halfW * 2 - FLOOR_INSET * 2, FLOOR_THICKNESS, b.halfD * 2 - FLOOR_INSET * 2],
    });
  }
  return boxes;
}

export function Buildings(): ReactElement | null {
  const world = clientWorld.world;
  const boxes = useMemo(() => (world ? buildBoxes(world) : null), [world]);

  const shared = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const materials: Record<MaterialKey, THREE.MeshStandardMaterial> = {
      house: new THREE.MeshStandardMaterial({ color: WALL_COLORS.house, flatShading: true }),
      shed: new THREE.MeshStandardMaterial({ color: WALL_COLORS.shed, flatShading: true }),
      barn: new THREE.MeshStandardMaterial({ color: WALL_COLORS.barn, flatShading: true }),
      roof: new THREE.MeshStandardMaterial({ color: ROOF_COLOR, flatShading: true }),
      floor: new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, flatShading: true }),
    };
    return { geometry, materials };
  }, []);

  useEffect(() => {
    return () => {
      shared.geometry.dispose();
      for (const mat of Object.values(shared.materials)) mat.dispose();
    };
  }, [shared]);

  if (!boxes) return null;
  return (
    <group>
      {boxes.map((box) => (
        <mesh
          key={box.key}
          geometry={shared.geometry}
          material={shared.materials[box.material]}
          position={box.position}
          scale={box.scale}
        />
      ))}
    </group>
  );
}
