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
} from "@worldspring/shared/constants";
import { ITEM_DEFS, RECIPES, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { CraftRecipe, ItemKind, ItemStack, ItemType } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import type { ChannelKind } from "@worldspring/shared/protocol";
import { doCraft, doDrop, doEquip, doUse } from "@/client/net/connection";
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
        {Array.from({ length: INVENTORY_SLOTS }, (_, i) => (
          <InventoryRow key={i} slot={i} stack={inventory[i] ?? null} />
        ))}
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
      <PickupPrompt />
      <VitalsPanel />
      <ChatPanel />
      <Hotbar />
      <InventoryPanel />
    </div>
  );
}
