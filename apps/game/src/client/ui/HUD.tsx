// In-game overlay root. Shared chrome (aim, items, chat, clock, ping, notices,
// cast bar) + the HUD module of whatever GameMode the server runs — survival's
// vitals are one mode's skin, not engine core (docs/plans/00). Pure DOM — no
// three.js. pointer-events: none everywhere except the hotbar and the panels.
//
// The crate / code-pad panels below are the last non-chrome, non-mode residents
// of this file; they move to ui/inventory/ with the rest of group (b).

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { ItemStack } from "@worldspring/shared/items";
import { doContainerMove, doSetCode, doTryCode } from "@/client/net/connection";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { Chrome } from "./hud/Chrome";
import { modeHud } from "./hud/modes/registry";
import { InventoryPanel } from "./inventory/InventoryPanel";
import "./ui.css";

// --- code pad (doc 06 M5): 4-digit lock overlay ---

const PAD_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * The 4-digit code-pad overlay. mode "try" = unlock a locked door (auto-
 * submits tryCode on the 4th digit; the pad closes when the door's sState
 * open arrives — a wrong code keeps it up with the server's notice). mode
 * "set" = owner sets/changes the code (setCode) or removes the lock (empty
 * code). Buttons for touch parity; a document keydown mirrors them for
 * desktop (InputController yields the keyboard while the pad is open).
 */
function CodePad(): ReactElement | null {
  const pad = useUIStore((s) => s.codePad);
  const [digits, setDigits] = useState("");
  const padKey = pad === null ? "" : `${pad.id}|${pad.mode}`;

  // Fresh entry whenever the pad opens or retargets.
  useEffect(() => {
    setDigits("");
  }, [padKey]);

  useEffect(() => {
    if (pad === null) return;
    const submitTry = (code: string): void => {
      doTryCode(pad.id, code);
      setDigits(""); // wrong-code retry starts clean; success closes via sState
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") {
        e.preventDefault();
        useUIStore.getState().setCodePad(null);
        return;
      }
      if (e.code === "Backspace") {
        e.preventDefault();
        setDigits((d) => d.slice(0, -1));
        return;
      }
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        setDigits((d) => {
          if (d.length >= 4) return d;
          const next = d + e.key;
          if (next.length === 4 && pad.mode === "try") {
            submitTry(next);
            return "";
          }
          return next;
        });
        return;
      }
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        setDigits((d) => {
          if (d.length !== 4) return d;
          if (pad.mode === "try") {
            submitTry(d);
          } else {
            doSetCode(pad.id, d);
            useUIStore.getState().setCodePad(null);
          }
          return "";
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pad]);

  if (pad === null) return null;
  const ui = useUIStore.getState();

  const press = (digit: string): void => {
    if (digits.length >= 4) return;
    const next = digits + digit;
    if (next.length === 4 && pad.mode === "try") {
      doTryCode(pad.id, next);
      setDigits("");
      return;
    }
    setDigits(next);
  };
  const submitSet = (): void => {
    if (digits.length !== 4) return;
    doSetCode(pad.id, digits);
    ui.setCodePad(null);
  };

  return (
    <div
      className="hud-inv-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.setCodePad(null);
      }}
    >
      <div className="hud-codepad">
        <div className="inv-title">{pad.mode === "try" ? "ENTER CODE" : "SET DOOR CODE"}</div>
        <div className="codepad-display">
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className={i < digits.length ? "codepad-cell codepad-cell--set" : "codepad-cell"}>
              {i < digits.length ? "●" : "·"}
            </span>
          ))}
        </div>
        <div className="codepad-grid">
          {PAD_DIGITS.map((d) => (
            <button key={d} className="codepad-btn" onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button className="codepad-btn" onClick={() => setDigits((d) => d.slice(0, -1))}>
            ⌫
          </button>
          <button className="codepad-btn" onClick={() => press("0")}>
            0
          </button>
          {pad.mode === "set" ? (
            <button className="codepad-btn codepad-btn--ok" disabled={digits.length !== 4} onClick={submitSet}>
              SET
            </button>
          ) : (
            <button
              className="codepad-btn codepad-btn--ok"
              disabled={digits.length !== 4}
              onClick={() => {
                doTryCode(pad.id, digits);
                setDigits("");
              }}
            >
              OK
            </button>
          )}
        </div>
        <div className="codepad-actions">
          {pad.mode === "set" && (
            <button
              className="inv-btn"
              onClick={() => {
                doSetCode(pad.id, "");
                ui.setCodePad(null);
              }}
            >
              REMOVE LOCK
            </button>
          )}
          <button className="inv-btn" onClick={() => ui.setCodePad(null)}>
            CANCEL
          </button>
        </div>
        {pad.mode === "set" && (
          <div className="inv-hint">setting a code revokes everyone it was shared with</div>
        )}
      </div>
    </div>
  );
}

// --- crate panel (doc 06 M6): 12-slot container beside the inventory ---

/** First empty index in a fixed slot array, or -1. */
function firstEmpty(slots: ReadonlyArray<ItemStack | null>): number {
  return slots.findIndex((s) => s === null);
}

/**
 * The storage-crate panel: the crate's 12 fixed slots + your inventory, with
 * one-tap whole-stack moves (cMove — the server replies authoritative cont +
 * inv). Closes on walk-away (NetSystem's range check), on E, and on backdrop
 * click. The target slot is picked client-side as the first empty; the
 * server re-validates everything.
 */
function CratePanel(): ReactElement | null {
  const container = useUIStore((s) => s.container);
  const inventory = useUIStore((s) => s.inventory);
  if (container === null) return null;
  const crateFree = firstEmpty(container.slots);
  const invFree = firstEmpty(inventory);

  return (
    <div
      className="hud-inv-backdrop hud-crate-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) useUIStore.getState().setContainer(null);
      }}
    >
      <div className="hud-crate">
        <div className="inv-title">STORAGE CRATE</div>
        {container.slots.map((stack, i) => (
          <div key={i} className="inv-row">
            <span className="inv-slot-num">{i + 1}</span>
            {stack === null ? (
              <span className="inv-empty">empty</span>
            ) : (
              <>
                <span className="inv-name">{(ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).name}</span>
                <span className="inv-count">×{stack.count}</span>
                <span className="inv-actions">
                  <button
                    className="inv-btn"
                    disabled={invFree === -1}
                    onClick={() => doContainerMove(container.id, i, invFree, "out")}
                  >
                    TAKE
                  </button>
                </span>
              </>
            )}
          </div>
        ))}
        <div className="inv-title inv-subtitle">YOUR ITEMS</div>
        {inventory.map((stack, i) =>
          stack === null ? null : (
            <div key={i} className="inv-row">
              <span className="inv-slot-num">{i + 1}</span>
              <span className="inv-name">{(ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).name}</span>
              <span className="inv-count">×{stack.count}</span>
              <span className="inv-actions">
                <button
                  className="inv-btn"
                  disabled={crateFree === -1}
                  onClick={() => doContainerMove(container.id, i, crateFree, "in")}
                >
                  STORE
                </button>
              </span>
            </div>
          ),
        )}
        <div className="inv-hint">walk away or press E to close</div>
      </div>
    </div>
  );
}

// --- root ---

export function HUD(): ReactElement {
  // welcome.config lands (clamped) before App mounts the HUD and never changes
  // mid-session, so this is a module read, not a store subscription — same
  // rationale as StatusCorner's and Minimap's map-config reads. A mode with no
  // HUD module renders the shared chrome alone.
  const mode = modeHud(clientWorld.config.mode);
  return (
    <div className="hud">
      <Chrome mode={mode} />
      {mode !== null && <mode.Hud />}
      <InventoryPanel />
      <CratePanel />
      <CodePad />
    </div>
  );
}
