// The Tab workspace: ONE tabbed surface — STORAGE + EQUIPMENT, the mode's tab
// (survival: CRAFTING), and MAP — with one section visible at a time. The shell
// every mode gets, since every mode has an inventory. What a mode adds beside it
// (survival: condition + crafting) comes through the HUD seam's InvSlot, not
// from here (docs/plans/00). Every readout is derived from the store's mirror of
// the server's inv message and ITEM_DEFS — the panel has no state of its own
// beyond which cell you are inspecting and which tab is up.
//
// Field Kit rule the layout obeys: no data is read twice. CARRY lives in the top
// bar and NOWHERE else.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { INVENTORY_SLOTS } from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import type { WearSlot, WornState } from "@worldspring/shared/protocol";
import { doContainerMove, doDrop, doUnwear, doUse, doWear } from "@/client/net/connection";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import type { ContainerState } from "@/client/state/store";
import { modeHud } from "../hud/modes/registry";
import { ItemIcon } from "../hud/parts/ItemIcon";
import { formatClock } from "../hud/parts/StatusCorner";
import { MapCanvas, MapLegend, mapIsFogged } from "../MapPanel";
import { KIND_HUE, defOf, detailFacts, freeSlots, primaryVerb, usedSlots } from "./items";
import "./inventory.css";

// --- tabs ---

/** The workspace's sections. "mode" is the GameMode's own tab, whatever it calls
 * itself (survival: CRAFT) — inventory.css keys the tab reveal on these ids and
 * on the mode section's own .inv-cond / .inv-craft class names, so they are the
 * stylesheet's names, not survival's. There is no JOURNAL: nothing backs it. */
type TabId = "carry" | "mode" | "map";

/** 24px stroked glyphs, currentColor. They ARE the tab under a coarse pointer —
 * the rail drops the labels (design frame 04). */
const TAB_ICONS: Record<TabId, string> = {
  carry:
    "M8.5 6V4.6A2.6 2.6 0 0 1 11.1 2h1.8A2.6 2.6 0 0 1 15.5 4.6V6M6.6 6h10.8A2.6 2.6 0 0 1 20 8.6v9.8A2.6 2.6 0 0 1 17.4 21H6.6A2.6 2.6 0 0 1 4 18.4V8.6A2.6 2.6 0 0 1 6.6 6ZM9 12.5h6",
  mode: "M20.6 6.4a4.8 4.8 0 0 1-6.2 6.2l-8 8a2 2 0 0 1-2.9-2.9l8-8a4.8 4.8 0 0 1 6.2-6.2l-2.9 2.9.7 3.3 3.3.7Z",
  map: "M9 4 3.6 6.3v13.4L9 17.4m0-13.4 6 2.3m-6-2.3v13.4m6-11.1 5.4-2.3v13.4L15 19.7m0-13.4v13.4m0 0-6-2.3",
};

const CLOSE_ICON = "M6.5 6.5l11 11M17.5 6.5l-11 11";

/** The top bar's CARRY glyph — a pack, because carry is measured in slots. */
const CARRY_ICON = TAB_ICONS.carry;

function Glyph({ path, className }: { path: string; className: string }): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

// --- item cells ---

interface CellProps {
  slot: number;
  stack: ItemStack | null;
  equipped: boolean;
  inspected: boolean;
  onInspect: (slot: number) => void;
}

function Cell({ slot, stack, equipped, inspected, onInspect }: CellProps): ReactElement {
  // Pack slots (8+) are storage-only: the hotbar digit keys bind 0–7, so their
  // index is informational and reads back.
  const index = (
    <span className={slot < INVENTORY_SLOTS ? "ui-cell-index" : "ui-cell-index inv-cell-index--pack"}>
      {slot + 1}
    </span>
  );
  if (stack === null) {
    return (
      <div className="ui-cell" aria-hidden>
        {index}
      </div>
    );
  }
  const def = defOf(stack.type);
  const classes = ["ui-cell", "ui-cell--filled"];
  if (equipped) classes.push("ui-cell--equipped");
  if (inspected) classes.push("ui-cell--selected");
  return (
    <button
      className={classes.join(" ")}
      // The popover anchors to this node by slot (see the layout effect below) —
      // a ref map would have to survive every re-render of the grid.
      data-slot={slot}
      title={def.name}
      onClick={() => onInspect(slot)}
      // Same predicate as the popover's hero button, and it has to be: the
      // popover prints "double-click the cell to {verb}", so a cell that acts on
      // a different set of kinds than primaryVerb answers for makes that hint a
      // lie (it did, for RELOAD — an equipped gun has a verb and "ranged" is not
      // a USABLE_KIND). One predicate, one verb, both surfaces.
      onDoubleClick={() => {
        if (primaryVerb(def, equipped) === null) return;
        if (def.kind === "wear") {
          doWear(slot);
          return;
        }
        doUse(slot);
      }}
    >
      {index}
      <span className="ui-cell-stripe" style={{ color: KIND_HUE[def.kind] }} />
      <ItemIcon type={stack.type} className="ui-cell-icon" />
      {stack.count > 1 && <span className="ui-cell-count">{stack.count}</span>}
    </button>
  );
}

