// Scatter props: rocks, sandbag walls, barriers and tents from props.glb,
// drawn with one InstancedMesh per (world cell x prop kind x GLB primitive)
// via chunkedDressing.ts so three frustum-culls the scatter per chunk in both
// the camera and shadow passes. Geometry and materials come straight from the
// shared GLTF cache (never cloned per instance); matrices are written once per
// world on mount — fully static. Placement comes from world.props
// (seed-deterministic worldgen), grounded via world.groundHeight.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingBucket,
  type DressingEntry,
} from "./chunkedDressing";

const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);

/** GLB node names double as the prop kind discriminant. */
const PROP_KINDS = ["rock_a", "rock_b", "rock_c", "sandbag_wall", "barrier", "tent"] as const;
type PropKind = (typeof PROP_KINDS)[number];

function isRock(kind: PropKind): boolean {
  return kind === "rock_a" || kind === "rock_b" || kind === "rock_c";
}

/** Single cast site bridging the parallel worldgen slice: World.props is not
 * on the shared interface yet but will exist at integration. */
interface PropPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /**
   * The mesh's transform inside props.glb, in the loaded scene's frame.
   *
   * NOT identity: `models:export` runs gltf-transform's meshopt pass, which
   * QUANTIZES positions to normalized int16 and compensates with a per-node
   * scale/translation — so the raw geometry is in a quantized space, not
   * placement space. Dropping this matrix renders every prop at the wrong
   * size. Folded into the INSTANCE matrix, never baked into the geometry
   * (applyMatrix4 on a normalized-int16 position attribute would write floats
   * into an Int16Array and corrupt it). Same hazard as BuildingTrim.
   */
  matrix: THREE.Matrix4;
}

/** Pulls shared geometry + material pairs out of a GLB node's mesh children
 * (multi-primitive nodes load as Groups of Meshes), each with its in-GLB
 * transform. Nothing is cloned. */
function extractParts(scene: THREE.Group, name: string): PropPart[] {
  const node = scene.getObjectByName(name);
  if (!node) return [];
  scene.updateMatrixWorld(true);
  const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const parts: PropPart[] = [];
  node.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    parts.push({
      geometry: obj.geometry,
      material: obj.material,
      matrix: new THREE.Matrix4().multiplyMatrices(sceneInv, obj.matrixWorld),
    });
  });
  return parts;
}

const dummy = new THREE.Object3D();

function buildScatter(scene: THREE.Group, world: World): ChunkedDressing {
  const buckets: DressingBucket[] = [];
  const kindBuckets = new Map<PropKind, { ids: number[]; parts: PropPart[] }>();
  for (const kind of PROP_KINDS) {
    const parts = extractParts(scene, kind);
    const ids = parts.map((part) => {
      buckets.push({
        geometry: part.geometry,
        material: part.material,
        castShadow: true,
        // Rocks are big grounded lumps — they should catch tree/building shadows.
        receiveShadow: isRock(kind),
      });
      return buckets.length - 1;
    });
    kindBuckets.set(kind, { ids, parts });
  }

  const entries: DressingEntry[] = [];
  for (const prop of world.props) {
    const kind = kindBuckets.get(prop.kind);
    if (!kind || kind.ids.length === 0) continue;
    dummy.position.set(prop.x, world.groundHeight(prop.x, prop.z), prop.z);
    dummy.rotation.set(0, prop.yaw, 0);
    dummy.scale.setScalar(prop.scale);
    dummy.updateMatrix();
    // placement * part-local — the GLB node transform rides the instance
    // matrix (see PropPart.matrix).
    kind.parts.forEach((part, i) => {
      entries.push({
        bucket: kind.ids[i],
        matrix: new THREE.Matrix4().multiplyMatrices(dummy.matrix, part.matrix),
      });
    });
  }
  return buildChunkedDressing(buckets, entries);
}

export function Scatter(): ReactElement | null {
  const gltf = useGLTF(PROPS_MODEL_URL);
  const world = clientWorld.world;

  const scatter = useMemo(() => {
    if (!world) return null;
    return buildScatter(gltf.scene, world);
  }, [gltf.scene, world]);

  useEffect(() => {
    if (!scatter) return;
    // Frees instance buffers only — geometry/materials belong to the
    // shared GLTF cache and must outlive this component.
    return () => scatter.dispose();
  }, [scatter]);

  useFrame((state) => {
    scatter?.updateVisibility(state.camera.position.x, state.camera.position.z);
  });

  if (!scatter) return null;
  return <primitive object={scatter.group} />;
}
