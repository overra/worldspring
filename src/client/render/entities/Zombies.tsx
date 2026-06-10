// Zombie rendering: pooled humanoid rigs with a hunched posture, greenish
// skin, raised arms while chasing/attacking, and a lunge pulse on attack.
// Same imperative pooling pattern as RemotePlayers — no React per snapshot.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { ZOMBIE_MAX } from "@/shared/constants";
import type { ZombieState } from "@/shared/protocol";
import { clientWorld } from "@/client/runtime";
import { createHumanoid, type HumanoidRig } from "./Humanoid";

const ZOMBIE_COLORS = { shirt: "#4a4f42", pants: "#3b3f36", skin: "#6a8a5a" };
// Military variant: darker uniform + a slightly wider torso (1.1x).
const MIL_ZOMBIE_SHIRT = "#3a4138";
const MIL_ZOMBIE_PANTS = "#2e332c";
const MIL_TORSO_SCALE_X = 1.1;
const HUNCH_X = 0.25; // torso forward tilt
const ARMS_RAISED_X = 1.35; // arms held out toward the target
const LUNGE_AMPLITUDE = 0.35;

function speedFactorFor(state: ZombieState): number {
  if (state === "chase") return 1.4;
  if (state === "attack") return 1.1;
  if (state === "wander") return 0.45;
  return 0;
}

interface ZombiePool {
  root: THREE.Group;
  rigs: HumanoidRig[];
  byId: Map<number, number>;
  free: number[];
}

function createPool(): ZombiePool {
  const root = new THREE.Group();
  const rigs: HumanoidRig[] = [];
  const free: number[] = [];
  for (let i = 0; i < ZOMBIE_MAX; i++) {
    const rig = createHumanoid(ZOMBIE_COLORS);
    rig.group.visible = false;
    rig.upper.rotation.x = HUNCH_X;
    root.add(rig.group);
    rigs.push(rig);
    free.push(ZOMBIE_MAX - 1 - i);
  }
  return { root, rigs, byId: new Map(), free };
}

export function Zombies(): ReactElement {
  const pool = useMemo(createPool, []);

  useFrame((state) => {
    const zombies = clientWorld.zombies;

    for (const [id, idx] of pool.byId) {
      if (zombies.has(id)) continue;
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.rigs[idx].group.visible = false;
    }

    const t = state.clock.elapsedTime;

    for (const z of zombies.values()) {
      let idx = pool.byId.get(z.id);
      if (idx === undefined) {
        idx = pool.free.pop();
        if (idx === undefined) continue;
        pool.byId.set(z.id, idx);
        const fresh = pool.rigs[idx];
        fresh.group.visible = true;
        // Variant styling on assignment (slots are reused — always set both ways).
        fresh.shirtMaterial.color.set(z.mil ? MIL_ZOMBIE_SHIRT : ZOMBIE_COLORS.shirt);
        fresh.pantsMaterial.color.set(z.mil ? MIL_ZOMBIE_PANTS : ZOMBIE_COLORS.pants);
        fresh.torso.scale.x = z.mil ? MIL_TORSO_SCALE_X : 1;
      }
      const rig = pool.rigs[idx];
      rig.group.position.set(z.x, z.y, z.z);
      rig.group.rotation.y = z.yaw;

      const tz = t + idx * 2.3; // de-sync the pool's walk cycles
      rig.update(tz, speedFactorFor(z.state), false);

      // Posture overrides AFTER update(): hunch + aggro arms + lunge.
      rig.upper.rotation.x = HUNCH_X;
      if (z.state === "chase" || z.state === "attack") {
        const wobble = Math.sin(tz * 5) * 0.12;
        rig.leftArm.rotation.x = ARMS_RAISED_X + wobble;
        rig.rightArm.rotation.x = ARMS_RAISED_X - wobble;
      }
      if (z.state === "attack") {
        const lunge = Math.max(0, Math.sin(tz * 7));
        rig.upper.rotation.x = HUNCH_X + lunge * LUNGE_AMPLITUDE;
      }
    }
  });

  return <primitive object={pool.root} />;
}
