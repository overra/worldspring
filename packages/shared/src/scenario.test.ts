// packages/shared/src/scenario.test.ts — doc 10 M2. Mirrors config.test.ts
// conventions: pure shared code, plain node env, the parser is the trust guard
// every later consumer (M3 provisioning, M4 panel, M5 skill, M6 harness) relies
// on, so it must be TOTAL and NEVER THROW on hostile input.
//
// The named-set files live in apps/game/scenarios/*.json (the form M4/M5
// author). The shared package must NOT depend on apps/game and has no Node type
// surface (no @types/node), so this test does not fs-read them — it embeds the
// canonical content of each shipped file as a fixture (kept byte-identical to
// the JSON on disk) and runs it through parseScenario. The actual on-disk files
// are validated separately during CI/verification by parsing them with the same
// exported parseScenario; this suite proves the SHAPE the files must satisfy.

import { describe, expect, it } from "vitest";

import {
  type Assert,
  BUILTIN_SCENARIO,
  parseScenario,
  type Provision,
  type Scenario,
} from "./scenario";

// Canonical content of apps/game/scenarios/survival.json (the M1-baseline set).
const SURVIVAL_JSON: unknown = {
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
    { kind: "vitals", hp: 50, food: 50, water: 20, temp: 37 },
    { kind: "clearCooldowns", which: ["attack", "item"] },
  ],
  checklist: ["spawn on beach"],
};

// Canonical content of apps/game/scenarios/combat.json (the weapons set).
const COMBAT_JSON: unknown = {
  name: "combat",
  provision: [
    { kind: "position", zone: "military", face: "inland" },
    {
      kind: "loadout",
      items: [
        { type: "pistol", count: 1 },
        { type: "ammo_9mm", count: 30 },
        { type: "rifle", count: 1 },
        { type: "ammo_762", count: 20 },
        { type: "shotgun", count: 1 },
        { type: "shells", count: 12 },
        { type: "bandage", count: 4 },
      ],
    },
    { kind: "vitals", hp: 100, food: 100, water: 100, temp: 37 },
    { kind: "clearCooldowns", which: ["attack"] },
  ],
  checklist: ["spawn at compound"],
};

function loadout(s: Scenario): Provision & { kind: "loadout" } {
  const p = s.provision.find((x): x is Provision & { kind: "loadout" } => x.kind === "loadout");
  if (!p) throw new Error(`scenario "${s.name}" has no loadout`);
  return p;
}
function vitals(s: Scenario): Provision & { kind: "vitals" } {
  const p = s.provision.find((x): x is Provision & { kind: "vitals" } => x.kind === "vitals");
  if (!p) throw new Error(`scenario "${s.name}" has no vitals`);
  return p;
}

// =============================================================================
// Round-trip: a valid scenario survives parse unchanged
// =============================================================================

describe("parseScenario round-trips valid input", () => {
  it("the builtin default parses to an equal scenario", () => {
    expect(parseScenario(BUILTIN_SCENARIO)).toEqual(BUILTIN_SCENARIO);
  });

  it("parsing is idempotent (parse(parse(x)) === parse(x))", () => {
    const once = parseScenario(BUILTIN_SCENARIO);
    expect(parseScenario(once)).toEqual(once);
  });

  it("a hand-authored valid scenario keeps every field", () => {
    const input: Scenario = {
      name: "demo",
      provision: [
        { kind: "position", zone: "inland", face: "inland" },
        { kind: "loadout", items: [{ type: "pistol", count: 1 }, { type: "ammo_9mm", count: 30 }] },
        { kind: "vitals", hp: 80, water: 40 },
        { kind: "clearCooldowns", which: ["attack", "fish"] },
      ],
      checklist: ["shoot something"],
    };
    expect(parseScenario(input)).toEqual(input);
  });

  it("accepts a raw JSON string (registry may hand a blob straight in)", () => {
    const json = JSON.stringify(BUILTIN_SCENARIO);
    expect(parseScenario(json)).toEqual(BUILTIN_SCENARIO);
  });
});

// =============================================================================
// Forward-compat: unknown item ids are KEPT (the no-op-unknowns rule)
// =============================================================================

describe("parseScenario keeps unknown item ids (forward-compat no-op rule)", () => {
  it("does not reject canteen_*/fishing_rod absent from ITEM_DEFS on main", () => {
    const s = parseScenario({
      name: "fwd",
      provision: [
        {
          kind: "loadout",
          items: [
            { type: "beans", count: 1 },
            { type: "canteen_empty", count: 1 },
            { type: "fishing_rod", count: 1 },
            { type: "totally_made_up_future_item", count: 2 },
          ],
        },
      ],
      checklist: [],
    });
    const items = loadout(s).items.map((i) => i.type);
    expect(items).toContain("canteen_empty");
    expect(items).toContain("fishing_rod");
    expect(items).toContain("totally_made_up_future_item");
  });

  it("the BUILTIN scenario itself carries doc-05 ids unknown on main", () => {
    const ids = loadout(BUILTIN_SCENARIO).items.map((i) => i.type);
    expect(ids).toContain("canteen_empty");
    expect(ids).toContain("fishing_rod");
  });
});

