// Doc 04 M1 — the repo's first vitest suite. Pure shared code, plain node env.
//
// The field-by-field defaults test imports the SHIPPED CONSTANTS and compares
// DEFAULT_CONFIG against them — it does NOT hardcode the expected numbers
// (that would make the assertion circular: it would only prove the literal
// equals itself). The whole point is to catch a future constants.ts edit that
// silently diverges DEFAULT_CONFIG from the real defaults.

import { describe, expect, it } from "vitest";

import {
  ANCHOR_MS,
  clampConfig,
  DEFAULT_CONFIG,
  effectiveDeerMax,
  effectiveGameHour,
  effectiveZombieMax,
  parseWorldFingerprint,
  PRESETS,
  resolveServerConfig,
  summarizeRules,
  wipeEpochOf,
  worldFingerprintOf,
  worldParamsOf,
} from "./config";
import type { ServerConfig } from "./config";
import {
  DAY_DURATION_S,
  DEER_COUNT,
  LOGOUT_LINGER_S,
  MAX_PLAYERS,
  RESPAWN_DELAY_S,
  START_HOUR,
  WORLD_SEED,
  ZOMBIE_MAX,
} from "./constants";
import { gameHours } from "./protocol";

// =============================================================================
// DEFAULT_CONFIG ⇔ shipped constants (the zero-behavior-change proof)
// =============================================================================

describe("DEFAULT_CONFIG equals the shipped constants field-by-field", () => {
  it("world identity matches WORLD_SEED, standard, no water", () => {
    expect(DEFAULT_CONFIG.world.seed).toBe(WORLD_SEED);
    expect(DEFAULT_CONFIG.world.sizeTier).toBe("standard");
    expect(DEFAULT_CONFIG.world.waterFeatures).toBe(false);
  });

  it("session absolutes match the constants", () => {
    expect(DEFAULT_CONFIG.session.maxPlayers).toBe(MAX_PLAYERS);
    expect(DEFAULT_CONFIG.session.respawnDelayS).toBe(RESPAWN_DELAY_S);
    expect(DEFAULT_CONFIG.session.logoutLingerS).toBe(LOGOUT_LINGER_S);
    expect(DEFAULT_CONFIG.session.wipeSchedule).toBe("never");
  });

  it("time absolutes match the constants (day length derived from DAY_DURATION_S)", () => {
    expect(DEFAULT_CONFIG.time.dayLengthMin).toBe(DAY_DURATION_S / 60);
    expect(DEFAULT_CONFIG.time.startHour).toBe(START_HOUR);
    expect(DEFAULT_CONFIG.time.fixedHour).toBeNull();
  });

  it("every multiplier is 1 (byte-identical behavior)", () => {
    expect(DEFAULT_CONFIG.threats.zombieDensity).toBe(1);
    expect(DEFAULT_CONFIG.threats.zombieDamage).toBe(1);
    expect(DEFAULT_CONFIG.threats.zombieSpeed).toBe(1);
    expect(DEFAULT_CONFIG.loot.density).toBe(1);
    expect(DEFAULT_CONFIG.loot.tierDensity.coastal).toBe(1);
    expect(DEFAULT_CONFIG.loot.tierDensity.inland).toBe(1);
    expect(DEFAULT_CONFIG.loot.tierDensity.military).toBe(1);
    expect(DEFAULT_CONFIG.loot.respawnRate).toBe(1);
    expect(DEFAULT_CONFIG.loot.airdrops).toBe(1);
    expect(DEFAULT_CONFIG.survival.hungerRate).toBe(1);
    expect(DEFAULT_CONFIG.survival.thirstRate).toBe(1);
    expect(DEFAULT_CONFIG.survival.temperatureSeverity).toBe(1);
    expect(DEFAULT_CONFIG.survival.regenRate).toBe(1);
    expect(DEFAULT_CONFIG.pvp.damageMult).toBe(1);
    expect(DEFAULT_CONFIG.wildlife.deerDensity).toBe(1);
    expect(DEFAULT_CONFIG.wildlife.rabbitDensity).toBe(1);
    expect(DEFAULT_CONFIG.wildlife.boarDensity).toBe(1);
    expect(DEFAULT_CONFIG.wildlife.wolfPackDensity).toBe(1);
  });

  it("every toggle matches today's behavior", () => {
    expect(DEFAULT_CONFIG.threats.zombies).toBe(true);
    expect(DEFAULT_CONFIG.threats.militaryZone).toBe(true);
    expect(DEFAULT_CONFIG.pvp.enabled).toBe(true);
    expect(DEFAULT_CONFIG.pvp.fullLoot).toBe(true);
    expect(DEFAULT_CONFIG.building.enabled).toBe(true);
  });

  it("building defaults are 120 / 168 / 0.25", () => {
    expect(DEFAULT_CONFIG.building.pieceCapPerPlayer).toBe(120);
    expect(DEFAULT_CONFIG.building.decayHours).toBe(168);
    expect(DEFAULT_CONFIG.building.offlineRaidMult).toBe(0.25);
  });

  it("preset id is deadcoast", () => {
    expect(DEFAULT_CONFIG.preset).toBe("deadcoast");
  });

  it("derivations match the raw constants at default", () => {
    expect(effectiveZombieMax(DEFAULT_CONFIG)).toBe(ZOMBIE_MAX);
    expect(effectiveDeerMax(DEFAULT_CONFIG)).toBe(DEER_COUNT);
    // effectiveGameHour at default must equal the legacy gameHours call exactly.
    for (const t of [0, 100, DAY_DURATION_S / 2, DAY_DURATION_S, 99999]) {
      expect(effectiveGameHour(DEFAULT_CONFIG.time, t)).toBe(
        gameHours(t, DAY_DURATION_S, START_HOUR),
      );
    }
  });
});

