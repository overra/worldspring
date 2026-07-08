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
  | "cooked_venison"
  // 16 new items added in doc 05 M1 (bumps PROTOCOL_VERSION 1→2)
  | "wood"
  | "cloth"
  | "scrap"
  | "rope"
  | "deer_pelt"
  | "knife"
  | "fishing_rod"
  | "raw_fish"
  | "cooked_fish"
  | "canteen_empty"
  | "canteen_dirty"
  | "canteen_clean"
  | "torch"
  | "first_aid_kit"
  | "padded_jacket"
  | "backpack"
  // doc 12: the in-game map item. Added ADDITIVELY (no PROTOCOL_VERSION bump) —
  // every client ITEM_DEFS[type] lookup is `?? UNKNOWN_DEF`, so an older client
  // that receives a map renders it as a generic item instead of crashing.
  | "map"
  // Red realm gateway (placeable): opens a linked portal pair you can step
  // through to reach (and return from) the red realm.
  | "portal_kit"
  // doc 06: base building. Additive (no bump needed for the ItemType itself —
  // the UNKNOWN_DEF rule); the doc's wire messages take the proto bump.
  | "hammer";

export type ItemKind =
  | "food"
  | "drink"
  | "heal"
  | "melee"
  | "ranged"
  | "ammo"
  | "placeable"
  | "tool"
  | "material"
  | "wear";

/** Firing behavior for kind === "ranged" weapons. */
export interface RangedConfig {
  /** Max hitscan distance, meters. */
  range: number;
  cooldownS: number;
  /** Rays per trigger pull (shotguns fire several). */
  pellets: number;
  /** Random cone half-angle per pellet, radians (0 = perfectly straight). */
  spreadRad: number;
  /** Ammo item the reload channel refills the magazine from (doc 11 M3).
   * Firing consumes from the LOADED MAG only (`ItemStack.mag`), one round per
   * trigger pull regardless of pellets. */
  ammo: ItemType;
  /**
   * Rounds the magazine holds (doc 11 M3 — combat-owned balance, placeholder
   * pending the M5 tuning pass). The per-weapon rounds counter lives on the
   * weapon's `ItemStack.mag` (absent ⇒ full).
   */
  magSize: number;
  /** Reload channel duration, game-seconds (doc 11 M3 — combat-owned balance;
   * per-weapon by the weapons-as-data rule, NOT a `*_CHANNEL_S` constant). */
  reloadS: number;
  /** Identifies the shot sound/tracer on the wire. */
  sound: "pistol" | "rifle" | "shotgun";
}

/**
 * Water vessel behavior. Priority order in useItem:
 *   1. near campfire + boilsTo → boil
 *   2. water ahead + fillsTo → fill
 *   3. drink → drink
 */
export interface WaterConfig {
  /** Using next to water (heightAt 2.5m ahead < WATER_LEVEL) converts to this type. */
  fillsTo?: ItemType;
  /** Using within FIRE_WARMTH_RADIUS of a campfire converts to this type. */
  boilsTo?: ItemType;
  /** Drinking: restore water, optionally cost hp, become emptiesTo. */
  drink?: { restore: number; hpPenalty?: number; emptiesTo: ItemType };
}

/** Wearable item config (jacket = insulation, backpack = extra slots). */
export interface WearConfig {
  slot: "body" | "back";
  /** Fraction of temperature fall negated while worn (0..1). */
  insulation?: number;
  /** Extra inventory slots granted while worn. */
  extraSlots?: number;
}

/** Held-light config. Set on the torch in M1; the flashlight keeps its existing
 * hardcoded PlayerCamera beam until a later doc-05 milestone unifies both behind
 * one held-light pool keyed by item type. */
