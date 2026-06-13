// packages/shared/src/scenario.ts — the typed Scenario schema (doc 10 M2, the
// KEYSTONE). A Scenario is the single contract every later consumer reads:
// M3's provisionTestbed(state, player, scenario), M4's in-game QA panel, the M5
// /testbed skill, and the M6 headless harness all read THIS shape. It is to the
// testbed exactly what ServerConfig (config.ts) is to the server: one typed
// object, one total/never-throws parser, never trusted raw off the wire.
//
// House rules (same as config.ts): strict TS, named exports, NO runtime deps.
// This file value-imports nothing but its own helpers — it must stay
// dependency-clean so M3's testbed.ts (whose only runtime imports are
// @worldspring/shared/*, for the node --experimental-strip-types harness) can
// import the Scenario *type* without dragging in a value-import chain. The
// ItemType import below is TYPE-ONLY (erased, isolatedModules-safe).
//
// CRITICAL forward-compat rule: a loadout entry's `id` is a STRING, not
// ItemType. Naming an item absent from this build (doc 05's canteen_*/
// fishing_rod before they land) parses fine and is simply skipped at
// provision time (M3's isItemType no-op guard) — then "lights up" once the id
// enters ITEM_DEFS. parseScenario therefore MUST NOT reject unknown item ids.

import type { ItemType } from "./items";

// =============================================================================
// 1. Schema
// =============================================================================

/** Spawn zone for the position primitive. "coastal" = the beach spawn ring (M1's
 * spawnPoints[0]); inland/military are reserved for M5+ and parse-but-default to
 * coastal at provision time until their geometry is wired. */
export type ScenarioZone = "coastal" | "inland" | "military";
/** Which way the spawned player faces. "ocean" = seaward (M1's behavior); "inland"
 * = toward origin (yaw + π). */
export type ScenarioFace = "ocean" | "inland";
/** Cooldown kinds the harness can zero so an action lands on the first tick. */
export type CooldownKind = "attack" | "respawn" | "item" | "fish";

/**
 * A single provisioning step. The discriminant is `kind`. provision[] is an
 * ORDERED array walked in sequence at provision time (position-then-fire-at-feet
 * composes correctly), NOT a struct — so M5 can append spawn/time/weather
 * primitives without reshaping anything. The M5-reserved variants below parse
 * today (their numerics clamp, their shape is stable) but provisionTestbed
 * no-ops-with-warn on them until M5 wires the system fns — the same
 * forward-compat posture as unknown item ids and config.ts's reserved fields.
 */
export type Provision =
  // --- live in M3 ---
  | { kind: "loadout"; items: ScenarioItem[] }
  | { kind: "vitals"; hp?: number; food?: number; water?: number; temp?: number }
  | { kind: "fire"; atFeet: true }
  | { kind: "position"; zone: ScenarioZone; face: ScenarioFace }
  | { kind: "clearCooldowns"; which: CooldownKind[] }
  // --- reserved for M5 (parsed-but-inert) ---
  | { kind: "spawnZombie"; count: number; military: boolean }
  | { kind: "spawnAnimal"; species: string; count: number }
  | { kind: "setTime"; hour: number }
  | { kind: "setWeather"; weather: "clear" | "rain" }
  | { kind: "config"; preset: string };

/** A loadout line. `type` is a STRING (not ItemType) on purpose — the
 * forward-compat no-op-unknowns rule. count is clamped to a sane stack-ish band. */
export interface ScenarioItem {
  type: string;
  count: number;
}

/** A harness assertion the M6 testkit checks after provisioning / after a Step.
 * Parsed and carried now so the schema shape M6 reads is already stable; M2 does
 * not execute them. */
export type Assert =
  | { on: "inv"; type: string; atLeast: number }
  | { on: "vitals"; field: "hp" | "food" | "water" | "temp"; cmp: "lte" | "gte"; value: number }
  | { on: "notice"; contains: string }
  | { on: "error"; contains: string }
  | { on: "snap"; path: string; equals: string | number | boolean };

/** A scripted harness action (M6 drives these: equip a slot, use an item, send
 * an input). Carried now so the shape is stable; M2 does not execute them. */
export interface Step {
  /** Human label shown in harness output. */
  label: string;
  /** Opaque action verb (e.g. "equip", "use", "input"); M6 owns the vocabulary. */
  action: string;
  /** Free-form args for the action (slot index, item type, input flags). */
  args?: Record<string, string | number | boolean>;
  /** Assertions to check after this step runs. */
  assert?: Assert[];
}