// --- storage: the one grid (hotbar slots + whatever the worn pack adds) ---

interface StorageProps {
  inventory: (ItemStack | null)[];
  selectedSlot: number;
  inspectedSlot: number | null;
  packName: string | null;
  onInspect: (slot: number) => void;
}

function Storage({
  inventory,
  selectedSlot,
  inspectedSlot,
  packName,
  onInspect,
}: StorageProps): ReactElement {
  return (
    <section className="inv-sec inv-storage">
      {/* No slot count here. The design's storage head reads `13/24` BESIDE a
          kg weight in the top bar — two different figures. Ours would be the
          same number twice, and the one rule this layout is built on is that no
          data is read twice. CARRY lives in the top bar. */}
      <div className="inv-sec-head">
        <span className="ui-eyebrow">Storage{packName === null ? "" : ` · ${packName}`}</span>
      </div>
      <div className="ui-grid inv-grid">
        {inventory.map((stack, i) => (
          <Cell
            key={i}
            slot={i}
            stack={stack}
            equipped={i === selectedSlot}
            inspected={i === inspectedSlot}
            onInspect={onInspect}
          />
        ))}
      </div>
    </section>
  );
}

// --- nearby: the open crate (doc 06 M6), in the workspace beside your storage ---

interface NearbyProps {
  container: ContainerState;
  inventory: (ItemStack | null)[];
}

