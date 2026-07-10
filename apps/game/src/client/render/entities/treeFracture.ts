// Tree-cut fracture templates. The fracture SOURCE is a closed, watertight
// trunk-segment proxy (a low-poly cylinder sized off the species' shared
// plantedTreeGeometry radius) — NEVER the EZ-Tree render meshes, whose sections
// are open and overlapping (Three Pinata requires sealed geometry). Bursts
// spawn at the cut line when a tree fells (treeCut) and when a resting trunk is
// axed apart (break kind:"trunk").

import * as THREE from "three";
import type { TreeSpecies } from "@worldspring/shared/trees";
import { buildFractureTemplate, type FragmentTemplate } from "./fracture";

export const TREE_FRACTURE_SEEDS = [2131, 8887, 22303] as const;
export const TREE_FRAGMENT_COUNTS = [6, 8] as const;
export type TreeFragmentCount = (typeof TREE_FRAGMENT_COUNTS)[number];
export const TREE_SPECIES: readonly TreeSpecies[] = ["conifer", "oak"] as const;

// One bark/inner pair shared by both species: fragments live ~1.25s — a per-
// species tint would be imperceptible, and shared materials keep the debris
// pool's cloned-material count flat.
export const TREE_BARK_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#5d4430",
  roughness: 0.95,
  flatShading: true,
});
export const TREE_WOOD_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#c9a06a",
  roughness: 0.85,
  flatShading: true,
});

/** Species trunk radii mirroring shared plantedTreeGeometry's mature radius —
 * duplicated as literals so the render bundle doesn't pull worldgen weight. */
const TRUNK_RADIUS: Record<TreeSpecies, number> = { conifer: 0.34, oak: 0.42 };
/** Height of the cut segment the burst appears to tear out of the trunk. */
const CUT_SEGMENT_HEIGHT = 1.1;

export function buildTreeCutTemplate(
  species: TreeSpecies,
  fragmentCount: TreeFragmentCount,
  seed: number,
): FragmentTemplate[] {
  const r = TRUNK_RADIUS[species];
  // Closed cylinder, slightly tapered like a real trunk section. 10 radial
  // segments keeps each Voronoi cell chunky (splinters, not shards).
  const source = new THREE.CylinderGeometry(r * 0.92, r * 1.05, CUT_SEGMENT_HEIGHT, 10);
  return buildFractureTemplate(source, TREE_BARK_MATERIAL, TREE_WOOD_MATERIAL, fragmentCount, seed);
}
