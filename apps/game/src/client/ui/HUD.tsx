// In-game overlay: vitals, hotbar, crosshair/prompt, clock/ping, notices,
// damage vignette and the full inventory panel. Pure DOM — no three.js.
// pointer-events: none everywhere except the hotbar and inventory panel.

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  FIRE_WARMTH_RADIUS,
  INVENTORY_SLOTS,
  MAX_FOOD,
  MAX_HP,
  MAX_WATER,
  TEMP_SHIVER,
  VEHICLE_FUEL_MAX,
  VEHICLE_HP_MAX,
} from "@worldspring/shared/constants";
import { ITEM_DEFS, RECIPES, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { CraftRecipe, ItemKind, ItemStack, ItemType } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import type { ChannelKind, WearSlot } from "@worldspring/shared/protocol";
import {
  doContainerMove,
  doCraft,
  doDrop,
  doEquip,
  doSetCode,
  doTryCode,
  doUnwear,
  doUse,
  doWear,
} from "@/client/net/connection";
import { clientWorld, debugStats } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { ChatPanel } from "./ChatPanel";
import { RecapStats } from "./DeathScreen";
import "./ui.css";

// Transparent 1x1 GIF. When an item has no /icons/<type>.png, the onError
// handlers swap this in as the src (and clear alt) so the browser shows neither
// a broken-image glyph nor the alt text — only the inline color-swatch fallback.
const BLANK_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const USABLE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "food",
  "drink",
  "heal",
  "placeable",
  "tool", // added M1: canteen fill/boil/drink, fishing rod, torch-equip parity with F key
  // "wear" is deliberately NOT here: wear items get the dedicated WEAR button
  // below (doc 05 §7). F-key USE still wears — the server's useItem routes
  // kind:"wear" to wearItem — but the panel shows one button, not two.
]);

function formatClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// --- vitals (bottom-left) ---

interface BarProps {
  label: string;
  value: number;
  max: number;
  fillClass: string;
}

function Bar({ label, value, max, fillClass }: BarProps): ReactElement {
  // Guard the denominator: vitals pass positive constant caps, but the cast bar
  // feeds wire-derived totalS — a zero/negative max would make value/max
  // NaN/Infinity and break the fill width. Empty bar is the safe fallback.
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bar-value">{Math.round(value)}</span>
    </div>
  );
}

function VitalsPanel(): ReactElement {
  const vitals = useUIStore((s) => s.vitals);
  const shivering = vitals.temp < TEMP_SHIVER;
  return (
    <div className="hud-vitals">
      <Bar label="HP" value={vitals.hp} max={MAX_HP} fillClass="bar-fill--hp" />
      <Bar label="FOOD" value={vitals.food} max={MAX_FOOD} fillClass="bar-fill--food" />
      <Bar label="WATER" value={vitals.water} max={MAX_WATER} fillClass="bar-fill--water" />
      <div className={shivering ? "hud-temp hud-temp--cold" : "hud-temp"}>
        <span className="hud-temp-value">{vitals.temp.toFixed(1)}°C</span>
        {shivering && <span className="hud-shiver">SHIVERING</span>}
      </div>
    </div>
  );
}

// --- damage vignette: flash whenever hp drops vs the previous render ---

function DamageFlash(): ReactElement | null {
  const hp = useUIStore((s) => s.vitals.hp);
  const prevHp = useRef(hp);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (hp < prevHp.current) setFlash((f) => f + 1);
    prevHp.current = hp;
  }, [hp]);

  if (flash === 0) return null;
  // Remounting via key restarts the 250ms fade-out animation on every hit.
  return <div key={flash} className="hud-damage-flash" />;
}

// --- hotbar (bottom-center) ---

function Hotbar(): ReactElement {
  const inventory = useUIStore((s) => s.inventory);
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  const setSelectedSlot = useUIStore((s) => s.setSelectedSlot);

  return (
    <div className="hud-hotbar">
      {Array.from({ length: INVENTORY_SLOTS }, (_, i) => {
        const stack = inventory[i] ?? null;
        const selected = i === selectedSlot;
        return (
          <button
            key={i}
            className={selected ? "hotbar-slot hotbar-slot--selected" : "hotbar-slot"}
            onClick={() => {
              doEquip(i);
              setSelectedSlot(i);
            }}
          >
            <span className="hotbar-index">{i + 1}</span>
            {stack !== null && (
              <img
                className="hotbar-swatch hotbar-icon"
                src={`/icons/${stack.type}.png`}
                alt={(ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).name}
                draggable={false}
                onError={(e) => {
                  // Missing icon: fall back to the flat color swatch. Swap in a
                  // blank pixel + clear alt so neither the broken-image glyph nor
                  // the item name renders on top of the swatch.
                  const img = e.currentTarget;
                  img.style.background = (ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).color;
                  img.style.visibility = "visible";
                  img.alt = "";
                  img.src = BLANK_PX;
                }}
              />
            )}
            {stack !== null && stack.count > 1 && (
              <span className="hotbar-count">{stack.count}</span>
            )}
          </button>
        );
      })}
      <AmmoReadout />
    </div>
  );
}

