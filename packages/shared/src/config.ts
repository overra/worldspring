// packages/shared/src/config.ts — ServerConfig schema, presets, validation, derivations.
// Shared: the server resolves it from env; the client receives it in `welcome`.
// House rules: strict TS, named exports, no deps. Constants in constants.ts are
// the DEFAULTS; config multiplies/overrides at each system's point of use.
//
// This file is the doc 04 M1 surface. It replaces doc 03 M2's throwaway stub
// wholesale. The TYPE-ONLY cross-import with serverInfo.ts is preserved
// (config imports the RulesSummary *type*; serverInfo imports
// WorldSizeTier/WipeSchedule *types*) — erased, isolatedModules-safe, no
// runtime cycle.

import {
  ARENA_RESPAWN_DELAY_S,
  CABIN_COUNT,
  DAY_DURATION_S,
  DEER_COUNT,
  LOGOUT_LINGER_S,
  MAP_ACQUIRE_DEFAULT,
  MAP_MINIMAP_DEFAULT,
  PHYSICS_BODY_CAP,
  MAP_REVEAL_DEFAULT,
  MAX_PLAYERS,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
  RESPAWN_DELAY_S,
  ROCK_COUNT,
  START_HOUR,
  TOWN_COUNT,
  TREE_COUNT,
  WORLD_SEED,
  WORLD_SIZE,
  WORLDGEN_VERSION,
  ZOMBIE_MAX,
} from "./constants";
import { gameHours } from "./protocol";
import type { LootTier } from "./items";
import type { RulesSummary } from "./serverInfo";
import type { WorldGenParams } from "./world";

// =============================================================================
// 1. Schema
// =============================================================================

/** World map size tier — 800/1,600/3,200 m. Value set owned by doc 07 §1/§3. */
export type WorldSizeTier = "standard" | "large" | "huge";
/** World wipe cadence. */
export type WipeSchedule = "never" | "weekly" | "biweekly" | "monthly";

/**
 * The GameMode a server runs (docs/plans/00). Survival is the flagship; arena
 * is the first non-survival mode. LIVE-class — it changes the GAMEPLAY layer,
 * not worldgen (the procedural island is identical), so it never taints a
 * persisted world's fingerprint. The server maps this id to a mode object
 * (server/mode/registry.ts); the client receives it in `welcome.config` and can
 * skin the HUD per-mode.
 */
export const GAME_MODES = ["survival", "arena", "horde"] as const;
export type GameModeId = (typeof GAME_MODES)[number];

export interface WorldConfig {
  /** Worldgen seed. WIPE-class. Default WORLD_SEED (1337). */
  seed: number;
  /** WIPE-class. All three tiers honored since doc 07 M2 (createWorld is
   * size-parameterized; a tier change on a persisted world routes through
   * initSchema's fail-closed wipe gate). */
  sizeTier: WorldSizeTier;
  /** WIPE-class. Reserved: forced to `false` until doc 07 wires it — the live
   * world has no fresh water, and a `true` placeholder would bake `water:1`
   * into stored fingerprints of worlds that never had water (doc 07 §1). */
  waterFeatures: boolean;
}

export interface ThreatsConfig {
  /** Master switch: false = no zombies spawn, tick, or respawn. */
  zombies: boolean;
  /** Multiplies ZOMBIE_MAX, ZOMBIES_PER_TOWN, ZOMBIE_ROAMERS, MILITARY_ZOMBIES. */
  zombieDensity: number; // 0..2
  /** Multiplies ZOMBIE_DMG / MILITARY_ZOMBIE_DMG. */
  zombieDamage: number; // 0..3
  /** Multiplies ZOMBIE_CHASE_SPEED / MILITARY_ZOMBIE_SPEED (wander unscaled). */
  zombieSpeed: number; // 0.5..1.3 — 1.3 ≈ 7.0 m/s, just over sprint 6.8
  /** false = no military garrison AND military loot spawns roll the inland
   * table. The compound geometry always generates (worldgen untouched). */
  militaryZone: boolean;
}

export interface LootConfig {
  /** <1: per-spawn stocking probability. >1: multiplies rolled stack counts.
   * Composes with tierDensity (effective = density * tierDensity[tier]). */
  density: number; // 0.25..3
  tierDensity: Record<LootTier, number>; // each 0.25..3
  /** Divides LOOT_RESPAWN_MIN_S/MAX_S (2 = twice as fast). */
  respawnRate: number; // 0.25..4
  /** Airdrop frequency multiplier; divides the interval. 0 = no airdrops. */
  airdrops: number; // 0..3
}

export interface SurvivalConfig {
  hungerRate: number; // 0..3  multiplies FOOD_DECAY_PER_S
  thirstRate: number; // 0..3  multiplies WATER_DECAY_PER_S
  /** Multiplies TEMP_FALL_PER_S and RAIN_TEMP_FALL_PER_S. 0 = cold disabled. */
  temperatureSeverity: number; // 0..3
  regenRate: number; // 0..3  multiplies REGEN_HP_PER_S
}

export interface PvpConfig {
  /** false = players cannot damage players (melee + ranged target loops skip them). */
  enabled: boolean;
  /** Scales player-vs-player damage only (zombies/deer unaffected). */
  damageMult: number; // 0.25..2
  /** true (default, today's behavior): death drops the whole inventory on the
   * corpse and respawn starts empty. false ("keep inventory"): the corpse
   * spawns visibly but empty, and respawn restores the inventory held at death. */
  fullLoot: boolean;
}

export interface TimeConfig {
  /** Full 24h cycle in real minutes. Default 16 (DAY_DURATION_S / 60). */
  dayLengthMin: number; // 4..120
  /** World-clock hour at game-time zero. Default START_HOUR (9). */
  startHour: number; // 0..24
  /** When non-null the clock is frozen at this hour: permanent night (e.g. 1)
   * or eternal noon (12). Drives sky, ambient-warmth and the HUD clock. */
  fixedHour: number | null; // null | 0..24
}

