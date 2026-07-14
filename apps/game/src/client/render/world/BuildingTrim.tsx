// Building trim kit: door frames, window frames, corner posts, fascia strips
// and chimneys from building_kit.glb, dressed onto every world building. Same
// structure as Scatter.tsx — one InstancedMesh per (piece kind x GLB
// primitive), geometry/materials straight from the shared GLTF cache, all
// matrices written once on mount. Fully static: no per-frame work.
//
// Placement is derived from the deterministic worldgen Building records; any
// per-building variation (window offsets, chimney corner) comes from a seeded
// rng hashed off building.id — never Math.random().

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { FOUNDATION_DEPTH, type Building, type World } from "@worldspring/shared/world";
import { createRng, hashString } from "@worldspring/shared/rng";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingBucket,
  type DressingEntry,
} from "./chunkedDressing";

const KIT_MODEL_URL = "/models/building_kit.glb";
useGLTF.preload(KIT_MODEL_URL);

/** GLB node names double as the piece kind discriminant. */
const PIECE_KINDS = ["door_frame", "window_frame", "corner_post", "fascia_strip", "chimney"] as const;
type PieceKind = (typeof PIECE_KINDS)[number];

/** Mirrors the (unexported) DOOR_WIDTH in shared/world.ts buildWalls — the
 * door gap every wall layout carves is this wide and centered. The kit's
 * door_frame models a 1.6m opening; x-scale bridges any mismatch. */
const DOOR_WIDTH = 1.6;
const KIT_DOOR_OPENING = 1.6;

// Render-only cosmetic offsets (not gameplay tunables — same category as
// Buildings.tsx's FLOOR_INSET).
/** Frames sit this far proud of the wall face so they read as applied trim. */
const TRIM_PROUD = 0.02;
/** Fascia is fully outside the wall plane (strip half-depth is 0.05). */
const FASCIA_PROUD = 0.06;
/** Strip is y-centered, 0.15 tall — drop the center so it tucks under the roofline. */
const FASCIA_HALF_HEIGHT = 0.075;
/** Extra length past each wall end so strips wrap the corner posts. */
const FASCIA_OVERHANG = 0.12;
/** window_frame origin is at the FRAME CENTER (unlike every other piece). */
const WINDOW_CENTER_Y = 1.3;
/** No window may land closer than this to the door gap segment. */
const WINDOW_DOOR_CLEARANCE = 1.2;
/** Keep windows clear of corners: frame half-width 0.55 + post + breathing room. */
const WINDOW_EDGE_MARGIN = 1.0;
// Corner posts span the SAME vertical extent as the walls they trim: from the
// wall foundation (floorY - FOUNDATION_DEPTH, imported from shared/world.ts so
// it can never drift) up to the roofline. A shallower skirt left the post
// hanging in mid-air on the downhill side of a slope while the wall beside it
// carried on down into the terrain. The buried portion is hidden by the ground
// on flat land, exactly as the wall's own foundation is.
/** Chimney center distance in from the roof corner. */
const CHIMNEY_INSET = 0.9;

/** Outward wall normal per doorSide index (0:+Z 1:-Z 2:+X 3:-X). */
const SIDE_NORMAL: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];
/** rotation.y aligning a piece's local +Z (its front) with the outward normal.
 * (Yaw 0 = local +Z = world +Z; the shared yaw-0-faces--Z convention is for
 * character forward vectors, not Object3D axis alignment.) */
const SIDE_YAW: readonly number[] = [0, Math.PI, Math.PI / 2, -Math.PI / 2];

interface TrimInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
}