// --- ammo readout (above the hotbar, doc 11 M3) ---

// Loaded-mag / reserve for the EQUIPPED ranged weapon, read straight from the
// inv-message mirror in the store: `stack.mag` rides each inventory stack
// (absent ⇒ full mag), reserve is the summed matching ammo. Renders nothing
// unless a ranged weapon is selected. Rendered INSIDE .hud-hotbar so the CSS
// can anchor it to the bar's top edge — it then tracks every responsive
// relocation of the hotbar without mirroring media queries. The "[R] reload"
// hint doubles as the empty-mag prompt (the server also auto-reloads on an
// empty trigger pull); it hides while the reload cast is already running
// (the M2 cast bar owns that feedback) and on touch via CSS (no R key there).
function AmmoReadout(): ReactElement | null {
  const inventory = useUIStore((s) => s.inventory);
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  const channelAction = useUIStore((s) => s.channelAction);
  const stack = inventory[selectedSlot] ?? null;
  if (!stack) return null;
  const def = ITEM_DEFS[stack.type] ?? UNKNOWN_DEF;
  if (def.kind !== "ranged" || !def.ranged) return null;
  const mag = Math.max(0, Math.min(def.ranged.magSize, stack.mag ?? def.ranged.magSize));
  const reserve = countOf(inventory, def.ranged.ammo);
  const empty = mag === 0;
  const reloading = channelAction?.kind === "reload";
  return (
    <div className={empty ? "hud-ammo hud-ammo--empty" : "hud-ammo"}>
      <span className="hud-ammo-mag">{mag}</span>
      <span className="hud-ammo-sep">/</span>
      <span className="hud-ammo-reserve">{reserve}</span>
      {empty && reserve > 0 && !reloading && (
        <span className="hud-ammo-hint">
          <span className="hud-prompt-key">[R]</span> reload
        </span>
      )}
    </div>
  );
}

// --- center: crosshair + pickup prompt ---

function PickupPrompt(): ReactElement | null {
  const prompt = useUIStore((s) => s.prompt);
  if (prompt === null) return null;
  return (
    <div className="hud-prompt">
      <span className="hud-prompt-key">[E]</span> {prompt}
    </div>
  );
}

// --- doc 13 M4: driving HUD (fuel / hull / speed) ---

function VehicleMeter({ label, pct, color }: { label: string; pct: number; color: string }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <span style={{ width: 40, opacity: 0.8 }}>{label}</span>
      <span style={{ position: "relative", width: 120, height: 8, background: "rgba(255,255,255,0.15)", borderRadius: 4 }}>
        <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: color, borderRadius: 4 }} />
      </span>
      <span style={{ width: 34, textAlign: "right", opacity: 0.9 }}>{pct}%</span>
    </div>
  );
}

function VehicleHud(): ReactElement | null {
  const seat = useUIStore((s) => s.vehicleSeat);
  if (!seat) return null;
  const fuelPct = Math.round(Math.max(0, Math.min(1, seat.fuel / VEHICLE_FUEL_MAX)) * 100);
  const hullPct = Math.round(Math.max(0, Math.min(1, seat.hp / VEHICLE_HP_MAX)) * 100);
  const kmh = Math.round(seat.speed * 3.6);
  const driver = seat.index === 0;
  const empty = fuelPct === 0;
  return (
    <div
      style={{
        position: "absolute",
        right: 20,
        bottom: 120,
        padding: "10px 12px",
        background: "rgba(12,14,10,0.72)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        color: "#e6e4d8",
        fontFamily: "system-ui, sans-serif",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 210,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, letterSpacing: 1, fontSize: 12 }}>
          {driver ? "DRIVING" : "PASSENGER"}
        </span>
        <span style={{ fontSize: 20, fontWeight: 700 }}>
          {kmh}
          <span style={{ fontSize: 11, opacity: 0.7 }}> km/h</span>
        </span>
      </div>
      <VehicleMeter label="Fuel" pct={fuelPct} color={empty ? "#c8402a" : "#d8b23a"} />
      <VehicleMeter label="Hull" pct={hullPct} color={hullPct < 30 ? "#c8402a" : "#5a9a5a"} />
      <div style={{ fontSize: 11, opacity: 0.7 }}>
        {driver ? "[W/S] drive · [A/D] steer · [Shift] brake · [E] exit" : "[E] exit"}
        {empty && driver ? " — OUT OF FUEL" : ""}
      </div>
    </div>
  );
}

