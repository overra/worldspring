// Item helpers shared by the workspace's storage grid, item popover and
// crafting list. Everything here is derived from ITEM_DEFS / the store mirror of
// the server's inv message — no readout in the panel exists that the game cannot
// back. (The design's kg-weight readout is one such: the server has no weight
// model, so CARRY is measured in slots. See usedSlots.)

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

/** Occupied slots — the panel's only notion of capacity. The design's top bar
 * reads a carry WEIGHT (`4.7 / 18.0 kg`); the server has no weight model, so the
 * readout keeps its shape (value / cap + fill track) and counts slots instead.
 * It is read in exactly one place: the workspace's top bar. */
export function usedSlots(inventory: readonly (ItemStack | null)[]): number {
  let used = 0;
  for (const stack of inventory) {
    if (stack) used += 1;
  }
  return used;
}

/** Indices of the empty slots, in order — the destinations a TAKE offers. */
export function freeSlots(inventory: readonly (ItemStack | null)[]): number[] {
  const free: number[] = [];
  for (let i = 0; i < inventory.length; i += 1) {
    if (inventory[i] === null) free.push(i);
  }
  return free;
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
 * The popover's primary verb — the one hero button (`.ui-btn--primary`). null
 * for a kind with no server-side use (material, ammo, melee, and an unequipped
 * gun): DROP is then the only action, and it stays the secondary button so the
 * card never grows a hero it cannot honor.
 *
 * `equipped` gates RELOAD: the server binds the reload channel to selectedSlot,
 * so `use` on an unequipped gun no-ops.
 */
export function primaryVerb(def: ItemDef, equipped: boolean): string | null {
  if (def.kind === "wear") return "Wear";
  if (def.kind === "food") return "Eat";
  if (def.kind === "drink") return "Drink";
  if (def.kind === "ranged") return equipped ? "Reload" : null;
  if (USABLE_KINDS.has(def.kind)) return "Use";
  return null;
}

/**
 * The popover's data line, e.g. `×4 · +45 food`. Every segment is read off the
 * ItemDef; the kind is NOT among them — the popover prints it as a colored chip,
 * and the design does not say a thing twice. A kind with no numeric effect
 * (ammo, material, placeable, tool) shows the stack count alone.
 *
 * ItemDef has no description field, so the design's prose line under this one
 * has no source and is not rendered.
 */
export function detailFacts(def: ItemDef, count: number): string[] {
  const facts: string[] = [`×${count}`];
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