interface TrimPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /**
   * The mesh's transform inside the kit GLB, in the loaded scene's frame.
   *
   * NOT identity, and must not be assumed so: `models:export` runs
   * gltf-transform's meshopt pass, which QUANTIZES positions to normalized
   * int16 and compensates with a per-node scale/translation. The raw geometry
   * is therefore in a unit-ish quantized space, not placement space — dropping
   * this matrix renders every piece at the wrong size (a 0.5-scaled
   * fascia_strip came out 2x, spearing out past the roofline).
   *
   * Folded into the INSTANCE matrix rather than baked into the geometry:
   * BufferGeometry.applyMatrix4 on a normalized-int16 position attribute would
   * write floats back into an Int16Array and corrupt the mesh.
   */
  matrix: THREE.Matrix4;
}

/** Pulls shared geometry + material pairs out of a GLB node's mesh children
 * (multi-primitive nodes load as Groups of Meshes). Nothing is cloned. */
function extractParts(scene: THREE.Group, name: string): TrimPart[] {
  const node = scene.getObjectByName(name);
  if (!node) return [];
  // Read each mesh's transform relative to the loaded scene (see TrimPart.matrix).
  scene.updateMatrixWorld(true);
  const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const parts: TrimPart[] = [];
  node.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    // The kit's window pane ("glass") would block the now-real opening —
    // windows are see-through gameplay surfaces, so the pane stays out.
    const mat = obj.material;
    if (!Array.isArray(mat) && mat.name === "pane_dark") return;
    parts.push({
      geometry: obj.geometry,
      material: mat,
      matrix: new THREE.Matrix4().multiplyMatrices(sceneInv, obj.matrixWorld),
    });
  });
  return parts;
}

function distToSegment2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

function isWideKind(b: Building): boolean {
  return b.kind === "barn" || b.kind === "hangar" || b.kind === "barracks";
}

function collectBuilding(
  b: Building,
  seed: number,
  out: Map<PieceKind, TrimInstance[]>,
): void {
  const rng = createRng(hashString(`trim|${seed}|${b.id}`));
  const push = (kind: PieceKind, inst: TrimInstance): void => {
    const list = out.get(kind);
    if (list) list.push(inst);
    else out.set(kind, [inst]);
  };

  const roofY = b.floorY + b.wallHeight;

  // Door gap segment (gap is centered on the doorSide wall, DOOR_WIDTH wide).
  const [dnx, dnz] = SIDE_NORMAL[b.doorSide];
  const dtx = Math.abs(dnz); // wall tangent direction
  const dtz = Math.abs(dnx);
  const dfx = b.cx + dnx * b.halfW;
  const dfz = b.cz + dnz * b.halfD;
  const gapAx = dfx - dtx * (DOOR_WIDTH / 2);
  const gapAz = dfz - dtz * (DOOR_WIDTH / 2);
  const gapBx = dfx + dtx * (DOOR_WIDTH / 2);
  const gapBz = dfz + dtz * (DOOR_WIDTH / 2);

  // --- Door frame: base-center origin, proud of the door wall face ---
  push("door_frame", {
    x: b.cx + dnx * (b.halfW + TRIM_PROUD),
    y: b.floorY,
    z: b.cz + dnz * (b.halfD + TRIM_PROUD),
    yaw: SIDE_YAW[b.doorSide],
    sx: DOOR_WIDTH / KIT_DOOR_OPENING,
    sy: 1,
    sz: 1,
  });

  // --- Window frames: one per REAL opening (building.windows is the shared
  // worldgen source that also cuts the wall geometry — frame and hole can
  // never disagree). Slight overscale so the border hides the cut faces. ---
  for (const win of b.windows) {
    const [nx, nz] = SIDE_NORMAL[win.side];
    const tx = Math.abs(nz);
    const tz = Math.abs(nx);
    push("window_frame", {
      x: b.cx + nx * (b.halfW + TRIM_PROUD) + tx * win.offset,
      y: b.floorY + WINDOW_CENTER_Y,
      z: b.cz + nz * (b.halfD + TRIM_PROUD) + tz * win.offset,
      yaw: SIDE_YAW[win.side],
      sx: 1.12,
      sy: 1.12,
      sz: 1,
    });
  }

  // --- Corner posts: unit-height base origin, stretched foundation-to-roofline ---
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      push("corner_post", {
        x: b.cx + sx * b.halfW,
        y: b.floorY - FOUNDATION_DEPTH,
        z: b.cz + sz * b.halfD,
        yaw: 0,
        sx: 1,
        sy: b.wallHeight + FOUNDATION_DEPTH,
        sz: 1,
      });
    }
  }

  // --- Fascia strips: unit-length center origin, x-scaled to wall length ---
  for (let side = 0; side < 4; side++) {
    const [nx, nz] = SIDE_NORMAL[side];
    const length = (side < 2 ? b.halfW : b.halfD) * 2 + FASCIA_OVERHANG * 2;
    push("fascia_strip", {
      x: b.cx + nx * (b.halfW + FASCIA_PROUD),
      y: roofY - FASCIA_HALF_HEIGHT,
      z: b.cz + nz * (b.halfD + FASCIA_PROUD),
      yaw: SIDE_YAW[side],
      sx: length,
      sy: 1,
      sz: 1,
    });
  }

  // --- Chimney: houses only (wilderness cabins are kind "house" too) ---
  if (b.kind === "house") {
    const cornerX = rng.chance(0.5) ? 1 : -1;
    const cornerZ = rng.chance(0.5) ? 1 : -1;
    push("chimney", {
      x: b.cx + cornerX * (b.halfW - CHIMNEY_INSET),
      y: roofY,
      z: b.cz + cornerZ * (b.halfD - CHIMNEY_INSET),
      yaw: 0,
      sx: 1,
      sy: 1,
      sz: 1,
    });
  }
}

