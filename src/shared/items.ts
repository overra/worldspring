export type ItemType =
  | "beans"
  | "water_bottle"
  | "bandage"
  | "pistol"
  | "ammo_9mm"
  | "axe"
  | "campfire_kit";

export type ItemKind = "food" | "drink" | "heal" | "melee" | "ranged" | "ammo" | "placeable";

export interface ItemDef {
  type: ItemType;
  name: string;
  kind: ItemKind;
  /** Max stack size in one inventory slot. */
  stack: number;
  /** Hex color used by the low-poly renderer and UI swatches. */
  color: string;
  /** Restored amount for consumables, damage for weapons. */
  power: number;
}

export const ITEM_DEFS: Record<ItemType, ItemDef> = {
  beans: { type: "beans", name: "Canned Beans", kind: "food", stack: 4, color: "#b5651d", power: 45 },
  water_bottle: { type: "water_bottle", name: "Water Bottle", kind: "drink", stack: 4, color: "#4fa8d8", power: 55 },
  bandage: { type: "bandage", name: "Bandage", kind: "heal", stack: 4, color: "#e8e4d8", power: 25 },
  pistol: { type: "pistol", name: "Makarov", kind: "ranged", stack: 1, color: "#3a3a3f", power: 30 },
  ammo_9mm: { type: "ammo_9mm", name: "9mm Rounds", kind: "ammo", stack: 30, color: "#c9a227", power: 0 },
  axe: { type: "axe", name: "Fire Axe", kind: "melee", stack: 1, color: "#a33327", power: 35 },
  campfire_kit: { type: "campfire_kit", name: "Campfire Kit", kind: "placeable", stack: 2, color: "#7a5230", power: 0 },
};

export interface ItemStack {
  type: ItemType;
  count: number;
}

/** Small pickings found on zombie corpses (rolled at ZOMBIE_LOOT_CHANCE). */
export const ZOMBIE_LOOT_TABLE: Array<{ type: ItemType; weight: number; min: number; max: number }> = [
  { type: "bandage", weight: 30, min: 1, max: 1 },
  { type: "beans", weight: 22, min: 1, max: 1 },
  { type: "water_bottle", weight: 22, min: 1, max: 1 },
  { type: "ammo_9mm", weight: 18, min: 4, max: 8 },
  { type: "campfire_kit", weight: 8, min: 1, max: 1 },
];

/** Weighted loot table used by the server when (re)stocking spawn points. */
export const LOOT_TABLE: Array<{ type: ItemType; weight: number; min: number; max: number }> = [
  { type: "beans", weight: 22, min: 1, max: 2 },
  { type: "water_bottle", weight: 22, min: 1, max: 2 },
  { type: "bandage", weight: 16, min: 1, max: 2 },
  { type: "ammo_9mm", weight: 14, min: 6, max: 14 },
  { type: "axe", weight: 9, min: 1, max: 1 },
  { type: "pistol", weight: 7, min: 1, max: 1 },
  { type: "campfire_kit", weight: 10, min: 1, max: 1 },
];