export interface Scenario {
  /** Registry key + the name a join may select. Lowercase id-ish. */
  name: string;
  /** Ordered provisioning primitives applied at testbed join (M3). */
  provision: Provision[];
  /** Human smoke-test steps. Rendered verbatim by M4's in-game QA panel AND
   * emitted by M5's /testbed skill as the "Manual smoke tests needed" markdown —
   * BOTH read this one field so the two never drift. Stored on the Scenario now
   * (per the M2 build note) so it isn't retrofitted in M4/M5. */
  checklist: string[];
  /** Optional scripted harness actions (M6). */
  steps?: Step[];
  /** Optional post-provision assertions (M6). */
  assert?: Assert[];
}

// =============================================================================
// 2. Built-in default — the universal kit, single-sourced as a code fallback
// =============================================================================

/**
 * The universal testbed scenario as a code literal, so the M3 registry has a
 * usable default even with zero JSON files (and parseScenario has a base to fall
 * back to on hostile input — same posture as DEFAULT_CONFIG). This mirrors M1's
 * hardcoded TESTBED_LOADOUT / TESTBED_VITALS (testbed.ts) exactly, including the
 * doc 05 ids absent from main (canteen_* and fishing_rod) which provisioning
 * skips until they enter ITEM_DEFS. apps/game/scenarios/survival.json is the
 * on-disk twin of this literal; the test asserts they agree.
 */
export const BUILTIN_SCENARIO: Scenario = {
  name: "survival",
  provision: [
    { kind: "position", zone: "coastal", face: "ocean" },
    { kind: "fire", atFeet: true },
    {
      kind: "loadout",
      items: [
        { type: "beans", count: 3 },
        { type: "water_bottle", count: 2 },
        { type: "bandage", count: 2 },
        { type: "raw_venison", count: 3 },
        { type: "canteen_empty", count: 1 },
        { type: "canteen_dirty", count: 1 },
        { type: "canteen_clean", count: 1 },
        { type: "fishing_rod", count: 1 },
      ],
    },
    { kind: "vitals", hp: 50, food: 50, water: 20, temp: 37 }, // 37 = TEMP_NORMAL
    { kind: "clearCooldowns", which: ["attack", "item"] },
  ],
  checklist: [
    "Spawn on the beach facing the ocean with a lit campfire at your feet.",
    "Eat beans (slot 1) — food goes up, no hp change.",
    "Drink a water bottle — water goes up.",
    "Eat raw venison away from the fire — food up a little, hp drops 8.",
    "Eat raw venison standing in the campfire — it cooks first (cooked_venison), bigger food gain, no hp loss.",
    "Apply a bandage — hp goes up toward 100.",
  ],
};

// =============================================================================
// 3. Parser — manual, total, never throws (mirrors config.ts clampConfig)
// =============================================================================

// Caps, single-sourced here (no constants.ts value-import — keep this file
// dependency-clean). MAX_HP/FOOD/WATER are 100; the normal body temp is 37, the
// body-temp band is roughly 32..45, so temp clamps into [20, 60] to leave
// headroom without allowing absurd values.
const VITAL_MAX = 100;
const TEMP_MIN = 20;
const TEMP_MAX = 60;
/** A loadout count cap. Real stacks max at 30 (ammo_9mm), but a scenario may
 * intentionally over-fill to fan across slots; cap generously, never reject. */
const COUNT_MAX = 999;
/** Bounds so a hostile JSON can't allocate unboundedly. */
const MAX_PROVISIONS = 64;
const MAX_ITEMS = 64;
const MAX_STR = 64;
const MAX_LIST = 64;

const ZONES: readonly ScenarioZone[] = ["coastal", "inland", "military"];
const FACES: readonly ScenarioFace[] = ["ocean", "inland"];
const COOLDOWNS: readonly CooldownKind[] = ["attack", "respawn", "item", "fish"];
const WEATHERS = ["clear", "rain"] as const;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a finite number, clamp to [min,max]; otherwise return fallback. Integer
 * fields truncate. Total; pushes nothing (the parser collects warnings via
 * console.warn at the call sites that matter, mirroring testbed.ts). */
