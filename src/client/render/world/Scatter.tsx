// Scatter props: rocks, sandbag walls, barriers and tents from props.glb,
// drawn with one InstancedMesh per (prop kind x GLB primitive) — rocks are
// single-prim, sandbag_wall 2, barrier 1, tent 3, so the whole scatter set is
// a handful of instanced draws. Geometry and materials come straight from the
// shared GLTF cache (never cloned per instance); matrices are written once per
// world on mount — fully static, no per-frame work. Placement comes from
// world.props (seed-deterministic worldgen), grounded via world.groundHeight.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { World, WorldProp } from "@/shared/world";
import { clientWorld } from "@/client/runtime";

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
}

/** Pulls shared geometry + material pairs out of a GLB node's mesh children
 * (multi-primitive nodes load as Groups of Meshes). Nothing is cloned. */
function extractParts(scene: THREE.Group, name: string): PropPart[] {
  const node = scene.getObjectByName(name);
  if (!node) return [];
  const parts: PropPart[] = [];
  node.traverse((obj) => {
    if (obj instanceof THREE.Mesh) parts.push({ geometry: obj.geometry, material: obj.material });
  });
  return parts;
}

const dummy = new THREE.Object3D();

interface ScatterBuild {
  root: THREE.Group;
  meshes: THREE.InstancedMesh[];
}

function buildScatter(scene: THREE.Group, world: World): ScatterBuild {
  const buckets = new Map<PropKind, WorldProp[]>();
  for (const prop of world.props) {
    const list = buckets.get(prop.kind);
    if (list) list.push(prop);
    else buckets.set(prop.kind, [prop]);
  }

  const root = new THREE.Group();
  const meshes: THREE.InstancedMesh[] = [];
  for (const kind of PROP_KINDS) {
    const instances = buckets.get(kind);
    if (!instances || instances.length === 0) continue;
    for (const part of extractParts(scene, kind)) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, instances.length);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      // Rocks are big grounded lumps — they should catch tree/building shadows.
      mesh.receiveShadow = isRock(kind);
      instances.forEach((prop, slot) => {
        dummy.position.set(prop.x, world.groundHeight(prop.x, prop.z), prop.z);
        dummy.rotation.set(0, prop.yaw, 0);
        dummy.scale.setScalar(prop.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      root.add(mesh);
      meshes.push(mesh);
    }
  }
  return { root, meshes };
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
    return () => {
      // Frees instance buffers only — geometry/materials belong to the
      // shared GLTF cache and must outlive this component.
      for (const mesh of scatter.meshes) mesh.dispose();
    };
  }, [scatter]);

  if (!scatter) return null;
  return <primitive object={scatter.root} />;
}