// =============================================================================
// Clamp / survive malformed input WITHOUT throwing (mirrors clampConfig)
// =============================================================================

describe("parseScenario clamps and survives malformed input", () => {
  it("non-object input → BUILTIN_SCENARIO, never throws", () => {
    for (const garbage of [42, true, ["a", "b"], null, undefined, "{not json", () => 0]) {
      expect(() => parseScenario(garbage as unknown)).not.toThrow();
      // for non-object/garbage we fall back to the builtin default
      if (garbage !== undefined) {
        const s = parseScenario(garbage as unknown);
        expect(s.name).toBe(BUILTIN_SCENARIO.name);
      }
    }
  });

  it("out-of-range vitals clamp into band, never reject", () => {
    const s = parseScenario({
      name: "x",
      provision: [{ kind: "vitals", hp: 1e9, food: -50, water: Number.NaN, temp: 9999 }],
      checklist: [],
    });
    const v = vitals(s);
    expect(v.hp).toBe(100); // clamped to MAX
    expect(v.food).toBe(0); // clamped to MIN
    expect(v.water).toBeUndefined(); // NaN → absent (not set)
    expect(v.temp).toBe(60); // clamped to TEMP_MAX
  });

  it("vitals ASSERTION values clamp per-field — low hp/water survive, temp keeps its band", () => {
    const s = parseScenario({
      name: "x",
      provision: [],
      checklist: [],
      assert: [
        { on: "vitals", field: "hp", cmp: "lte", value: 8 },
        { on: "vitals", field: "water", cmp: "lte", value: 0 },
        { on: "vitals", field: "temp", cmp: "gte", value: 5 },
        { on: "vitals", field: "temp", cmp: "lte", value: 9999 },
      ],
    });
    const va = (s.assert ?? []).filter(
      (a): a is Extract<Assert, { on: "vitals" }> => a.on === "vitals",
    );
    const find = (field: string, cmp: string) =>
      va.find((a) => a.field === field && a.cmp === cmp)?.value;
    expect(find("hp", "lte")).toBe(8); // below TEMP_MIN(20) must NOT clamp up
    expect(find("water", "lte")).toBe(0); // 0 survives (was forced to 20)
    expect(find("temp", "gte")).toBe(20); // temp clamps to TEMP_MIN
    expect(find("temp", "lte")).toBe(60); // temp clamps to TEMP_MAX
  });

  it("an unknown provision kind is DROPPED, the rest are kept", () => {
    const s = parseScenario({
      name: "x",
      provision: [
        { kind: "fire", atFeet: true },
        { kind: "teleport_to_moon", x: 1 },
        { kind: "loadout", items: [{ type: "beans", count: 2 }] },
      ],
      checklist: [],
    });
    const kinds = s.provision.map((p) => p.kind);
    expect(kinds).toEqual(["fire", "loadout"]);
  });

  it("a malformed loadout item is dropped, valid siblings survive", () => {
    const s = parseScenario({
      name: "x",
      provision: [
        {
          kind: "loadout",
          items: [
            { type: "beans", count: 2 },
            { notAType: true },
            { type: "", count: 5 },
            { type: "bandage" },
          ],
        },
      ],
      checklist: [],
    });
    const items = loadout(s).items;
    expect(items).toEqual([
      { type: "beans", count: 2 },
      { type: "bandage", count: 1 }, // missing count floors to 1, line kept
    ]);
  });

  it("provision not an array → empty provision, scenario still usable", () => {
    const s = parseScenario({ name: "x", provision: "nope", checklist: [] });
    expect(s.provision).toEqual([]);
    expect(s.name).toBe("x");
  });

  it("count caps and bad counts floor to 1, never drop the kit line", () => {
    const s = parseScenario({
      name: "x",
      provision: [{ kind: "loadout", items: [{ type: "ammo_9mm", count: 1e6 }, { type: "beans", count: -3 }] }],
      checklist: [],
    });
    const items = loadout(s).items;
    expect(items[0].count).toBe(999); // COUNT_MAX
    expect(items[1].count).toBe(1); // negative → floor 1
  });

  it("enum fields fall back to a known value on garbage", () => {
    const s = parseScenario({
      name: "x",
      provision: [{ kind: "position", zone: "atlantis", face: "sideways" }],
      checklist: [],
    });
    const pos = s.provision[0];
    expect(pos.kind === "position" && pos.zone).toBe("coastal");
    expect(pos.kind === "position" && pos.face).toBe("ocean");
  });

  it("clearCooldowns filters unknown cooldown kinds", () => {
    const s = parseScenario({
      name: "x",
      provision: [{ kind: "clearCooldowns", which: ["attack", "nope", "item", 42] }],
      checklist: [],
    });
    const cc = s.provision[0];
    expect(cc.kind === "clearCooldowns" && cc.which).toEqual(["attack", "item"]);
  });

  it("never throws on a fuzz of hostile shapes", () => {
    const hostile: unknown[] = [
      {},
      { provision: [null, 1, "x", {}, { kind: 5 }] },
      { name: 123, provision: [{ kind: "vitals" }], checklist: [1, 2, "ok"] },
      { provision: [{ kind: "loadout" }] },
      { checklist: "not-an-array" },
      { steps: [{}, { action: "use", args: { slot: 0, junk: { nested: 1 } } }] },
      { assert: [{ on: "bogus" }, { on: "inv", type: "beans", atLeast: 2 }] },
    ];
    for (const h of hostile) {
      expect(() => parseScenario(h)).not.toThrow();
      const s = parseScenario(h);
      expect(typeof s.name).toBe("string");
      expect(Array.isArray(s.provision)).toBe(true);
      expect(Array.isArray(s.checklist)).toBe(true);
    }
  });
});