export interface LightConfig {
  /** Spotlight tint. */
  color: string;
  intensity: number;
  range: number;
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
  /**
   * Base damage vs player STRUCTURES (doc 06 M7) — per swing for melee, per
   * PELLET for ranged (the `power` convention). Absent ⇒ FIST_STRUCT_DMG for
   * melee/fists, zero effect for anything unequippable. Effective damage =
   * structDmg × TIER_DMG_MULT[tier][melee|bullet] × offline shield.
   */
  structDmg?: number;
  /** Present only on kind === "ranged" items. */
  ranged?: RangedConfig;
  /**
   * Using within FIRE_WARMTH_RADIUS of a campfire converts one stack to this
   * type (generalizes the old raw_venison branch in players.ts). Present on
   * raw_venison, raw_fish.
   */
  cooksTo?: ItemType;
  /**
   * HP cost of consuming this item raw (power still restores food first).
   * Floor at 1 hp, never lethal.
   */
  rawPenaltyHp?: number;
  /** Water vessel behavior (canteen variants). */
  water?: WaterConfig;
  /** Wearable item behavior (jacket, backpack). */
  wear?: WearConfig;
  /** Held-light behavior (torch). Client light-pool key is the item type. */
  light?: LightConfig;
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
    structDmg: 1, // doc 06 M7 — ammo scarcity makes gun-raiding wasteful by design
    // magSize/reloadS: doc 11 M3 placeholders flagged for the combat tuning pass (M5).
    ranged: { range: 90, cooldownS: 0.35, pellets: 1, spreadRad: 0, ammo: "ammo_9mm", magSize: 12, reloadS: 1.5, sound: "pistol" },
  },
  rifle: {
    type: "rifle",
    name: "Mosin",
    kind: "ranged",
    stack: 1,
    color: "#4a4030",
    power: 65,
    structDmg: 2, // doc 06 M7
    ranged: { range: 180, cooldownS: 1.15, pellets: 1, spreadRad: 0, ammo: "ammo_762", magSize: 5, reloadS: 2.5, sound: "rifle" },
  },
  shotgun: {
    type: "shotgun",
    name: "Izh-43",
    kind: "ranged",
    stack: 1,
    color: "#3d3328",
    power: 13,
    structDmg: 0.5, // doc 06 M7 — per PELLET (6 pellets ≈ 3/shell point-blank)
    ranged: { range: 28, cooldownS: 1.3, pellets: 6, spreadRad: 0.085, ammo: "shells", magSize: 6, reloadS: 2.8, sound: "shotgun" },
  },
  ammo_9mm: { type: "ammo_9mm", name: "9mm Rounds", kind: "ammo", stack: 30, color: "#c9a227", power: 0 },
  ammo_762: { type: "ammo_762", name: "7.62 Rounds", kind: "ammo", stack: 20, color: "#a8842c", power: 0 },
  shells: { type: "shells", name: "Shotgun Shells", kind: "ammo", stack: 12, color: "#b03a2e", power: 0 },
  // structDmg 6 (doc 06 M7): the axe is THE raid tool — wood door ≈ 30s.
  axe: { type: "axe", name: "Fire Axe", kind: "melee", stack: 1, color: "#a33327", power: 35, structDmg: 6 },
  campfire_kit: { type: "campfire_kit", name: "Campfire Kit", kind: "placeable", stack: 2, color: "#7a5230", power: 0 },
  flashlight: { type: "flashlight", name: "Flashlight", kind: "tool", stack: 1, color: "#c8c23a", power: 0 },
  // Raw venison: migrated from the hardcoded branch in players.ts — now data-driven
  // via cooksTo / rawPenaltyHp (doc 05 M1).
  raw_venison: {
    type: "raw_venison",
    name: "Raw Venison",
    kind: "food",
    stack: 3,
    color: "#9e4a4a",
    power: 15,
    cooksTo: "cooked_venison",
    rawPenaltyHp: 8,
  },
  cooked_venison: { type: "cooked_venison", name: "Cooked Venison", kind: "food", stack: 3, color: "#7a4a2e", power: 65 },

  // --- 16 new items (doc 05 M1) ---

  // Materials (craft inputs only)
  wood: { type: "wood", name: "Wood Branches", kind: "material", stack: 8, color: "#7a5c3a", power: 0 },
  cloth: { type: "cloth", name: "Cloth Scraps", kind: "material", stack: 8, color: "#c8c0a8", power: 0 },
  scrap: { type: "scrap", name: "Scrap Metal", kind: "material", stack: 8, color: "#8a8a8a", power: 0 },
  rope: { type: "rope", name: "Rope", kind: "material", stack: 4, color: "#a09060", power: 0 },
  deer_pelt: { type: "deer_pelt", name: "Deer Pelt", kind: "material", stack: 4, color: "#8a6a40", power: 0 },

  // Melee tool (also gates crafting)
  knife: { type: "knife", name: "Hunting Knife", kind: "melee", stack: 1, color: "#c0b878", power: 20 },

  // Fishing
  fishing_rod: { type: "fishing_rod", name: "Fishing Rod", kind: "tool", stack: 1, color: "#7a6040", power: 0 },
  raw_fish: {
    type: "raw_fish",
    name: "Raw Fish",
    kind: "food",
    stack: 4,
    color: "#7ab8c8",
    power: 12,
    cooksTo: "cooked_fish",
    rawPenaltyHp: 5,
  },
  cooked_fish: { type: "cooked_fish", name: "Cooked Fish", kind: "food", stack: 4, color: "#c88050", power: 50 },

  // Canteens
  canteen_empty: {
    type: "canteen_empty",
    name: "Canteen (empty)",
    kind: "tool",
    stack: 1,
    color: "#788888",
    power: 0,
    water: { fillsTo: "canteen_dirty" },
  },
  canteen_dirty: {
    type: "canteen_dirty",
    name: "Canteen (murky)",
    kind: "drink",
    stack: 1,
    color: "#88a078",
    power: 0,
    water: {
      boilsTo: "canteen_clean",
      drink: { restore: 25, hpPenalty: 10, emptiesTo: "canteen_empty" },
    },
  },
  canteen_clean: {
    type: "canteen_clean",
    name: "Canteen (clean)",
    kind: "drink",
    stack: 1,
    color: "#78b8c8",
    power: 0,
    water: {
      drink: { restore: 70, emptiesTo: "canteen_empty" },
    },
  },

  // Torch — infinite, dimmer than the flashlight (no battery on either)
  torch: {
    type: "torch",
    name: "Torch",
    kind: "tool",
    stack: 1,
    color: "#e89040",
    power: 0,
    light: { color: "#ff9040", intensity: 1.8, range: 12 },
  },

  // Medical
  first_aid_kit: { type: "first_aid_kit", name: "First Aid Kit", kind: "heal", stack: 2, color: "#e84040", power: 60 },

  // Wearables
  padded_jacket: {
    type: "padded_jacket",
    name: "Padded Jacket",
    kind: "wear",
    stack: 1,
    color: "#5a7060",
    power: 0,
    wear: { slot: "body", insulation: 0.65 },
  },
  backpack: {
    type: "backpack",
    name: "Canvas Backpack",
    kind: "wear",
    stack: 1,
    color: "#9a8060",
    power: 0,
    wear: { slot: "back", extraSlots: 4 },
  },

  // doc 12: the full-screen map. kind:"tool" → useItem is a no-op; the client
  // opens the map UI from possession + a keybind (M4), never a server round-trip.
  map: { type: "map", name: "Island Map", kind: "tool", stack: 1, color: "#d8c9a0", power: 0 },

  // Red Ender Portal — a placeable that tears open a linked portal pair: one in
  // your current realm, one at the same spot in the other realm. Step through to
  // cross; step back through the twin to return. (kind "placeable" routes through
  // useItem's placeable branch, which dispatches on type.)
  portal_kit: { type: "portal_kit", name: "Red Ender Portal", kind: "placeable", stack: 4, color: "#e0245e", power: 0 },

  // doc 06: base building — equipping it enters build mode (client) and gates
  // server-side placement. kind:"tool" → useItem no-op, like the flashlight.
  hammer: { type: "hammer", name: "Hammer", kind: "tool", stack: 1, color: "#8a7550", power: 0 },
};

