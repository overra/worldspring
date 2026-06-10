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
} from "@/shared/constants";
import { ITEM_DEFS } from "@/shared/items";
import type { ItemKind, ItemStack } from "@/shared/items";
import { doDrop, doEquip, doUse } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import "./ui.css";

const USABLE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "food",
  "drink",
  "heal",
  "placeable",
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
              <span
                className="hotbar-swatch"
                style={{ background: ITEM_DEFS[stack.type].color }}
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
  const def = ITEM_DEFS[stack.type];
  return (
    <div className="inv-row">
      <span className="inv-slot-num">{slot + 1}</span>
      <span className="inv-swatch" style={{ background: def.color }} />
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

export function HUD(): ReactElement {
  return (
    <div className="hud">
      <DamageFlash />
      <Notices />
      <StatusCorner />
      <div className="hud-crosshair" />
      <PickupPrompt />
      <VitalsPanel />
      <Hotbar />
      <InventoryPanel />
    </div>
  );
}
