// Campfires: pooled props.glb campfire models (stone ring + logs, no baked
// flame), an emissive cone flame, and a flickering point light per active
// fire in clientWorld.fires. GLB clones share geometry + materials like
// LootItems; the old crossed-log primitives remain as fallback if the node
// goes missing.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 16;

const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);
const FIRE_COLOR = "#ff8c3a";
const LIGHT_INTENSITY = 2.2;
const LIGHT_FLICKER = 0.5;
const LIGHT_DISTANCE = 14;
const LIGHT_DECAY = 2;

const LOG_GEO = new THREE.CylinderGeometry(0.07, 0.09, 1.15, 5);
const LOG_MAT = new THREE.MeshLambertMaterial({ color: "#4a3a28" });
const FLAME_GEO = new THREE.ConeGeometry(0.32, 0.85, 6);
const FLAME_MAT = new THREE.MeshBasicMaterial({ color: FIRE_COLOR });

interface FireSlot {
  group: THREE.Group;
  flame: THREE.Mesh;
  light: THREE.PointLight;
}

interface FirePool {
  root: THREE.Group;
  slots: FireSlot[];
}

function createPool(scene: THREE.Group): FirePool {
  // Flag shadows on the source once; clones inherit (LootItems pattern).
  const fireSource = scene.getObjectByName("campfire") ?? null;
  fireSource?.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
  const root = new THREE.Group();
  const slots: FireSlot[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const group = new THREE.Group();
    group.visible = false;
    if (fireSource) {
      group.add(fireSource.clone());
    } else {
      // Fallback: three crossed logs leaning into the center.
      for (let k = 0; k < 3; k++) {
        const log = new THREE.Mesh(LOG_GEO, LOG_MAT);
        log.castShadow = true;
        log.rotation.order = "YXZ";
        log.rotation.y = (k * Math.PI * 2) / 3;
        log.rotation.x = 1.2;
        log.position.y = 0.18;
        group.add(log);
      }
    }
    const flame = new THREE.Mesh(FLAME_GEO, FLAME_MAT);
    flame.position.y = 0.55;
    group.add(flame);
    const light = new THREE.PointLight(FIRE_COLOR, LIGHT_INTENSITY, LIGHT_DISTANCE, LIGHT_DECAY);
    light.position.y = 0.9;
    group.add(light);
    root.add(group);
    slots.push({ group, flame, light });
  }
  return { root, slots };
}

export function Campfires(): ReactElement {
  // Suspends until the GLB loads; the Canvas mounts post-welcome so the
  // suspension is invisible. Same drei cache entry the other props use.
  const gltf = useGLTF(PROPS_MODEL_URL);
  const pool = useMemo(() => createPool(gltf.scene), [gltf.scene]);

  useFrame((state) => {
    const fires = clientWorld.fires;
    const t = state.clock.elapsedTime;
    const n = Math.min(fires.length, POOL_SIZE);

    for (let i = 0; i < n; i++) {
      const fire = fires[i];
      const slot = pool.slots[i];
      slot.group.visible = true;
      slot.group.position.set(fire.x, fire.y, fire.z);
      // Flicker: two incommensurate sines, phase-offset per fire id.
      const f1 = Math.sin(t * 9 + fire.id * 1.7);
      const f2 = Math.sin(t * 23 + fire.id * 0.9);
      slot.light.intensity = LIGHT_INTENSITY + (f1 * 0.4 + f2 * 0.1) * LIGHT_FLICKER * 2;
      slot.flame.scale.set(1 + f1 * 0.12, 1 + f2 * 0.2, 1 + f1 * 0.12);
    }
    for (let i = n; i < POOL_SIZE; i++) pool.slots[i].group.visible = false;
  });

  return <primitive object={pool.root} />;
}
