// Pure Three Pinata template builder. Fracturing happens once during browser
// idle time; break events only reuse the resulting geometry.

import { DestructibleMesh, FractureOptions } from "@dgreenheck/three-pinata";
import * as THREE from "three";
import {
  BARREL_GEOMETRY,
  BARREL_INNER_MATERIAL,
  BARREL_MATERIAL,
} from "./physicsBodyAssets";

export const BARREL_FRACTURE_SEEDS = [1301, 7331, 19001] as const;
export const BARREL_FRAGMENT_COUNTS = [6, 8] as const;
export type BarrelFragmentCount = (typeof BARREL_FRAGMENT_COUNTS)[number];

export interface BarrelFragmentTemplate {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  radius: number;
}

export function buildBarrelFractureTemplate(
  fragmentCount: BarrelFragmentCount,
  seed: number,
): BarrelFragmentTemplate[] {
  const sourceGeometry = BARREL_GEOMETRY.clone();
  const source = new DestructibleMesh(
    sourceGeometry,
    BARREL_MATERIAL,
    BARREL_INNER_MATERIAL,
  );
  source.updateMatrixWorld(true);
  const fragments = source.fracture(
    new FractureOptions({
      fractureMethod: "voronoi",
      fragmentCount,
      seed,
      voronoiOptions: { mode: "3D" },
    }),
  );
  sourceGeometry.dispose();

  return fragments.map((fragment) => {
    fragment.geometry.computeBoundingSphere();
    return {
      geometry: fragment.geometry,
      center: fragment.position.clone(),
      radius: fragment.geometry.boundingSphere?.radius ?? 0.1,
    };
  });
}
