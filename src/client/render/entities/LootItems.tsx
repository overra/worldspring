// Ground loot: a pool of bobbing, spinning GLB models — items.glb holds one
// node per ItemType (named exactly by type, base-origin, standing on y=0).
// Each pool slot is a Group whose child is swapped for a template clone when
// the item type changes; clones share geometry + materials. Types missing
// from the GLB fall back to the old tinted box so a future ItemType never
// crashes the renderer. (Corpses render separately in Corpses.tsx.)

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { ITEM_DEFS, type ItemType } from "@/shared/items";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 64;
// Model origins sit at the base (minY = 0 for every node), so the lowest
// vertex hovers at HOVER_Y - BOB_AMPLITUDE — long guns never clip the ground.
const HOVER_Y = 0.35;
const BOB_AMPLITUDE = 0.06;
const BOB_FREQ = 2;
const SPIN_SPEED = 1.2;

/** Readability floor: tiny items (ammo boxes ~7cm) vanish in grass, so each
 * template scales up until its largest XZ dimension reads at this size.
 * Weapons already exceed it and render at native scale (factor 1). */
const MIN_GROUND_XZ = 0.22;

const ITEMS_MODEL_URL = "/models/items.glb";
useGLTF.preload(ITEMS_MODEL_URL);

const BOX_GEO = new THREE.BoxGeometry(0.28, 0.28, 0.28);

const materialCache = new Map<ItemType, THREE.MeshLambertMaterial>();

function lootMaterial(type: ItemType): THREE.MeshLambertMaterial {
  const cached = materialCache.get(type);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({ color: ITEM_DEFS[type].color });
  materialCache.set(type, mat);
  return mat;
}

interface LootTemplate {
  /** Source node inside the cached GLB scene — cloned per slot, never
   * added to the scene graph itself. */
  source: THREE.Object3D;
  /** Ground display scale (>= 1), computed once from the template bounds. */
  scale: number;
}

function buildTemplates(scene: THREE.Group): Map<ItemType, LootTemplate> {
  const map = new Map<ItemType, LootTemplate>();
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  for (const type of Object.keys(ITEM_DEFS) as ItemType[]) {
    const node = scene.getObjectByName(type);
    if (!node) continue;
    // Clones inherit castShadow, so flag the source meshes once here.
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
    box.setFromObject(node);
    box.getSize(size);
    const maxXZ = Math.max(size.x, size.z, 1e-3);
    map.set(type, { source: node, scale: Math.max(1, MIN_GROUND_XZ / maxXZ) });
  }
  return map;
}

interface LootPool {
  root: THREE.Group;
  slots: THREE.Group[];
  /** Item type currently applied to each pool slot (avoids re-cloning). */
  applied: Array<ItemType | null>;
}

function createPool(): LootPool {
  const root = new THREE.Group();
  const slots: THREE.Group[] = [];
  const applied: Array<ItemType | null> = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = new THREE.Group();
    slot.visible = false;
    root.add(slot);
    slots.push(slot);
    applied.push(null);
  }
  return { root, slots, applied };
}

export function LootItems(): ReactElement {
  // Suspends until the GLB loads; the Canvas mounts post-welcome so the
  // suspension is invisible. Same drei cache entry CharacterRig uses.
  const gltf = useGLTF(ITEMS_MODEL_URL);
  const templates = useMemo(() => buildTemplates(gltf.scene), [gltf.scene]);
  const pool = useMemo(createPool, []);

  useFrame((state) => {
    const loot = clientWorld.loot;
    const t = state.clock.elapsedTime;
    const n = Math.min(loot.length, POOL_SIZE);

    for (let i = 0; i < n; i++) {
      const item = loot[i];
      const slot = pool.slots[i];
      slot.visible = true;
      if (pool.applied[i] !== item.type) {
        pool.applied[i] = item.type;
        slot.clear();
        const template = templates.get(item.type);
        if (template) {
          slot.add(template.source.clone());
          slot.scale.setScalar(template.scale);
        } else {
          // Unknown type (future ItemType / missing GLB node): tinted box.
          const mesh = new THREE.Mesh(BOX_GEO, lootMaterial(item.type));
          mesh.castShadow = true;
          slot.add(mesh);
          slot.scale.setScalar(1);
        }
      }
      slot.position.set(
        item.x,
        item.y + HOVER_Y + Math.sin(t * BOB_FREQ + item.id) * BOB_AMPLITUDE,
        item.z,
      );
      slot.rotation.y = t * SPIN_SPEED;
    }
    for (let i = n; i < POOL_SIZE; i++) pool.slots[i].visible = false;
  });

  return <primitive object={pool.root} />;
}
