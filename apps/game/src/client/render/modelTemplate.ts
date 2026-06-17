// Shared normalizer for standalone GLB assets (Meshy-generated props/items)
// into drop-in scene-graph templates. items.glb/props.glb nodes are authored
// base-origin (minY = 0, centered on x/z); a standalone GLB is typically
// modeled centered on the origin at an arbitrary scale, so this re-seats it to
// match that invariant before it's cloned into a pool.

import * as THREE from "three";

/**
 * Normalizes a standalone GLB scene into a template ready to clone: x/z
 * centered, base sitting at y=0, every mesh flagged castShadow. With
 * `opts.heightM` the model is uniformly scaled to stand that many meters tall
 * (use when the GLB was NOT exported at real-world scale); omit it when scale
 * is already baked in and only re-seating is needed. The result is wrapped in
 * a Group so the per-clone transform survives `.clone()`. Returns null when the
 * scene has no mesh geometry, letting the caller fall back to a primitive.
 */
export function normalizeModel(
  scene: THREE.Group,
  opts: { heightM?: number } = {},
): THREE.Object3D | null {
  const model = scene.clone(true);
  let hasMesh = false;
  model.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      hasMesh = true;
    }
  });
  if (!hasMesh) return null;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Recenter x/z to origin and drop the base to y=0; the wrapper then scales
  // about the origin so the base stays planted at y=0.
  model.position.set(-center.x, -box.min.y, -center.z);
  const wrap = new THREE.Group();
  wrap.add(model);
  if (opts.heightM !== undefined) {
    wrap.scale.setScalar(size.y > 0 ? opts.heightM / size.y : 1);
  }
  return wrap;
}