const dummy = new THREE.Object3D();

function buildTrim(scene: THREE.Group, world: World): ChunkedDressing {
  const instances = new Map<PieceKind, TrimInstance[]>();
  for (const building of world.buildings) collectBuilding(building, world.seed, instances);

  const buckets: DressingBucket[] = [];
  const entries: DressingEntry[] = [];
  for (const kind of PIECE_KINDS) {
    const list = instances.get(kind);
    if (!list || list.length === 0) continue;
    const parts = extractParts(scene, kind);
    if (parts.length === 0) {
      console.warn(`BuildingTrim: node "${kind}" missing from ${KIT_MODEL_URL} — skipping piece`);
      continue;
    }
    const ids = parts.map((part) => {
      buckets.push({
        geometry: part.geometry,
        material: part.material,
        castShadow: true,
        receiveShadow: false, // thin trim — receiving shadows just shimmers
      });
      return buckets.length - 1;
    });
    for (const inst of list) {
      dummy.position.set(inst.x, inst.y, inst.z);
      dummy.rotation.set(0, inst.yaw, 0);
      dummy.scale.set(inst.sx, inst.sy, inst.sz);
      dummy.updateMatrix();
      // placement * part-local. Each part carries its own GLB node transform,
      // so parts of one piece no longer share a matrix (see TrimPart.matrix).
      parts.forEach((part, i) => {
        entries.push({
          bucket: ids[i],
          matrix: new THREE.Matrix4().multiplyMatrices(dummy.matrix, part.matrix),
        });
      });
    }
  }
  return buildChunkedDressing(buckets, entries);
}

export function BuildingTrim(): ReactElement | null {
  const gltf = useGLTF(KIT_MODEL_URL);
  const world = clientWorld.world;

  const trim = useMemo(() => {
    if (!world) return null;
    return buildTrim(gltf.scene, world);
  }, [gltf.scene, world]);

  useEffect(() => {
    if (!trim) return;
    // Frees instance buffers only — geometry/materials belong to the
    // shared GLTF cache and must outlive this component.
    return () => trim.dispose();
  }, [trim]);

  useFrame((state) => {
    trim?.updateVisibility(state.camera.position.x, state.camera.position.z);
  });

  if (!trim) return null;
  return <primitive object={trim.group} />;
}
