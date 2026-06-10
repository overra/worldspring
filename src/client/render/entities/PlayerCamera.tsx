// Camera rig: first-person or third-person shoulder cam following the
// predicted local player (clientWorld.me) + mouse-look (inputState.yaw/pitch).
// Runs at renderPriority 1 so it executes AFTER NetSystem's default-priority
// prediction step. NOTE: registering a positive-priority useFrame disables
// R3F's automatic render, so this component calls gl.render itself — it is
// the scene's renderer.
//
// Also owns the LOCAL player's body (visible in third person only).

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER_EYE_HEIGHT } from "@/shared/constants";
import { clientWorld, inputState } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { createHumanoid, localPlayerAnim } from "./Humanoid";

const CAM_DISTANCE = 3.6; // third-person boom length (per contract)
const CAM_SIDE = 0.45; // right-shoulder offset
const CAM_MIN_DIST = 0.8; // never pull closer than this
const CAM_HIT_MARGIN = 0.15; // back off the wall hit a touch
const LOOK_AHEAD = 3; // lookAt target this far ahead of the eye

const LOCAL_COLORS = { shirt: "#3f5d8a", pants: "#44484f", skin: "#d9b08c" };
const SPRINT_ANIM_FACTOR = 1.35;

// Reused frame temps — zero allocations per frame.
const EYE = new THREE.Vector3();
const DIR = new THREE.Vector3();
const TARGET = new THREE.Vector3();

export function PlayerCamera(): null {
  const scene = useThree((s) => s.scene);
  const rig = useMemo(() => createHumanoid(LOCAL_COLORS), []);

  useEffect(() => {
    rig.group.visible = false;
    scene.add(rig.group);
    return () => {
      scene.remove(rig.group);
    };
  }, [scene, rig]);

  useFrame((state) => {
    const me = clientWorld.me;
    const yaw = inputState.yaw;
    const pitch = inputState.pitch;
    const cam = state.camera;
    const eyeY = me.y + PLAYER_EYE_HEIGHT;

    // Look direction from yaw/pitch (yaw 0 faces -Z, see @/shared/math lookDir).
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;

    if (inputState.firstPerson) {
      rig.group.visible = false;
      cam.rotation.order = "YXZ";
      cam.position.set(me.x, eyeY, me.z);
      cam.rotation.set(pitch, yaw, 0);
    } else {
      // Third person: boom from the eye, offset over the right shoulder.
      const rx = Math.cos(yaw); // right vector = (cos yaw, 0, -sin yaw)
      const rz = -Math.sin(yaw);
      EYE.set(me.x, eyeY, me.z);
      DIR.set(
        -fx * CAM_DISTANCE + rx * CAM_SIDE,
        -fy * CAM_DISTANCE,
        -fz * CAM_DISTANCE + rz * CAM_SIDE,
      );
      const boomLen = DIR.length();
      DIR.multiplyScalar(1 / boomLen);
      let dist = boomLen;
      const world = clientWorld.world;
      if (world) {
        const hit = world.raycastStatics(EYE, DIR, boomLen);
        if (hit !== null) dist = Math.max(CAM_MIN_DIST, hit - CAM_HIT_MARGIN);
      }
      cam.position.set(EYE.x + DIR.x * dist, EYE.y + DIR.y * dist, EYE.z + DIR.z * dist);
      TARGET.set(EYE.x + fx * LOOK_AHEAD, EYE.y + fy * LOOK_AHEAD, EYE.z + fz * LOOK_AHEAD);
      cam.lookAt(TARGET);

      // Local body, third person only.
      rig.group.visible = clientWorld.ready;
      rig.group.position.set(me.x, me.y, me.z);
      rig.group.rotation.y = yaw;
      const moving =
        inputState.forward || inputState.back || inputState.left || inputState.right;
      const speedFactor = moving ? (inputState.sprint ? SPRINT_ANIM_FACTOR : 1) : 0;
      const attacking = performance.now() < localPlayerAnim.attackUntil;
      rig.update(state.clock.elapsedTime, speedFactor, attacking);
      const ui = useUIStore.getState();
      const stack = ui.inventory[ui.selectedSlot] ?? null;
      rig.setHeldItem(stack ? stack.type : null);
    }

    // Positive-priority subscriber => R3F auto-render is off; render here.
    state.gl.render(state.scene, state.camera);
  }, 1);

  return null;
}
