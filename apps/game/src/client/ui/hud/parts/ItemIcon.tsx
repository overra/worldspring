import type { ReactElement } from "react";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { ItemType } from "@worldspring/shared/items";

// Transparent 1x1 GIF. When an item has no /icons/<type>.png, the onError
// handler swaps this in as the src (and clears alt) so the browser shows neither
// a broken-image glyph nor the alt text — only the inline color-swatch fallback.
const BLANK_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

interface ItemIconProps {
  type: ItemType;
  /** Site-specific box class (hotbar-swatch hotbar-icon / inv-swatch inv-icon / ui-cell-icon). */
  className: string;
  alt?: string;
}

/** The item image with its flat-color-swatch fallback — several items ship
 * without a PNG (portal_kit, hammer, fuel, pine_cone, acorn), so every icon
 * site goes through this. */
export function ItemIcon({ type, className, alt = "" }: ItemIconProps): ReactElement {
  const def = ITEM_DEFS[type] ?? UNKNOWN_DEF;
  return (
    <img
      className={className}
      src={`/icons/${type}.png`}
      alt={alt}
      draggable={false}
      onError={(e) => {
        const img = e.currentTarget;
        img.style.background = def.color;
        img.style.visibility = "visible";
        img.alt = "";
        img.src = BLANK_PX;
      }}
    />
  );
}