export interface WildlifeConfig {
  /** Multiplies DEER_COUNT. 0 = no deer (and no venison economy). */
  deerDensity: number; // 0..3
  // Reserved for doc 07's species (validated 0..3, default 1, NO-OP until
  // doc 07 M8/M9 land): rabbitDensity, boarDensity, wolfPackDensity.
  rabbitDensity: number; // 0..3
  boarDensity: number; // 0..3
  wolfPackDensity: number; // 0..3
}

export interface BuildingConfig {
  // Field set amended per doc 06's Migration section (its decayHours/raid
  // shield design replaced an earlier `decayRate` 0..3 multiplier). All
  // reserved for doc 06: validated and carried, NO-OP until doc 06 lands.
  enabled: boolean;
  /** Per-player piece cap (fairness dial, not anti-Sybil — doc 06). */
  pieceCapPerPlayer: number; // 10..500, default 120
  /** Wall-clock hours of owner absence before pieces decay. 0 = no decay. */
  decayHours: number; // 0..2160, default 168
  /** Structure damage multiplier while the owner is offline. 0 = invulnerable. */
  offlineRaidMult: number; // 0..1, default 0.25
}

export interface SessionConfig {
  /** Soft cap; hard-clamped to MAX_PLAYERS (40) — the verified perf envelope. */
  maxPlayers: number; // 2..40
  respawnDelayS: number; // 0..30   (RESPAWN_DELAY_S default 4)
  /** Combat-log linger for disconnected living bodies. 0 = instant despawn-save. */
  logoutLingerS: number; // 0..300  (LOGOUT_LINGER_S default 60)
  /** Scheduled character+world wipes (leaderboard always survives). */
  wipeSchedule: WipeSchedule;
}

/** How a player obtains the full-screen map item (doc 12). */
export type MapAcquire = "spawn" | "loot" | "none";
/** What the map (minimap + full screen) reveals (doc 12). */
export type MapReveal = "full" | "explored";

/**
 * Cartography dials (doc 12). All three are LIVE-class — none touch worldgen, so
 * none enter worldFingerprintOf and none ever wipe. `reveal:"explored"` engages
 * server-authoritative fog-of-war (doc 12 M5/M6).
 */
export interface MapConfig {
  /** Always-on corner minimap. false = no minimap HUD element. */
  minimap: boolean;
  /** Full-screen map item acquisition. "none" = no full map this server. */
  acquire: MapAcquire;
  /** Reveal mode for both surfaces. */
  reveal: MapReveal;
}

/**
 * Server-auth dynamic physics dials (doc 13). BOTH LIVE-class — physics is
 * server-authoritative and outside the client determinism contract (clients
 * never step it), so neither field enters worldFingerprintOf or wipes.
 * Lowering bodyCap on a live world evicts oldest-settled-first next tick.
 */
export interface PhysicsConfig {
  /** false = the physics world is never built; spawnBody is a warn-noop. */
  enabled: boolean;
  /** Max dynamic bodies per room (the DO tick-cost ceiling, doc 13 §3). */
  bodyCap: number;
}

export interface ServerConfig {
  /** Resolved preset id ("custom" when overrides touch any field). */
  preset: string;
  /** Which GameMode runs (docs/plans/00). Default "survival". */
  mode: GameModeId;
  world: WorldConfig;
  threats: ThreatsConfig;
  loot: LootConfig;
  survival: SurvivalConfig;
  pvp: PvpConfig;
  time: TimeConfig;
  wildlife: WildlifeConfig;
  building: BuildingConfig;
  session: SessionConfig;
  map: MapConfig;
  physics: PhysicsConfig;
}

// =============================================================================
// 2. Defaults — the deadcoast preset, single-sourced from constants.ts
// =============================================================================

/**
 * DEFAULT_CONFIG is the **deadcoast** preset: every multiplier 1, every toggle
 * matching shipped behavior. Absolutes are pinned to the SHIPPED CONSTANTS so
 * the diff in every system stays a handful of lines and behavior is byte-
 * identical at default. The M1 unit test asserts this field-by-field against
 * the same constants (independently imported — not against this literal).
 */
export const DEFAULT_CONFIG: ServerConfig = {
  preset: "deadcoast",
  mode: "survival",
  world: {
    seed: WORLD_SEED,
    sizeTier: "standard",
    waterFeatures: false,
  },
  threats: {
    zombies: true,
    zombieDensity: 1,
    zombieDamage: 1,
    zombieSpeed: 1,
    militaryZone: true,
  },
  loot: {
    density: 1,
    tierDensity: { coastal: 1, inland: 1, military: 1 },
    respawnRate: 1,
    airdrops: 1,
  },
  survival: {
    hungerRate: 1,
    thirstRate: 1,
    temperatureSeverity: 1,
    regenRate: 1,
  },
  pvp: {
    enabled: true,
    damageMult: 1,
    fullLoot: true,
  },
  time: {
    dayLengthMin: DAY_DURATION_S / 60,
    startHour: START_HOUR,
    fixedHour: null,
  },
  wildlife: {
    deerDensity: 1,
    rabbitDensity: 1,
    boarDensity: 1,
    wolfPackDensity: 1,
  },
  building: {
    enabled: true,
    pieceCapPerPlayer: 120,
    decayHours: 168,
    offlineRaidMult: 0.25,
  },
  session: {
    maxPlayers: MAX_PLAYERS,
    respawnDelayS: RESPAWN_DELAY_S,
    logoutLingerS: LOGOUT_LINGER_S,
    wipeSchedule: "never",
  },
  map: {
    minimap: MAP_MINIMAP_DEFAULT,
    acquire: MAP_ACQUIRE_DEFAULT,
    reveal: MAP_REVEAL_DEFAULT,
  },
  physics: {
    enabled: true,
    bodyCap: PHYSICS_BODY_CAP,
  },
};

// =============================================================================
// 3. PRESETS — partials merged over DEFAULT_CONFIG (deadcoast single-sourced)
// =============================================================================

/**
 * Shipped presets. Partials merged over DEFAULT_CONFIG, so deadcoast's values
 * are single-sourced. Full effective matrix is doc 04 §3 (blank = default).
 */