function num(raw: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const v = integer ? Math.trunc(raw) : raw;
  return clamp(v, min, max);
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** A bounded, trimmed string or the fallback. */
function str(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  return raw.length > MAX_STR ? raw.slice(0, MAX_STR) : raw;
}

/** Optional vitals field: a clamped number, or undefined if absent/invalid. */
function optVital(raw: unknown, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return clamp(raw, min, max);
}

/** Parse one loadout item. Returns null to DROP a malformed entry (the parser
 * filters nulls). `type` is kept as a string even if unknown to ITEM_DEFS — the
 * forward-compat rule; provisioning, not the schema, decides to skip it. */
function parseItem(raw: unknown): ScenarioItem | null {
  if (!isObject(raw)) return null;
  if (typeof raw.type !== "string" || raw.type.length === 0) return null;
  const type = raw.type.length > MAX_STR ? raw.type.slice(0, MAX_STR) : raw.type;
  // count defaults to 1 and clamps to [1, COUNT_MAX]; a bad count never drops
  // the line (it would silently lose a kit item), it just floors to 1.
  const count = num(raw.count, 1, 1, COUNT_MAX, true);
  return { type, count };
}

/** Parse one provision primitive. Returns null to DROP an unknown/malformed kind
 * (warn + filtered), so a typo in a single entry never bricks the whole scenario
 * — exactly clampConfig's posture, applied per-entry. */
function parseProvision(raw: unknown): Provision | null {
  if (!isObject(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "loadout": {
      const arr = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
      const items = arr.map(parseItem).filter((x): x is ScenarioItem => x !== null);
      return { kind: "loadout", items };
    }
    case "vitals":
      return {
        kind: "vitals",
        hp: optVital(raw.hp, 0, VITAL_MAX),
        food: optVital(raw.food, 0, VITAL_MAX),
        water: optVital(raw.water, 0, VITAL_MAX),
        temp: optVital(raw.temp, TEMP_MIN, TEMP_MAX),
      };
    case "fire":
      return { kind: "fire", atFeet: true };
    case "position":
      return {
        kind: "position",
        zone: enumOr(raw.zone, ZONES, "coastal"),
        face: enumOr(raw.face, FACES, "ocean"),
      };
    case "clearCooldowns": {
      const which = (Array.isArray(raw.which) ? raw.which : [])
        .filter((w): w is CooldownKind => (COOLDOWNS as readonly unknown[]).includes(w))
        .slice(0, MAX_LIST);
      return { kind: "clearCooldowns", which };
    }
    // --- M5-reserved: parsed-but-inert ---
    case "spawnZombie":
      return { kind: "spawnZombie", count: num(raw.count, 1, 0, 999, true), military: bool(raw.military, false) };
    case "spawnAnimal":
      return { kind: "spawnAnimal", species: str(raw.species, "deer"), count: num(raw.count, 1, 0, 999, true) };
    case "setTime":
      return { kind: "setTime", hour: num(raw.hour, 12, 0, 24) };
    case "setWeather":
      return { kind: "setWeather", weather: enumOr(raw.weather, WEATHERS, "clear") };
    case "config":
      return { kind: "config", preset: str(raw.preset, "deadcoast") };
    default:
      console.warn(`[scenario] unknown provision kind "${String(raw.kind)}" — dropped`);
      return null;
  }
}

/** Membership-checked enum read with a typed fallback. */
function enumOr<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Parse a bounded array of strings (the checklist). Non-string entries dropped. */
function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => (s.length > 512 ? s.slice(0, 512) : s))
    .slice(0, MAX_LIST);
}

/** Parse one assertion (M6 shape). Returns null to drop a malformed entry. */
function parseAssert(raw: unknown): Assert | null {
  if (!isObject(raw) || typeof raw.on !== "string") return null;
  switch (raw.on) {
    case "inv":
      if (typeof raw.type !== "string") return null;
      return { on: "inv", type: raw.type, atLeast: num(raw.atLeast, 1, 0, COUNT_MAX, true) };
    case "vitals": {
      const field = enumOr(raw.field, ["hp", "food", "water", "temp"] as const, "hp");
      const cmp = enumOr(raw.cmp, ["lte", "gte"] as const, "gte");
      return { on: "vitals", field, cmp, value: num(raw.value, 0, TEMP_MIN, VITAL_MAX) };
    }
    case "notice":
      return { on: "notice", contains: str(raw.contains, "") };
    case "error":
      return { on: "error", contains: str(raw.contains, "") };
    case "snap":
      if (typeof raw.path !== "string") return null;
      if (typeof raw.equals !== "string" && typeof raw.equals !== "number" && typeof raw.equals !== "boolean") {
        return null;
      }
      return { on: "snap", path: raw.path, equals: raw.equals };
    default:
      return null;
  }
}

