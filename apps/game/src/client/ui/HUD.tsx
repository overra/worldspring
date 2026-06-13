// In-game overlay: vitals, hotbar, crosshair/prompt, clock/ping, notices,
// damage vignette and the full inventory panel. Pure DOM — no three.js.
// pointer-events: none everywhere except the hotbar and inventory panel.

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  INVENTORY_SLOTS,
  MAX_FOOD,
  MAX_HP,
  MAX_WATER,
  TEMP_SHIVER,
} from "@worldspring/shared/constants";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { ItemKind, ItemStack } from "@worldspring/shared/items";
import { doDrop, doEquip, doUse } from "@/client/net/connection";
import { debugStats } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { ChatPanel } from "./ChatPanel";
import { RecapStats } from "./DeathScreen";
import "./ui.css";

const USABLE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "food",
  "drink",
  "heal",
  "placeable",
  "tool", // added M1: canteen fill/boil/drink, fishing rod, torch-equip parity with F key
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
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
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
                  // Missing icon: fall back to the flat color swatch.
                  e.currentTarget.style.background = (ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).color;
                  e.currentTarget.style.visibility = "visible";
                  e.currentTarget.removeAttribute("src");
                }}
              />
            )}
            {stack !== null && stack.count > 1 && (
              <span className="hotbar-count">{stack.count}</span>
            )}
          </button>
        );
      })}
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

// --- top-right: clock, players online, ping ---

function StatusCorner(): ReactElement {
  const clockHours = useUIStore((s) => s.clockHours);
  const playerCount = useUIStore((s) => s.playerCount);
  const pingMs = useUIStore((s) => s.pingMs);
  return (
    <div className="hud-status">
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
          e.currentTarget.style.background = def.color;
          e.currentTarget.removeAttribute("src");
        }}
      />
      <span className="inv-name">{def.name}</span>
      <span className="inv-count">×{stack.count}</span>
      <span className="inv-kind">{def.kind}</span>
      <span className="inv-actions">
        {USABLE_KINDS.has(def.kind) && (
          <button className="inv-btn" onClick={() => doUse(slot)}>
            USE
          </button>
        )}
        <button className="inv-btn" onClick={() => doDrop(slot)}>
          DROP
        </button>
      </span>
    </div>
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
        {Array.from({ length: INVENTORY_SLOTS }, (_, i) => (
          <InventoryRow key={i} slot={i} stack={inventory[i] ?? null} />
        ))}
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
      <PickupPrompt />
      <VitalsPanel />
      <ChatPanel />
      <Hotbar />
      <InventoryPanel />
    </div>
  );
}