export const PRESETS: Record<string, DeepPartial<ServerConfig>> = {
  // The island as designed — every field default.
  deadcoast: {},

  // Peaceful scavenge & explore. Military zone stays ON as the exploration
  // prize (rifles for deer hunting); zombies+PvP off means no garrison to fight.
  driftwood: {
    threats: { zombies: false },
    loot: { density: 1.25, respawnRate: 1.5 },
    survival: {
      hungerRate: 0.75,
      thirstRate: 0.75,
      temperatureSeverity: 0.5,
      regenRate: 1.5,
    },
    pvp: { enabled: false, fullLoot: false },
    wildlife: { deerDensity: 1.5 },
    building: { offlineRaidMult: 0 },
    session: { respawnDelayS: 2, logoutLingerS: 0 },
  },

  // You will not be missed — scarcity + slow regen + brutal cold; 24-min day.
  ironcoast: {
    threats: { zombieDensity: 1.5, zombieDamage: 1.5, zombieSpeed: 1.1 },
    loot: { density: 0.6, respawnRate: 0.5, airdrops: 0.5 },
    survival: {
      hungerRate: 1.5,
      thirstRate: 1.5,
      temperatureSeverity: 1.75,
      regenRate: 0.5,
    },
    time: { dayLengthMin: 24 },
    building: { decayHours: 72, offlineRaidMult: 1 },
    session: { respawnDelayS: 10, logoutLingerS: 180, wipeSchedule: "monthly" },
    // Earn the map; fog the unknown.
    map: { acquire: "loot", reveal: "explored" },
  },

  // The compound is an objective — PvP war server; gunfire-loot economy up.
  warpath: {
    threats: { zombieDensity: 0.5, zombieDamage: 0.75 },
    loot: {
      density: 1.5,
      tierDensity: { coastal: 1, inland: 1, military: 1.5 },
      respawnRate: 2,
      airdrops: 2.5,
    },
    survival: { hungerRate: 0.5, thirstRate: 0.5, temperatureSeverity: 0.5 },
    time: { dayLengthMin: 12 },
    session: { respawnDelayS: 2, logoutLingerS: 120, wipeSchedule: "weekly" },
    // PvP server — deny the radar; spawn-with kept so newspawns aren't blind.
    map: { reveal: "explored" },
  },

  // Build in peace — militaryZone off downgrades compound loot to inland.
  homestead: {
    threats: { zombies: false, militaryZone: false },
    loot: { density: 1.5, respawnRate: 2 },
    survival: {
      hungerRate: 0.25,
      thirstRate: 0.25,
      temperatureSeverity: 0,
      regenRate: 2,
    },
    pvp: { enabled: false, fullLoot: false },
    time: { dayLengthMin: 30 },
    wildlife: { deerDensity: 2 },
    building: { pieceCapPerPlayer: 200, decayHours: 0, offlineRaidMult: 0 },
    session: { respawnDelayS: 0, logoutLingerS: 0 },
  },

  // Round-based frag deathmatch — the first non-survival mode (docs/plans/00).
  // `mode:"arena"` routes to the arena GameMode; the rest is the config combat
  // needs: PvP on, and corpses spawn EMPTY (fullLoot:false) so a felled fighter
  // leaves no gun to scavenge. Zombies + base-building off, quick respawn, no
  // logout linger. The arena tick doesn't run the survival systems at all, so
  // their multipliers are left at default — the mode, not the config, is what
  // makes this a different game.
  arena: {
    mode: "arena",
    threats: { zombies: false },
    pvp: { enabled: true, fullLoot: false },
    building: { enabled: false },
    session: { respawnDelayS: ARENA_RESPAWN_DELAY_S, logoutLingerS: 0 },
  },

  // Cooperative wave defense — the third GameMode (docs/plans/00). `mode:"horde"`
  // routes to the horde GameMode; the rest is what co-op-vs-zombies needs: zombies
  // ON (the mode owns spawning via waves, not ambient density), PvP OFF (no
  // friendly fire — teammates share fate, not bullets), building OFF, no logout
  // linger. zombieDensity stays 1 so effectiveZombieMax = 60 keeps the client pool
  // sized above HORDE_MAX_CONCURRENT (56) — do NOT lower it. session.respawnDelayS
  // is carried but IGNORED: the mode gates revival on the wave clock.
  horde: {
    mode: "horde",
    threats: { zombies: true }, // required — tickZombies + zombie damage early-return when false
    pvp: { enabled: false, fullLoot: false }, // co-op: friendly fire off; husks empty
    building: { enabled: false },
    session: { respawnDelayS: 0, logoutLingerS: 0 },
  },

  // The sun never rises — fixedHour 1 means warmth only from campfires.
  nightfall: {
    threats: { zombieDensity: 1.25, zombieDamage: 1.25, zombieSpeed: 1.05 },
    loot: { airdrops: 1.5 },
    survival: { temperatureSeverity: 0.5 },
    time: { fixedHour: 1 },
    session: { respawnDelayS: 5 },
    // The sun never rises — fog amplifies the dread (minimap stays on).
    map: { reveal: "explored" },
  },
};

// =============================================================================
// 4. Validation — manual, total, never throws
// =============================================================================

/** Recursive partial — every leaf and every nested object is optional. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface ResolvedConfig {
  config: ServerConfig;
  /** Human-readable notes for every field that was coerced/clamped/defaulted. */
  warnings: string[];
  /** True when the env carried no GAME_CONFIG at all. Resolves cleanly to
   * defaults with zero warnings — which is exactly why it is NOT proof the
   * operator wants a default world: wrangler deletes dashboard-set vars on the
   * next deploy unless keep_vars is set, and doc 01's multipart update replaces
   * bindings wholesale. Absence must never wipe (§4). */
  varAbsent: boolean;
  /** True when any world.* value — or the preset name itself, or the whole
   * GAME_CONFIG payload — failed to parse cleanly and was produced by
   * fallback/coercion. WIPE decisions must fail closed on this (§4); LIVE
   * fields just take the fallback plus a warning. */
  worldTainted: boolean;
}

// --- Range table (the documented bands; single source for clamps + fuzz) ---

