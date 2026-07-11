// Generic Three Pinata template builder — the shared core behind the barrel
// and tree-cut debris (barrelFracture.ts / treeFracture.ts). Fracturing runs
// once during browser idle time; break/treeCut events only reuse the resulting
// geometry. Source geometry MUST be closed/watertight and non-overlapping
// (never EZ-Tree meshes — their sections are open and overlapping).

import { DestructibleMesh, FractureOptions } from "@dgreenheck/three-pinata";
import * as THREE from "three";

export interface FragmentTemplate {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  radius: number;
}

/** Voronoi-fracture `source` into `fragmentCount` pieces. The two materials
 * define the group split every fragment carries: index 0 = original surface,
 * index 1 = inner cut faces. `source` is consumed (disposed) — pass a clone. */
export function buildFractureTemplate(
  source: THREE.BufferGeometry,
  outerMaterial: THREE.Material,
  innerMaterial: THREE.Material,
  fragmentCount: number,
  seed: number,
): FragmentTemplate[] {
  const mesh = new DestructibleMesh(source, outerMaterial, innerMaterial);
  mesh.updateMatrixWorld(true);
  const fragments = mesh.fracture(
    new FractureOptions({
      fractureMethod: "voronoi",
      fragmentCount,
      seed,
      voronoiOptions: { mode: "3D" },
    }),
  );
  source.dispose();

  return fragments.map((fragment) => {
    fragment.geometry.computeBoundingSphere();
    return {
      geometry: fragment.geometry,
      center: fragment.position.clone(),
      radius: fragment.geometry.boundingSphere?.radius ?? 0.1,
    };
  });
}
