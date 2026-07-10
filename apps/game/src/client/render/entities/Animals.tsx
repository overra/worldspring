// Wildlife: per-species pooled props.glb clones driven per frame from
// clientWorld.animals. Missing GLB nodes use procedural box fallbacks so new
// species are playable before their Blender assets exist.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import {
  ANIMAL_POOL_MAX,
  ANIMAL_SPECIES,
  isAnimalSpecies,
  type AnimalSpecies,
} from "@worldspring/shared/constants";
import { effectiveAnimalMax } from "@worldspring/shared/config";
import { clientWorld } from "@/client/runtime";

const MAX_FRAME_DT = 0.1;
const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);

const SPECIES = Object.keys(ANIMAL_SPECIES) as AnimalSpecies[];
const PREALLOCATED_SPECIES = new Set<AnimalSpecies>(["deer", "rabbit"]);
const LEG_NODE_NAMES = ["leg_fl", "leg_fr", "leg_bl", "leg_br"] as const;

const GAIT: Record<AnimalSpecies, {
  wanderRate: number;
  wanderAmp: number;
  runRate: number;
  runAmp: number;
  runBob: number;
  runPitch: number;
  fallbackScale: number;
}> = {
  deer: { wanderRate: 5, wanderAmp: 0.3, runRate: 14, runAmp: 0.8, runBob: 0.07, runPitch: 0.06, fallbackScale: 1 },
  rabbit: { wanderRate: 8, wanderAmp: 0.22, runRate: 18, runAmp: 0.65, runBob: 0.12, runPitch: 0.04, fallbackScale: 0.42 },
  boar: { wanderRate: 4.5, wanderAmp: 0.24, runRate: 12, runAmp: 0.55, runBob: 0.03, runPitch: 0.03, fallbackScale: 0.85 },
  wolf: { wanderRate: 5.5, wanderAmp: 0.28, runRate: 13, runAmp: 0.65, runBob: 0.04, runPitch: 0.05, fallbackScale: 0.75 },
};
const BLEND_RATE = 8;

const BODY_GEO = new THREE.BoxGeometry(0.5, 0.6, 0.9);
const BELLY_GEO = new THREE.BoxGeometry(0.44, 0.24, 0.78);
const NECK_GEO = new THREE.BoxGeometry(0.16, 0.5, 0.16);
const HEAD_GEO = new THREE.BoxGeometry(0.2, 0.2, 0.34);
const TAIL_GEO = new THREE.BoxGeometry(0.08, 0.14, 0.08);
const LEG_GEO = new THREE.BoxGeometry(0.09, 0.7, 0.09);

const BODY_MATS: Record<AnimalSpecies, THREE.MeshLambertMaterial> = {
  deer: new THREE.MeshLambertMaterial({ color: "#8a6f4d" }),
  rabbit: new THREE.MeshLambertMaterial({ color: "#b7aa96" }),
  boar: new THREE.MeshLambertMaterial({ color: "#4d382d" }),
  wolf: new THREE.MeshLambertMaterial({ color: "#5f6670" }),
};
const BELLY_MATS: Record<AnimalSpecies, THREE.MeshLambertMaterial> = {
  deer: new THREE.MeshLambertMaterial({ color: "#a89071" }),
  rabbit: new THREE.MeshLambertMaterial({ color: "#ded6c8" }),
  boar: new THREE.MeshLambertMaterial({ color: "#6a5040" }),
  wolf: new THREE.MeshLambertMaterial({ color: "#838b92" }),
};

// Hip anchor points: [frontLeft, frontRight, backLeft, backRight].
// Front of the fallback is -Z (yaw 0 convention).
const HIPS: ReadonlyArray<readonly [number, number]> = [
  [-0.17, -0.32],
  [0.17, -0.32],
  [-0.17, 0.32],
  [0.17, 0.32],
];

interface AnimalRig {
  root: THREE.Group;
  torso: THREE.Group;
  legs: Array<THREE.Object3D | null>;
}

interface AnimalSlot {
  rig: AnimalRig;
  phase: number;
  amp: number;
  run: number;
}

interface AnimalPool {
  species: AnimalSpecies;
  root: THREE.Group;
  slots: AnimalSlot[];
  byId: Map<number, number>;
  free: number[];
  source: THREE.Object3D | null;
}

interface AnimalPools {
  root: THREE.Group;
  bySpecies: Map<AnimalSpecies, AnimalPool>;
}

function createFallbackRig(species: AnimalSpecies): AnimalRig {
  const root = new THREE.Group();
  root.visible = false;
  root.scale.setScalar(GAIT[species].fallbackScale);

  const torso = new THREE.Group();
  root.add(torso);

  const bodyMat = BODY_MATS[species];
  const bellyMat = BELLY_MATS[species];

  const body = new THREE.Mesh(BODY_GEO, bodyMat);
  body.position.y = 0.7;
  body.castShadow = true;
  torso.add(body);

  const belly = new THREE.Mesh(BELLY_GEO, bellyMat);
  belly.position.y = 0.46;
  torso.add(belly);

  const neck = new THREE.Mesh(NECK_GEO, bodyMat);
  neck.position.set(0, 1.02, -0.42);
  neck.rotation.x = -0.5;
  neck.castShadow = true;
  torso.add(neck);

  const head = new THREE.Mesh(HEAD_GEO, bodyMat);
  head.position.set(0, 1.3, -0.62);
  head.castShadow = true;
  torso.add(head);

  const tail = new THREE.Mesh(TAIL_GEO, bellyMat);
  tail.position.set(0, 0.92, 0.46);
  tail.rotation.x = 0.5;
  torso.add(tail);

  const legs: THREE.Group[] = [];
  for (const [hx, hz] of HIPS) {
    const pivot = new THREE.Group();
    pivot.position.set(hx, 0.7, hz);
    const leg = new THREE.Mesh(LEG_GEO, bodyMat);
    leg.position.y = -0.35;
    leg.castShadow = true;
    pivot.add(leg);
    root.add(pivot);
    legs.push(pivot);
  }

  return { root, torso, legs };
}

