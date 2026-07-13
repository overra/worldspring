// Spatial-cell instancing for static world dressing (trees, scatter, trim,
// containers, structures, stumps): the dressing renderers used to draw ONE
// world-spanning InstancedMesh per bucket with frustumCulled=false — an
// InstancedMesh bounding sphere ignores instance transforms unless explicitly
// recomputed, so culling had to be off, and every instance was vertex-processed
// every frame in BOTH the camera pass and the shadow pass regardless of view
// (~190K tris for the standard 700-tree forest alone; the huge tier scales
// that 16x). This module partitions instances into one InstancedMesh per
// (world cell x bucket) with a correct per-chunk bounding sphere, so three
// culls each chunk independently PER CAMERA — the shadow pass tests against
// the LIGHT camera's frustum (WebGLShadowMap), which is why there is
// deliberately NO CPU-side view-frustum prefilter here: a chunk behind the
// player but inside the camera-following shadow box must still cast.
//
// On top of three's per-camera frustum test, updateVisibility() radius-gates
// chunks with hysteresis: chunks fully past the fog far (day 320m) render as
// pure fog color anyway, and hiding them removes them from BOTH passes. On
// the standard 800m world this trims coast-to-coast views; on large/huge
// tiers it is what bounds vertex load to the player's surroundings at all.
//
// React-free leaf module (the terrainChunks.ts precedent) so the .mjs harness
// (scripts/chunked-dressing.mjs, CI-run via `pnpm test`) drives the real code.

import * as THREE from "three";

/** World-cell edge (m). Bigger cells = fewer draw calls but coarser culling;
 * 256m keeps the standard world at <=16 cells while a 352m radius on huge
 * keeps ~9-12 cells live. Draw calls scale with (live cells x buckets). */
export const DRESSING_CHUNK_SIZE = 256;
/** Chunk-center hide radius (m). Past the day fog far (320) everything is
 * fog-colored; +32 covers the rain/night tightening never being the gate and
 * keeps the constant static (hysteresis + shadow stability want ONE radius,
 * not a weather-reactive one). Chunk extent is handled per-mesh via its
 * bounding-sphere radius, not baked into this constant. */
export const DRESSING_DRAW_RADIUS = 352;
/** Enter/exit dead band (m) around the radius — the terrainChunks pattern. */
export const DRESSING_HYSTERESIS = 16;
/** Bounding-sphere padding (m) — covers float slop; dressing never sways. */
const SPHERE_SLACK = 0.5;

export interface DressingBucket {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface DressingEntry {
  /** Index into the buckets array passed to buildChunkedDressing. */
  bucket: number;
  /** World-space instance matrix. Read (copied into the GPU attribute) at
   * build time — give each entry its own Matrix4; entries for the same
   * logical object (e.g. a tree's branches + leaves parts) may share one. */
  matrix: THREE.Matrix4;
  /** Optional per-instance color (allocates instanceColor for the mesh). */
  color?: THREE.Color;
  /** Caller's stable id (tree index, planted id) for later refSlots lookups. */
  ref?: number;
}

export interface InstanceSlot {
  mesh: THREE.InstancedMesh;
  slot: number;
}

export interface ChunkedDressing {
  group: THREE.Group;
  meshes: THREE.InstancedMesh[];
  /** ref -> every (mesh, slot) that ref's entries landed in. Mutations write
   * matrices via setMatrixAt + instanceMatrix.needsUpdate; NEVER recompute a
   * mesh bounding sphere afterwards — a zero-scale matrix sits at the world
   * origin, and a recompute would union that origin point into the sphere.
   * The stale pre-mutation sphere is conservative and correct. */
  refSlots: Map<number, InstanceSlot[]>;
  /** Radius-gate chunk visibility around (camX, camZ) with hysteresis. */
  updateVisibility(camX: number, camZ: number): void;
  /** Frees instance buffers only — geometry/materials belong to callers. */
  dispose(): void;
}

const WHITE = new THREE.Color(1, 1, 1);

/** Per-mesh visibility bookkeeping (module-internal). */
interface ChunkMeshState {
  mesh: THREE.InstancedMesh;
  /** World-space chunk sphere (== mesh.boundingSphere; matrices are world). */
  centerX: number;
  centerZ: number;
  radius: number;
  shown: boolean;
}

/**
 * Partition world-space instances into per-(cell x bucket) InstancedMeshes
 * with real bounding spheres, frustumCulled=true, at the scene origin.
 * Build-once per world / per version bump; callers dispose + rebuild on
 * their existing version counters.
 */
export function buildChunkedDressing(
  buckets: readonly DressingBucket[],
  entries: readonly DressingEntry[],
  chunkSize: number = DRESSING_CHUNK_SIZE,
): ChunkedDressing {
  // Group entry indices by (cell, bucket). String keys: dressing coordinates
  // are unbounded (planted trees), unlike terrain's fixed centered grid.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const x = e.matrix.elements[12];
    const z = e.matrix.elements[14];
    const key = `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}|${e.bucket}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(i);
  }

  const group = new THREE.Group();
  // Chunk meshes never move; skip their per-frame local recompose (their
  // matrix stays identity — instance matrices carry the world transforms).
  group.matrixAutoUpdate = false;
  const meshes: THREE.InstancedMesh[] = [];
  const refSlots = new Map<number, InstanceSlot[]>();
  const states: ChunkMeshState[] = [];

  for (const indices of groups.values()) {
    const bucket = buckets[entries[indices[0]].bucket];
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, indices.length);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    const needsColor = indices.some((i) => entries[i].color !== undefined);
    indices.forEach((i, slot) => {
      const e = entries[i];
      mesh.setMatrixAt(slot, e.matrix);
      if (needsColor) mesh.setColorAt(slot, e.color ?? WHITE);
      if (e.ref !== undefined) {
        let slots = refSlots.get(e.ref);
        if (!slots) {
          slots = [];
          refSlots.set(e.ref, slots);
        }
        slots.push({ mesh, slot });
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // THE point of chunking: a real per-chunk sphere (instance-transform
    // aware) so three's per-camera frustum test works — camera AND shadow.
    mesh.computeBoundingSphere();
    const sphere = mesh.boundingSphere;
    if (sphere) sphere.radius += SPHERE_SLACK;
    mesh.frustumCulled = true;
    group.add(mesh);
    meshes.push(mesh);
    states.push({
      mesh,
      centerX: sphere ? sphere.center.x : 0,
      centerZ: sphere ? sphere.center.z : 0,
      radius: sphere ? sphere.radius : 0,
      shown: true,
    });
  }

  return {
    group,
    meshes,
    refSlots,
    updateVisibility(camX: number, camZ: number): void {
      for (const s of states) {
        // Distance to the chunk sphere's EDGE, so big chunks hide only when
        // everything in them is past the radius.
        const dx = s.centerX - camX;
        const dz = s.centerZ - camZ;
        const edge = Math.sqrt(dx * dx + dz * dz) - s.radius;
        // Hysteresis: flip only past the dead band on each side.
        if (s.shown && edge > DRESSING_DRAW_RADIUS + DRESSING_HYSTERESIS) {
          s.shown = false;
          s.mesh.visible = false;
        } else if (!s.shown && edge < DRESSING_DRAW_RADIUS - DRESSING_HYSTERESIS) {
          s.shown = true;
          s.mesh.visible = true;
        }
      }
    },
    dispose(): void {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.dispose(); // instance attributes only
      }
      meshes.length = 0;
      states.length = 0;
      refSlots.clear();
    },
  };
}
