// Zombie rendering: pooled rigged skeleton characters driven by the wire
// state — shamble while wandering, run while chasing, punch overlays on the
// server's swing cadence. Same imperative pooling pattern as RemotePlayers.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ZombieState } from "@worldspring/shared/protocol";
import { clientWorld } from "@/client/runtime";
import {
  createCharacterRig,
  useCharacterModel,
  type CharacterRig,
  type LocomotionState,
} from "./CharacterRig";

// Very subtle green cast over the authored skeleton palette.
const NORMAL_TINT = new THREE.Color("#d4ddc9");
// Military variant: dark olive + slightly bigger.
const MIL_TINT = new THREE.Color("#5a6148");
const MIL_SCALE = 1.06;
/** Matches the server swing cadence while a zombie stays in `attack`. */
const ATTACK_SWING_INTERVAL_S = 1.2;
// Rigs beyond this only step their mixer every Nth frame (accumulated dt).
const FAR_DIST_SQ = 80 * 80;
const FAR_UPDATE_INTERVAL = 4;
// Generous cap: under rAF display-throttling (occluded windows tick at ~2Hz
// or LESS) a small clamp plays anims in slow motion and holds new rigs in
// bind pose. Locomotion clips are cyclic — a multi-second step lands on the
// correct phase, so a throttled tab shows the right pose on every frame it
// actually gets.
const MAX_FRAME_DT = 5;

function locomotionFor(state: ZombieState): LocomotionState {
  if (state === "chase") return "run";
  if (state === "wander") return "shamble";
  return "idle"; // idle + attack (the punch overlay carries the swing)
}

interface ZombieSlot {
  rig: CharacterRig;
  lastState: ZombieState | null;
  nextSwingIn: number;
  accumDt: number;
}

interface ZombiePool {
  root: THREE.Group;
  slots: ZombieSlot[];
  byId: Map<number, number>;
  free: number[];
  frame: number;
}

/** Allocate a single new zombie slot into the pool (lazy growth path). The
 * rig stays DETACHED like createPool's — the caller acquires (and attaches)
 * it in the same frame. */
function growPool(pool: ZombiePool): number {
  const idx = pool.slots.length;
  const rig = createCharacterRig("zombie");
  rig.root.visible = false;
  pool.slots.push({ rig, lastState: null, nextSwingIn: 0, accumDt: 0 });
  pool.free.push(idx);
  return idx;
}

function createPool(): ZombiePool {
  // Empty pool: zombie rigs are cloned lazily on first sighting via growPool,
  // so a join pays only for zombies actually in the initial interest set — not
  // the full config capacity. Cloning skinned rigs is the join hitch, and
  // pre-cloning effectiveZombieMax of them up front is exactly what this avoids;
  // growth stays bounded by real wire entities (see growPool). Pooled rigs are
  // DETACHED + hidden until acquire (three r184's updateMatrixWorld recurses
  // into ALL children, so an attached-but-hidden rig still pays per-bone work).
  return { root: new THREE.Group(), slots: [], byId: new Map(), free: [], frame: 0 };
}

export function Zombies(): ReactElement {
  useCharacterModel("zombie");
  const pool = useMemo(createPool, []);

  useFrame((state, delta) => {
    const zombies = clientWorld.zombies;
    pool.frame++;

    for (const [id, idx] of pool.byId) {
      if (zombies.has(id)) continue;
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.slots[idx].rig.root.visible = false;
      // Detach so the idle rig costs zero matrix work per frame (createPool).
      pool.root.remove(pool.slots[idx].rig.root);
    }

    const dt = Math.min(delta, MAX_FRAME_DT);
    const camPos = state.camera.position;

    for (const z of zombies.values()) {
      let idx = pool.byId.get(z.id);
      let justAcquired = false;
      if (idx === undefined) {
        // Grow lazily when the free list is exhausted — welcome-time config is
        // an allocation hint, not a render cap. Growth is bounded by real wire
        // entities so a hostile config cannot force runaway allocation.
        if (pool.free.length === 0) growPool(pool);
        idx = pool.free.pop()!;
        pool.byId.set(z.id, idx);
        justAcquired = true;
        const fresh = pool.slots[idx];
        fresh.rig.root.visible = true;
        // Re-attach (see createPool). Position/rotation are written right
        // below in this priority-0 useFrame, before the priority-2 composer
        // render — world matrices are correct within the same frame.
        pool.root.add(fresh.rig.root);
        // Variant styling on assignment (slots are reused — always set both ways).
        fresh.rig.setTint(z.mil ? MIL_TINT : NORMAL_TINT);
        fresh.rig.root.scale.setScalar(z.mil ? MIL_SCALE : 1);
        fresh.lastState = null;
        fresh.accumDt = 0;
      }
      const slot = pool.slots[idx];
      const root = slot.rig.root;
      root.position.set(z.x, z.y, z.z);
      root.rotation.y = z.yaw;

      if (z.state !== slot.lastState) {
        slot.lastState = z.state;
        slot.rig.setLocomotion(locomotionFor(z.state));
        if (z.state === "attack") {
          slot.rig.playOverlay("attack_punch");
          slot.nextSwingIn = ATTACK_SWING_INTERVAL_S;
        }
      } else if (z.state === "attack") {
        slot.nextSwingIn -= dt;
        if (slot.nextSwingIn <= 0) {
          slot.rig.playOverlay("attack_punch");
          slot.nextSwingIn += ATTACK_SWING_INTERVAL_S;
        }
      }

      // Mixer step — far rigs only every Nth frame, staggered by slot. A
      // just-acquired rig always steps: a freshly cloned skeleton renders in
      // its bind pose (T-pose) until the mixer runs once, and the throttle
      // could otherwise skip that first step for a rig acquired far away.
      slot.accumDt += dt;
      const dx = z.x - camPos.x;
      const dy = z.y - camPos.y;
      const dz = z.z - camPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (!justAcquired && distSq > FAR_DIST_SQ && (pool.frame + idx) % FAR_UPDATE_INTERVAL !== 0)
        continue;
      slot.rig.update(slot.accumDt);
      slot.accumDt = 0;
    }
  });

  return <primitive object={pool.root} />;
}