const RANGES = {
  threats: {
    zombieDensity: [0, 2],
    zombieDamage: [0, 3],
    zombieSpeed: [0.5, 1.3],
  },
  loot: {
    density: [0.25, 3],
    tierDensity: [0.25, 3],
    respawnRate: [0.25, 4],
    airdrops: [0, 3],
  },
  survival: {
    hungerRate: [0, 3],
    thirstRate: [0, 3],
    temperatureSeverity: [0, 3],
    regenRate: [0, 3],
  },
  pvp: {
    damageMult: [0.25, 2],
  },
  time: {
    dayLengthMin: [4, 120],
    startHour: [0, 24],
    fixedHour: [0, 24],
  },
  wildlife: {
    deerDensity: [0, 3],
    rabbitDensity: [0, 3],
    boarDensity: [0, 3],
    wolfPackDensity: [0, 3],
  },
  building: {
    pieceCapPerPlayer: [10, 500],
    decayHours: [0, 2160],
    offlineRaidMult: [0, 1],
  },
  session: {
    maxPlayers: [2, MAX_PLAYERS],
    respawnDelayS: [0, 30],
    logoutLingerS: [0, 300],
  },
  physics: {
    bodyCap: [0, 256],
  },
} as const;

const WIPE_SCHEDULES: readonly WipeSchedule[] = [
  "never",
  "weekly",
  "biweekly",
  "monthly",
];
/** The tier value set, exported so consumers (e.g. GameRoom's size reverse
 * lookup) never duplicate the literal list. */
export const SIZE_TIERS: readonly WorldSizeTier[] = ["standard", "large", "huge"];
const MAP_ACQUIRES: readonly MapAcquire[] = ["spawn", "loot", "none"];
const MAP_REVEALS: readonly MapReveal[] = ["full", "explored"];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Read a finite number from raw, clamp to [min,max]; otherwise return
 * fallback. Pushes a warning on coercion. Integer fields are truncated. */
function num(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
  warnings: string[],
  integer = false,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    if (raw !== undefined) {
      warnings.push(`${path}: not a finite number, using ${fallback}`);
    }
    return fallback;
  }
  let v = integer ? Math.trunc(raw) : raw;
  const clamped = clamp(v, min, max);
  if (clamped !== v) {
    warnings.push(
      `${path}: ${v} out of range [${min}, ${max}], clamped to ${clamped}`,
    );
    v = clamped;
  }
  return v;
}

function bool(
  raw: unknown,
  fallback: boolean,
  path: string,
  warnings: string[],
): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw !== undefined) {
    warnings.push(`${path}: not a boolean, using ${fallback}`);
  }
  return fallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The pure validate/clamp half of resolveServerConfig (no preset/env
 * resolution): total, never throws, clamps every numeric to its documented
 * range and every enum to a known value. The CLIENT runs this on
 * `welcome.config` before storing it — a hostile open-source server's
 * welcome.config drives client alloc sizes (render pool) and divisors
 * (dayLengthMin), so the raw object must NEVER be trusted (doc 04 §2).
 *
 * Merges over `base` (default DEFAULT_CONFIG): any field absent or invalid in
 * `raw` takes the base value.
 */
export function clampConfig(
  raw: unknown,
  base: ServerConfig = DEFAULT_CONFIG,
): ServerConfig {
  const warnings: string[] = [];
  return clampInto(raw, base, warnings).config;
}

interface ClampResult {
  config: ServerConfig;
  /** True when any world.* field had to be coerced (bad type / out of range /
   * non-standard tier / true waterFeatures). Feeds worldTainted. */
  worldCoerced: boolean;
}

