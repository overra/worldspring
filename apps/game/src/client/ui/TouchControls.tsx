// Touch input layer: virtual joystick (move + push-to-rim sprint), drag-to-
// look, and action buttons for coarse-pointer devices. Pure DOM — writes
// inputState (touch acts as an input controller under the runtime ownership
// contract) and calls net action helpers on button taps. No React state at
// touch-move rate: the joystick nub is positioned via style mutation and the
// camera via inputState; React only re-renders at visibility rate (phase,
// pickup prompt, the HUD surfaces that stand this layer down).
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
import type { ReactElement, ReactNode } from "react";
import type { WirePiece } from "@worldspring/shared/protocol";
import { buildState, clientWorld, inputState, triggerLocalAttackAnim } from "@/client/runtime";
import { attackAnimAllowed, useUIStore } from "@/client/state/store";
import { useSettingsStore } from "@/client/state/settings";
import {
  doAttack,
  doContainerOpen,
  doDoor,
  doEnterVehicle,
  doExitVehicle,
  doPickup,
  doPlace,
} from "@/client/net/connection";
import "./touch.css";

/** Full-deflection distance when the base circle cannot be measured (it is
 * sized in touch.css and read off the DOM at gesture start, so the nub always
 * lands exactly on the rim — see applyStick). Only a zero-size layout, which
 * the gesture handlers can't produce, falls back to this. */
const STICK_RADIUS_FALLBACK_PX = 60;
const STICK_DEADZONE = 0.15; // normalized deflection below which input is 0
const STICK_SPRINT_AT = 0.95; // push past 95% of the rim to sprint
const LOOK_SENSITIVITY = 0.005; // rad per px at sensitivity 1
const PITCH_LIMIT = 1.45; // rad — same clamp as InputController

/** Surfaces a look-drag must never start on. `.ui-panel` is the panel primitive
 * every modal composes, so a panel that renames its own class stays excluded;
 * the explicit classes cover the ones that predate it. */
const LOOK_EXCLUDE =
  "button, input, [data-tc], .ui-panel, .hud-inv, .hud-codepad, .map-panel";

/** No gameplay input through UI. `mapOpen` mirrors InputController's canMove
 * gate: the map overlay covers the whole screen on a phone, so a drag on it
 * must not steer the camera underneath. A crate is covered by `invOpen`: it now
 * opens INSIDE the workspace (as its NEARBY section) rather than as its own
 * panel, so it blocks gameplay like any other open panel — walking away is no
 * longer its close gesture. */
function gameplayBlocked(): boolean {
  const ui = useUIStore.getState();
  return (
    ui.invOpen ||
    ui.menuOpen ||
    ui.chatOpen ||
    ui.mapOpen ||
    ui.codePad !== null ||
    ui.phase !== "playing"
  );
}

/** Verb for the interact button, matching what its tap will actually do (the
 * E-key priority order in InputController). The prompt ids live on clientWorld,
 * but `prompt` — which this component subscribes to — changes whenever the
 * target does, so the read is never a frame stale in practice. */
function interactVerb(seated: boolean): string {
  if (seated) return "EXIT";
  if (clientWorld.promptLootId !== null) return "TAKE";
  if (clientWorld.promptDoorId !== null || clientWorld.promptCrateId !== null) return "OPEN";
  return "RIDE";
}

/** The cluster's icons. Glyph for a verb that never changes (JUMP, BAG, the
 * attack swing); a WORD for one that does (the interact button reads TAKE /
 * OPEN / RIDE / EXIT — an icon cannot say which). Drawn inline, like
 * VitalsPanel's: there is no shared icon module, and these are used once.
 *
 * No emoji glyphs anywhere: U+2699 and friends have an emoji presentation on
 * iOS and Android, which paints a color icon into a monochrome UI. */
function Icon({ size, children }: { size: number; children: ReactNode }): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function MenuIcon(): ReactElement {
  return <Icon size={20}>{<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />}</Icon>;
}

function ChatIcon(): ReactElement {
  return (
    <Icon size={20}>
      <path d="M16.8 11.8a2.2 2.2 0 0 1-2.2 2.2H7.3L4 16.6V5.7a2.2 2.2 0 0 1 2.2-2.2h8.4a2.2 2.2 0 0 1 2.2 2.2z" />
    </Icon>
  );
}

function JumpIcon(): ReactElement {
  return <Icon size={22}>{<path d="M10 16.5V4.6M5.2 9.4 10 4.6l4.8 4.8" />}</Icon>;
}

function BagIcon(): ReactElement {
  return (
    <Icon size={20}>
      <path d="M7 6.6V5.4a3 3 0 0 1 6 0v1.2" />
      <rect x="3.6" y="6.6" width="12.8" height="10" rx="3" />
      <path d="M7.6 11h4.8" />
    </Icon>
  );
}

