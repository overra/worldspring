// The Tab panel: carry grid (+ pack), worn equipment, the selected item's detail
// card — the shell every mode gets, since every mode has an inventory. What a
// mode adds beside it (survival: condition + crafting) comes through the HUD
// seam's InvSlot, not from here (docs/plans/00). Every readout is derived from
// the store's mirror of the server's inv message and ITEM_DEFS — the panel has
// no state of its own beyond which cell you are inspecting and which tab is up.

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { INVENTORY_SLOTS } from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import type { WearSlot } from "@worldspring/shared/protocol";
import { doDrop, doUnwear, doUse, doWear } from "@/client/net/connection";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { modeHud } from "../hud/modes/registry";
import { ItemIcon } from "../hud/parts/ItemIcon";
import { formatClock } from "../hud/parts/StatusCorner";
import { KIND_HUE, USABLE_KINDS, defOf, detailFacts, usedSlots } from "./items";
import "./inventory.css";

// --- carry grid ---

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
      title={def.name}
      onClick={() => onInspect(slot)}
      onDoubleClick={() => {
        if (def.kind === "wear") {
          doWear(slot);
          return;
        }
        if (USABLE_KINDS.has(def.kind)) doUse(slot);
      }}
    >
      {index}
      <span className="ui-cell-stripe" style={{ color: KIND_HUE[def.kind] }} />
      <ItemIcon type={stack.type} className="ui-cell-icon" />
      {stack.count > 1 && <span className="ui-cell-count">{stack.count}</span>}
    </button>
  );
}

// --- equipment: exactly two wear slots (body, back) + the held item ---

const WEAR_SLOT_LABELS: Record<WearSlot, string> = { body: "body", back: "back" };

interface WearRowProps {
  label: string;
  stack: ItemStack | null;
  /** Absent = the read-only HELD mirror of the equipped hotbar slot. */
  onRemove?: () => void;
}

function WearRow({ label, stack, onRemove }: WearRowProps): ReactElement {
  const classes = ["inv-eq-row"];
  if (onRemove === undefined) classes.push("inv-eq-row--held");
  else if (stack !== null) classes.push("inv-eq-row--worn");
  return (
    <div className={classes.join(" ")}>
      <span className="ui-label inv-eq-slot">{label}</span>
      {stack === null ? (
        <>
          <span className="inv-eq-icon" />
          <span className="inv-eq-name inv-eq-name--empty">—</span>
        </>
      ) : (
        <>
          <ItemIcon type={stack.type} className="inv-eq-icon" />
          <span className="inv-eq-name">{defOf(stack.type).name}</span>
          {onRemove !== undefined && (
            <button className="ui-btn ui-btn--secondary inv-eq-btn" onClick={onRemove}>
              Remove
            </button>
          )}
        </>
      )}
    </div>
  );
}

// --- detail card (desktop) / action bar (mobile) ---

interface DetailProps {
  slot: number | null;
  stack: ItemStack | null;
  equipped: boolean;
  onDropped: () => void;
}