// --- build mode (doc 06): selected piece/tier + why the ghost is red ---

const PIECE_LABELS: Record<string, string> = {
  foundation: "Foundation",
  wall: "Wall",
  doorway: "Doorway",
  window: "Window Wall",
  door: "Door",
  gate: "Gate",
  crate: "Storage Crate",
};

function BuildPanel(): ReactElement | null {
  const info = useUIStore((s) => s.buildInfo);
  if (info === null) return null;
  return (
    <div className="hud-build">
      <div className="hud-build-row">
        <span className="hud-build-piece">
          {PIECE_LABELS[info.kind] ?? info.kind} · {info.tier === 1 ? "scrap" : "wood"}
        </span>
        {info.status !== null && <span className="hud-build-status">{info.status}</span>}
      </div>
      <div className="hud-build-hints">
        <span className="hud-prompt-key">[Q]</span> piece
        <span className="hud-prompt-key">[T]</span> tier
        <span className="hud-prompt-key">[LMB]</span> place
        <span className="hud-prompt-key">[hold X]</span> demolish
      </div>
    </div>
  );
}

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

// --- center-low: cast bar for the in-progress channeled action (doc 11 M2) ---

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  cook: "Cooking…",
  reload: "Reloading…",
  use: "Using…",
  craft: "Crafting…",
  fish: "Casting…",
};

// Server-authoritative, render-only: the bar fills toward totalS and vanishes
// the instant a snapshot arrives with you.action absent (a cook cancel's "you
// stepped out of range" feedback). Reuses the Bar primitive (value = elapsed).
function ChannelBar(): ReactElement | null {
  const action = useUIStore((s) => s.channelAction);
  if (!action) return null;
  return (
    <div className="hud-channel">
      <Bar
        label={CHANNEL_LABELS[action.kind]}
        value={action.totalS - action.remainingS}
        max={action.totalS}
        fillClass="bar-fill--channel"
      />
    </div>
  );
}

// --- top-right: clock, players online, ping ---

function StatusCorner(): ReactElement {
  const clockHours = useUIStore((s) => s.clockHours);
  const playerCount = useUIStore((s) => s.playerCount);
  const pingMs = useUIStore((s) => s.pingMs);
  // doc 12: the corner minimap sits in this same top-right slot, so drop below it
  // when it's active (config is stable per session; map.css owns the offset).
  const cls = clientWorld.config.map.minimap ? "hud-status has-minimap" : "hud-status";
  return (
    <div className={cls}>
      <div className="hud-clock">{formatClock(clockHours)}</div>
      <div>{playerCount} online</div>
      <div>{Math.round(pingMs)}ms</div>
    </div>
  );
}

// --- top-center: "last life" recap toast (died while offline) ---

function LastLifeToast(): ReactElement | null {
  const phase = useUIStore((s) => s.phase);
  const recap = useUIStore((s) => s.recap);
  const setRecap = useUIStore((s) => s.setRecap);
  if (phase !== "playing" || recap === null) return null;
  return (
    <div className="hud-lastlife">
      <div className="lastlife-head">
        <span className="lastlife-title">LAST LIFE</span>
        <button
          className="lastlife-close"
          aria-label="dismiss"
          onClick={() => setRecap(null)}
        >
          ×
        </button>
      </div>
      <p className="lastlife-msg">While you were away you died — killed by {recap.by}</p>
      <RecapStats recap={recap} />
    </div>
  );
}

// --- top-left: notices feed ---

function Notices(): ReactElement {
  const notices = useUIStore((s) => s.notices);
  return (
    <div className="hud-notices">
      {notices.slice(-5).map((n) => (
        <div key={n.id} className="hud-notice">
          {n.msg}
        </div>
      ))}
    </div>
  );
}

// --- inventory panel (Tab) ---

interface InventoryRowProps {
  slot: number;
  stack: ItemStack | null;
}

