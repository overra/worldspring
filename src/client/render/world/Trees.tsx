// Forest: two low-poly variants drawn with InstancedMesh per part.
// Conifer = trunk + two stacked cones, oak = trunk + olive icosahedron blob.
// Matrices are written once per world in useLayoutEffect — fully static.

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import type { Tree } from "@/shared/world";
import { clientWorld } from "@/client/runtime";

const TRUNK_COLOR = "#5d4630";
const CONIFER_COLOR = "#2f4a2d";
const OAK_COLOR = "#6b7440";

// Base proportions are authored for an 8m tree; everything scales by height/8.
const BASE_HEIGHT = 8;
// Golden-angle increment gives a deterministic, non-repeating yaw per index.
const YAW_STEP = 2.3999632;

interface TreeInstance {
  tree: Tree;
  /** Index in world.trees — drives deterministic rotation variance. */
  index: number;
}

const dummy = new THREE.Object3D();

function setMatrix(
  mesh: THREE.InstancedMesh,
  slot: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw: number,
  tilt: number,
): void {
  dummy.position.set(x, y, z);
  dummy.rotation.set(tilt, yaw, -tilt);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  mesh.setMatrixAt(slot, dummy.matrix);
}

export function Trees(): ReactElement | null {
  const world = clientWorld.world;

  const split = useMemo(() => {
    if (!world) return null;
    const all: TreeInstance[] = world.trees.map((tree, index) => ({ tree, index }));
    return {
      all,
      conifers: all.filter((t) => t.tree.kind === "conifer"),
      oaks: all.filter((t) => t.tree.kind === "oak"),
    };
  }, [world]);

  const assets = useMemo(() => {
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 4.6, 6);
    trunkGeo.translate(0, 2.3, 0); // origin at trunk base
    const coneGeo = new THREE.ConeGeometry(1, 1, 7);
    coneGeo.translate(0, 0.5, 0); // unit cone, base at origin
    const blobGeo = new THREE.IcosahedronGeometry(1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, flatShading: true });
    const coniferMat = new THREE.MeshStandardMaterial({ color: CONIFER_COLOR, flatShading: true });
    const oakMat = new THREE.MeshStandardMaterial({ color: OAK_COLOR, flatShading: true });
    return { trunkGeo, coneGeo, blobGeo, trunkMat, coniferMat, oakMat };
  }, []);

  useEffect(() => {
    return () => {
      assets.trunkGeo.dispose();
      assets.coneGeo.dispose();
      assets.blobGeo.dispose();
      assets.trunkMat.dispose();
      assets.coniferMat.dispose();
      assets.oakMat.dispose();
    };
  }, [assets]);

  const trunksRef = useRef<THREE.InstancedMesh>(null);
  const coneRef = useRef<THREE.InstancedMesh>(null);
  const blobRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    if (!split) return;
    const trunks = trunksRef.current;
    const cones = coneRef.current;
    const blobs = blobRef.current;
    if (!trunks || !cones || !blobs) return;

    split.all.forEach(({ tree, index }, slot) => {
      const s = tree.height / BASE_HEIGHT;
      const yaw = (index * YAW_STEP) % (Math.PI * 2);
      const thick = tree.kind === "oak" ? 1.25 : 1; // oaks get stockier trunks
      setMatrix(trunks, slot, tree.x, tree.groundY, tree.z, s * thick, s, s * thick, yaw, 0);
    });
    trunks.instanceMatrix.needsUpdate = true;

    split.conifers.forEach(({ tree, index }, slot) => {
      const s = tree.height / BASE_HEIGHT;
      const yaw = (index * YAW_STEP) % (Math.PI * 2);
      // Lower wide cone + upper narrow cone; top lands at groundY + height.
      setMatrix(cones, slot * 2, tree.x, tree.groundY + 2.1 * s, tree.z, 2.0 * s, 3.9 * s, 2.0 * s, yaw, 0);
      setMatrix(cones, slot * 2 + 1, tree.x, tree.groundY + 4.7 * s, tree.z, 1.45 * s, 3.3 * s, 1.45 * s, yaw, 0);
    });
    cones.instanceMatrix.needsUpdate = true;

    split.oaks.forEach(({ tree, index }, slot) => {
      const s = tree.height / BASE_HEIGHT;
      const yaw = (index * YAW_STEP) % (Math.PI * 2);
      const tilt = Math.sin(index * 1.7) * 0.08; // slight deterministic lean
      setMatrix(blobs, slot, tree.x, tree.groundY + 5.1 * s, tree.z, 2.4 * s, 2.1 * s, 2.4 * s, yaw, tilt);
    });
    blobs.instanceMatrix.needsUpdate = true;
  }, [split]);

  if (!split) return null;
  return (
    <group>
      <instancedMesh
        ref={trunksRef}
        args={[assets.trunkGeo, assets.trunkMat, split.all.length]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={coneRef}
        args={[assets.coneGeo, assets.coniferMat, split.conifers.length * 2]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={blobRef}
        args={[assets.blobGeo, assets.oakMat, split.oaks.length]}
        frustumCulled={false}
      />
    </group>
  );
}
