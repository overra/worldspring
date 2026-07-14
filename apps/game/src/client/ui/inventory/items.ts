// Item helpers shared by the Tab panel's grid, detail card and crafting list.
// Everything here is derived from ITEM_DEFS / the store mirror of the server's
// inv message — no readout in the panel exists that the game cannot back.

import { FIRE_WARMTH_RADIUS } from "@worldspring/shared/constants";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import type { ItemDef, ItemKind, ItemStack, ItemType } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import { clientWorld } from "@/client/runtime";

/** Kinds the panel offers a USE button for. "wear" is deliberately absent — it
 * gets the dedicated WEAR button (doc 05 §7), though the server's useItem
 * routes it to wearItem either way. */
export const USABLE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "food",
  "drink",
  "heal",
  "placeable",
  "tool",
]);

/** ItemKind → the cell stripe / detail chip hue. Applied inline: a stylesheet
 * rule would have to out-specify the .ui-cell-stripe/.ui-chip primitives and
 * would then depend on sheet order. */
export const KIND_HUE: Record<ItemKind, string> = {
  food: "var(--ui-kind-food)",
  drink: "var(--ui-kind-drink)",
  heal: "var(--ui-kind-heal)",
  melee: "var(--ui-kind-melee)",
  ranged: "var(--ui-kind-ranged)",
  ammo: "var(--ui-kind-ammo)",
  placeable: "var(--ui-kind-placeable)",
  tool: "var(--ui-kind-tool)",
  material: "var(--ui-kind-material)",
  wear: "var(--ui-kind-wear)",
};

export function defOf(type: ItemType): ItemDef {
  return ITEM_DEFS[type] ?? UNKNOWN_DEF;
}

/** Occupied slots — the panel's only notion of capacity (there is no weight). */
export function usedSlots(inventory: (ItemStack | null)[]): number {
  let used = 0;
  for (const stack of inventory) {
    if (stack) used += 1;
  }
  return used;
}

/** Within FIRE_WARMTH_RADIUS of any rendered fire — cosmetic mirror of the
 * server's nearFire; the server is the authority on whether a craft succeeds. */
export function nearFireClient(): boolean {
  const me = clientWorld.me;
  const rSq = FIRE_WARMTH_RADIUS * FIRE_WARMTH_RADIUS;
  for (const fire of clientWorld.fires) {
    if (distSq2D(me.x, me.z, fire.x, fire.z) <= rSq) return true;
  }
  return false;
}

/**
 * The detail card's data line, e.g. `×4 · FOOD · +45 food`. Every segment is
 * read off the ItemDef — there is no description field to print, so a kind with
 * no numeric effect (ammo, material, placeable, tool) shows the stack and kind
 * alone.
 */
export function detailFacts(def: ItemDef, count: number): string[] {
  const facts: string[] = [`×${count}`, def.kind.toUpperCase()];
  if (def.kind === "food") facts.push(`+${def.power} food`);
  if (def.kind === "drink") facts.push(`+${def.power} water`);
  if (def.kind === "heal") facts.push(`+${def.power} hp`);
  if (def.kind === "melee") facts.push(`${def.power} dmg`);
  if (def.kind === "ranged" && def.ranged) {
    facts.push(`${def.power} dmg`, `${def.ranged.magSize} rounds`, `${def.ranged.reloadS}s reload`);
  }
  if (def.wear?.insulation !== undefined) {
    facts.push(`+${Math.round(def.wear.insulation * 100)}% insulation`);
  }
  if (def.wear?.extraSlots !== undefined) facts.push(`+${def.wear.extraSlots} slots`);
  return facts;
}