/** The broadhead: the design's FIRE glyph. It reads as "the offensive tap" for
 * every weapon class, and for the build-mode place the button captures. */
function AttackIcon(): ReactElement {
  return <Icon size={22}>{<path d="M10 3.2 15.8 16.4 10 13.9 4.2 16.4z" />}</Icon>;
}

export function TouchControls(): ReactElement | null {
  const [isTouch] = useState<boolean>(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  const phase = useUIStore((s) => s.phase);
  const prompt = useUIStore((s) => s.prompt);
  // The three surfaces that live INSIDE .hud (z-index 5) — this layer is 6, so
  // it paints over them. See hudSurfaceOpen below.
  const invOpen = useUIStore((s) => s.invOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const codePadOpen = useUIStore((s) => s.codePad !== null);
  // doc 06 M5 — a door in range shows the LOCK button (L-key touch parity).
  const doorPromptId = useUIStore((s) => s.doorPromptId);
  // doc 13 M4 — seated, the interact button becomes EXIT (E-key parity).
  const vehicleSeat = useUIStore((s) => s.vehicleSeat);

  /** This layer stands DOWN — it does not merely go inert — while any surface in
   * the HUD layer is up. Those three (the inventory workspace, the chat input
   * row, the code pad) render inside `.hud` at z-index 5; `.touch-root` is 6, so
   * every thumb control paints ON them, and `.tc-btn`/`.tc-stick-zone` are
   * pointer-events:auto, so they SWALLOW the taps as well as cover them. On a
   * phone the workspace is full-bleed and its × sits at the foot of the rail —
   * directly under the joystick zone — so leaving this layer up means the bag
   * cannot be closed with its own close button and the item sheet's USE/DROP row
   * is half unreachable. Each of the three carries its own dismissal (the ×, the
   * pad's CANCEL, the chat backdrop), and those become reachable exactly because
   * this layer is gone.
   *
   * The overlays that paint ABOVE this layer are deliberately NOT here: the map
   * and the escape menu are z-index 8 and already cover it. They are still in
   * gameplayBlocked() — covering the stick is not the same as gating it. */
  const hudSurfaceOpen = invOpen || chatOpen || codePadOpen;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLDivElement | null>(null);
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
  //
  // Torn down with the layer while a HUD surface is up. That teardown is load-
  // bearing: its resetStick() zeroes a stick the finger was still holding when
  // the panel opened, so the walk stops (and PlayerCamera's locomotion, which
  // reads analogX/analogZ with no UI gate of its own, drops back to idle).
  useEffect(() => {
    if (!isTouch || phase !== "playing" || hudSurfaceOpen) return;
    const root = rootRef.current;
    const zone = zoneRef.current;
    const base = baseRef.current;
    const nub = nubRef.current;
    if (root === null || zone === null || base === null || nub === null) return;

    let stickId: number | null = null;
    let stickOriginX = 0;
    let stickOriginY = 0;
    let stickRadius = STICK_RADIUS_FALLBACK_PX;
    let lookId: number | null = null;
    let lookLastX = 0;
    let lookLastY = 0;

    /** Stand the stick down WITHOUT dropping the gesture: the finger is still on
     * the glass, so its identifier has to survive to touchend. Used when a
     * blocking surface opens mid-drag. */
    const zeroStick = (): void => {
      inputState.analogX = 0;
      inputState.analogZ = 0;
      inputState.sprint = false;
      nub.style.transform = "translate(-50%, -50%)";
    };

    const resetStick = (): void => {
      stickId = null;
      zeroStick();
    };

    const applyStick = (clientX: number, clientY: number): void => {
      const dx = (clientX - stickOriginX) / stickRadius;
      const dy = (clientY - stickOriginY) / stickRadius;
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
      const reach = Math.min(mag, 1) * stickRadius;
      const nx = mag > 0 ? (dx / mag) * reach : 0;
      const ny = mag > 0 ? (dy / mag) * reach : 0;
      nub.style.transform = `translate(calc(${nx}px - 50%), calc(${ny}px - 50%))`;
    };

    const onZoneTouchStart = (e: TouchEvent): void => {
      // No gameplay input through UI — the same gate the look drag takes. The
      // zone is unmounted while a HUD surface is up, so in practice this catches
      // the overlays that paint above this layer (map, escape menu). It bails
      // BEFORE preventDefault: a gesture this handler will not act on must not
      // be consumed either, or it is stolen from whatever it was actually aimed
      // at. mapOpen is the one that bites — NetSystem's move gate does not carry
      // it, so a stick that writes analogX behind the map really does walk you.
      if (gameplayBlocked()) {
        resetStick();
        return;
      }
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
      // The base is sized in touch.css and scales with the viewport, so full
      // deflection is whatever its rendered radius is — hard-coding it would
      // let the nub over- or under-run the rim at every size but one. Measured
      // per gesture (not per move): one layout read, no touch-move cost.
      const baseWidth = base.getBoundingClientRect().width;
      stickRadius = baseWidth > 0 ? baseWidth / 2 : STICK_RADIUS_FALLBACK_PX;
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
          // doc 13 M4 — seated: the tap leaves the vehicle, exactly as E does
          // (highest priority, so a rider is never stuck in the seat).
          if (ui.vehicleSeat !== null) {
            doExitVehicle();
            return;
          }
          const lootId = clientWorld.promptLootId;
          if (lootId !== null) {
            doPickup(lootId);
            return;
          }
          // doc 06 — no loot in range: the tap works a nearby door/gate,
          // mirroring InputController's E handler exactly — a locked door
          // with no cached grant opens the code pad instead of a doomed
          // toggle round-trip (M5 touch parity).
          const doorId = clientWorld.promptDoorId;
          if (doorId !== null) {
            const piece = clientWorld.world?.structures.pieces.get(doorId) as
              | WirePiece
              | undefined;
            const needsCode =
              piece?.locked === true && !clientWorld.unlockedDoors.has(doorId);
            if (needsCode) ui.setCodePad({ id: doorId, mode: "try" });
            else doDoor(doorId);
            return;
          }
          // doc 06 M6 — open a nearby storage crate (E parity).
          const crateId = clientWorld.promptCrateId;
          if (crateId !== null) {
            doContainerOpen(crateId);
            return;
          }
          // doc 13 M4 — last: board a nearby vehicle, driver seat first (the
          // joystick already steers once seated: NetSystem folds analogX/analogZ
          // into steer/throttle, so boarding was the only missing touch verb).
          const vehId = clientWorld.promptVehicleId;
          if (vehId !== null) {
            const seats = clientWorld.bodies.get(vehId)?.seats;
            doEnterVehicle(vehId, seats !== undefined && seats[0] !== null ? 1 : 0);
          }
          return;
        }
        case "lock": {
          // doc 06 M5 — the L-key parity button: owner set/change/remove a
          // door code (server enforces ownership).
          if (gameplayBlocked()) return;
          const lockDoorId = clientWorld.promptDoorId;
          if (lockDoorId !== null) ui.setCodePad({ id: lockDoorId, mode: "set" });
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
        if (target.closest(LOOK_EXCLUDE) !== null) continue;
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
          handled = true;
          // Same contract as the look branch: keep tracking the finger, stop
          // steering. Reached when a surface this layer does NOT stand down for
          // (map, escape menu) opens under a thumb that is already on the stick.
          if (gameplayBlocked()) {
            zeroStick();
            continue;
          }
          applyStick(t.clientX, t.clientY);
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
  }, [isTouch, phase, hudSurfaceOpen]);

  if (!isTouch || phase !== "playing" || hudSurfaceOpen) return null;

  return (
    <div ref={rootRef} className="touch-root">
      <div ref={zoneRef} className="tc-stick-zone">
        <div ref={baseRef} className="tc-stick-base">
          <div ref={nubRef} className="tc-stick-nub" />
        </div>
      </div>

      {/* The action cluster: an arc off the bottom-right corner, hero nearest
          the resting thumb. Order is the paint order — the two contextual
          buttons sit furthest out, so a target coming into range never moves
          the verbs the thumb already knows. */}
      <div className="tc-cluster">
        {prompt !== null && (
          <button
            type="button"
            data-tc="interact"
            aria-label={prompt}
            className="tc-btn tc-btn--interact"
          >
            {interactVerb(vehicleSeat !== null)}
          </button>
        )}
        {doorPromptId !== null && (
          <button type="button" data-tc="lock" className="tc-btn tc-btn--lock">
            LOCK
          </button>
        )}
        <button type="button" data-tc="attack" className="tc-btn tc-btn--attack">
          <AttackIcon />
          <span className="tc-btn-label">ATTACK</span>
        </button>
        <button type="button" data-tc="jump" aria-label="Jump" className="tc-btn tc-btn--jump">
          <JumpIcon />
        </button>
        {/* Opens the workspace only. It has no latched state because it cannot
            be on screen while the workspace is: the panel's own × closes it. */}
        <button type="button" data-tc="bag" aria-label="Inventory" className="tc-btn tc-btn--bag">
          <BagIcon />
        </button>
      </div>

      {/* Top-left, just right of the relocated vitals — clear of the
          joystick, cluster and the top-right status/menu stack. */}
      <button type="button" data-tc="chat" aria-label="Chat" className="tc-btn tc-btn--chat">
        <ChatIcon />
      </button>

      <button type="button" data-tc="menu" aria-label="Menu" className="tc-btn tc-btn--menu">
        <MenuIcon />
      </button>
    </div>
  );
}
