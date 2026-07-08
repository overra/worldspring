// Keyboard + pointer-lock mouse input. Writes inputState (the only writer per
// the runtime contract) and fires net action helpers on edges. Returns null —
// it renders nothing, it only wires document/window/canvas listeners.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { BUILD_RANGE, PLAYER_EYE_HEIGHT } from "@worldspring/shared/constants";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import { lookDir } from "@worldspring/shared/math";
import { PLACEABLE_KINDS } from "@worldspring/shared/structures";
import { buildState, clientWorld, inputState, triggerLocalAttackAnim } from "@/client/runtime";
import { attackAnimAllowed, useUIStore } from "@/client/state/store";
import { useSettingsStore } from "@/client/state/settings";
import {
  doAttack,
  doDemolish,
  doDoor,
  doDrop,
  doEquip,
  doPickup,
  doPlace,
  doUse,
} from "@/client/net/connection";

const MOUSE_SENSITIVITY = 0.0024; // rad per px at sensitivity 1
const PITCH_LIMIT = 1.45; // rad, per contract

/** doc 06 — hold X this long aiming at your own piece to demolish it. */
const DEMOLISH_HOLD_MS = 600;

/** doc 06 — the structure piece under the crosshair, or null. */
function aimedPieceId(): number | null {
  const world = clientWorld.world;
  if (!world) return null;
  const me = clientWorld.me;
  const hit = world.structures.raycastPiece(
    { x: me.x, y: me.y + PLAYER_EYE_HEIGHT, z: me.z },
    lookDir(inputState.yaw, inputState.pitch),
    BUILD_RANGE + 2,
  );
  return hit === null ? null : hit.id;
}

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

    // doc 06 — hold-X demolish: keydown arms a timer against the aimed piece;
    // keyup (or aiming away by fire time) cancels. Ownership is enforced
    // server-side (ownerHash never reaches the client) — a non-owner gets the
    // rejection notice.
    let demolishTimer: ReturnType<typeof setTimeout> | null = null;
    let demolishTargetId: number | null = null;
    const cancelDemolish = (): void => {
      if (demolishTimer !== null) clearTimeout(demolishTimer);
      demolishTimer = null;
      demolishTargetId = null;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const ui = useUIStore.getState();
      if (ui.phase !== "playing") return;

      // While the chat input is open it owns the keyboard outright — every
      // game binding below (movement, Tab, hotbar, E/G/V…) is gated off.
      // The input's own keydown handles Enter/Escape and stops propagation;
      // this gate covers keys when focus strays from the input.
      if (ui.chatOpen) return;

      if (e.code === "Tab") {
        e.preventDefault();
        if (e.repeat) return;
        if (ui.menuOpen) return; // menu has priority over inventory
        // Turning on clears movement via subscription; turning off re-locks
        // via subscription (still inside this keydown's user gesture).
        ui.setInvOpen(!ui.invOpen);
        return;
      }

      if (e.code === "KeyM") {
        if (e.repeat) return;
        if (ui.menuOpen) return;
        // Possession gates OPENING the map (doc 12: acquire decides who has one);
        // closing is always allowed, so losing the item mid-view can't trap the
        // panel open. Pointer release / re-lock ride the store subscription below.
        if (!ui.mapOpen && !ui.inventory.some((s) => s?.type === "map")) return;
        ui.setMapOpen(!ui.mapOpen);
        return;
      }

      // Movement only registers while in mouselook (or touch mode, where
      // input flows without pointer lock) — this matches the NetSystem gate
      // exactly, so the local rig never animates a walk the prediction isn't
      // actually running.
      const canMove =
        !ui.invOpen &&
        !ui.mapOpen &&
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
        case "Enter":
        case "NumpadEnter":
          // Open chat only from live gameplay — same gate as movement
          // (mouselook or touch mode, no inventory/menu). The store
          // subscription below releases the pointer, mirroring inventory.
          if (!canMove) return;
          e.preventDefault();
          ui.openChat();
          return;
        case "KeyE": {
          const lootId = clientWorld.promptLootId;
          if (lootId !== null) {
            doPickup(lootId);
            return;
          }
          // doc 06 — no loot in range: E toggles a nearby door/gate.
          const doorId = clientWorld.promptDoorId;
          if (doorId !== null) doDoor(doorId);
          return;
        }
        case "KeyQ":
          // doc 06 — cycle the build piece kind while in build mode.
          if (buildState.active) {
            buildState.kindIndex = (buildState.kindIndex + 1) % PLACEABLE_KINDS.length;
          }
          return;
        case "KeyT":
          // doc 06 — toggle wood/scrap tier while in build mode.
          if (buildState.active) buildState.tier = buildState.tier === 0 ? 1 : 0;
          return;
        case "KeyX": {
          // doc 06 — arm the hold-to-demolish timer on the aimed piece.
          if (!buildState.active || demolishTimer !== null) return;
          const id = aimedPieceId();
          if (id === null) return;
          demolishTargetId = id;
          demolishTimer = setTimeout(() => {
            demolishTimer = null;
            // Still aiming at the same piece after the hold — commit.
            if (demolishTargetId !== null && aimedPieceId() === demolishTargetId) {
              doDemolish(demolishTargetId);
            }
            demolishTargetId = null;
          }, DEMOLISH_HOLD_MS);
          return;
        }
        case "KeyF":
          // A held map opens the panel client-side (doc 12) — the item is a
          // "tool" so the server `use` is a no-op anyway; skip the round-trip.
          if (ui.inventory[ui.selectedSlot]?.type === "map") {
            ui.setMapOpen(!ui.mapOpen);
            return;
          }
          // Use the selected hotbar slot (canteen fill/boil/drink, fishing rod,
          // cooking raw food near fire). Same message the Tab panel USE button
          // sends — zero wire change. Edge-triggered only (e.repeat already
          // filtered above).
          doUse(ui.selectedSlot);
          return;
        case "KeyR": {
          // Reload the equipped ranged weapon (doc 11 M3). The wire verb is the
          // existing {t:"use", slot} — startUse routes use-on-a-ranged-weapon to
          // the reload channel — so gate on "ranged selected" client-side: an
          // ungated R on, say, beans would EAT them. Edge-triggered only
          // (e.repeat filtered above); the server validates mag/ammo and the
          // cast bar rides you.action like every channel.
          const held = ui.inventory[ui.selectedSlot];
          if (held && (ITEM_DEFS[held.type] ?? UNKNOWN_DEF).kind === "ranged") {
            doUse(ui.selectedSlot);
          }
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
      if (e.code === "KeyX") {
        cancelDemolish();
        return;
      }
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
      if (ui.invOpen || ui.chatOpen || ui.phase !== "playing") return;
      // doc 06 — build mode captures the click: a green ghost places, a red
      // one does nothing (the HUD already shows why). Never falls through to
      // an attack — the hammer is a tool, not a weapon.
      if (buildState.active) {
        if (buildState.valid && buildState.target !== null) doPlace(buildState.target);
        return;
      }
      // The attack message always goes out (an empty-mag pull is what triggers
      // the server auto-reload), but the optimistic swing animation only plays
      // when a shot is actually possible — no phantom "shots" on a dry mag or
      // mid-reload (doc 11 M3: the trigger is dead during the cast).
      if (attackAnimAllowed()) triggerLocalAttackAnim();
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
      // sets invOpen first, chat sets chatOpen first, and death flips phase
      // before exitLock runs.
      if (!wasLocked || inputState.touchMode) return;
      const ui = useUIStore.getState();
      if (ui.phase !== "playing" || ui.invOpen || ui.mapOpen || ui.menuOpen || ui.chatOpen) return;
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
      // The full map needs clicks (close-on-backdrop) — release like inventory.
      if (state.mapOpen && !prev.mapOpen) {
        clearMovementKeys();
        exitLock();
      }
      // Chat opening releases the mouse the same way: the input needs focus
      // and clicks, and a locked pointer would swallow both.
      if (state.chatOpen && !prev.chatOpen) {
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
      const mapClosed = !state.mapOpen && prev.mapOpen;
      const menuClosed = !state.menuOpen && prev.menuOpen;
      const chatClosed = !state.chatOpen && prev.chatOpen;
      if (
        (invClosed || mapClosed || menuClosed || chatClosed) &&
        state.phase === "playing" &&
        !state.invOpen &&
        !state.mapOpen &&
        !state.menuOpen &&
        !state.chatOpen &&
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
      cancelDemolish();
      clearMovementKeys();
      inputState.pointerLocked = false;
    };
  }, [gl]);

  return null;
}
