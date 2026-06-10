// Keyboard + pointer-lock mouse input. Writes inputState (the only writer per
// the runtime contract) and fires net action helpers on edges. Returns null —
// it renders nothing, it only wires document/window/canvas listeners.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { clientWorld, inputState } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { doAttack, doDrop, doEquip, doPickup } from "@/client/net/connection";
import { ATTACK_ANIM_S, localPlayerAnim } from "./Humanoid";

const MOUSE_SENSITIVITY = 0.0024; // rad per px of pointer-lock movement
const PITCH_LIMIT = 1.45; // rad, per contract

function clearMovementKeys(): void {
  inputState.forward = false;
  inputState.back = false;
  inputState.left = false;
  inputState.right = false;
  inputState.sprint = false;
}

export function InputController(): null {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const canvas = gl.domElement;

    const onKeyDown = (e: KeyboardEvent): void => {
      const ui = useUIStore.getState();
      if (ui.phase !== "playing") return;

      if (e.code === "Tab") {
        e.preventDefault();
        if (e.repeat) return;
        ui.setInvOpen(!ui.invOpen); // turning on clears movement via subscription
        return;
      }

      // Movement only registers while in mouselook — this matches the
      // NetSystem gate exactly, so the local rig never animates a walk the
      // prediction isn't actually running.
      const canMove = !ui.invOpen && inputState.pointerLocked;
      switch (e.code) {
        case "KeyW":
          if (canMove) inputState.forward = true;
          return;
        case "KeyS":
          if (canMove) inputState.back = true;
          return;
        case "KeyA":
          if (canMove) inputState.left = true;
          return;
        case "KeyD":
          if (canMove) inputState.right = true;
          return;
        case "ShiftLeft":
          if (canMove) inputState.sprint = true;
          return;
        default:
          break;
      }

      if (e.repeat) return; // everything below is edge-triggered

      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (canMove) inputState.jump = true;
          return;
        case "KeyV":
          inputState.firstPerson = !inputState.firstPerson;
          return;
        case "KeyE": {
          const lootId = clientWorld.promptLootId;
          if (lootId !== null) doPickup(lootId);
          return;
        }
        case "KeyG":
          doDrop(ui.selectedSlot);
          return;
        default: {
          // Digit1..Digit8 → equip hotbar slot.
          if (!e.code.startsWith("Digit")) return;
          const n = Number(e.code.slice(5));
          if (!Number.isInteger(n) || n < 1 || n > 8) return;
          const slot = n - 1;
          doEquip(slot);
          ui.setSelectedSlot(slot); // optimistic; server `inv` confirms
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      // Always process releases, even mid-death or with inventory open.
      switch (e.code) {
        case "KeyW":
          inputState.forward = false;
          return;
        case "KeyS":
          inputState.back = false;
          return;
        case "KeyA":
          inputState.left = false;
          return;
        case "KeyD":
          inputState.right = false;
          return;
        case "ShiftLeft":
          inputState.sprint = false;
          return;
        default:
          return;
      }
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (!inputState.pointerLocked) return;
      const ui = useUIStore.getState();
      if (ui.invOpen || ui.phase !== "playing") return;
      localPlayerAnim.attackUntil = performance.now() + ATTACK_ANIM_S * 1000;
      doAttack();
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!inputState.pointerLocked) return;
      inputState.yaw -= e.movementX * MOUSE_SENSITIVITY;
      const pitch = inputState.pitch - e.movementY * MOUSE_SENSITIVITY;
      inputState.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    };

    const onCanvasClick = (): void => {
      if (document.pointerLockElement === canvas) return;
      if (useUIStore.getState().phase !== "playing") return;
      // Promise-wrapped: requestPointerLock can reject (e.g. re-lock too soon
      // after Esc) and we don't want an unhandled rejection for that.
      Promise.resolve(canvas.requestPointerLock()).catch(() => {
        // Browser refused the lock; the next click tries again.
      });
    };

    const onPointerLockChange = (): void => {
      inputState.pointerLocked = document.pointerLockElement === canvas;
      // Esc exits pointer lock natively — don't fight it, just stop moving.
      if (!inputState.pointerLocked) clearMovementKeys();
    };

    const onBlur = (): void => {
      clearMovementKeys();
    };

    const exitLock = (): void => {
      try {
        document.exitPointerLock();
      } catch {
        // Not locked; nothing to release.
      }
    };

    const unsubscribe = useUIStore.subscribe((state, prev) => {
      // Release the mouse for any UI that needs clicking — death screen and
      // the inventory panel are unreachable while the pointer is locked.
      if (state.invOpen && !prev.invOpen) {
        clearMovementKeys();
        exitLock();
      }
      if (state.phase === "dead" && prev.phase !== "dead") exitLock();
    });

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    canvas.addEventListener("click", onCanvasClick);
    window.addEventListener("blur", onBlur);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      canvas.removeEventListener("click", onCanvasClick);
      window.removeEventListener("blur", onBlur);
      unsubscribe();
      clearMovementKeys();
      inputState.pointerLocked = false;
    };
  }, [gl]);

  return null;
}
