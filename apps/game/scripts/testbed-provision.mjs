// Testbed provisioning unit test (doc 10 M1).
//   node --experimental-strip-types apps/game/scripts/testbed-provision.mjs
//
// Two things matter here:
//   (a) the PROD-SAFETY gate — isTestbedEnabled is true ONLY for the exact
//       string "1", so a var-less prod deploy can never provision; and
//   (b) provisionTestbed seeds a fresh player correctly — a deterministic
//       coast station facing seaward, a lit fire at the feet, the universal
//       loadout (skipping ids absent on this build), and the vitals baseline.
//
// Builds a minimal fake GameState/player inline (no config.ts import — its
// extensionless relative imports break node --strip-types), like loot-invariant.mjs.
import {
  isTestbedEnabled,
  provisionTestbed,
  TESTBED_LOADOUT,
  TESTBED_VITALS,
} from "../src/server/systems/testbed.ts";
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

// --- (b) provisionTestbed against a minimal fake state + a fresh-spawn player ---
const STATION = { x: 123.5, z: -42 };
const GROUND_Y = 1.5;
const state = {
  world: { spawnPoints: [STATION, { x: 7, z: 7 }], groundHeight: () => GROUND_Y },
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
provisionTestbed(state, player);

// Position: deterministic spawnPoints[0], on the ground, transient state reset.
check(player.core.x === STATION.x && player.core.z === STATION.z, "teleported to spawnPoints[0]");
check(player.core.y === GROUND_Y, "y set to groundHeight");
check(
  player.core.vy === 0 && player.core.grounded === true && player.core.pitch === 0,
  "core reset (vy/grounded/pitch)",
);

// Facing: forward = (-sin yaw, -cos yaw) must point seaward (away from origin).
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

// Loadout: every id present on THIS build is granted at its EXACT quantity;
// absent ids are skipped (no-op). Sum counts across slots so the check holds
// even if a quantity ever spans multiple stacks.
const present = new Set(player.inventory.filter(Boolean).map((s) => s.type));
const qtyByType = new Map();
for (const stack of player.inventory) {
  if (stack) qtyByType.set(stack.type, (qtyByType.get(stack.type) ?? 0) + stack.count);
}
for (const { id, count } of TESTBED_LOADOUT) {
  if (id in ITEM_DEFS) {
    check(present.has(id), `loadout has "${id}"`);
    check((qtyByType.get(id) ?? 0) === count, `loadout "${id}" quantity is ${count} (got ${qtyByType.get(id) ?? 0})`);
  } else {
    check(!present.has(id), `absent id "${id}" correctly skipped (no-op)`);
  }
}
// Sanity: at least the known survival staples are granted on main.
check(present.has("beans") && present.has("raw_venison"), "core items (beans, raw_venison) granted");
// selectedSlot is reset to 0 by the provisioning contract (player started at 5).
check(player.selectedSlot === 0, "selectedSlot reset to 0");

// Vitals: known baseline; attack cooldown cleared.
check(player.vitals.hp === TESTBED_VITALS.hp, `hp baseline ${TESTBED_VITALS.hp}`);
check(player.vitals.food === TESTBED_VITALS.food, `food baseline ${TESTBED_VITALS.food}`);
check(player.vitals.water === TESTBED_VITALS.water, `water baseline ${TESTBED_VITALS.water}`);
check(player.vitals.temp === TESTBED_VITALS.temp, `temp baseline ${TESTBED_VITALS.temp}`);
check(player.attackCooldown === 0, "attack cooldown cleared");

if (failures > 0) {
  console.error(`TESTBED-PROVISION: FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("TESTBED-PROVISION: PASS — gate is string-strict and provisionTestbed seeds a ready player");
