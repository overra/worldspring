// Wildlife: pooled props.glb deer clones driven per frame from
// clientWorld.animals — same imperative pooling pattern as Zombies. Yaw 0
// faces -Z like every other entity (the GLB deer faces +Z, so each clone is
// flipped half a turn). Legs swing procedurally via rotation.x on the
// leg_fl/fr/bl/br child nodes, whose origins sit at the hip joints in the
// model; rate/amplitude map from the wire state (idle: none, wander: slow
// walk, flee: fast gallop with body bob). The old procedural box deer
// remains as fallback if the GLB node goes missing.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { DEER_COUNT } from "@/shared/constants";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = DEER_COUNT + 4; // margin over the wire max (respawn overlap)
const MAX_FRAME_DT = 0.1;

const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);

// Hip-pivot leg nodes inside the deer GLB node, in gait order.
const LEG_NODE_NAMES = ["leg_fl", "leg_fr", "leg_bl", "leg_br"] as const;

// Gait tuning (rad/s swing rate, rad swing amplitude).
const WANDER_RATE = 5;
const WANDER_AMP = 0.3;
const FLEE_RATE = 14;
const FLEE_AMP = 0.8;
const GALLOP_BOB_HEIGHT = 0.07; // body bounce at full flee
const GALLOP_PITCH = 0.06; // body rock at full flee
const BLEND_RATE = 8; // 1/s — smooths gait transitions, no pops

// Shared geometry/materials — module-level singletons like Campfires.
const BODY_GEO = new THREE.BoxGeometry(0.5, 0.6, 0.9);
const BELLY_GEO = new THREE.BoxGeometry(0.44, 0.24, 0.78);
const NECK_GEO = new THREE.BoxGeometry(0.16, 0.5, 0.16);
const HEAD_GEO = new THREE.BoxGeometry(0.2, 0.2, 0.34);
const TAIL_GEO = new THREE.BoxGeometry(0.08, 0.14, 0.08);
const LEG_GEO = new THREE.BoxGeometry(0.09, 0.7, 0.09);
const TAN_MAT = new THREE.MeshLambertMaterial({ color: "#8a6f4d" });
const BELLY_MAT = new THREE.MeshLambertMaterial({ color: "#a89071" });

// Hip anchor points: [frontLeft, frontRight, backLeft, backRight].
// Front of the deer is -Z (yaw 0 convention).
const HIPS: ReadonlyArray<readonly [number, number]> = [
  [-0.17, -0.32],
  [0.17, -0.32],
  [-0.17, 0.32],
  [0.17, 0.32],
];

interface DeerRig {
  root: THREE.Group;
  /** Whole body — bobbed/rocked as one during a gallop. */
  torso: THREE.Group;
  /** Hip-pivot leg nodes [fl, fr, bl, br]; swing = rotation.x. Null when a
   * leg node is missing from the GLB (slot keeps its gait order). */
  legs: Array<THREE.Object3D | null>;
}

interface DeerSlot {
  rig: DeerRig;
  phase: number;
  /** Smoothed leg swing amplitude (rad). */
  amp: number;
  /** Smoothed gallop weight 0..1 (drives body bob/rock). */
  gallop: number;
}

interface DeerPool {
  root: THREE.Group;
  slots: DeerSlot[];
  byId: Map<number, number>;
  free: number[];
}