function parseAsserts(raw: unknown): Assert[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(parseAssert).filter((a): a is Assert => a !== null).slice(0, MAX_LIST);
  return out.length > 0 ? out : undefined;
}

function parseStep(raw: unknown): Step | null {
  if (!isObject(raw)) return null;
  if (typeof raw.action !== "string") return null;
  const step: Step = { label: str(raw.label, raw.action), action: raw.action };
  if (isObject(raw.args)) {
    const args: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.args)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") args[k] = v;
    }
    step.args = args;
  }
  const asserts = parseAsserts(raw.assert);
  if (asserts) step.assert = asserts;
  return step;
}

function parseSteps(raw: unknown): Step[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(parseStep).filter((s): s is Step => s !== null).slice(0, MAX_LIST);
  return out.length > 0 ? out : undefined;
}

/**
 * Parse any input into a usable Scenario. TOTAL and NEVER THROWS — the same
 * invariant resolveServerConfig/clampConfig hold for GAME_CONFIG: a typo in a
 * scenario JSON (or a hostile welcome) must never brick boot or a join. Behavior:
 *
 * - Non-object input            → BUILTIN_SCENARIO (clean fallback).
 * - Missing/blank name          → BUILTIN_SCENARIO.name.
 * - provision not an array      → [] (an empty, harmless scenario).
 * - A malformed provision entry → DROPPED (warn); the rest are kept.
 * - Out-of-range numerics       → clamped to caps.
 * - Unknown item ids            → KEPT as strings (forward-compat no-op rule).
 *
 * A JSON string is accepted too (parsed; unparseable → BUILTIN), so the M3
 * registry can hand a raw imported blob OR a string straight in.
 */
export function parseScenario(input: unknown): Scenario {
  let raw: unknown = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      console.warn("[scenario] unparseable JSON string — using BUILTIN_SCENARIO");
      return cloneBuiltin();
    }
  }
  if (!isObject(raw)) {
    if (raw !== undefined) console.warn("[scenario] not an object — using BUILTIN_SCENARIO");
    return cloneBuiltin();
  }

  const name = str(raw.name, BUILTIN_SCENARIO.name) || BUILTIN_SCENARIO.name;

  const provisionRaw = Array.isArray(raw.provision) ? raw.provision.slice(0, MAX_PROVISIONS) : [];
  if (raw.provision !== undefined && !Array.isArray(raw.provision)) {
    console.warn(`[scenario] "${name}": provision is not an array — using []`);
  }
  const provision = provisionRaw
    .map(parseProvision)
    .filter((p): p is Provision => p !== null);

  const scenario: Scenario = {
    name,
    provision,
    checklist: parseStringList(raw.checklist),
  };
  const steps = parseSteps(raw.steps);
  if (steps) scenario.steps = steps;
  const asserts = parseAsserts(raw.assert);
  if (asserts) scenario.assert = asserts;
  return scenario;
}

/** A fresh deep copy of the builtin so callers can never mutate the shared
 * literal (the registry freezes; the parser hands out copies). */
function cloneBuiltin(): Scenario {
  return parseScenarioFromLiteral(BUILTIN_SCENARIO);
}

/** Internal: rebuild a Scenario from a known-good literal without the
 * string/object guards (used only for cloneBuiltin). Kept separate so the public
 * parseScenario stays the single hostile-input entry point. */
function parseScenarioFromLiteral(s: Scenario): Scenario {
  return {
    name: s.name,
    provision: s.provision.map((p) => structuredCloneProvision(p)),
    checklist: [...s.checklist],
    ...(s.steps ? { steps: s.steps.map((st) => ({ ...st })) } : {}),
    ...(s.assert ? { assert: s.assert.map((a) => ({ ...a })) } : {}),
  };
}

function structuredCloneProvision(p: Provision): Provision {
  if (p.kind === "loadout") return { kind: "loadout", items: p.items.map((i) => ({ ...i })) };
  if (p.kind === "clearCooldowns") return { kind: "clearCooldowns", which: [...p.which] };
  return { ...p };
}

// Type-only touch so the unused ItemType import is intentional documentation of
// the forward-compat contract (loadout ids ARE eventually ItemType, but the
// schema does not require it). Erased at compile time.
export type KnownItemId = ItemType;
