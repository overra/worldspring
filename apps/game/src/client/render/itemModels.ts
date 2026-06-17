// Per-item standalone GLB registry. Historically every ItemType lived as one
// named node inside the monolithic items.glb; this registry lets a Meshy-
// generated, independently-optimized GLB override any single item without
// rebuilding that shared file. An entry here takes precedence over the
// same-named items.glb node; ItemTypes absent here keep falling back to the
// node, then to a tinted box (see LootItems / CharacterRig).
//
// AUTHORING CONTRACT: each per-item GLB is Meshy-generated at arbitrary scale,
// so the registry carries a real-world `maxSizeM` (the item's largest real
// dimension in meters) and the runtime scales by largest-axis + re-seats to
// base-origin — orientation-independent, since Meshy's upright axis isn't
// guaranteed. Held-item facing is still corrected per type via GRIP_TRANSFORMS.

import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { type ItemType } from "@worldspring/shared/items";
import { normalizeModel } from "./modelTemplate";

export interface ItemModelDef {
  url: string;
  /** Largest real-world dimension in meters; the GLB is uniformly scaled so its
   * longest axis spans this (orientation-independent — see normalizeModel). */
  maxSizeM: number;
}

export const ITEM_MODELS: Partial<Record<ItemType, ItemModelDef>> = {
  beans: { url: "/models/items/beans.glb", maxSizeM: 0.11 },
  water_bottle: { url: "/models/items/water_bottle.glb", maxSizeM: 0.24 },
  bandage: { url: "/models/items/bandage.glb", maxSizeM: 0.1 },
  pistol: { url: "/models/items/pistol.glb", maxSizeM: 0.18 },
  rifle: { url: "/models/items/rifle.glb", maxSizeM: 1.2 },
  shotgun: { url: "/models/items/shotgun.glb", maxSizeM: 1.1 },
  ammo_9mm: { url: "/models/items/ammo_9mm.glb", maxSizeM: 0.1 },
  ammo_762: { url: "/models/items/ammo_762.glb", maxSizeM: 0.12 },
  shells: { url: "/models/items/shells.glb", maxSizeM: 0.1 },
  axe: { url: "/models/items/axe.glb", maxSizeM: 0.8 },
  campfire_kit: { url: "/models/items/campfire_kit.glb", maxSizeM: 0.35 },
  flashlight: { url: "/models/items/flashlight.glb", maxSizeM: 0.2 },
  raw_venison: { url: "/models/items/raw_venison.glb", maxSizeM: 0.22 },
  cooked_venison: { url: "/models/items/cooked_venison.glb", maxSizeM: 0.22 },
};

// Stable module-level parallel arrays — the array form of useGLTF keys its
// suspense cache off this list, so it must not change between renders.
const ITEM_MODEL_ENTRIES = Object.entries(ITEM_MODELS) as Array<[ItemType, ItemModelDef]>;
const ITEM_MODEL_URL_LIST = ITEM_MODEL_ENTRIES.map(([, def]) => def.url);

for (const url of ITEM_MODEL_URL_LIST) useGLTF.preload(url);

// Templates are built once per ItemType from the stable drei-cached scenes and
// kept in a module map so the hook returns a stable reference (consumers' memo
// deps don't churn). Cloned per pool slot by the consumer, never added here.
const templateCache = new Map<ItemType, THREE.Object3D>();

/**
 * Loads every registered per-item GLB and returns base-origin, real-world-scaled
 * templates keyed by ItemType, ready to clone. The array form of useGLTF
 * suspends until all are loaded — or resolves instantly to an empty result when
 * the registry is empty, so this is safe (and a no-op) before any assets exist.
 */
export function useItemModelTemplates(): Map<ItemType, THREE.Object3D> {
  const gltfs = useGLTF(ITEM_MODEL_URL_LIST) as unknown as Array<{ scene: THREE.Group }>;
  ITEM_MODEL_ENTRIES.forEach(([type, def], i) => {
    if (templateCache.has(type)) return;
    const scene = gltfs[i]?.scene;
    if (!scene) return;
    const template = normalizeModel(scene, { maxSizeM: def.maxSizeM });
    if (template) templateCache.set(type, template);
  });
  return templateCache;
}