// =============================================================================
// resolveServerConfig — default boot, presets, fuzz, seed coercion
// =============================================================================

describe("resolveServerConfig", () => {
  it("absent var resolves to DEFAULT_CONFIG with varAbsent + zero warnings", () => {
    const r = resolveServerConfig(undefined);
    expect(r.varAbsent).toBe(true);
    expect(r.worldTainted).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });

  it("null var also resolves cleanly (varAbsent, no warnings)", () => {
    const r = resolveServerConfig(null);
    expect(r.varAbsent).toBe(true);
    expect(r.worldTainted).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });

  it("a known preset name resolves to that preset (not varAbsent, not tainted)", () => {
    const r = resolveServerConfig("warpath");
    expect(r.varAbsent).toBe(false);
    expect(r.worldTainted).toBe(false);
    expect(r.config.preset).toBe("warpath");
    // spot-check matrix values
    expect(r.config.threats.zombieDensity).toBe(0.5);
    expect(r.config.loot.tierDensity.military).toBe(1.5);
    expect(r.config.time.dayLengthMin).toBe(12);
    expect(r.config.session.wipeSchedule).toBe("weekly");
  });

  it("a JSON-string preset wrapper resolves the same as the bare name", () => {
    const bare = resolveServerConfig("ironcoast").config;
    const json = resolveServerConfig('{"preset":"ironcoast"}').config;
    expect(json).toEqual(bare);
  });

  it("a JSON string-literal preset resolves the same as the bare name", () => {
    const bare = resolveServerConfig("warpath").config;
    const jsonLiteral = resolveServerConfig('"warpath"').config;
    expect(jsonLiteral).toEqual(bare);
  });

  it("clampConfig bounds an out-of-range time.fixedHour", () => {
    const hi = clampConfig({ time: { fixedHour: 99 } }).time.fixedHour;
    const lo = clampConfig({ time: { fixedHour: -5 } }).time.fixedHour;
    expect(hi).not.toBe(99);
    expect(lo).not.toBe(-5);
    expect(hi).toBeLessThanOrEqual(24);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it("an object with overrides marks preset custom and applies clamped values", () => {
    const r = resolveServerConfig({
      preset: "warpath",
      overrides: { threats: { zombieDensity: 0.9 } },
    });
    expect(r.config.preset).toBe("custom");
    expect(r.config.threats.zombieDensity).toBe(0.9);
    // untouched warpath value survives
    expect(r.config.loot.respawnRate).toBe(2);
  });

  it("unknown preset name falls back to deadcoast AND taints (fail-closed)", () => {
    const r = resolveServerConfig("does-not-exist");
    expect(r.config.preset).toBe("deadcoast");
    expect(r.worldTainted).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/unknown preset/);
  });

  it("unparseable JSON string falls back + taints", () => {
    const r = resolveServerConfig("{not valid json");
    expect(r.worldTainted).toBe(true);
    expect(r.config).toMatchObject({ preset: "deadcoast" });
  });

  it("garbage non-string/non-object input falls back + taints", () => {
    for (const garbage of [42, true, ["a", "b"]]) {
      const r = resolveServerConfig(garbage);
      expect(r.worldTainted).toBe(true);
      expect(r.config.world.seed).toBe(WORLD_SEED);
    }
  });

  it("out-of-range override numbers clamp with a warning, config still usable", () => {
    const r = resolveServerConfig({
      overrides: {
        threats: { zombieDensity: 1e9 },
        time: { dayLengthMin: 0 },
        survival: { hungerRate: -5 },
      },
    });
    expect(r.config.threats.zombieDensity).toBe(2); // clamped to max
    expect(r.config.time.dayLengthMin).toBe(4); // clamped to min
    expect(r.config.survival.hungerRate).toBe(0); // clamped to min
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("NaN / Infinity numbers fall back to the base value", () => {
    const r = resolveServerConfig({
      overrides: {
        threats: { zombieDamage: Number.NaN },
        loot: { density: Number.POSITIVE_INFINITY },
      },
    });
    expect(r.config.threats.zombieDamage).toBe(DEFAULT_CONFIG.threats.zombieDamage);
    // Infinity is non-finite → falls back to base (NOT clamped to max).
    expect(r.config.loot.density).toBe(DEFAULT_CONFIG.loot.density);
  });

  it("M1 coerces a non-default world.seed back to WORLD_SEED + taints", () => {
    const r = resolveServerConfig({ overrides: { world: { seed: 4242 } } });
    expect(r.config.world.seed).toBe(WORLD_SEED);
    expect(r.worldTainted).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/seed/);
  });

  it("M1 coerces a non-standard sizeTier to standard + taints", () => {
    const r = resolveServerConfig({ overrides: { world: { sizeTier: "huge" } } });
    expect(r.config.world.sizeTier).toBe("standard");
    expect(r.worldTainted).toBe(true);
  });

  it("waterFeatures:true is coerced to false + taints (reserved until doc 07)", () => {
    const r = resolveServerConfig({ overrides: { world: { waterFeatures: true } } });
    expect(r.config.world.waterFeatures).toBe(false);
    expect(r.worldTainted).toBe(true);
  });

  it("a bad world value (string seed) taints but does not throw", () => {
    const r = resolveServerConfig({
      overrides: { world: { seed: "not-a-number" } },
    } as unknown);
    expect(r.config.world.seed).toBe(WORLD_SEED);
    expect(r.worldTainted).toBe(true);
  });
});

// =============================================================================
// every preset resolves cleanly and is byte-stable
// =============================================================================

describe("PRESETS", () => {
  it("ships exactly the six documented presets", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      ["deadcoast", "driftwood", "homestead", "ironcoast", "nightfall", "warpath"].sort(),
    );
  });

  it("deadcoast preset resolves identical to DEFAULT_CONFIG", () => {
    expect(resolveServerConfig("deadcoast").config).toEqual(DEFAULT_CONFIG);
  });

  for (const name of Object.keys(PRESETS)) {
    it(`${name} resolves with no warnings and no taint`, () => {
      const r = resolveServerConfig(name);
      expect(r.warnings).toEqual([]);
      expect(r.worldTainted).toBe(false);
      expect(r.config.preset).toBe(name);
      // every preset keeps the WIPE-class fields at default in M1
      expect(r.config.world.seed).toBe(WORLD_SEED);
      expect(r.config.world.sizeTier).toBe("standard");
      expect(r.config.world.waterFeatures).toBe(false);
    });
  }

  it("driftwood/homestead disable zombies and PvP per the matrix", () => {
    for (const name of ["driftwood", "homestead"]) {
      const c = resolveServerConfig(name).config;
      expect(c.threats.zombies).toBe(false);
      expect(c.pvp.enabled).toBe(false);
      expect(c.pvp.fullLoot).toBe(false);
    }
  });

  it("nightfall freezes the clock at hour 1", () => {
    expect(resolveServerConfig("nightfall").config.time.fixedHour).toBe(1);
  });
});