function clampInto(
  raw: unknown,
  base: ServerConfig,
  warnings: string[],
): ClampResult {
  const r = isObject(raw) ? raw : {};
  if (raw !== undefined && !isObject(raw)) {
    warnings.push("config: not an object, using defaults");
  }

  const rw = isObject(r.world) ? r.world : {};
  let worldCoerced = false;

  // --- world (WIPE-class; every coercion taints) ---
  let seed = base.world.seed;
  if (rw.seed !== undefined) {
    if (typeof rw.seed === "number" && Number.isFinite(rw.seed)) {
      seed = Math.trunc(rw.seed);
    } else {
      warnings.push(
        `world.seed: not a finite number, using ${base.world.seed}`,
      );
      worldCoerced = true;
    }
  }

  let sizeTier = base.world.sizeTier;
  if (rw.sizeTier !== undefined) {
    if (
      typeof rw.sizeTier === "string" &&
      (SIZE_TIERS as readonly string[]).includes(rw.sizeTier)
    ) {
      sizeTier = rw.sizeTier as WorldSizeTier;
    } else {
      warnings.push(
        `world.sizeTier: unknown "${String(rw.sizeTier)}", using ${base.world.sizeTier}`,
      );
      worldCoerced = true;
    }
  }
  // doc 07 M2: non-standard tiers are honored (the former force-to-standard
  // coercion is gone) — createWorld is size-parameterized and the tier is
  // WIPE-class via worldFingerprintOf, so initSchema's fail-closed gate guards
  // persisted state against a tier change exactly like a seed change.
  // OPERATIONAL CAVEAT: client bundles built BEFORE this change still send the
  // same PROTOCOL_VERSION but coerce large/huge -> standard here, so they pass
  // the join gate against a tier'd server and silently desync. Flipping a live
  // server to a non-standard tier is only safe after a PROTOCOL_VERSION bump
  // ships post-M2 (doc 07 §1 runbook caveat).

  // doc 07 M5: waterFeatures is now HONORED (the reserved force-to-false is
  // gone — the sizeTier-honoring precedent from M2). A clean boolean does NOT
  // taint: waterFeatures:true is WIPE-class via worldFingerprintOf (`water:1`),
  // so flipping it on a persisted world routes through initSchema's fail-closed
  // gate exactly like a seed/tier change — a sanctioned wipe, not a coercion.
  // OPERATIONAL CAVEAT (same shape as the tier one above): client bundles built
  // BEFORE M5 still force waterFeatures→false here, so they pass the join gate
  // against a water server and silently build a DRY world. Flipping a LIVE
  // server to water is only safe after the PROTOCOL_VERSION bump ships (doc 07
  // M7) — a stale bundle is then refused at rejoin instead of desyncing.
  let waterFeatures = base.world.waterFeatures;
  if (rw.waterFeatures !== undefined) {
    if (typeof rw.waterFeatures === "boolean") {
      waterFeatures = rw.waterFeatures;
    } else {
      warnings.push(
        `world.waterFeatures: not a boolean, using ${base.world.waterFeatures}`,
      );
      worldCoerced = true;
    }
  }

  const rt = isObject(r.threats) ? r.threats : {};
  const rl = isObject(r.loot) ? r.loot : {};
  const rtd = isObject(rl.tierDensity) ? rl.tierDensity : {};
  const rs = isObject(r.survival) ? r.survival : {};
  const rp = isObject(r.pvp) ? r.pvp : {};
  const rtime = isObject(r.time) ? r.time : {};
  const rww = isObject(r.wildlife) ? r.wildlife : {};
  const rb = isObject(r.building) ? r.building : {};
  const rsess = isObject(r.session) ? r.session : {};
  const rmap = isObject(r.map) ? r.map : {};
  const rphys = isObject(r.physics) ? r.physics : {};

  // --- fixedHour: null | number in [0,24] ---
  let fixedHour: number | null = base.time.fixedHour;
  if (rtime.fixedHour !== undefined) {
    if (rtime.fixedHour === null) {
      fixedHour = null;
    } else if (
      typeof rtime.fixedHour === "number" &&
      Number.isFinite(rtime.fixedHour)
    ) {
      const rawFixedHour = rtime.fixedHour;
      fixedHour = clamp(rawFixedHour, RANGES.time.fixedHour[0], RANGES.time.fixedHour[1]);
      if (fixedHour !== rawFixedHour) {
        warnings.push(
          `time.fixedHour: ${rawFixedHour} out of range [${RANGES.time.fixedHour[0]}, ${RANGES.time.fixedHour[1]}], clamped to ${fixedHour}`,
        );
      }
    } else {
      warnings.push(
        `time.fixedHour: not null or a finite number, using ${String(base.time.fixedHour)}`,
      );
    }
  }

  const config: ServerConfig = {
    preset: typeof r.preset === "string" ? r.preset : base.preset,
    mode: gameMode(r.mode, base.mode, warnings),
    world: { seed, sizeTier, waterFeatures },
    threats: {
      zombies: bool(rt.zombies, base.threats.zombies, "threats.zombies", warnings),
      zombieDensity: num(rt.zombieDensity, base.threats.zombieDensity, RANGES.threats.zombieDensity[0], RANGES.threats.zombieDensity[1], "threats.zombieDensity", warnings),
      zombieDamage: num(rt.zombieDamage, base.threats.zombieDamage, RANGES.threats.zombieDamage[0], RANGES.threats.zombieDamage[1], "threats.zombieDamage", warnings),
      zombieSpeed: num(rt.zombieSpeed, base.threats.zombieSpeed, RANGES.threats.zombieSpeed[0], RANGES.threats.zombieSpeed[1], "threats.zombieSpeed", warnings),
      militaryZone: bool(rt.militaryZone, base.threats.militaryZone, "threats.militaryZone", warnings),
    },
    loot: {
      density: num(rl.density, base.loot.density, RANGES.loot.density[0], RANGES.loot.density[1], "loot.density", warnings),
      tierDensity: {
        coastal: num(rtd.coastal, base.loot.tierDensity.coastal, RANGES.loot.tierDensity[0], RANGES.loot.tierDensity[1], "loot.tierDensity.coastal", warnings),
        inland: num(rtd.inland, base.loot.tierDensity.inland, RANGES.loot.tierDensity[0], RANGES.loot.tierDensity[1], "loot.tierDensity.inland", warnings),
        military: num(rtd.military, base.loot.tierDensity.military, RANGES.loot.tierDensity[0], RANGES.loot.tierDensity[1], "loot.tierDensity.military", warnings),
      },
      respawnRate: num(rl.respawnRate, base.loot.respawnRate, RANGES.loot.respawnRate[0], RANGES.loot.respawnRate[1], "loot.respawnRate", warnings),
      airdrops: num(rl.airdrops, base.loot.airdrops, RANGES.loot.airdrops[0], RANGES.loot.airdrops[1], "loot.airdrops", warnings),
    },
    survival: {
      hungerRate: num(rs.hungerRate, base.survival.hungerRate, RANGES.survival.hungerRate[0], RANGES.survival.hungerRate[1], "survival.hungerRate", warnings),
      thirstRate: num(rs.thirstRate, base.survival.thirstRate, RANGES.survival.thirstRate[0], RANGES.survival.thirstRate[1], "survival.thirstRate", warnings),
      temperatureSeverity: num(rs.temperatureSeverity, base.survival.temperatureSeverity, RANGES.survival.temperatureSeverity[0], RANGES.survival.temperatureSeverity[1], "survival.temperatureSeverity", warnings),
      regenRate: num(rs.regenRate, base.survival.regenRate, RANGES.survival.regenRate[0], RANGES.survival.regenRate[1], "survival.regenRate", warnings),
    },
    pvp: {
      enabled: bool(rp.enabled, base.pvp.enabled, "pvp.enabled", warnings),
      damageMult: num(rp.damageMult, base.pvp.damageMult, RANGES.pvp.damageMult[0], RANGES.pvp.damageMult[1], "pvp.damageMult", warnings),
      fullLoot: bool(rp.fullLoot, base.pvp.fullLoot, "pvp.fullLoot", warnings),
    },
    time: {
      dayLengthMin: num(rtime.dayLengthMin, base.time.dayLengthMin, RANGES.time.dayLengthMin[0], RANGES.time.dayLengthMin[1], "time.dayLengthMin", warnings),
      startHour: num(rtime.startHour, base.time.startHour, RANGES.time.startHour[0], RANGES.time.startHour[1], "time.startHour", warnings),
      fixedHour,
    },
    wildlife: {
      deerDensity: num(rww.deerDensity, base.wildlife.deerDensity, RANGES.wildlife.deerDensity[0], RANGES.wildlife.deerDensity[1], "wildlife.deerDensity", warnings),
      rabbitDensity: num(rww.rabbitDensity, base.wildlife.rabbitDensity, RANGES.wildlife.rabbitDensity[0], RANGES.wildlife.rabbitDensity[1], "wildlife.rabbitDensity", warnings),
      boarDensity: num(rww.boarDensity, base.wildlife.boarDensity, RANGES.wildlife.boarDensity[0], RANGES.wildlife.boarDensity[1], "wildlife.boarDensity", warnings),
      wolfPackDensity: num(rww.wolfPackDensity, base.wildlife.wolfPackDensity, RANGES.wildlife.wolfPackDensity[0], RANGES.wildlife.wolfPackDensity[1], "wildlife.wolfPackDensity", warnings),
    },
    building: {
      enabled: bool(rb.enabled, base.building.enabled, "building.enabled", warnings),
      pieceCapPerPlayer: num(rb.pieceCapPerPlayer, base.building.pieceCapPerPlayer, RANGES.building.pieceCapPerPlayer[0], RANGES.building.pieceCapPerPlayer[1], "building.pieceCapPerPlayer", warnings, true),
      decayHours: num(rb.decayHours, base.building.decayHours, RANGES.building.decayHours[0], RANGES.building.decayHours[1], "building.decayHours", warnings),
      offlineRaidMult: num(rb.offlineRaidMult, base.building.offlineRaidMult, RANGES.building.offlineRaidMult[0], RANGES.building.offlineRaidMult[1], "building.offlineRaidMult", warnings),
    },
    session: {
      maxPlayers: num(rsess.maxPlayers, base.session.maxPlayers, RANGES.session.maxPlayers[0], RANGES.session.maxPlayers[1], "session.maxPlayers", warnings, true),
      respawnDelayS: num(rsess.respawnDelayS, base.session.respawnDelayS, RANGES.session.respawnDelayS[0], RANGES.session.respawnDelayS[1], "session.respawnDelayS", warnings),
      logoutLingerS: num(rsess.logoutLingerS, base.session.logoutLingerS, RANGES.session.logoutLingerS[0], RANGES.session.logoutLingerS[1], "session.logoutLingerS", warnings),
      wipeSchedule: wipeSchedule(rsess.wipeSchedule, base.session.wipeSchedule, warnings),
    },
    // LIVE-class — never sets worldCoerced (must not taint / wipe).
    map: {
      minimap: bool(rmap.minimap, base.map.minimap, "map.minimap", warnings),
      acquire: mapAcquire(rmap.acquire, base.map.acquire, warnings),
      reveal: mapReveal(rmap.reveal, base.map.reveal, warnings),
    },
    // LIVE-class (doc 13 §Migration): server-auth physics is outside the
    // client determinism contract — never sets worldCoerced.
    physics: {
      enabled: bool(rphys.enabled, base.physics.enabled, "physics.enabled", warnings),
      bodyCap: num(rphys.bodyCap, base.physics.bodyCap, RANGES.physics.bodyCap[0], RANGES.physics.bodyCap[1], "physics.bodyCap", warnings, true),
    },
  };

  return { config, worldCoerced };
}