function DetailCard({ slot, stack, equipped, onDropped }: DetailProps): ReactElement {
  if (slot === null || stack === null) {
    return (
      <section className="inv-detail inv-detail--empty">
        <span className="ui-hint">select an item</span>
      </section>
    );
  }
  const def = defOf(stack.type);
  return (
    <section className="inv-detail">
      <div className="inv-detail-main">
        <ItemIcon type={stack.type} className="inv-detail-icon" />
        <div className="inv-detail-text">
          <div className="inv-detail-head">
            <span className="ui-title">{def.name}</span>
            <span className="ui-chip" style={{ color: KIND_HUE[def.kind] }}>
              {def.kind}
            </span>
          </div>
          <div className="inv-detail-facts">{detailFacts(def, stack.count).join(" · ")}</div>
        </div>
      </div>
      <div className="inv-detail-actions">
        {def.kind === "wear" && (
          <button className="ui-btn" onClick={() => doWear(slot)}>
            Wear
          </button>
        )}
        {USABLE_KINDS.has(def.kind) && (
          <button className="ui-btn" onClick={() => doUse(slot)}>
            Use
          </button>
        )}
        {def.kind === "ranged" && equipped && (
          // The server binds the reload channel to selectedSlot, so RELOAD is
          // only offered on the held weapon — USE on an unequipped gun no-ops.
          <button className="ui-btn" onClick={() => doUse(slot)}>
            Reload
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
    </section>
  );
}

// --- panel ---

// "craft" is the mode-slot tab, whatever the mode calls it: inventory.css keys
// the narrow-screen reveal on these two ids (and on the slot's own section
// classes), so they are the stylesheet's names, not survival's.
type InvTab = "carry" | "craft";

export function InventoryPanel(): ReactElement | null {
  const invOpen = useUIStore((s) => s.invOpen);
  const inventory = useUIStore((s) => s.inventory);
  const worn = useUIStore((s) => s.worn);
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  const playerName = useUIStore((s) => s.playerName);
  const clockHours = useUIStore((s) => s.clockHours);
  const [inspected, setInspected] = useState<number | null>(null);
  const [tab, setTab] = useState<InvTab>("carry");
  // Module read of the session's mode, same as HUD's. A mode with no InvSlot has
  // nothing in the side column but the detail card, so it gets no tab bar either
  // — `tab` can then never leave "carry".
  const modeInv = modeHud(clientWorld.config.mode)?.InvSlot;

  // A fresh open starts on CARRY with nothing inspected.
  useEffect(() => {
    if (invOpen) return;
    setInspected(null);
    setTab("carry");
  }, [invOpen]);

  if (!invOpen) return null;

  const capacity = inventory.length;
  const packSlots = Math.max(0, capacity - INVENTORY_SLOTS);
  // The pack shrinks the instant the backpack comes off, so an index that fell
  // out of range (or emptied) reads as nothing inspected rather than stale.
  const inspectedStack = inspected === null ? null : (inventory[inspected] ?? null);
  const inspectedSlot = inspectedStack === null ? null : inspected;
  const held = inventory[selectedSlot] ?? null;

  return (
    <div
      className="hud-inv-backdrop"
      onClick={(e) => {
        // Backdrop only — clicks inside the panel land on a child.
        if (e.target === e.currentTarget) useUIStore.getState().setInvOpen(false);
      }}
    >
      <div className={`hud-inv hud-inv--flush inv-panel inv-panel--${tab}`}>
        <header className="ui-panel-head inv-head">
          <div className="inv-who">
            <span className="ui-eyebrow inv-kicker">Field kit</span>
            <span className="ui-title">{playerName}</span>
          </div>
          <div className="inv-meta">
            <span className="ui-num">
              Slots {usedSlots(inventory)} / {capacity}
            </span>
            <span className="ui-num ui-num--sm">{formatClock(clockHours)}</span>
            <span className="inv-tab-hint">
              <span className="ui-key">Tab</span>
              <span className="ui-label">close</span>
            </span>
            <button
              className="inv-close"
              aria-label="close inventory"
              onClick={() => useUIStore.getState().setInvOpen(false)}
            >
              ×
            </button>
          </div>
        </header>

        {modeInv !== undefined && (
          <div className="inv-seg">
            <button
              className={tab === "carry" ? "inv-seg-btn inv-seg-btn--active" : "inv-seg-btn"}
              onClick={() => setTab("carry")}
            >
              Carry
            </button>
            <button
              className={tab === "craft" ? "inv-seg-btn inv-seg-btn--active" : "inv-seg-btn"}
              onClick={() => setTab("craft")}
            >
              {modeInv.tabLabel}
            </button>
          </div>
        )}

        <div className="inv-body">
          <div className="inv-main">
            <section className="inv-sec">
              <div className="inv-sec-head">
                <span className="ui-eyebrow">Carry</span>
                <span className="ui-num ui-num--sm">
                  {usedSlots(inventory)} / {capacity}
                </span>
              </div>
              <div className="ui-grid">
                {Array.from({ length: Math.min(INVENTORY_SLOTS, capacity) }, (_, i) => (
                  <Cell
                    key={i}
                    slot={i}
                    stack={inventory[i] ?? null}
                    equipped={i === selectedSlot}
                    inspected={i === inspectedSlot}
                    onInspect={setInspected}
                  />
                ))}
              </div>
              {/* Pack slots exist only while a backpack is worn; they are
                  storage-only (the server's equipSlot bound is 0–7). */}
              {packSlots > 0 && (
                <>
                  <div className="ui-eyebrow inv-pack-head">Pack</div>
                  <div className="ui-grid">
                    {Array.from({ length: packSlots }, (_, i) => (
                      <Cell
                        key={INVENTORY_SLOTS + i}
                        slot={INVENTORY_SLOTS + i}
                        stack={inventory[INVENTORY_SLOTS + i] ?? null}
                        equipped={false}
                        inspected={INVENTORY_SLOTS + i === inspectedSlot}
                        onInspect={setInspected}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="inv-sec">
              <div className="ui-eyebrow inv-sec-head">Equipment</div>
              <WearRow
                label={WEAR_SLOT_LABELS.body}
                stack={worn.body}
                onRemove={() => doUnwear("body")}
              />
              <WearRow
                label={WEAR_SLOT_LABELS.back}
                stack={worn.back}
                onRemove={() => doUnwear("back")}
              />
              <WearRow label="held" stack={held} />
            </section>
          </div>

          {/* The shell's own card leads the column; the mode's sections follow it
              (on a narrow screen the card is a pinned action bar either way). */}
          <div className="inv-side">
            <DetailCard
              slot={inspectedSlot}
              stack={inspectedStack}
              equipped={inspectedSlot === selectedSlot}
              onDropped={() => setInspected(null)}
            />
            {modeInv !== undefined && <modeInv.Section />}
          </div>
        </div>
      </div>
    </div>
  );
}
