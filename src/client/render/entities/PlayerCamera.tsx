// Camera rig: first-person or third-person shoulder cam following the
// predicted local player (clientWorld.me) + mouse-look (inputState.yaw/pitch).
// Runs at renderPriority 1 so it executes AFTER NetSystem's default-priority
// prediction step. NOTE: registering a positive-priority useFrame disables
// R3F's automatic render; the actual render is owned by <PostFX/>'s
// EffectComposer (renderPriority 2), which runs after this camera update.
//
// Also owns the LOCAL player's body (visible in third person only).

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER_EYE_HEIGHT } from "@/shared/constants";
import { clientWorld, inputState, localPlayerAnim } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { createCharacterRig, overlayForItem, useCharacterModel } from "./CharacterRig";

const CAM_DISTANCE = 3.6; // third-person boom length (per contract)
const CAM_SIDE = 0.45; // right-shoulder offset
const CAM_MIN_DIST = 0.8; // never pull closer than this
const CAM_HIT_MARGIN = 0.15; // back off the wall hit a touch
const LOOK_AHEAD = 3; // lookAt target this far ahead of the eye

// Subtle blue tint distinguishing the local body (mirrors the old blue shirt).
const LOCAL_TINT = new THREE.Color(1, 1, 1).lerp(new THREE.Color("#3f5d8a"), 0.35);
const MAX_FRAME_DT = 0.1;

// Reused frame temps — zero allocations per frame.
const EYE = new THREE.Vector3();
const DIR = new THREE.Vector3();
const TARGET = new THREE.Vector3();

export function PlayerCamera(): null {
  useCharacterModel("survivor");
  const scene = useThree((s) => s.scene);
  const rig = useMemo(() => {
    const r = createCharacterRig("survivor");
    r.setTint(LOCAL_TINT);
    return r;
  }, []);
  // Frame-rate mutable tracking, deliberately outside React state.
  const anim = useMemo(() => ({ lastAttackUntil: 0 }), []);

  useEffect(() => {
    rig.root.visible = false;
    scene.add(rig.root);
    return () => {
      scene.remove(rig.root);
    };
  }, [scene, rig]);

  useFrame((state, delta) => {
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

    // Consume the attack edge in both camera modes so a stale swing never
    // replays when toggling out of first person.
    const attackTriggered = localPlayerAnim.attackUntil > anim.lastAttackUntil;
    if (attackTriggered) anim.lastAttackUntil = localPlayerAnim.attackUntil;

    if (inputState.firstPerson) {
      rig.root.visible = false;
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
      rig.root.visible = clientWorld.ready;
      rig.root.position.set(me.x, me.y, me.z);
      rig.root.rotation.y = yaw;
      // Keys OR the virtual joystick (analog) count as moving — touch input
      // never sets the boolean key flags.
      const analogMag = Math.hypot(inputState.analogX, inputState.analogZ);
      const moving =
        inputState.forward ||
        inputState.back ||
        inputState.left ||
        inputState.right ||
        analogMag > 0.05;
      rig.setLocomotion(moving ? (inputState.sprint ? "run" : "walk") : "idle");
      const ui = useUIStore.getState();
      const stack = ui.inventory[ui.selectedSlot] ?? null;
      const item = stack ? stack.type : null;
      rig.setHeldItem(item);
      if (attackTriggered) rig.playOverlay(overlayForItem(item));
    }
    // Mixer runs in both modes so the pose stays coherent across toggles.
    rig.update(Math.min(delta, MAX_FRAME_DT));
  }, 1);

  return null;
}
