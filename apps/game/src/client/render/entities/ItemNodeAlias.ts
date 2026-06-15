// Side-effect-free shared constant: which ItemTypes render from a different
// (shared) items.glb node than their own name. Kept in its own module so both
// the character rig (held items) and ground loot can import it without dragging
// in CharacterRig.ts's module-level useGLTF.preload side effects.

import type { ItemType } from "@worldspring/shared/items";

/**
 * The canteen is one mesh; its three water states (empty/dirty/clean) differ
 * only by item name + UI swatch, never the canvas — so all three resolve to the
 * single `canteen` node instead of duplicating geometry. Consumed by both the
 * held-item registry (CharacterRig.ts) and ground loot (LootItems.tsx).
 */
export const ITEM_NODE_ALIAS: Partial<Record<ItemType, string>> = {
  canteen_empty: "canteen",
  canteen_dirty: "canteen",
  canteen_clean: "canteen",
};