// =============================================================================
// clampConfig — the client trust guard
// =============================================================================

describe("clampConfig (client-side total clamp)", () => {
  it("undefined → DEFAULT_CONFIG (the no-welcome-config fallback)", () => {
    expect(clampConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("a clean DEFAULT_CONFIG round-trips unchanged", () => {
    expect(clampConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it("hostile zombieDensity:1e9 clamps into [0,2] (render-pool OOM guard)", () => {
    const c = clampConfig({ threats: { zombieDensity: 1e9 } });
    expect(c.threats.zombieDensity).toBe(2);
    // effective pool hint is bounded, not 6e10
    expect(effectiveZombieMax(c)).toBe(ZOMBIE_MAX * 2);
  });

  it("hostile dayLengthMin:0 clamps into [4,120] (NaN-clock guard)", () => {
    expect(clampConfig({ time: { dayLengthMin: 0 } }).time.dayLengthMin).toBe(4);
  });

  it("negative / NaN absolutes never escape their band", () => {
    const c = clampConfig({
      session: { maxPlayers: -10, respawnDelayS: 9999, logoutLingerS: Number.NaN },
      building: { pieceCapPerPlayer: 100000 },
    });
    expect(c.session.maxPlayers).toBe(2); // min
    expect(c.session.respawnDelayS).toBe(30); // max
    expect(c.session.logoutLingerS).toBe(DEFAULT_CONFIG.session.logoutLingerS); // NaN → base
    expect(c.building.pieceCapPerPlayer).toBe(500); // max
  });

  it("garbage top-level input → DEFAULT_CONFIG (never throws)", () => {
    for (const garbage of [42, "string", true, ["array"], null]) {
      expect(clampConfig(garbage)).toEqual(DEFAULT_CONFIG);
    }
  });

  it("never stores out-of-enum wipeSchedule", () => {
    const c = clampConfig({ session: { wipeSchedule: "hourly" } });
    expect(c.session.wipeSchedule).toBe(DEFAULT_CONFIG.session.wipeSchedule);
  });

  it("the resolved-config from the server is what the client would store (round-trip)", () => {
    // The server resolves, the client clamps welcome.config. For a clean preset
    // the two MUST agree (no drift).
    for (const name of Object.keys(PRESETS)) {
      const resolved = resolveServerConfig(name).config;
      expect(clampConfig(resolved)).toEqual(resolved);
    }
  });
});

// =============================================================================
// worldParamsOf — seed-only in M1
// =============================================================================

describe("worldParamsOf", () => {
  it("returns { seed } ONLY in M1", () => {
    const p = worldParamsOf(DEFAULT_CONFIG.world);
    expect(p).toEqual({ seed: WORLD_SEED });
    expect(Object.keys(p)).toEqual(["seed"]);
  });
});

// =============================================================================
// world fingerprint string — round-trip (config WIPE identity, NOT worldgen hash)
// =============================================================================

describe("worldFingerprintOf / parseWorldFingerprint", () => {
  it("default world stringifies to the canonical v1 form", () => {
    expect(worldFingerprintOf(DEFAULT_CONFIG.world)).toBe(
      `v1|seed:${WORLD_SEED}|size:standard|water:0`,
    );
  });

  it("round-trips every tier/seed/water combination", () => {
    const worlds = [
      { seed: 1337, sizeTier: "standard" as const, waterFeatures: false },
      { seed: 0, sizeTier: "large" as const, waterFeatures: true },
      { seed: -42, sizeTier: "huge" as const, waterFeatures: false },
      { seed: 65535, sizeTier: "standard" as const, waterFeatures: true },
    ];
    for (const w of worlds) {
      const fp = worldFingerprintOf(w);
      expect(parseWorldFingerprint(fp)).toEqual(w);
    }
  });

  it("rejects malformed strings with null (never throws)", () => {
    for (const bad of [
      "",
      "v2|seed:1|size:standard|water:0",
      "v1|seed:x|size:standard|water:0",
      "v1|seed:1|size:gigantic|water:0",
      "v1|seed:1|size:standard|water:2",
      "v1|seed:1|size:standard",
      "garbage",
    ]) {
      expect(parseWorldFingerprint(bad)).toBeNull();
    }
  });
});

// =============================================================================
// wipe epoch math
// =============================================================================

describe("wipeEpochOf", () => {
  const anchor = ANCHOR_MS;
  const day = 24 * 60 * 60 * 1000;

  it("never pins epoch 0 regardless of now", () => {
    expect(wipeEpochOf("never", anchor)).toBe(0);
    expect(wipeEpochOf("never", anchor + 999 * day)).toBe(0);
  });

  it("weekly increments exactly at each 7-day boundary", () => {
    expect(wipeEpochOf("weekly", anchor)).toBe(0);
    expect(wipeEpochOf("weekly", anchor + 7 * day - 1)).toBe(0);
    expect(wipeEpochOf("weekly", anchor + 7 * day)).toBe(1);
    expect(wipeEpochOf("weekly", anchor + 14 * day)).toBe(2);
  });

  it("biweekly / monthly use 14 / 30 day periods", () => {
    expect(wipeEpochOf("biweekly", anchor + 14 * day)).toBe(1);
    expect(wipeEpochOf("biweekly", anchor + 28 * day - 1)).toBe(1);
    expect(wipeEpochOf("monthly", anchor + 30 * day)).toBe(1);
    expect(wipeEpochOf("monthly", anchor + 60 * day)).toBe(2);
  });

  it("the anchor is a Monday (2026-01-05 UTC)", () => {
    expect(new Date(ANCHOR_MS).getUTCDay()).toBe(1);
    expect(ANCHOR_MS).toBe(Date.UTC(2026, 0, 5));
  });
});

// =============================================================================
// summarizeRules — banding (doc 04 §6)
// =============================================================================

describe("summarizeRules", () => {
  it("default config bands to normal/cycle/etc", () => {
    const s = summarizeRules(DEFAULT_CONFIG);
    expect(s.preset).toBe("deadcoast");
    expect(s.zombies).toBe("normal");
    expect(s.pvp).toBe(true);
    expect(s.fullLoot).toBe(true);
    expect(s.loot).toBe("normal");
    expect(s.vitals).toBe("normal");
    expect(s.night).toBe("cycle");
    expect(s.dayLengthMin).toBe(DAY_DURATION_S / 60);
    expect(s.worldSize).toBe("standard");
    expect(s.maxPlayers).toBe(MAX_PLAYERS);
    expect(s.wipe).toBe("never");
  });

  it("zombies band by density: off / sparse / normal / horde", () => {
    const off: ServerConfig = { ...DEFAULT_CONFIG, threats: { ...DEFAULT_CONFIG.threats, zombies: false } };
    expect(summarizeRules(off).zombies).toBe("off");
    expect(summarizeRules(resolveServerConfig("warpath").config).zombies).toBe("sparse"); // 0.5
    expect(summarizeRules(resolveServerConfig("ironcoast").config).zombies).toBe("horde"); // 1.5
    expect(summarizeRules(resolveServerConfig("nightfall").config).zombies).toBe("normal"); // 1.25 ≤ 1.25
  });

  it("a preset with overrides reports preset=custom", () => {
    const cfg = resolveServerConfig({ preset: "warpath", overrides: { loot: { density: 1 } } }).config;
    expect(summarizeRules(cfg).preset).toBe("custom");
  });

  it("nightfall (fixedHour 1) reports night=always", () => {
    expect(summarizeRules(resolveServerConfig("nightfall").config).night).toBe("always");
  });
});