function wipeSchedule(
  raw: unknown,
  fallback: WipeSchedule,
  warnings: string[],
): WipeSchedule {
  if (
    typeof raw === "string" &&
    (WIPE_SCHEDULES as readonly string[]).includes(raw)
  ) {
    return raw as WipeSchedule;
  }
  if (raw !== undefined) {
    warnings.push(`session.wipeSchedule: unknown "${String(raw)}", using ${fallback}`);
  }
  return fallback;
}

function mapAcquire(raw: unknown, fallback: MapAcquire, warnings: string[]): MapAcquire {
  if (typeof raw === "string" && (MAP_ACQUIRES as readonly string[]).includes(raw)) {
    return raw as MapAcquire;
  }
  if (raw !== undefined) {
    warnings.push(`map.acquire: unknown "${String(raw)}", using ${fallback}`);
  }
  return fallback;
}

function gameMode(raw: unknown, fallback: GameModeId, warnings: string[]): GameModeId {
  if (typeof raw === "string" && (GAME_MODES as readonly string[]).includes(raw)) {
    return raw as GameModeId;
  }
  if (raw !== undefined) {
    warnings.push(`mode: unknown "${String(raw)}", using ${fallback}`);
  }
  return fallback;
}

function mapReveal(raw: unknown, fallback: MapReveal, warnings: string[]): MapReveal {
  if (typeof raw === "string" && (MAP_REVEALS as readonly string[]).includes(raw)) {
    return raw as MapReveal;
  }
  if (raw !== undefined) {
    warnings.push(`map.reveal: unknown "${String(raw)}", using ${fallback}`);
  }
  return fallback;
}

/** Allowlist deep-merge of a DeepPartial<ServerConfig> over a base config — the
 * injection guard (only known keys are copied; never Object.assign). Reuses
 * clampInto so the merge is validated by the same code path. */
function mergeConfig(
  base: ServerConfig,
  partial: DeepPartial<ServerConfig>,
  warnings: string[],
): ClampResult {
  return clampInto(partial, base, warnings);
}

/**
 * Accepts: undefined (default config), a preset name string, a JSON string, or
 * an object { preset?: string; overrides?: DeepPartial<ServerConfig> }. Unknown
 * keys ignored with a warning; NaN/Infinity/out-of-range clamped; wrong types
 * fall back to the preset value. ALWAYS returns a usable config — a typo in
 * wrangler.jsonc must not brick the boot. The inverse guard matters just as
 * much: varAbsent/worldTainted let §4's wipe path refuse to act on fallback-
 * derived world identity.
 */
