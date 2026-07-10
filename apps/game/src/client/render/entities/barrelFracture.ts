// Barrel fracture templates — the doc 13 M3 debris, now a thin species of the
// shared fracture.ts builder. Fracturing happens once during browser idle
// time; break events only reuse the resulting geometry.

import { buildFractureTemplate, type FragmentTemplate } from "./fracture";
import {
  BARREL_GEOMETRY,
  BARREL_INNER_MATERIAL,
  BARREL_MATERIAL,
} from "./physicsBodyAssets";

export const BARREL_FRACTURE_SEEDS = [1301, 7331, 19001] as const;
export const BARREL_FRAGMENT_COUNTS = [6, 8] as const;
export type BarrelFragmentCount = (typeof BARREL_FRAGMENT_COUNTS)[number];

export type BarrelFragmentTemplate = FragmentTemplate;

export function buildBarrelFractureTemplate(
  fragmentCount: BarrelFragmentCount,
  seed: number,
): BarrelFragmentTemplate[] {
  return buildFractureTemplate(
    BARREL_GEOMETRY.clone(),
    BARREL_MATERIAL,
    BARREL_INNER_MATERIAL,
    fragmentCount,
    seed,
  );
}
