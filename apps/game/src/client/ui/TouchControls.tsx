// Touch input layer: virtual joystick (move + push-to-rim sprint), drag-to-
// look, and action buttons for coarse-pointer devices. Pure DOM — writes
// inputState (touch acts as an input controller under the runtime ownership
// contract) and calls net action helpers on button taps. No React state at
// touch-move rate: the joystick nub is positioned via style mutation and the
// camera via inputState; React only re-renders at visibility rate (phase,
// pickup prompt, inventory-open).
//
// Detection: `(pointer: coarse)` matches the device's PRIMARY pointer. Phones
// and tablets report coarse; a desktop/laptop with a touchscreen still
// reports its mouse/trackpad (fine) as primary, so it correctly keeps
// keyboard + pointer-lock and never sees this overlay. Checked once at mount
// (useState initializer) — a device's primary pointer doesn't change
// mid-session.
//
// All button/joystick handlers are native non-passive listeners (not React
// props): React 17+ registers root touchstart/touchmove listeners as passive,
// so preventDefault — required to stop synthetic mouse events from
// double-firing the desktop handlers — would be ignored.

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { buildState, clientWorld, inputState, triggerLocalAttackAnim } from "@/client/runtime";
import { attackAnimAllowed, useUIStore } from "@/client/state/store";
import { useSettingsStore } from "@/client/state/settings";
import { doAttack, doDoor, doPickup, doPlace } from "@/client/net/connection";
import "./ui.css";

const STICK_RADIUS_PX = 60; // base circle is 120px in ui.css
const STICK_DEADZONE = 0.15; // normalized deflection below which input is 0
const STICK_SPRINT_AT = 0.95; // push past 95% of the rim to sprint
const LOOK_SENSITIVITY = 0.005; // rad per px at sensitivity 1
const PITCH_LIMIT = 1.45; // rad — same clamp as InputController

/** Same gate as NetSystem/InputController: no gameplay input through UI. */
function gameplayBlocked(): boolean {
  const ui = useUIStore.getState();
  return ui.invOpen || ui.menuOpen || ui.chatOpen || ui.phase !== "playing";
}

