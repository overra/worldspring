// Per-item standalone GLB registry. Historically every ItemType lived as one
// named node inside the monolithic items.glb; this registry lets a Meshy-
// generated, independently-optimized GLB override any single item without
// rebuilding that shared file. An entry here takes precedence over the
// same-named items.glb node; ItemTypes absent here keep falling back to the
// node, then to a tinted box (see LootItems / CharacterRig).
//
// AUTHORING CONTRACT: each per-item GLB MUST be exported upright and at
// real-world scale (baked at asset-prep time, e.g. the gltf-transform pass) —
// the runtime only re-seats it to base-origin (normalizeModel without heightM),
// it does NOT rescale, because the meaningful axis differs per item (a rifle is
// long on Z, a can is tall on Y).

import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { type ItemType } from "@worldspring/shared/items";
import { normalizeModel } from "./modelTemplate";

export const ITEM_MODEL_URLS: Partial<Record<ItemType, string>> = {
  // Filled in as assets are produced, e.g.:
  // beans: "/models/items/beans.glb",
};

// Stable module-level parallel arrays — the array form of useGLTF keys its
// suspense cache off this list, so it must not change between renders.
const ITEM_MODEL_ENTRIES = Object.entries(ITEM_MODEL_URLS) as Array<[ItemType, string]>;
const ITEM_MODEL_URL_LIST = ITEM_MODEL_ENTRIES.map(([, url]) => url);

for (const url of ITEM_MODEL_URL_LIST) useGLTF.preload(url);

// Templates are built once per ItemType from the stable drei-cached scenes and
// kept in a module map so the hook returns a stable reference (consumers' memo
// deps don't churn). Cloned per pool slot by the consumer, never added here.
const templateCache = new Map<ItemType, THREE.Object3D>();

/**
 * Loads every registered per-item GLB and returns base-origin templates keyed
 * by ItemType, ready to clone. The array form of useGLTF suspends until all are
 * loaded — or resolves instantly to an empty result when the registry is empty,
 * so this is safe (and a no-op) before any per-item assets exist.
 */
export function useItemModelTemplates(): Map<ItemType, THREE.Object3D> {
  const gltfs = useGLTF(ITEM_MODEL_URL_LIST) as unknown as Array<{ scene: THREE.Group }>;
  ITEM_MODEL_ENTRIES.forEach(([type], i) => {
    if (templateCache.has(type)) return;
    const scene = gltfs[i]?.scene;
    if (!scene) return;
    const template = normalizeModel(scene);
    if (template) templateCache.set(type, template);
  });
  return templateCache;
}