function createRig(deerSource: THREE.Object3D | null): DeerRig {
  const root = new THREE.Group();
  root.visible = false;

  const torso = new THREE.Group();
  root.add(torso);

  if (deerSource) {
    const model = deerSource.clone();
    // GLB deer faces +Z (head and leg_f* sit at positive Z); flip to the
    // game's yaw-0-faces--Z convention.
    model.rotation.y = Math.PI;
    torso.add(model);
    // Hip-origin leg nodes — gait drives rotation.x on these directly.
    const legs = LEG_NODE_NAMES.map((name) => model.getObjectByName(name) ?? null);
    return { root, torso, legs };
  }

  // Fallback: procedural box deer (props.glb node missing).
  const body = new THREE.Mesh(BODY_GEO, TAN_MAT);
  body.position.y = 0.7;
  body.castShadow = true;
  torso.add(body);

  const belly = new THREE.Mesh(BELLY_GEO, BELLY_MAT);
  belly.position.y = 0.46;
  torso.add(belly);

  const neck = new THREE.Mesh(NECK_GEO, TAN_MAT);
  neck.position.set(0, 1.02, -0.42);
  neck.rotation.x = -0.5; // top leans forward (-Z)
  neck.castShadow = true;
  torso.add(neck);

  const head = new THREE.Mesh(HEAD_GEO, TAN_MAT);
  head.position.set(0, 1.3, -0.62);
  head.castShadow = true;
  torso.add(head);

  const tail = new THREE.Mesh(TAIL_GEO, BELLY_MAT);
  tail.position.set(0, 0.92, 0.46);
  tail.rotation.x = 0.5; // perks up and back
  torso.add(tail);

  const legs: THREE.Group[] = [];
  for (const [hx, hz] of HIPS) {
    const pivot = new THREE.Group();
    pivot.position.set(hx, 0.7, hz);
    const leg = new THREE.Mesh(LEG_GEO, TAN_MAT);
    leg.position.y = -0.35; // hangs from the hip; pivot swings the whole leg
    leg.castShadow = true;
    pivot.add(leg);
    root.add(pivot);
    legs.push(pivot);
  }

  return { root, torso, legs };
}

function createPool(scene: THREE.Group): DeerPool {
  // Flag shadows on the source once; clones inherit (LootItems pattern).
  const deerSource = scene.getObjectByName("deer") ?? null;
  deerSource?.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
  const root = new THREE.Group();
  const slots: DeerSlot[] = [];
  const free: number[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const rig = createRig(deerSource);
    root.add(rig.root);
    // Stagger phases so a herd never moves in lockstep.
    slots.push({ rig, phase: i * 1.3, amp: 0, gallop: 0 });
    free.push(POOL_SIZE - 1 - i);
  }
  return { root, slots, byId: new Map(), free };
}

export function Animals(): ReactElement {
  // Suspends until the GLB loads; the Canvas mounts post-welcome so the
  // suspension is invisible. Same drei cache entry the other props use.
  const gltf = useGLTF(PROPS_MODEL_URL);
  const pool = useMemo(() => createPool(gltf.scene), [gltf.scene]);

  useFrame((_, delta) => {
    const animals = clientWorld.animals;
    const dt = Math.min(delta, MAX_FRAME_DT);

    // Release slots whose animal left the interest set / died.
    for (const [id, idx] of pool.byId) {
      if (animals.has(id)) continue;
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.slots[idx].rig.root.visible = false;
    }

    for (const a of animals.values()) {
      let idx = pool.byId.get(a.id);
      if (idx === undefined) {
        idx = pool.free.pop();
        if (idx === undefined) continue;
        pool.byId.set(a.id, idx);
        const fresh = pool.slots[idx];
        fresh.rig.root.visible = true;
        fresh.amp = 0;
        fresh.gallop = 0;
      }
      const slot = pool.slots[idx];
      const rig = slot.rig;
      rig.root.position.set(a.x, a.y, a.z);
      rig.root.rotation.y = a.yaw;

      // Gait targets from the wire state.
      let rate = 0;
      let ampTarget = 0;
      let gallopTarget = 0;
      if (a.state === "wander") {
        rate = WANDER_RATE;
        ampTarget = WANDER_AMP;
      } else if (a.state === "flee") {
        rate = FLEE_RATE;
        ampTarget = FLEE_AMP;
        gallopTarget = 1;
      }

      slot.phase += rate * dt;
      const k = Math.min(1, dt * BLEND_RATE);
      slot.amp += (ampTarget - slot.amp) * k;
      slot.gallop += (gallopTarget - slot.gallop) * k;

      // Diagonal leg pairs (FL+BR vs FR+BL) in antiphase.
      const swing = Math.sin(slot.phase) * slot.amp;
      const [fl, fr, bl, br] = rig.legs;
      if (fl) fl.rotation.x = swing;
      if (fr) fr.rotation.x = -swing;
      if (bl) bl.rotation.x = -swing;
      if (br) br.rotation.x = swing;

      // Gallop: bounce the whole torso and rock it slightly.
      rig.torso.position.y = Math.abs(Math.sin(slot.phase)) * GALLOP_BOB_HEIGHT * slot.gallop;
      rig.torso.rotation.x = Math.sin(slot.phase) * GALLOP_PITCH * slot.gallop;
    }
  });

  return <primitive object={pool.root} />;
}