export function resolveServerConfig(raw: unknown): ResolvedConfig {
  const warnings: string[] = [];
  const varAbsent = raw === undefined || raw === null;
  let worldTainted = false;

  // Normalize raw → { presetName, overrides }.
  let presetName = "deadcoast";
  let overrides: DeepPartial<ServerConfig> | undefined;

  let value: unknown = raw;

  // A bare string is either a preset name or a JSON document.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.startsWith("{") ||
      trimmed.startsWith("[") ||
      trimmed.startsWith('"')
    ) {
      try {
        value = JSON.parse(trimmed);
        // A JSON string literal (e.g. '"warpath"') parses to a bare string —
        // treat it as a preset name, not an invalid object (which would silently
        // fall back to deadcoast).
        if (typeof value === "string") value = { preset: value.trim() };
      } catch {
        warnings.push(
          "GAME_CONFIG: unparseable JSON string, using deadcoast defaults",
        );
        worldTainted = true;
        value = undefined;
      }
    } else {
      // bare preset name
      value = { preset: trimmed };
    }
  }

  if (value !== undefined && value !== null) {
    if (isObject(value)) {
      if (typeof value.preset === "string") {
        presetName = value.preset;
      } else if (value.preset !== undefined) {
        warnings.push("GAME_CONFIG.preset: not a string, using deadcoast");
        worldTainted = true;
      }
      if (value.overrides !== undefined) {
        if (isObject(value.overrides)) {
          overrides = value.overrides as DeepPartial<ServerConfig>;
        } else {
          warnings.push("GAME_CONFIG.overrides: not an object, ignored");
        }
      }
    } else {
      warnings.push(
        "GAME_CONFIG: not a preset name or object, using deadcoast defaults",
      );
      worldTainted = true;
    }
  }

  // Resolve the preset partial.
  const presetPartial = PRESETS[presetName];
  let base = DEFAULT_CONFIG;
  if (presetPartial === undefined) {
    warnings.push(`GAME_CONFIG: unknown preset "${presetName}", using deadcoast`);
    // Unknown presets may pin world fields in a future binary; a name we don't
    // recognize must fail closed for WIPE decisions.
    worldTainted = true;
    presetName = "deadcoast";
  } else {
    const merged = mergeConfig(DEFAULT_CONFIG, presetPartial, warnings);
    base = merged.config;
    base.preset = presetName;
    if (merged.worldCoerced) worldTainted = true;
  }

  // Layer explicit overrides on top.
  let config = base;
  if (overrides !== undefined) {
    const merged = mergeConfig(base, overrides, warnings);
    config = merged.config;
    if (merged.worldCoerced) worldTainted = true;
    // Any override marks the resolved preset "custom" (doc 04 §1).
    config.preset = "custom";
  } else {
    config.preset = presetName;
  }

  // M2 lifted the M1 seed restriction: a clean, finite custom world.seed is now
  // honored and flows to worldFingerprintOf + createWorld. Persistence's fail-
  // closed fingerprint check (initSchema) — not coercion here — is what guards a
  // stale world_state from being hydrated into a different world. A non-finite
  // or wrong-typed seed is still clamped to WORLD_SEED + tainted upstream.

  return { config, warnings, varAbsent, worldTainted };
}

// =============================================================================
// 5. Worldgen params + derivations
// =============================================================================

/** The per-tier slice of WorldGenParams (everything but the seed). */
export interface TierParams {
  /** World edge length in meters (WorldGenParams.size). */
  size: number;
  towns: number;
  cabins: number;
  trees: number;
  rocks: number;
}

/** Per-tier worldgen constants (doc 07 §3; doc 04 M6 subsumed). The standard
 * row is single-sourced from the shipped constants, so standard-tier worldgen
 * stays byte-identical — the committed world.fingerprint.txt is the gate. */
const TIER_PARAMS: Record<WorldSizeTier, TierParams> = {
  standard: {
    size: WORLD_SIZE,
    towns: TOWN_COUNT,
    cabins: CABIN_COUNT,
    trees: TREE_COUNT,
    rocks: ROCK_COUNT,
  },
  large: { size: 1600, towns: 10, cabins: 18, trees: 2800, rocks: 280 },
  huge: { size: 3200, towns: 22, cabins: 44, trees: 11200, rocks: 1120 },
};

/** Full per-tier worldgen params. Exported so createWorld call sites and
 * tooling (fingerprint harness, map renderer) derive identical geometry from
 * the same table. */
export function tierParamsOf(tier: WorldSizeTier): TierParams {
  return TIER_PARAMS[tier];
}

/**
 * The explicit inputs createWorld needs, derived from WorldConfig (doc 07 M2).
 * Integers straight off the tier table — no float math, so client and server
 * derive bit-identical params from the same config.
 */
export function worldParamsOf(world: WorldConfig): WorldGenParams {
  // doc 07 M5: waterFeatures rides the params so both sides carve identically.
  // false → createWorld takes the exact pre-M5 dry path (byte-identical).
  return { seed: world.seed, waterFeatures: world.waterFeatures, ...tierParamsOf(world.sizeTier) };
}

/** Effective zombie population cap (server cap AND client pool hint). 0 when
 * zombies are disabled. */
export function effectiveZombieMax(cfg: ServerConfig): number {
  return cfg.threats.zombies
    ? Math.round(ZOMBIE_MAX * cfg.threats.zombieDensity)
    : 0;
}

/** Effective deer population (server cap AND client pool hint). */
export function effectiveDeerMax(cfg: ServerConfig): number {
  return Math.round(DEER_COUNT * cfg.wildlife.deerDensity);
}

/** Game-time → hour of day, honoring fixedHour and the configured day length /
 * start hour. The single clock derivation shared by server warmth logic, the
 * HUD clock, and the sky renderer. */
export function effectiveGameHour(cfg: TimeConfig, gameTimeS: number): number {
  if (cfg.fixedHour !== null) return cfg.fixedHour;
  return gameHours(gameTimeS, cfg.dayLengthMin * 60, cfg.startHour);
}

// =============================================================================
// 6. World fingerprint (config WIPE-class identity — NOT the worldgen hash)
// =============================================================================

/**
 * Canonical string of the WIPE-class world fields: `v1|seed:1337|size:standard|
 * water:0` (plus `|gen:N` once WORLDGEN_VERSION >= 2). Round-trippable with
 * parseWorldFingerprint. Persistence compares this instead of the bare
 * world_seed, and the fail-closed refusal path boots the world FROM the stored
 * string. `gen:` is WORLDGEN_VERSION (doc 07 M1) — a formula-change counter;
 * absent == 1 on EVERY parse path, so the suffix is OMITTED while the running
 * version is 1. That omission is load-bearing rollback safety: a stored
 * `...|gen:1` string is unreadable to every pre-doc-07 binary (their 4-part
 * fingerprint regex + string equality both fail), so eagerly writing the
 * 5-part form would turn a routine revert of the doc 07 deploy into a
 * production wipe on both the sanctioned and fail-closed paths. doc 07 M5 does
 * NOT bump it: the water carve only reshapes heightAt on the WET path
 * (waterFeatures:true) and leaves the dry seed-1337 prod world byte-identical,
 * so its identity is distinguished by the existing `water:0/1` component and
 * WORLDGEN_VERSION stays 1 (a bump would emit `|gen:2` for the live dry world
 * and wipe it on ship). The first 5-part/gen-bump writer is therefore the first
 * FUTURE formula change that alters an already-shipped world's geometry from an
 * identical config — by which time no gen-unaware binary is a plausible
 * rollback target. NOTE: this is the
 * config wipe identity, NOT the worldgen determinism hash
 * (scripts/fingerprint.mjs) — they are unrelated; do not conflate them.
 */
