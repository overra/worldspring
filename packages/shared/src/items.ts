export type ItemType =
  | "beans"
  | "water_bottle"
  | "bandage"
  | "pistol"
  | "rifle"
  | "shotgun"
  | "ammo_9mm"
  | "ammo_762"
  | "shells"
  | "axe"
  | "campfire_kit"
  | "flashlight"
  | "raw_venison"
  | "cooked_venison";

export type ItemKind =
  | "food"
  | "drink"
  | "heal"
  | "melee"
  | "ranged"
  | "ammo"
  | "placeable"
  | "tool";

/** Firing behavior for kind === "ranged" weapons. */
export interface RangedConfig {
  /** Max hitscan distance, meters. */
  range: number;
  cooldownS: number;
  /** Rays per trigger pull (shotguns fire several). */
  pellets: number;
  /** Random cone half-angle per pellet, radians (0 = perfectly straight). */
  spreadRad: number;
  /** Ammo item consumed per trigger pull (one round regardless of pellets). */
  ammo: ItemType;
  /** Identifies the shot sound/tracer on the wire. */
  sound: "pistol" | "rifle" | "shotgun";
}

export interface ItemDef {
  type: ItemType;
  name: string;
  kind: ItemKind;
  /** Max stack size in one inventory slot. */
  stack: number;
  /** Hex color used by the low-poly renderer and UI swatches. */
  color: string;
  /** Restored amount for consumables, damage for weapons (per pellet). */
  power: number;
  /** Present only on kind === "ranged" items. */
  ranged?: RangedConfig;
}

export const ITEM_DEFS: Record<ItemType, ItemDef> = {
  beans: { type: "beans", name: "Canned Beans", kind: "food", stack: 4, color: "#b5651d", power: 45 },
  water_bottle: { type: "water_bottle", name: "Water Bottle", kind: "drink", stack: 4, color: "#4fa8d8", power: 55 },
  bandage: { type: "bandage", name: "Bandage", kind: "heal", stack: 4, color: "#e8e4d8", power: 25 },
  pistol: {
    type: "pistol",
    name: "Makarov",
    kind: "ranged",
    stack: 1,
    color: "#3a3a3f",
    power: 30,
    ranged: { range: 90, cooldownS: 0.35, pellets: 1, spreadRad: 0, ammo: "ammo_9mm", sound: "pistol" },
  },
  rifle: {
    type: "rifle",
    name: "Mosin",
    kind: "ranged",
    stack: 1,
    color: "#4a4030",
    power: 65,
    ranged: { range: 180, cooldownS: 1.15, pellets: 1, spreadRad: 0, ammo: "ammo_762", sound: "rifle" },
  },
  shotgun: {
    type: "shotgun",
    name: "Izh-43",
    kind: "ranged",
    stack: 1,
    color: "#3d3328",
    power: 13,
    ranged: { range: 28, cooldownS: 1.3, pellets: 6, spreadRad: 0.085, ammo: "shells", sound: "shotgun" },
  },
  ammo_9mm: { type: "ammo_9mm", name: "9mm Rounds", kind: "ammo", stack: 30, color: "#c9a227", power: 0 },
  ammo_762: { type: "ammo_762", name: "7.62 Rounds", kind: "ammo", stack: 20, color: "#a8842c", power: 0 },
  shells: { type: "shells", name: "Shotgun Shells", kind: "ammo", stack: 12, color: "#b03a2e", power: 0 },
  axe: { type: "axe", name: "Fire Axe", kind: "melee", stack: 1, color: "#a33327", power: 35 },
  campfire_kit: { type: "campfire_kit", name: "Campfire Kit", kind: "placeable", stack: 2, color: "#7a5230", power: 0 },
  flashlight: { type: "flashlight", name: "Flashlight", kind: "tool", stack: 1, color: "#c8c23a", power: 0 },
  // Raw venison restores little and costs hp (eat it desperate or cook it:
  // using it within FIRE_WARMTH_RADIUS of a campfire converts the stack).
  raw_venison: { type: "raw_venison", name: "Raw Venison", kind: "food", stack: 3, color: "#9e4a4a", power: 15 },
  cooked_venison: { type: "cooked_venison", name: "Cooked Venison", kind: "food", stack: 3, color: "#7a4a2e", power: 65 },
};

/** HP penalty for eating venison raw (power still applies to food). */
export const RAW_VENISON_HP_PENALTY = 8;

/** Airdrop crates roll this many stacks from this table. */
export const AIRDROP_ROLLS = 5;
export const AIRDROP_TABLE: LootTableEntry[] = [
  { type: "rifle", weight: 16, min: 1, max: 1 },
  { type: "shotgun", weight: 14, min: 1, max: 1 },
  { type: "ammo_762", weight: 22, min: 8, max: 16 },
  { type: "shells", weight: 16, min: 6, max: 10 },
  { type: "bandage", weight: 16, min: 2, max: 4 },
  { type: "flashlight", weight: 8, min: 1, max: 1 },
  { type: "cooked_venison", weight: 8, min: 1, max: 2 },
];

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

export type LootTier = "coastal" | "inland" | "military";

export interface LootTableEntry {
  type: ItemType;
  weight: number;
  min: number;
  max: number;
}

/**
 * Weighted loot tables per zone tier. The risk gradient of the island:
 * coastal towns feed newspawns, inland cabins bridge, the military compound
 * is the only source of rifles and shotguns.
 */
export const LOOT_TABLES: Record<LootTier, LootTableEntry[]> = {
  coastal: [
    { type: "beans", weight: 24, min: 1, max: 2 },
    { type: "water_bottle", weight: 24, min: 1, max: 2 },
    { type: "bandage", weight: 16, min: 1, max: 2 },
    { type: "ammo_9mm", weight: 12, min: 6, max: 14 },
    { type: "axe", weight: 8, min: 1, max: 1 },
    { type: "pistol", weight: 6, min: 1, max: 1 },
    { type: "campfire_kit", weight: 9, min: 1, max: 1 },
    { type: "flashlight", weight: 6, min: 1, max: 1 },
  ],
  inland: [
    { type: "beans", weight: 18, min: 1, max: 2 },
    { type: "water_bottle", weight: 18, min: 1, max: 2 },
    { type: "bandage", weight: 18, min: 1, max: 2 },
    { type: "ammo_9mm", weight: 14, min: 8, max: 16 },
    { type: "axe", weight: 10, min: 1, max: 1 },
    { type: "pistol", weight: 9, min: 1, max: 1 },
    { type: "campfire_kit", weight: 8, min: 1, max: 1 },
    { type: "shells", weight: 4, min: 3, max: 6 },
    { type: "flashlight", weight: 7, min: 1, max: 1 },
  ],
  military: [
    { type: "rifle", weight: 9, min: 1, max: 1 },
    { type: "shotgun", weight: 11, min: 1, max: 1 },
    { type: "ammo_762", weight: 20, min: 5, max: 12 },
    { type: "shells", weight: 17, min: 4, max: 8 },
    { type: "ammo_9mm", weight: 12, min: 10, max: 20 },
    { type: "bandage", weight: 16, min: 1, max: 3 },
    { type: "beans", weight: 8, min: 1, max: 1 },
    { type: "water_bottle", weight: 7, min: 1, max: 1 },
  ],
};

/** Back-compat alias: the coastal table is the old global table's heir. */
export const LOOT_TABLE = LOOT_TABLES.coastal;
