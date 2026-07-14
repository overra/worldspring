import type { ReactElement } from "react";
import { INVENTORY_SLOTS } from "@worldspring/shared/constants";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import { doEquip } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import { ItemIcon } from "./ItemIcon";
import { countOf } from "./items";

export function Hotbar(): ReactElement {
  const inventory = useUIStore((s) => s.inventory);
  const selectedSlot = useUIStore((s) => s.selectedSlot);
  const setSelectedSlot = useUIStore((s) => s.setSelectedSlot);

  return (
    <div className="hud-hotbar">
      {Array.from({ length: INVENTORY_SLOTS }, (_, i) => {
        const stack = inventory[i] ?? null;
        const classes = ["hotbar-slot"];
        if (stack !== null) classes.push("hotbar-slot--filled");
        if (i === selectedSlot) classes.push("hotbar-slot--selected");
        return (
          <button
            key={i}
            className={classes.join(" ")}
            onClick={() => {
              doEquip(i);
              setSelectedSlot(i);
            }}
          >
            <span className="hotbar-index">{i + 1}</span>
            {stack !== null && (
              <ItemIcon
                className="hotbar-swatch hotbar-icon"
                type={stack.type}
                alt={(ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).name}
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

// Loaded-mag / reserve for the EQUIPPED ranged weapon, read straight from the
// inv-message mirror in the store: `stack.mag` rides each inventory stack
// (absent ⇒ full mag), reserve is the summed matching ammo. Renders nothing
// unless a ranged weapon is selected. Rendered INSIDE .hud-hotbar so the CSS
// can anchor it to the bar's top edge — it then tracks every responsive
// relocation of the hotbar without mirroring media queries. The "[R] reload"
// hint doubles as the empty-mag prompt (the server also auto-reloads on an
// empty trigger pull); it hides while the reload cast is already running
// (the cast bar owns that feedback) and on touch via CSS (no R key there).
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
