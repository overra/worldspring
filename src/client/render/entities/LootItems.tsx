// Ground loot: a pool of small bobbing, spinning boxes tinted by item type.
// Geometry and materials are shared; the pool only swaps references when an
// item type changes. (Corpses render separately in Corpses.tsx.)

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { ITEM_DEFS, type ItemType } from "@/shared/items";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 64;
const HOVER_Y = 0.35;
const BOB_AMPLITUDE = 0.06;
const BOB_FREQ = 2;
const SPIN_SPEED = 1.2;

const BOX_GEO = new THREE.BoxGeometry(0.28, 0.28, 0.28);

const materialCache = new Map<ItemType, THREE.MeshLambertMaterial>();

function lootMaterial(type: ItemType): THREE.MeshLambertMaterial {
  const cached = materialCache.get(type);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({ color: ITEM_DEFS[type].color });
  materialCache.set(type, mat);
  return mat;
}

interface LootPool {
  root: THREE.Group;
  meshes: THREE.Mesh[];
  /** Item type currently applied to each pool mesh (avoids re-assignment). */
  applied: Array<ItemType | null>;
}

function createPool(): LootPool {
  const root = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const applied: Array<ItemType | null> = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(BOX_GEO, lootMaterial("beans"));
    mesh.castShadow = true;
    mesh.visible = false;
    root.add(mesh);
    meshes.push(mesh);
    applied.push(null);
  }
  return { root, meshes, applied };
}

export function LootItems(): ReactElement {
  const pool = useMemo(createPool, []);

  useFrame((state) => {
    const loot = clientWorld.loot;
    const t = state.clock.elapsedTime;
    const n = Math.min(loot.length, POOL_SIZE);

    for (let i = 0; i < n; i++) {
      const item = loot[i];
      const mesh = pool.meshes[i];
      mesh.visible = true;
      if (pool.applied[i] !== item.type) {
        pool.applied[i] = item.type;
        mesh.material = lootMaterial(item.type);
      }
      mesh.position.set(
        item.x,
        item.y + HOVER_Y + Math.sin(t * BOB_FREQ + item.id) * BOB_AMPLITUDE,
        item.z,
      );
      mesh.rotation.y = t * SPIN_SPEED;
    }
    for (let i = n; i < POOL_SIZE; i++) pool.meshes[i].visible = false;
  });

  return <primitive object={pool.root} />;
}