export function TouchControls(): ReactElement | null {
  const [isTouch] = useState<boolean>(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  const phase = useUIStore((s) => s.phase);
  const prompt = useUIStore((s) => s.prompt);
  const invOpen = useUIStore((s) => s.invOpen);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const nubRef = useRef<HTMLDivElement | null>(null);

  // Touch mode flag: while playing or on the death screen, gameplay input
  // flows without pointer lock. Cleared on unmount (back to menu).
  useEffect(() => {
    if (!isTouch) return;
    inputState.touchMode = phase === "playing" || phase === "dead";
    return () => {
      inputState.touchMode = false;
    };
  }, [isTouch, phase]);

  // Gesture wiring. Touch-identifier tracking keeps the joystick (left thumb)
  // and the look drag (right thumb) fully independent for multi-touch.
  useEffect(() => {
    if (!isTouch || phase !== "playing") return;
    const root = rootRef.current;
    const zone = zoneRef.current;
    const nub = nubRef.current;
    if (root === null || zone === null || nub === null) return;

    let stickId: number | null = null;
    let stickOriginX = 0;
    let stickOriginY = 0;
    let lookId: number | null = null;
    let lookLastX = 0;
    let lookLastY = 0;

    const resetStick = (): void => {
      stickId = null;
      inputState.analogX = 0;
      inputState.analogZ = 0;
      inputState.sprint = false;
      nub.style.transform = "translate(-50%, -50%)";
    };

    const applyStick = (clientX: number, clientY: number): void => {
      const dx = (clientX - stickOriginX) / STICK_RADIUS_PX;
      const dy = (clientY - stickOriginY) / STICK_RADIUS_PX;
      const mag = Math.hypot(dx, dy);
      // Classic push-to-the-edge sprint: engage past the rim, release below.
      inputState.sprint = mag >= STICK_SPRINT_AT;
      if (mag < STICK_DEADZONE) {
        inputState.analogX = 0;
        inputState.analogZ = 0;
      } else {
        // Remap deadzone..1 → 0..1 so the walk/run nuance survives the
        // deadzone; magnitude (not just direction) feeds the move vector.
        // Screen-up (negative dy) is forward (negative Z in cmd space).
        const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
        inputState.analogX = (dx / mag) * scaled;
        inputState.analogZ = (dy / mag) * scaled;
      }
      // Nub visual: deflection from the base center, clamped to the rim.
      // Style mutation only — never React state at touch-move rate.
      const reach = Math.min(mag, 1) * STICK_RADIUS_PX;
      const nx = mag > 0 ? (dx / mag) * reach : 0;
      const ny = mag > 0 ? (dy / mag) * reach : 0;
      nub.style.transform = `translate(calc(${nx}px - 50%), calc(${ny}px - 50%))`;
    };

    const onZoneTouchStart = (e: TouchEvent): void => {
      // The zone is a pure control surface: always swallow the gesture so it
      // never scrolls the page or replays as a synthetic mouse click.
      e.preventDefault();
      if (stickId !== null) return;
      const t = e.changedTouches.item(0);
      if (t === null) return;
      stickId = t.identifier;
      // Anchor at the touch point (relative stick): deflection is measured
      // from wherever the thumb landed inside the zone, not the base center.
      stickOriginX = t.clientX;
      stickOriginY = t.clientY;
      applyStick(t.clientX, t.clientY);
    };

    // Buttons: delegated by data-tc so one non-passive listener covers the
    // whole overlay. Acting on touchstart keeps actions snappy (no 300ms
    // click delay) and preventDefault stops the follow-up synthetic
    // mousedown/click from double-firing desktop handlers.
    const onRootTouchStart = (e: TouchEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest<HTMLElement>("[data-tc]");
      if (btn === null) return;
      e.preventDefault();
      e.stopPropagation(); // a button tap never becomes a look drag
      const ui = useUIStore.getState();
      switch (btn.dataset.tc) {
        case "attack":
          if (gameplayBlocked()) return;
          // doc 06 — build mode captures the tap exactly like desktop LMB
          // (InputController.onMouseDown): a green ghost places, a red one
          // does nothing, and the tap NEVER falls through to an attack — the
          // hammer is a tool, not a weapon.
          if (buildState.active) {
            if (buildState.valid && buildState.target !== null) doPlace(buildState.target);
            return;
          }
          // Attack always goes to the server (an empty-mag pull triggers the
          // auto-reload) but the local swing only animates when a shot can
          // actually happen — no phantom fire on a dry mag or mid-reload.
          if (attackAnimAllowed()) triggerLocalAttackAnim();
          doAttack();
          return;
        case "jump":
          if (gameplayBlocked()) return;
          inputState.jump = true; // edge flag; NetSystem consumes it
          return;
        case "interact": {
          if (gameplayBlocked()) return;
          const lootId = clientWorld.promptLootId;
          if (lootId !== null) {
            doPickup(lootId);
            return;
          }
          // doc 06 — no loot in range: the tap toggles a nearby door/gate,
          // mirroring InputController's E handler (the prompt already reads
          // "Open door" — without this the button was a no-op on doors).
          const doorId = clientWorld.promptDoorId;
          if (doorId !== null) doDoor(doorId);
          return;
        }
        case "bag":
          if (ui.menuOpen || ui.chatOpen || ui.phase !== "playing") return;
          ui.setInvOpen(!ui.invOpen);
          return;
        case "chat":
          if (ui.menuOpen || ui.chatOpen || ui.phase !== "playing") return;
          if (ui.invOpen) ui.setInvOpen(false); // chat replaces the bag panel
          ui.openChat();
          return;
        case "menu":
          if (ui.menuOpen || ui.chatOpen || ui.phase !== "playing") return;
          ui.setMenuOpen(true);
          return;
        default:
          return;
      }
    };

    // Look drag: any touch that is not on interactive UI and not in the
    // joystick zone steers the camera. Registered on document (bubble) so it
    // catches canvas touches; button taps stopPropagation before reaching it
    // and the closest() check below is the belt-and-suspenders filter for
    // HUD buttons/panels that don't.
    const onDocTouchStart = (e: TouchEvent): void => {
      if (lookId !== null) return;
      if (gameplayBlocked()) return;
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        const t = e.changedTouches.item(i);
        if (t === null || t.identifier === stickId) continue;
        const target = t.target;
        if (!(target instanceof Element)) continue;
        if (zone.contains(target)) continue; // stick zone never look-drags
        if (target.closest("button, input, [data-tc], .hud-inv") !== null) continue;
        lookId = t.identifier;
        lookLastX = t.clientX;
        lookLastY = t.clientY;
        return;
      }
    };

    const onTouchMove = (e: TouchEvent): void => {
      let handled = false;
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        const t = e.changedTouches.item(i);
        if (t === null) continue;
        if (t.identifier === stickId) {
          applyStick(t.clientX, t.clientY);
          handled = true;
        } else if (t.identifier === lookId) {
          const dx = t.clientX - lookLastX;
          const dy = t.clientY - lookLastY;
          lookLastX = t.clientX;
          lookLastY = t.clientY;
          handled = true;
          if (gameplayBlocked()) continue; // keep tracking, stop steering
          // Live-read sensitivity each event (same pattern as mouse look).
          const sens = LOOK_SENSITIVITY * useSettingsStore.getState().sensitivity;
          inputState.yaw -= dx * sens;
          const pitch = inputState.pitch - dy * sens;
          inputState.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
        }
      }
      if (handled) e.preventDefault(); // our gesture: no scroll/zoom/refresh
    };

    const onTouchEnd = (e: TouchEvent): void => {
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        const t = e.changedTouches.item(i);
        if (t === null) continue;
        if (t.identifier === stickId) resetStick();
        else if (t.identifier === lookId) lookId = null;
      }
    };

    // Non-passive wherever preventDefault is needed; the doc-level start
    // handler only claims identifiers, so it can stay passive.
    zone.addEventListener("touchstart", onZoneTouchStart, { passive: false });
    root.addEventListener("touchstart", onRootTouchStart, { passive: false });
    document.addEventListener("touchstart", onDocTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);

    return () => {
      zone.removeEventListener("touchstart", onZoneTouchStart);
      root.removeEventListener("touchstart", onRootTouchStart);
      document.removeEventListener("touchstart", onDocTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      resetStick();
      lookId = null;
    };
  }, [isTouch, phase]);

  if (!isTouch || phase !== "playing") return null;

  return (
    <div ref={rootRef} className="touch-root">
      <div ref={zoneRef} className="tc-stick-zone">
        <div className="tc-stick-base">
          <div ref={nubRef} className="tc-stick-nub" />
        </div>
      </div>

      <div className="tc-cluster">
        {prompt !== null && (
          <button type="button" data-tc="interact" className="tc-btn tc-btn--interact">
            TAKE
          </button>
        )}
        <button type="button" data-tc="attack" className="tc-btn tc-btn--attack">
          ATTACK
        </button>
        <button type="button" data-tc="jump" className="tc-btn tc-btn--jump">
          JUMP
        </button>
        <button
          type="button"
          data-tc="bag"
          className={invOpen ? "tc-btn tc-btn--bag tc-btn--active" : "tc-btn tc-btn--bag"}
        >
          BAG
        </button>
      </div>

      {/* Top-left, just right of the relocated vitals — clear of the
          joystick, cluster and the top-right status/menu stack. */}
      <button type="button" data-tc="chat" aria-label="Chat" className="tc-btn tc-btn--chat">
        CHAT
      </button>

      <button type="button" data-tc="menu" aria-label="Menu" className="tc-btn tc-btn--menu">
        ⚙
      </button>
    </div>
  );
}