function createRig(species: AnimalSpecies, source: THREE.Object3D | null): AnimalRig {
  if (!source) return createFallbackRig(species);

  const root = new THREE.Group();
  root.visible = false;
  const torso = new THREE.Group();
  root.add(torso);

  const model = source.clone();
  // Current deer node faces +Z; future quadruped nodes use the same convention.
  model.rotation.y = Math.PI;
  torso.add(model);
  const legs = LEG_NODE_NAMES.map((name) => model.getObjectByName(name) ?? null);
  return { root, torso, legs };
}

function growPool(pool: AnimalPool): boolean {
  if (pool.slots.length >= ANIMAL_POOL_MAX) return false;
  const idx = pool.slots.length;
  const rig = createRig(pool.species, pool.source);
  pool.root.add(rig.root);
  pool.slots.push({ rig, phase: idx * 1.3, amp: 0, run: 0 });
  pool.free.push(idx);
  return true;
}

function createPool(scene: THREE.Group, species: AnimalSpecies): AnimalPool {
  const source = scene.getObjectByName(species) ?? null;
  source?.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
  const root = new THREE.Group();
  const pool: AnimalPool = {
    species,
    root,
    slots: [],
    byId: new Map(),
    free: [],
    source,
  };
  const max = effectiveAnimalMax(clientWorld.config, species);
  const initialSize = PREALLOCATED_SPECIES.has(species) && max > 0
    ? Math.min(max + 4, ANIMAL_POOL_MAX)
    : 0;
  for (let i = 0; i < initialSize; i++) growPool(pool);
  return pool;
}

function createPools(scene: THREE.Group): AnimalPools {
  const root = new THREE.Group();
  const bySpecies = new Map<AnimalSpecies, AnimalPool>();
  for (const species of SPECIES) {
    const pool = createPool(scene, species);
    root.add(pool.root);
    bySpecies.set(species, pool);
  }
  return { root, bySpecies };
}

function releaseMissing(pool: AnimalPool): void {
  const animals = clientWorld.animals;
  for (const [id, idx] of pool.byId) {
    const animal = animals.get(id);
    if (animal?.species === pool.species) continue;
    pool.byId.delete(id);
    pool.free.push(idx);
    pool.slots[idx].rig.root.visible = false;
  }
}

function acquireSlot(pool: AnimalPool, id: number): AnimalSlot | null {
  let idx = pool.byId.get(id);
  if (idx === undefined) {
    if (pool.free.length === 0 && !growPool(pool)) return null;
    idx = pool.free.pop()!;
    pool.byId.set(id, idx);
    const fresh = pool.slots[idx];
    fresh.rig.root.visible = true;
    fresh.amp = 0;
    fresh.run = 0;
  }
  return pool.slots[idx];
}

export function Animals(): ReactElement {
  const gltf = useGLTF(PROPS_MODEL_URL);
  const pools = useMemo(() => createPools(gltf.scene), [gltf.scene]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, MAX_FRAME_DT);
    for (const pool of pools.bySpecies.values()) releaseMissing(pool);

    for (const a of clientWorld.animals.values()) {
      const species = isAnimalSpecies(a.species) ? a.species : "deer";
      const pool = pools.bySpecies.get(species) ?? pools.bySpecies.get("deer");
      if (!pool) continue;
      const slot = acquireSlot(pool, a.id);
      if (!slot) continue;

      const rig = slot.rig;
      rig.root.position.set(a.x, a.y, a.z);
      rig.root.rotation.y = a.yaw;

      const gait = GAIT[species];
      let rate = 0;
      let ampTarget = 0;
      let runTarget = 0;
      if (a.state === "wander" || a.state === "stalk") {
        rate = gait.wanderRate;
        ampTarget = gait.wanderAmp;
      } else if (a.state === "flee" || a.state === "charge" || a.state === "attack") {
        rate = gait.runRate;
        ampTarget = gait.runAmp;
        runTarget = 1;
      }

      slot.phase += rate * dt;
      const k = Math.min(1, dt * BLEND_RATE);
      slot.amp += (ampTarget - slot.amp) * k;
      slot.run += (runTarget - slot.run) * k;

      const swing = Math.sin(slot.phase) * slot.amp;
      const [fl, fr, bl, br] = rig.legs;
      if (fl) fl.rotation.x = swing;
      if (fr) fr.rotation.x = -swing;
      if (bl) bl.rotation.x = -swing;
      if (br) br.rotation.x = swing;

      rig.torso.position.y = Math.abs(Math.sin(slot.phase)) * gait.runBob * slot.run;
      rig.torso.rotation.x = Math.sin(slot.phase) * gait.runPitch * slot.run;
    }
  });

  return <primitive object={pools.root} />;
}