function InventoryRow({ slot, stack }: InventoryRowProps): ReactElement {
  // Hook before the early return (rules of hooks): the RELOAD button below is
  // only offered on the equipped slot.
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  if (stack === null) {
    return (
      <div className="inv-row">
        <span className="inv-slot-num">{slot + 1}</span>
        <span className="inv-empty">empty</span>
      </div>
    );
  }
  const def = ITEM_DEFS[stack.type] ?? UNKNOWN_DEF;
  return (
    <div className="inv-row">
      <span className="inv-slot-num">{slot + 1}</span>
      <img
        className="inv-swatch inv-icon"
        src={`/icons/${stack.type}.png`}
        alt=""
        draggable={false}
        onError={(e) => {
          // Missing icon: flat color swatch (blank pixel avoids the broken glyph).
          e.currentTarget.style.background = def.color;
          e.currentTarget.src = BLANK_PX;
        }}
      />
      <span className="inv-name">{def.name}</span>
      <span className="inv-count">×{stack.count}</span>
      <span className="inv-kind">{def.kind}</span>
      <span className="inv-actions">
        {def.kind === "wear" && (
          // Dedicated wear verb (doc 05 M6): both WEAR and USE converge on the
          // server's wearItem; WEAR is the discoverable label per doc 05 §7.
          <button className="inv-btn" onClick={() => doWear(slot)}>
            WEAR
          </button>
        )}
        {USABLE_KINDS.has(def.kind) && (
          <button className="inv-btn" onClick={() => doUse(slot)}>
            USE
          </button>
        )}
        {def.kind === "ranged" && slot === selectedSlot && (
          // Manual reload without a keyboard (touch parity with the R key):
          // {t:"use"} on the EQUIPPED ranged weapon is the reload verb. Gated
          // on the slot being equipped because startChannel's reload
          // precondition binds the cast to selectedSlot — USE on an unequipped
          // gun would silently no-op server-side.
          <button className="inv-btn" onClick={() => doUse(slot)}>
            RELOAD
          </button>
        )}
        <button className="inv-btn" onClick={() => doDrop(slot)}>
          DROP
        </button>
      </span>
    </div>
  );
}

// --- crafting (Tab) ---

/** Sum of `type` across the store inventory (client mirror of server countOf). */
function countOf(inventory: (ItemStack | null)[], type: ItemType): number {
  let total = 0;
  for (const stack of inventory) {
    if (stack && stack.type === type) total += stack.count;
  }
  return total;
}

/** Within FIRE_WARMTH_RADIUS of any rendered fire — cosmetic mirror of the
 * server's nearFire; the server is the authority on whether a craft succeeds. */
function nearFireClient(): boolean {
  const me = clientWorld.me;
  const rSq = FIRE_WARMTH_RADIUS * FIRE_WARMTH_RADIUS;
  for (const fire of clientWorld.fires) {
    if (distSq2D(me.x, me.z, fire.x, fire.z) <= rSq) return true;
  }
  return false;
}

interface CraftRowProps {
  recipe: CraftRecipe;
  index: number;
  inventory: (ItemStack | null)[];
}

function CraftRow({ recipe, index, inventory }: CraftRowProps): ReactElement {
  const inputsMet = recipe.inputs.every((i) => countOf(inventory, i.type) >= i.count);
  const toolMet = recipe.tool === undefined || countOf(inventory, recipe.tool) > 0;
  const stationMet = recipe.station !== "campfire" || nearFireClient();
  const enabled = inputsMet && toolMet && stationMet;

  const out = ITEM_DEFS[recipe.output.type] ?? UNKNOWN_DEF;
  const inputText = recipe.inputs
    .map((i) => `${i.count}× ${(ITEM_DEFS[i.type] ?? UNKNOWN_DEF).name}`)
    .join(", ");
  const hints: string[] = [];
  if (recipe.tool !== undefined) hints.push(`needs ${(ITEM_DEFS[recipe.tool] ?? UNKNOWN_DEF).name}`);
  if (recipe.station === "campfire") hints.push("needs campfire");

  return (
    <div className={enabled ? "craft-row" : "craft-row craft-row--disabled"}>
      <span className="craft-out">
        {out.name}
        {recipe.output.count > 1 ? ` ×${recipe.output.count}` : ""}
      </span>
      <span className="craft-inputs">{inputText}</span>
      {hints.length > 0 && <span className="craft-hint">{hints.join(" · ")}</span>}
      <button className="inv-btn" disabled={!enabled} onClick={() => doCraft(index)}>
        CRAFT
      </button>
    </div>
  );
}

// --- equipment (Tab) — doc 05 M6 ---