// --- Crafting (doc 05 M2) ---

/** Crafting station gate. Campfire is the first (and only) station; the field
 * is built so workbenches/etc. slot in later without a wire change. */
export type CraftStation = "campfire";

export interface CraftRecipe {
  /** Display name of the recipe's output (the crafted thing). */
  name: string;
  /** Inputs CONSUMED from the inventory (summed across stacks). */
  inputs: ReadonlyArray<{ type: ItemType; count: number }>;
  /** Granted on success; overflow drops at the player's feet. */
  output: { type: ItemType; count: number };
  /** Must be present anywhere in the inventory; NEVER consumed. */
  tool?: ItemType;
  /** Player must be within the station's radius (campfire = FIRE_WARMTH_RADIUS). */
  station?: CraftStation;
}

/**
 * Flat recipe table. The ARRAY INDEX is the stable wire id sent in
 * `{t:"craft", recipe}` — APPEND-ONLY, never reorder or delete a row (doc 05
 * §2). The client lists these in the Tab panel; the server is the authority on
 * inputs/tool/station. Every type referenced here exists in ITEM_DEFS.
 */
export const RECIPES: readonly CraftRecipe[] = [
  // 0
  { name: "Bandage", inputs: [{ type: "cloth", count: 2 }], output: { type: "bandage", count: 2 } },
  // 1
  { name: "Rope", inputs: [{ type: "cloth", count: 3 }], output: { type: "rope", count: 1 } },
  // 2
  {
    name: "Torch",
    inputs: [
      { type: "wood", count: 1 },
      { type: "cloth", count: 1 },
    ],
    output: { type: "torch", count: 1 },
    station: "campfire",
  },
  // 3
  {
    name: "Campfire Kit",
    inputs: [
      { type: "wood", count: 3 },
      { type: "cloth", count: 1 },
    ],
    output: { type: "campfire_kit", count: 1 },
  },
  // 4
  {
    name: "Hunting Knife",
    inputs: [
      { type: "scrap", count: 2 },
      { type: "wood", count: 1 },
    ],
    output: { type: "knife", count: 1 },
  },
  // 5
  {
    name: "Fishing Rod",
    inputs: [
      { type: "wood", count: 2 },
      { type: "rope", count: 1 },
      { type: "scrap", count: 1 },
    ],
    output: { type: "fishing_rod", count: 1 },
    tool: "knife",
  },
  // 6
  {
    name: "Padded Jacket",
    inputs: [
      { type: "cloth", count: 4 },
      { type: "deer_pelt", count: 2 },
      { type: "rope", count: 1 },
    ],
    output: { type: "padded_jacket", count: 1 },
    tool: "knife",
  },
  // 7
  {
    name: "Canvas Backpack",
    inputs: [
      { type: "cloth", count: 6 },
      { type: "rope", count: 2 },
    ],
    output: { type: "backpack", count: 1 },
    tool: "knife",
  },
];

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
  { type: "first_aid_kit", weight: 12, min: 1, max: 1 },
];

