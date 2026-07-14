import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";

/** Bottom-right key legend. Hidden under a coarse pointer (chrome.css) — a
 * device with no keyboard has its own buttons for all three.
 *
 * M is listed only while you actually carry a map, because that is exactly the
 * rule InputController enforces (doc 12: `acquire` decides who has one). A hint
 * for a key that does nothing is worse than no hint. */
export function KeyHints(): ReactElement {
  const hasMap = useUIStore((s) => s.inventory.some((stack) => stack?.type === "map"));
  return (
    <div className="hud-keyhints">
      <span>
        <span className="hud-keyhint-key">TAB</span>Inventory
      </span>
      {hasMap && (
        <span>
          <span className="hud-keyhint-key">M</span>Map
        </span>
      )}
      <span>
        <span className="hud-keyhint-key">ESC</span>Menu
      </span>
    </div>
  );
}
