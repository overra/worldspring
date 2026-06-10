// Keyboard + pointer-lock mouse input. Writes inputState (the only writer per
// the runtime contract) and fires net action helpers on edges. Returns null —
// it renders nothing, it only wires document/window/canvas listeners.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { clientWorld, inputState, triggerLocalAttackAnim } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { useSettingsStore } from "@/client/state/settings";
import { doAttack, doDrop, doEquip, doPickup } from "@/client/net/connection";

const MOUSE_SENSITIVITY = 0.0024; // rad per px at sensitivity 1
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
        if (ui.menuOpen) return; // menu has priority over inventory
        // Turning on clears movement via subscription; turning off re-locks
        // via subscription (still inside this keydown's user gesture).
        ui.setInvOpen(!ui.invOpen);
        return;
      }

      // Movement only registers while in mouselook (or touch mode, where
      // input flows without pointer lock) — this matches the NetSystem gate
      // exactly, so the local rig never animates a walk the prediction isn't
      // actually running.
      const canMove =
        !ui.invOpen &&
        !ui.menuOpen &&
        (inputState.pointerLocked || inputState.touchMode);
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
      triggerLocalAttackAnim();
      doAttack();
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!inputState.pointerLocked) return;
      // Live-read the multiplier each event — getState() is cheap and the
      // settings slider applies instantly, no re-subscribe needed.
      const sens = MOUSE_SENSITIVITY * useSettingsStore.getState().sensitivity;
      inputState.yaw -= e.movementX * sens;
      const pitch = inputState.pitch - e.movementY * sens;
      inputState.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    };

    const requestLock = (): void => {
      if (document.pointerLockElement === canvas) return;
      // Promise-wrapped: requestPointerLock can reject (e.g. Chrome blocks
      // re-locking for ~1.5s after Esc) and we don't want an unhandled
      // rejection for that. On rejection do nothing — clicking the canvas
      // tries again.
      Promise.resolve(canvas.requestPointerLock()).catch(() => {
        // Browser refused the lock; the next click tries again.
      });
    };

    const onCanvasClick = (): void => {
      if (inputState.touchMode) return; // touch input flows without lock
      if (useUIStore.getState().phase !== "playing") return;
      requestLock();
    };

    const onPointerLockChange = (): void => {
      const wasLocked = inputState.pointerLocked;
      inputState.pointerLocked = document.pointerLockElement === canvas;
      if (inputState.pointerLocked) return;
      // Esc exits pointer lock natively — don't fight it, just stop moving.
      clearMovementKeys();
      // An unlock mid-play that no UI asked for means the user pressed Esc —
      // surface the escape menu. Intentional unlocks are excluded: inventory
      // sets invOpen first, and death flips phase before exitLock runs.
      if (!wasLocked || inputState.touchMode) return;
      const ui = useUIStore.getState();
      if (ui.phase !== "playing" || ui.invOpen || ui.menuOpen) return;
      ui.setMenuOpen(true);
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

      // Re-lock when a blocking UI closes mid-play. Zustand notifies
      // synchronously, so this still runs inside the user gesture that
      // closed it (Tab keydown / the menu's Resume click) and browsers
      // allow the request. If Chrome still refuses (≈1.5s cooldown after
      // Esc), requestLock's catch swallows it and a canvas click re-locks.
      const invClosed = !state.invOpen && prev.invOpen;
      const menuClosed = !state.menuOpen && prev.menuOpen;
      if (
        (invClosed || menuClosed) &&
        state.phase === "playing" &&
        !state.invOpen &&
        !state.menuOpen &&
        !inputState.touchMode
      ) {
        requestLock();
      }
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
