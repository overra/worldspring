// Bodies left behind by dead players and zombies: pooled prone low-poly
// figures lying on the ground, scavengeable via the pickup prompt. Static —
// positions come straight from snapshots, no interpolation needed.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 32;
const GROUND_OFFSET = 0.02;

interface CorpseColors {
  shirt: string;
  pants: string;
  skin: string;
}

const PLAYER_COLORS: CorpseColors = { shirt: "#5a6a7a", pants: "#3c3c40", skin: "#b08d6a" };
const ZOMBIE_COLORS: CorpseColors = { shirt: "#4a4f42", pants: "#3a3e36", skin: "#6a8a5a" };

interface CorpseRig {
  root: THREE.Group;
  shirtMat: THREE.MeshLambertMaterial;
  pantsMat: THREE.MeshLambertMaterial;
  skinMat: THREE.MeshLambertMaterial;
  /** "player" | "zombie" currently applied (avoids re-tinting every frame). */
  appliedKind: string | null;
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.MeshLambertMaterial,
  x: number,
  y: number,
  z: number,
  rotY = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.castShadow = true;
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  return mesh;
}

/** A figure lying on its back: head toward -Z, legs toward +Z in local space. */
function createRig(): CorpseRig {
  const shirtMat = new THREE.MeshLambertMaterial({ color: PLAYER_COLORS.shirt });
  const pantsMat = new THREE.MeshLambertMaterial({ color: PLAYER_COLORS.pants });
  const skinMat = new THREE.MeshLambertMaterial({ color: PLAYER_COLORS.skin });

  const root = new THREE.Group();
  root.add(box(0.52, 0.2, 0.66, shirtMat, 0, 0.12, 0)); // torso
  root.add(box(0.3, 0.18, 0.3, skinMat, 0, 0.11, -0.49)); // head
  root.add(box(0.14, 0.14, 0.55, shirtMat, -0.38, 0.09, 0.05, 0.18)); // arms splayed
  root.add(box(0.14, 0.14, 0.55, shirtMat, 0.38, 0.09, 0.05, -0.18));
  root.add(box(0.17, 0.15, 0.7, pantsMat, -0.13, 0.09, 0.68)); // legs
  root.add(box(0.17, 0.15, 0.7, pantsMat, 0.14, 0.09, 0.66, 0.08));
  root.visible = false;

  return { root, shirtMat, pantsMat, skinMat, appliedKind: null };
}

function applyColors(rig: CorpseRig, kind: string): void {
  if (rig.appliedKind === kind) return;
  rig.appliedKind = kind;
  const colors = kind === "zombie" ? ZOMBIE_COLORS : PLAYER_COLORS;
  rig.shirtMat.color.set(colors.shirt);
  rig.pantsMat.color.set(colors.pants);
  rig.skinMat.color.set(colors.skin);
}

export function Corpses(): ReactElement {
  const pool = useMemo(() => {
    const root = new THREE.Group();
    const rigs: CorpseRig[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const rig = createRig();
      root.add(rig.root);
      rigs.push(rig);
    }
    return { root, rigs };
  }, []);

  useFrame(() => {
    const corpses = clientWorld.corpses;
    const n = Math.min(corpses.length, POOL_SIZE);
    for (let i = 0; i < n; i++) {
      const corpse = corpses[i];
      const rig = pool.rigs[i];
      rig.root.visible = true;
      applyColors(rig, corpse.kind);
      rig.root.position.set(corpse.x, corpse.y + GROUND_OFFSET, corpse.z);
      rig.root.rotation.y = corpse.yaw;
    }
    for (let i = n; i < POOL_SIZE; i++) pool.rigs[i].root.visible = false;
  });

  return <primitive object={pool.root} />;
}