export interface ItemStack {
  type: ItemType;
  count: number;
  /**
   * Rounds currently loaded in a ranged weapon's magazine (doc 11 M3, Open Q5
   * resolved: the counter rides the stack so it travels with the gun through
   * drop / pickup / slot moves and persists with `CharacterState.inventory`
   * for free). ABSENT ⇒ full (`ranged.magSize`): old saves and freshly
   * spawned/looted weapons read as full, and pre-M3 code ignoring the key is
   * rollback-safe. Never set on non-ranged stacks. Additive-optional on the
   * `inv` wire message (the fog/felled no-bump posture).
   */
  mag?: number;
}

/** Small pickings found on zombie corpses (rolled at ZOMBIE_LOOT_CHANCE). */
export const ZOMBIE_LOOT_TABLE: Array<{ type: ItemType; weight: number; min: number; max: number }> = [
  { type: "bandage", weight: 28, min: 1, max: 1 },
  { type: "beans", weight: 20, min: 1, max: 1 },
  { type: "water_bottle", weight: 20, min: 1, max: 1 },
  { type: "ammo_9mm", weight: 16, min: 4, max: 8 },
  { type: "campfire_kit", weight: 8, min: 1, max: 1 },
  { type: "cloth", weight: 12, min: 1, max: 2 },
  { type: "scrap", weight: 6, min: 1, max: 1 },
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
    { type: "beans", weight: 22, min: 1, max: 2 },
    { type: "water_bottle", weight: 22, min: 1, max: 2 },
    { type: "bandage", weight: 14, min: 1, max: 2 },
    { type: "ammo_9mm", weight: 10, min: 6, max: 14 },
    { type: "axe", weight: 7, min: 1, max: 1 },
    { type: "pistol", weight: 5, min: 1, max: 1 },
    { type: "campfire_kit", weight: 8, min: 1, max: 1 },
    { type: "flashlight", weight: 5, min: 1, max: 1 },
    { type: "cloth", weight: 10, min: 1, max: 3 },
    { type: "canteen_empty", weight: 8, min: 1, max: 1 },
    { type: "rope", weight: 4, min: 1, max: 1 },
    { type: "portal_kit", weight: 5, min: 1, max: 1 },
    { type: "hammer", weight: 7, min: 1, max: 1 },
  ],
  inland: [
    { type: "beans", weight: 16, min: 1, max: 2 },
    { type: "water_bottle", weight: 16, min: 1, max: 2 },
    { type: "bandage", weight: 16, min: 1, max: 2 },
    { type: "ammo_9mm", weight: 12, min: 8, max: 16 },
    { type: "axe", weight: 9, min: 1, max: 1 },
    { type: "pistol", weight: 8, min: 1, max: 1 },
    { type: "campfire_kit", weight: 7, min: 1, max: 1 },
    { type: "shells", weight: 4, min: 3, max: 6 },
    { type: "flashlight", weight: 6, min: 1, max: 1 },
    { type: "scrap", weight: 8, min: 1, max: 2 },
    { type: "rope", weight: 5, min: 1, max: 1 },
    { type: "canteen_empty", weight: 6, min: 1, max: 1 },
    { type: "portal_kit", weight: 6, min: 1, max: 1 },
    { type: "hammer", weight: 7, min: 1, max: 1 },
  ],
  military: [
    { type: "rifle", weight: 9, min: 1, max: 1 },
    { type: "shotgun", weight: 11, min: 1, max: 1 },
    { type: "ammo_762", weight: 18, min: 5, max: 12 },
    { type: "shells", weight: 15, min: 4, max: 8 },
    { type: "ammo_9mm", weight: 10, min: 10, max: 20 },
    { type: "bandage", weight: 14, min: 1, max: 3 },
    { type: "beans", weight: 7, min: 1, max: 1 },
    { type: "water_bottle", weight: 6, min: 1, max: 1 },
    { type: "first_aid_kit", weight: 8, min: 1, max: 1 },
    { type: "scrap", weight: 8, min: 2, max: 4 },
    { type: "canteen_empty", weight: 6, min: 1, max: 1 },
  ],
};

/** Back-compat alias: the coastal table is the old global table's heir. */
export const LOOT_TABLE = LOOT_TABLES.coastal;

/**
 * Fallback ItemDef for an unrecognised ItemType string (e.g. a server running
 * a newer version sends a type this client has never heard of). Guards the
 * `ITEM_DEFS[type] ?? UNKNOWN_DEF` pattern in HUD.tsx and NetSystem.tsx so old
 * clients don't crash rendering a new item type after PROTOCOL_VERSION bumps.
 *
 * This sentinel is intentionally NOT in ITEM_DEFS — it has no valid ItemType
 * — so TypeScript callers must opt in explicitly rather than accidentally
 * relying on it.
 */
export const UNKNOWN_DEF: ItemDef = {
  type: "beans" as ItemType, // safe placeholder — this field is never read for display
  name: "Unknown Item",
  kind: "material",
  stack: 1,
  color: "#888888",
  power: 0,
};