const WEAR_SLOT_LABELS: Record<WearSlot, string> = { body: "body", back: "back" };

function EquipmentRow({ ws, stack }: { ws: WearSlot; stack: ItemStack | null }): ReactElement {
  const def = stack ? (ITEM_DEFS[stack.type] ?? UNKNOWN_DEF) : null;
  return (
    <div className="inv-row">
      <span className="inv-slot-num">{WEAR_SLOT_LABELS[ws]}</span>
      {stack !== null && def !== null ? (
        <>
          <img
            className="inv-swatch inv-icon"
            src={`/icons/${stack.type}.png`}
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.background = def.color;
              e.currentTarget.src = BLANK_PX;
            }}
          />
          <span className="inv-name">{def.name}</span>
          <span className="inv-actions">
            <button className="inv-btn" onClick={() => doUnwear(ws)}>
              REMOVE
            </button>
          </span>
        </>
      ) : (
        <span className="inv-empty">—</span>
      )}
    </div>
  );
}

function EquipmentSection(): ReactElement {
  const worn = useUIStore((s) => s.worn);
  return (
    <>
      <div className="inv-title inv-subtitle">EQUIPMENT</div>
      <EquipmentRow ws="body" stack={worn.body} />
      <EquipmentRow ws="back" stack={worn.back} />
    </>
  );
}

function CraftingSection({ inventory }: { inventory: (ItemStack | null)[] }): ReactElement {
  return (
    <>
      <div className="inv-title inv-subtitle">CRAFTING</div>
      {RECIPES.map((recipe, i) => (
        <CraftRow key={i} recipe={recipe} index={i} inventory={inventory} />
      ))}
    </>
  );
}

function InventoryPanel(): ReactElement | null {
  const invOpen = useUIStore((s) => s.invOpen);
  const inventory = useUIStore((s) => s.inventory);
  if (!invOpen) return null;
  return (
    <div
      className="hud-inv-backdrop"
      onClick={(e) => {
        // Backdrop only — clicks inside the panel land on a child.
        if (e.target === e.currentTarget) useUIStore.getState().setInvOpen(false);
      }}
    >
      <div className="hud-inv">
        <div className="inv-title">INVENTORY</div>
        {Array.from({ length: Math.min(INVENTORY_SLOTS, inventory.length) }, (_, i) => (
          <InventoryRow key={i} slot={i} stack={inventory[i] ?? null} />
        ))}
        {/* PACK rows (doc 05 M6): slots 8+ exist only while a backpack is worn.
            Storage-only — the hotbar stays 0–7 (the server's equipSlot bound). */}
        {inventory.length > INVENTORY_SLOTS && (
          <>
            <div className="inv-title inv-subtitle">PACK</div>
            {Array.from({ length: inventory.length - INVENTORY_SLOTS }, (_, i) => (
              <InventoryRow
                key={INVENTORY_SLOTS + i}
                slot={INVENTORY_SLOTS + i}
                stack={inventory[INVENTORY_SLOTS + i] ?? null}
              />
            ))}
          </>
        )}
        <EquipmentSection />
        <CraftingSection inventory={inventory} />
        <div className="inv-hint">Tab to close</div>
      </div>
    </div>
  );
}

// --- root ---

/**
 * Visible-but-starved detector: macOS/Chrome display-throttle occluded or
 * embedded windows down to ~2Hz rAF (0Hz fully hidden) — the game looks
 * frozen/T-posed while the code is healthy. DOM timers keep firing in that
 * state, so an interval can catch it and say so. Only shown while the
 * document is visible: a fully hidden window has nobody to warn.
 */
function ThrottleWarning(): ReactElement | null {
  const [starved, setStarved] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      const stale =
        document.visibilityState === "visible" &&
        debugStats.lastFrameAt > 0 &&
        performance.now() - debugStats.lastFrameAt > 1500;
      setStarved(stale);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!starved) return null;
  return (
    <div className="hud-throttle-warning">
      window is being throttled by the OS — click the game window or unblock it
      to restore smooth play
    </div>
  );
}

export function HUD(): ReactElement {
  return (
    <div className="hud">
      <DamageFlash />
      <ThrottleWarning />
      <Notices />
      <LastLifeToast />
      <StatusCorner />
      <div className="hud-crosshair" />
      <ChannelBar />
      <BuildPanel />
      <PickupPrompt />
      <VehicleHud />
      <VitalsPanel />
      <ChatPanel />
      <Hotbar />
      <InventoryPanel />
      <CratePanel />
      <CodePad />
    </div>
  );
}