export function worldFingerprintOf(world: WorldConfig): string {
  const base = `v1|seed:${world.seed}|size:${world.sizeTier}|water:${world.waterFeatures ? 1 : 0}`;
  return (WORLDGEN_VERSION as number) >= 2 ? `${base}|gen:${WORLDGEN_VERSION}` : base;
}

/** Parse a fingerprint string back to a WorldConfig, or null if it is not a
 * well-formed v1 fingerprint. Accepts 4 parts (pre-gen legacy, gen == 1) or 5
 * parts (`gen:N`). Total; never throws. The gen component is validated for
 * shape but not returned — WorldConfig has no gen field; the running binary's
 * WORLDGEN_VERSION is compile-time. */
export function parseWorldFingerprint(fp: string): WorldConfig | null {
  if (typeof fp !== "string") return null;
  const parts = fp.split("|");
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== "v1") return null;

  const seedMatch = /^seed:(-?\d+)$/.exec(parts[1]);
  const sizeMatch = /^size:(.+)$/.exec(parts[2]);
  const waterMatch = /^water:([01])$/.exec(parts[3]);
  if (!seedMatch || !sizeMatch || !waterMatch) return null;
  if (parts.length === 5 && !/^gen:\d+$/.test(parts[4])) return null;

  const sizeTier = sizeMatch[1];
  if (!(SIZE_TIERS as readonly string[]).includes(sizeTier)) return null;

  return {
    seed: Number.parseInt(seedMatch[1], 10),
    sizeTier: sizeTier as WorldSizeTier,
    waterFeatures: waterMatch[1] === "1",
  };
}

// =============================================================================
// 7. Wipe epoch (counter, not a cron — doc 04 §4)
// =============================================================================

/** Anchor for scheduled-wipe epoch math: 2026-01-05 00:00 UTC (a Monday). */
export const ANCHOR_MS = Date.UTC(2026, 0, 5);

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<Exclude<WipeSchedule, "never">, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/**
 * Epoch counter for the wipe schedule. `never` pins 0; otherwise
 * floor((nowMs - ANCHOR_MS) / periodMs). An epoch is meaningless without its
 * schedule, so persistence stores the pair (doc 04 §4). Before the anchor the
 * epoch floors negative — harmless, the pair still round-trips.
 */
export function wipeEpochOf(schedule: WipeSchedule, nowMs: number): number {
  if (schedule === "never") return 0;
  const periodMs = PERIOD_DAYS[schedule] * DAY_MS;
  return Math.floor((nowMs - ANCHOR_MS) / periodMs);
}

// =============================================================================
// 8. Rules summary (badge derivation; type owned by serverInfo.ts / doc 03)
// =============================================================================

const KNOWN_PRESETS: readonly RulesSummary["preset"][] = [
  "deadcoast",
  "driftwood",
  "ironcoast",
  "warpath",
  "homestead",
  "nightfall",
];

/** Band a 0..N multiplier into low/mid/high semantics: <0.75 low, ≤1.25 mid,
 * >1.25 high. */
function band3<L, M, H>(v: number, low: L, mid: M, high: H): L | M | H {
  if (v < 0.75) return low;
  if (v <= 1.25) return mid;
  return high;
}

/**
 * Map a ServerConfig to render-ready rules badges. The directory renders these
 * as badges and MUST NOT need to understand the full ServerConfig. The banding
 * thresholds are doc 04 §6; the preset field is membership-checked against the
 * shipped registry and resolves anything unknown/overridden to "custom".
 */
export function summarizeRules(cfg: ServerConfig): RulesSummary {
  const presetKnown = (KNOWN_PRESETS as readonly string[]).includes(cfg.preset);
  const preset: RulesSummary["preset"] = presetKnown
    ? (cfg.preset as RulesSummary["preset"])
    : "custom";

  const zombies: RulesSummary["zombies"] = !cfg.threats.zombies
    ? "off"
    : band3(cfg.threats.zombieDensity, "sparse", "normal", "horde");

  const loot: RulesSummary["loot"] = band3(
    cfg.loot.density,
    "scarce",
    "normal",
    "plentiful",
  );

  const vitalsMax = Math.max(
    cfg.survival.hungerRate,
    cfg.survival.thirstRate,
    cfg.survival.temperatureSeverity,
  );
  const vitals: RulesSummary["vitals"] = band3(
    vitalsMax,
    "gentle",
    "normal",
    "harsh",
  );

  let night: RulesSummary["night"];
  if (cfg.time.fixedHour === null) {
    night = "cycle";
  } else if (
    cfg.time.fixedHour >= NIGHT_START_HOUR ||
    cfg.time.fixedHour < NIGHT_END_HOUR
  ) {
    night = "always";
  } else {
    night = "never";
  }

  // Map regime badge: fog dominates find dominates full; off only when there is
  // no surface at all (no minimap AND no obtainable map item).
  const m = cfg.map;
  const map: RulesSummary["map"] =
    !m.minimap && m.acquire === "none"
      ? "off"
      : m.reveal === "explored"
        ? "fog"
        : m.acquire === "loot"
          ? "find"
          : "full";

  return {
    preset,
    zombies,
    pvp: cfg.pvp.enabled,
    fullLoot: cfg.pvp.fullLoot,
    loot,
    vitals,
    night,
    dayLengthMin: cfg.time.dayLengthMin,
    worldSize: cfg.world.sizeTier,
    maxPlayers: cfg.session.maxPlayers,
    wipe: cfg.session.wipeSchedule,
    map,
  };
}