// =============================================================================
// Optional harness fields (M6) parse and are carried
// =============================================================================

describe("parseScenario carries optional steps/assert (M6 shape)", () => {
  it("keeps valid steps and asserts, drops malformed ones", () => {
    const s = parseScenario({
      name: "x",
      provision: [],
      checklist: [],
      steps: [
        { label: "fire pistol", action: "use", args: { slot: 0 } },
        { missingAction: true },
      ],
      assert: [
        { on: "inv", type: "ammo_9mm", atLeast: 29 },
        { on: "vitals", field: "hp", cmp: "gte", value: 50 },
        { on: "garbage" },
      ],
    });
    expect(s.steps?.length).toBe(1);
    expect(s.steps?.[0].action).toBe("use");
    expect(s.assert?.length).toBe(2);
  });

  it("omits steps/assert entirely when absent (clean default)", () => {
    const s = parseScenario({ name: "x", provision: [], checklist: [] });
    expect(s.steps).toBeUndefined();
    expect(s.assert).toBeUndefined();
  });
});

// =============================================================================
// Shipped named-set data files parse, and survival reproduces M1's baseline
// =============================================================================

describe("apps/game/scenarios/*.json shape is parse-valid", () => {
  it("survival set parses and equals the BUILTIN loadout/vitals (M1 baseline single-sourced)", () => {
    const survival = parseScenario(SURVIVAL_JSON);
    expect(survival.name).toBe("survival");

    // The acceptance check: the default scenario reproduces M1's hardcoded
    // TESTBED_LOADOUT / TESTBED_VITALS so a future edit can't silently diverge.
    expect(loadout(survival).items).toEqual(loadout(BUILTIN_SCENARIO).items);
    expect(vitals(survival)).toEqual(vitals(BUILTIN_SCENARIO));

    // M1's exact loadout, asserted literally (the source-of-truth values).
    expect(loadout(survival).items).toEqual([
      { type: "beans", count: 3 },
      { type: "water_bottle", count: 2 },
      { type: "bandage", count: 2 },
      { type: "raw_venison", count: 3 },
      { type: "canteen_empty", count: 1 },
      { type: "canteen_dirty", count: 1 },
      { type: "canteen_clean", count: 1 },
      { type: "fishing_rod", count: 1 },
    ]);
    expect(vitals(survival)).toEqual({ kind: "vitals", hp: 50, food: 50, water: 20, temp: 37 });

    // It carries a non-empty human checklist (M4 panel / M5 skill read it).
    expect(survival.checklist.length).toBeGreaterThan(0);
  });

  it("combat set parses to a distinct weapons set", () => {
    const combat = parseScenario(COMBAT_JSON);
    expect(combat.name).toBe("combat");
    const types = loadout(combat).items.map((i) => i.type);
    expect(types).toContain("pistol");
    expect(types).toContain("rifle");
    expect(types).toContain("shotgun");
  });

  it("the two named sets have distinct names (multiplicity)", () => {
    const a = parseScenario(SURVIVAL_JSON).name;
    const b = parseScenario(COMBAT_JSON).name;
    expect(a).not.toBe(b);
  });
});
