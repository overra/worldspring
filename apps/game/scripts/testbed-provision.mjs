// Testbed provisioning unit test (doc 10 M1 + M3).
//   node --experimental-strip-types apps/game/scripts/testbed-provision.mjs
//
// Two things matter:
//   (a) the PROD-SAFETY gate — isTestbedEnabled is true ONLY for the exact
//       string "1", so a var-less prod deploy can never provision; and
//   (b) provisionTestbed(state, player, scenario) walks the scenario's
//       provision[] and seeds the player — position/fire/loadout (skipping ids
//       absent on this build)/vitals/cooldowns, plus a selectedSlot reset.
//
// Builds a minimal fake GameState/player and an INLINE Scenario literal (no
// scenario.ts import — keeps this strip-types harness clear of any value-import
// chain), mirroring loot-invariant.mjs.
import { isTestbedEnabled, provisionTestbed } from "../src/server/systems/testbed.ts";
import { FIRE_WARMTH_RADIUS } from "@worldspring/shared/constants";
import { ITEM_DEFS } from "@worldspring/shared/items";

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  }
}

// --- (a) Gate: only the exact string "1" enables the testbed ---
check(isTestbedEnabled({ TESTBED: "1" }) === true, 'TESTBED="1" enables');
check(isTestbedEnabled({}) === false, "env={} disabled (the prod default)");
check(isTestbedEnabled(undefined) === false, "env=undefined disabled");
check(isTestbedEnabled({ TESTBED: "0" }) === false, 'TESTBED="0" disabled');
check(isTestbedEnabled({ TESTBED: 1 }) === false, "TESTBED=number 1 disabled (string-strict)");
check(isTestbedEnabled({ TESTBED: "true" }) === false, 'TESTBED="true" disabled');

// --- (b) provisionTestbed against a minimal fake state + an inline Scenario ---
const STATION = { x: 123.5, z: -42 };
const GROUND_Y = 1.5;
const LOADOUT = [
  { type: "beans", count: 3 },
  { type: "raw_venison", count: 3 },
  { type: "canteen_empty", count: 1 }, // absent on main → must be skipped (no-op rule)
];
const VITALS = { hp: 50, food: 50, water: 20, temp: 37 };
const scenario = {
  name: "test",
  provision: [
    { kind: "position", zone: "coastal", face: "ocean" },
    { kind: "fire", atFeet: true },
    { kind: "loadout", items: LOADOUT },
    { kind: "vitals", ...VITALS },
    { kind: "clearCooldowns", which: ["attack"] },
  ],
  checklist: [],
};
const state = {
  world: {
    spawnPoints: [STATION, { x: 7, z: 7 }],
    groundHeight: () => GROUND_Y,
    military: { cx: 0, cz: 0, radius: 30 },
  },
  fires: [],
  nextEntityId: 1,
};
const player = {
  core: { x: 999, y: 999, z: 999, vy: 9, yaw: 9, pitch: 9, grounded: false },
  vitals: { hp: 100, food: 100, water: 100, temp: 37 },
  inventory: Array.from({ length: 8 }, () => null),
  selectedSlot: 5,
  attackCooldown: 9,
};
provisionTestbed(state, player, scenario);

// Position: coastal → spawnPoints[0], on the ground, transient state reset.
check(player.core.x === STATION.x && player.core.z === STATION.z, "teleported to spawnPoints[0] (coastal)");
check(player.core.y === GROUND_Y, "y set to groundHeight");
check(
  player.core.vy === 0 && player.core.grounded === true && player.core.pitch === 0,
  "core reset (vy/grounded/pitch)",
);

// Facing ocean: forward = (-sin yaw, -cos yaw) must point seaward (away from origin).
const fx = -Math.sin(player.core.yaw);
const fz = -Math.cos(player.core.yaw);
const len = Math.hypot(STATION.x, STATION.z);
const dot = fx * (STATION.x / len) + fz * (STATION.z / len);
check(dot > 0.999, `faces seaward (forward·outward = ${dot.toFixed(4)})`);

// Fire: exactly one, at the feet, within warmth radius (nearFire true), lit.
check(state.fires.length === 1, "one campfire pushed");
const fire = state.fires[0];
const fireDist = Math.hypot(fire.x - player.core.x, fire.z - player.core.z);
check(fireDist < FIRE_WARMTH_RADIUS, `fire within warmth radius (dist = ${fireDist.toFixed(2)})`);
check(fire.burnRemaining > 0, "fire is lit (burnRemaining > 0)");

// Loadout: ids present on THIS build granted at exact quantity; absent ids skipped.
const qty = new Map();
for (const s of player.inventory) if (s) qty.set(s.type, (qty.get(s.type) ?? 0) + s.count);
for (const { type, count } of LOADOUT) {
  if (type in ITEM_DEFS) check(qty.get(type) === count, `loadout "${type}" quantity is ${count} (got ${qty.get(type) ?? 0})`);
  else check(!qty.has(type), `absent id "${type}" correctly skipped (no-op)`);
}
check(qty.has("beans") && qty.has("raw_venison"), "core items (beans, raw_venison) granted");

// Vitals + selection + cooldown, all from the scenario.
check(
  player.vitals.hp === VITALS.hp &&
    player.vitals.food === VITALS.food &&
    player.vitals.water === VITALS.water &&
    player.vitals.temp === VITALS.temp,
  "vitals set from scenario",
);
check(player.selectedSlot === 0, "selectedSlot reset to 0");
check(player.attackCooldown === 0, "attack cooldown cleared");

if (failures > 0) {
  console.error(`TESTBED-PROVISION: FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("TESTBED-PROVISION: PASS — gate is string-strict and provisionTestbed walks a scenario");
