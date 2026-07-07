// Shared normalizer for standalone GLB assets (Meshy-generated props/items)
// into drop-in scene-graph templates. items.glb/props.glb nodes are authored
// base-origin (minY = 0, centered on x/z); a standalone GLB is typically
// modeled centered on the origin at an arbitrary scale, so this re-seats it to
// match that invariant before it's cloned into a pool.

import * as THREE from "three";

/**
 * Normalizes a standalone GLB scene into a template ready to clone: x/z
 * centered, base sitting at y=0, every mesh flagged castShadow. Optional
 * rescale (Meshy outputs arbitrary scale):
 *  - `opts.maxSizeM` scales so the LARGEST of x/y/z spans that many meters —
 *    orientation-independent, the right choice when the model's upright axis
 *    isn't guaranteed (most loot items).
 *  - `opts.heightM` scales by the y-extent to stand that many meters tall —
 *    use only when the model is known upright (e.g. the crate).
 * maxSizeM wins if both are given; omit both to re-seat without rescaling. The
 * result is wrapped in a Group so the per-clone transform survives `.clone()`.
 * Returns null when the scene has no mesh geometry (caller → primitive).
 */
export function normalizeModel(
  scene: THREE.Group,
  opts: { heightM?: number; maxSizeM?: number } = {},
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
  if (opts.maxSizeM !== undefined) {
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    wrap.scale.setScalar(opts.maxSizeM / maxDim);
  } else if (opts.heightM !== undefined) {
    wrap.scale.setScalar(size.y > 0 ? opts.heightM / size.y : 1);
  }
  return wrap;
}