function Nearby({ container, inventory }: NearbyProps): ReactElement {
  const free = freeSlots(inventory);

  // The server moves a whole stack into an EMPTY slot only and never merges
  // (structures.ts handleContainerMove), so each take needs its own destination.
  // Precomputing distinct free indices is exact rather than optimistic: message
  // N fills exactly the slot it names, so the ones picked for N+1… stay empty.
  // The server re-validates every one of them.
  const takeAll = (): void => {
    let n = 0;
    for (let i = 0; i < container.slots.length && n < free.length; i += 1) {
      const to = free[n];
      if (container.slots[i] === null || to === undefined) continue;
      doContainerMove(container.id, i, to, "out");
      n += 1;
    }
  };

  const takeable = container.slots.some((s) => s !== null) && free.length > 0;
  return (
    <section className="inv-sec inv-nearby">
      <div className="inv-sec-head">
        <span className="ui-eyebrow">Nearby · Storage crate</span>
        <button className="ui-btn inv-takeall" disabled={!takeable} onClick={takeAll}>
          Take all
        </button>
      </div>
      <div className="ui-grid inv-grid">
        {container.slots.map((stack, i) => {
          if (stack === null) return <div key={i} className="ui-cell" aria-hidden />;
          const def = defOf(stack.type);
          const to = free[0];
          return (
            // Click TAKES — the crate is not a place you inspect from, and one
            // tap is the gesture the panel it replaces already used.
            <button
              key={i}
              className="ui-cell ui-cell--filled"
              title={`Take ${def.name}`}
              disabled={to === undefined}
              onClick={() => {
                if (to === undefined) return;
                doContainerMove(container.id, i, to, "out");
              }}
            >
              <span className="ui-cell-stripe" style={{ color: KIND_HUE[def.kind] }} />
              <ItemIcon type={stack.type} className="ui-cell-icon" />
              {stack.count > 1 && <span className="ui-cell-count">{stack.count}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// --- equipment: the paperdoll. Exactly two wear slots (body, back) + the held item ---

const WEAR_SLOT_LABELS: Record<WearSlot, string> = { body: "Body", back: "Back" };

interface SlotCardProps {
  label: string;
  stack: ItemStack | null;
  /** Absent = the read-only HELD mirror of the equipped hotbar slot. */
  onRemove?: () => void;
}

function SlotCard({ label, stack, onRemove }: SlotCardProps): ReactElement {
  const classes = ["inv-eq"];
  if (onRemove === undefined) classes.push("inv-eq--held");
  else if (stack !== null) classes.push("inv-eq--worn");
  return (
    <div className={classes.join(" ")}>
      <span className="inv-eq-icon">
        {stack !== null && <ItemIcon type={stack.type} className="inv-eq-img" />}
      </span>
      <span className="inv-eq-text">
        <span className="ui-label inv-eq-slot">{label}</span>
        <span className={stack === null ? "inv-eq-name inv-eq-name--empty" : "inv-eq-name"}>
          {stack === null ? "Empty" : defOf(stack.type).name}
        </span>
      </span>
      {stack !== null && onRemove !== undefined && (
        <button className="inv-eq-remove" aria-label={`Remove ${defOf(stack.type).name}`} onClick={onRemove}>
          <Glyph path={CLOSE_ICON} className="inv-eq-remove-glyph" />
        </button>
      )}
    </div>
  );
}

/** The silhouette. Traced from the design (frame 01) — decorative: the game has
 * no character-model preview to rotate here, so it carries no "drag to rotate"
 * affordance either. */
function Paperdoll(): ReactElement {
  return (
    <div className="inv-doll" aria-hidden>
      <svg
        viewBox="0 0 200 400"
        className="inv-doll-svg"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="100" cy="52" r="30" />
        <path d="M100 82v22" />
        <path d="M64 116q36 -16 72 0l-7 92q-29 11 -58 0z" />
        <path d="M66 120l-20 88 9 6 24 -80" />
        <path d="M134 120l20 88 -9 6 -24 -80" />
        <path d="M76 208l-6 118 20 0 10 -96 10 96 20 0 -6 -118" />
      </svg>
    </div>
  );
}

interface EquipmentProps {
  worn: WornState;
  held: ItemStack | null;
}

function Equipment({ worn, held }: EquipmentProps): ReactElement {
  return (
    <section className="inv-sec inv-equip">
      <div className="inv-sec-head">
        <span className="ui-eyebrow">Equipment</span>
      </div>
      {/* Two columns of slot cards flanking the doll — the design's shape. The
          game has exactly three: two worn (body, back) and the held mirror. */}
      <div className="inv-equip-body">
        <div className="inv-eq-col">
          <SlotCard
            label={WEAR_SLOT_LABELS.body}
            stack={worn.body}
            onRemove={() => doUnwear("body")}
          />
          <SlotCard
            label={WEAR_SLOT_LABELS.back}
            stack={worn.back}
            onRemove={() => doUnwear("back")}
          />
        </div>
        <Paperdoll />
        <div className="inv-eq-col">
          <SlotCard label="Held" stack={held} />
        </div>
      </div>
    </section>
  );
}

// --- item popover (desktop) / action sheet (touch) ---

/** Must match --inv-pop-w in inventory.css: the anchor math needs the width in
 * JS, the sheet needs it in CSS, and there is no third place to keep it. */
const POP_W = 290;
const POP_GAP = 10;

interface PopoverProps {
  slot: number;
  stack: ItemStack;
  equipped: boolean;
  anchor: Anchor | null;
  onDropped: () => void;
  onClose: () => void;
}

function ItemPopover({
  slot,
  stack,
  equipped,
  anchor,
  onDropped,
  onClose,
}: PopoverProps): ReactElement {
  const def = defOf(stack.type);
  const verb = primaryVerb(def, equipped);
  const classes = ["ui-panel", "ui-panel--deep", "inv-pop"];
  if (anchor?.flip === true) classes.push("inv-pop--flip");
  // Custom properties, not `left`/`top`: an inline left/top would out-specify
  // the coarse-pointer rules that turn this card into a bottom sheet.
  const style = {
    "--inv-pop-x": `${anchor?.x ?? 0}px`,
    "--inv-pop-y": `${anchor?.y ?? 0}px`,
  } as CSSProperties;
  return (
    <div className={classes.join(" ")} style={style}>
      <span className="inv-pop-tail" aria-hidden />
      <div className="inv-pop-head">
        <span className="inv-pop-icon">
          <ItemIcon type={stack.type} className="inv-pop-img" />
        </span>
        <div className="inv-pop-title">
          <div className="inv-pop-name">
            <span className="ui-title">{def.name}</span>
            <span className="ui-chip ui-chip--solid" style={{ color: KIND_HUE[def.kind] }}>
              {def.kind}
            </span>
          </div>
          <div className="ui-num ui-num--sm">
            {detailFacts(def, stack.count).join(" · ")}
          </div>
        </div>
        <button className="inv-pop-close" aria-label="Close item" onClick={onClose}>
          <Glyph path={CLOSE_ICON} className="inv-pop-close-glyph" />
        </button>
      </div>
      {/* ItemDef carries no description, so the design's prose line is omitted
          rather than invented. */}
      <div className="inv-pop-actions">
        {verb !== null && (
          <button
            className="ui-btn ui-btn--primary inv-pop-verb"
            onClick={() => (def.kind === "wear" ? doWear(slot) : doUse(slot))}
          >
            {verb}
          </button>
        )}
        <button
          className="ui-btn ui-btn--secondary"
          onClick={() => {
            doDrop(slot);
            onDropped();
          }}
        >
          Drop
        </button>
      </div>
      {verb !== null && <div className="ui-hint inv-pop-hint">double-click the cell to {verb.toLowerCase()}</div>}
    </div>
  );
}

// --- panel ---

interface Anchor {
  x: number;
  y: number;
  /** The card would overflow the workspace on the right — hang it left instead. */
  flip: boolean;
}

export function InventoryPanel(): ReactElement | null {
  const invOpen = useUIStore((s) => s.invOpen);
  const inventory = useUIStore((s) => s.inventory);
  const worn = useUIStore((s) => s.worn);
  const container = useUIStore((s) => s.container);
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  const playerName = useUIStore((s) => s.playerName);
  const clockHours = useUIStore((s) => s.clockHours);
  const mapOpen = useUIStore((s) => s.mapOpen);
  const [inspected, setInspected] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>("carry");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Module read of the session's mode, same as HUD's. A mode with no InvSlot has
  // no tab of its own — `tab` can then never be "mode".
  const modeInv = modeHud(clientWorld.config.mode)?.InvSlot;
  // Possession gates the MAP tab exactly as it gates the M key (InputController:
  // doc 12 — acquire decides who has one).
  const hasMap = inventory.some((s) => s?.type === "map");

  // A fresh open starts on the storage tab with nothing inspected.
  useEffect(() => {
    if (invOpen) return;
    setInspected(null);
    setTab("carry");
  }, [invOpen]);

  // An opening container must force the CARRY tab, not merely reset it on close.
  // NEARBY only renders under CARRY, and pressing E at a crate while the workspace
  // is already open on MAP/CRAFT does not transition invOpen — so without this the
  // container opens, the pointer lock is released, and NOTHING renders.
  useEffect(() => {
    if (container === null) return;
    setTab("carry");
  }, [container]);

  // The popover hangs off a grid cell, so its anchor is only valid for the
  // layout that produced it.
  useEffect(() => {
    if (!invOpen) return;
    const onResize = (): void => setResizeTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [invOpen]);

  // The pack shrinks the instant the backpack comes off, so an index that fell
  // out of range (or emptied) reads as nothing inspected rather than stale.
  const inspectedStack = inspected === null ? null : (inventory[inspected] ?? null);
  const inspectedSlot = inspectedStack === null ? null : inspected;

  // Measure AFTER layout, before paint — the card must not flash at 0,0. Reading
  // the cell by [data-slot] beats a ref map: the grid re-renders on every inv
  // message and the DOM is the only thing that survives that unchanged.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null || inspectedSlot === null || tab !== "carry") {
      setAnchor(null);
      return;
    }
    const cell = body.querySelector<HTMLElement>(`[data-slot="${inspectedSlot}"]`);
    if (cell === null) {
      setAnchor(null);
      return;
    }
    const b = body.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const flip = c.right - b.left + POP_GAP + POP_W > b.width;
    setAnchor({
      x: flip ? c.left - b.left - POP_GAP - POP_W : c.right - b.left + POP_GAP,
      // Keep the card's head level with the cell, but never below the fold.
      y: Math.max(0, Math.min(c.top - b.top, b.height - 200)),
      flip,
    });
  }, [inspectedSlot, tab, invOpen, resizeTick, inventory.length]);

  if (!invOpen) return null;

  const held = inventory[selectedSlot] ?? null;
  const used = usedSlots(inventory);
  const capacity = inventory.length;
  const packName = worn.back === null ? null : defOf(worn.back.type).name;

  const tabs: { id: TabId; label: string }[] = [
    { id: "carry", label: "Inventory" },
    ...(modeInv === undefined ? [] : [{ id: "mode" as const, label: modeInv.tabLabel }]),
    ...(hasMap ? [{ id: "map" as const, label: "Map" }] : []),
  ];

  // The popover is a pinned bottom SHEET under a coarse pointer, so the pane
  // must reserve room for it or its last card is unreachable.
  const picked = tab === "carry" && inspectedSlot !== null && inspectedStack !== null;

  const close = (): void => useUIStore.getState().setInvOpen(false);
  const pickTab = (id: TabId): void => {
    setTab(id);
    setInspected(null); // the popover belongs to the storage grid
  };

  return (
    <div
      className="ui-backdrop ui-backdrop--scrim inv-backdrop"
      onClick={(e) => {
        // Backdrop only — clicks inside the panel land on a child.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`ui-panel ui-panel--xl hud-inv inv-panel inv-panel--${tab}${picked ? " inv-panel--picked" : ""}`}
      >
        <header className="inv-bar">
          <div className="inv-who">
            <span className="inv-mono" aria-hidden>
              {playerName.slice(0, 1).toUpperCase()}
            </span>
            <span className="inv-who-text">
              <span className="ui-eyebrow inv-kicker">Field kit</span>
              <span className="ui-title inv-who-name">{playerName}</span>
            </span>
          </div>

          <nav className="inv-tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={t.id === tab ? "inv-tab inv-tab--on" : "inv-tab"}
                aria-current={t.id === tab}
                onClick={() => pickTab(t.id)}
              >
                <Glyph path={TAB_ICONS[t.id]} className="inv-tab-icon" />
                <span className="inv-tab-label">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="inv-meta">
            {/* CARRY. The one place it is read — the design is explicit, and the
                server has no weight model, so the unit is slots. */}
            <div className="inv-carry">
              <Glyph path={CARRY_ICON} className="inv-carry-icon" />
              <div className="inv-carry-read">
                <div className="ui-num inv-carry-num">
                  {used}
                  <span className="inv-num-of"> / {capacity} slots</span>
                </div>
                <div className="inv-carry-track">
                  <span
                    className="inv-carry-fill"
                    style={{ width: `${capacity > 0 ? (used / capacity) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
            <span className="ui-num inv-clock">{formatClock(clockHours)}</span>
            <span className="inv-tab-hint">
              <span className="ui-key">Tab</span>
              <span className="ui-label">close</span>
            </span>
          </div>

          <button className="inv-close" aria-label="Close inventory" onClick={close}>
            <Glyph path={CLOSE_ICON} className="inv-close-glyph" />
          </button>
        </header>

        <div className="inv-body" ref={bodyRef}>
          {tab === "carry" && (
            <>
              <div className="inv-col inv-col--store">
                <Storage
                  inventory={inventory}
                  selectedSlot={selectedSlot}
                  inspectedSlot={inspectedSlot}
                  packName={packName}
                  onInspect={setInspected}
                />
                {container !== null && <Nearby container={container} inventory={inventory} />}
              </div>
              <div className="inv-col inv-col--gear">
                <Equipment worn={worn} held={held} />
              </div>
            </>
          )}

          {tab === "map" && (
            <section className="inv-sec inv-map">
              <div className="inv-sec-head">
                <span className="ui-eyebrow">Island map</span>
                {mapIsFogged() && <span className="ui-chip">Fog of war</span>}
              </div>
              <div className="inv-map-body">
                {/* The standalone M panel outranks this one (map.css z-index 8),
                    so while it is up this canvas stands down — one MapCanvas,
                    one redraw interval, one mapBake chunk fetch. */}
                {mapOpen ? (
                  <p className="ui-hint inv-map-note">The map is open over the world — press M to close it.</p>
                ) : (
                  <MapCanvas className="inv-map-canvas" />
                )}
              </div>
              <div className="inv-map-foot">
                <MapLegend />
              </div>
            </section>
          )}

          {/* The mode's own sections. Mounted ONCE, in the grid area the active
              tab gives them: the condition strip sits under EQUIPMENT on the
              storage tab, the recipe list fills the workspace on the mode's own.
              inventory.css reveals one and hides the other by the section class
              names the mode uses (.inv-cond / .inv-craft) — the same contract
              the narrow-screen reveal has always used. */}
          {modeInv !== undefined && tab !== "map" && (
            <div className="inv-slot">
              <modeInv.Section />
            </div>
          )}

          {picked && inspectedSlot !== null && inspectedStack !== null && (
            <ItemPopover
              slot={inspectedSlot}
              stack={inspectedStack}
              equipped={inspectedSlot === selectedSlot}
              anchor={anchor}
              onDropped={() => setInspected(null)}
              onClose={() => setInspected(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
