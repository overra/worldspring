#!/usr/bin/env node
// Reload + magazine harness (doc 11 M3) — CI-run via `pnpm test`.
//
//   node --experimental-strip-types apps/game/scripts/reload-magazine.mjs
//
// Two layers:
//   1. PURE ACCOUNTING — imports systems/magazine.ts directly (its relative
//      imports are type-only, the loot-invariant.mjs precedent): absent-mag ⇒
//      full, fire-side decrement, reload-completion min()/back-to-front drain.
//   2. CHANNEL INTEGRATION — bundles the REAL players.ts + combat.ts with
//      esbuild (the trees-probe.mjs data-URL pattern; strip-types can't follow
//      their extensionless value imports) and drives performAttack /
//      startUse / tickActiveActions / equipSlot over a minimal fake GameState:
//      fire drains the mag not the inventory; an empty mag fires nothing and
//      auto-starts the reload channel; the reload cast SURVIVES movement but
//      cancels on damage/slot-swap with nothing consumed; completion moves
//      min(need, reserve) rounds; firing mid-reload is a dead trigger.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ITEM_DEFS } from "@worldspring/shared/items";
import {
  canStartReload,
  completeReload,
  roundsInMag,
  tryConsumeRound,
} from "../src/server/systems/magazine.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const PISTOL = ITEM_DEFS.pistol.ranged;
const MAG = PISTOL.magSize; // 12 (placeholder pending tuning)

// --- 1. pure accounting ------------------------------------------------------
console.log("magazine.ts accounting:");
{
  const gun = { type: "pistol", count: 1 };
  check(roundsInMag(gun, PISTOL) === MAG, `absent mag reads FULL (${MAG})`);
  check(roundsInMag({ ...gun, mag: 999 }, PISTOL) === MAG, "oversized persisted mag clamps to magSize");
  check(roundsInMag({ ...gun, mag: -3 }, PISTOL) === 0, "negative persisted mag clamps to 0");

  check(tryConsumeRound(gun, PISTOL) === true && gun.mag === MAG - 1, "fire decrements the mag");
  gun.mag = 0;
  check(tryConsumeRound(gun, PISTOL) === false && gun.mag === 0, "empty mag: no round consumed, fire refused");

  // Reload accounting: min(need, reserve), draining ammo BACK-TO-FRONT.
  const inv = [
    { type: "pistol", count: 1, mag: 0 },
    { type: "ammo_9mm", count: 5 },
    null,
    { type: "ammo_9mm", count: 4 },
  ];
  check(canStartReload(inv, 0) === PISTOL, "canStartReload: empty mag + reserve ⇒ ok");
  check(canStartReload(inv, 1) === null, "canStartReload: not a gun ⇒ null");
  check(completeReload(inv, 0) === true, "completeReload reports a change");
  check(inv[0].mag === 9, `partial reload loads all 9 reserve rounds (got ${inv[0].mag})`);
  check(inv[3] === null && inv[1] === null, "reserve stacks drained back-to-front and cleared");
  check(canStartReload(inv, 0) === null, "canStartReload: no reserve left ⇒ null");

  const inv2 = [{ type: "pistol", count: 1, mag: 4 }, { type: "ammo_9mm", count: 30 }];
  completeReload(inv2, 0);
  check(inv2[0].mag === MAG && inv2[1].count === 30 - (MAG - 4), "reload tops to magSize, takes only the need");
  check(completeReload(inv2, 0) === false, "full mag: completeReload is a no-op");
}

// --- 2. channel integration over the real players.ts + combat.ts -------------
// Bundle (extensionless value imports break strip-types; esbuild resolves the
// workspace @worldspring/shared exports too).
const systemsDir = fileURLToPath(new URL("../src/server/systems", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { startUse, startReload, tickActiveActions, equipSlot, dropSlot, pickupLoot } from "./players.ts";\n' +
      'export { performAttack } from "./combat.ts";\n',
    resolveDir: systemsDir,
    loader: "ts",
    sourcefile: "reload-harness-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const sys = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

const DT = 1 / 15;

function makeState() {
  return {
    // structures.raycastPiece: doc 06 M7 — fireRanged probes for per-pellet
    // piece attribution; an empty index never attributes.
    world: {
      raycastStatics: () => null,
      groundHeight: () => 0,
      heightAt: () => 0,
      structures: { raycastPiece: () => null },
    },
    config: { pvp: { enabled: false, fullLoot: true }, map: { reveal: "full" } },
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
    loot: new Map(),
    corpses: new Map(),
    fires: [],
    portals: [],
    drops: new Map(),
    animals: new Map(),
    events: [],
    outbox: [],
    nextEntityId: 1,
    posHistory: [],
  };
}

/** Minimal ServerPlayer carrying only the fields the exercised paths touch. */
function makePlayer(state, inventory) {
  const player = {
    id: "p1",
    name: "magbot",
    core: { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: true },
    vitals: { hp: 100, food: 100, water: 100, temp: 20 },
    inventory,
    selectedSlot: 0,
    alive: true,
    stats: { bornAt: 0, kills: 0, zombieKills: 0, distanceM: 0 },
    attackCooldown: 0,
    attackAnimT: 0,
    fishCooldownT: 0,
    movedThisTick: false,
    tookDamageThisTick: false,
    action: null,
    realm: "overworld",
  };
  state.players.set(player.id, player);
  return player;
}

const shots = (state) => state.events.filter((q) => q.ev.e === "shot").length;
const reserve = (inv) => inv.reduce((n, s) => n + (s && s.type === "ammo_9mm" ? s.count : 0), 0);
/** Run N channel ticks, optionally flagging movement each tick. */
const runTicks = (state, player, n, { moving = false } = {}) => {
  for (let i = 0; i < n; i++) {
    player.movedThisTick = moving;
    sys.tickActiveActions(state, DT);
  }
};

console.log("\nfire side (real fireRanged):");
{
  const state = makeState();
  const player = makePlayer(state, [{ type: "pistol", count: 1 }, { type: "ammo_9mm", count: 30 }, null, null]);

  sys.performAttack(state, player, undefined);
  check(shots(state) === 1, "trigger pull fires one pellet");
  check(player.inventory[0].mag === MAG - 1, "…consuming from the MAG");
  check(reserve(player.inventory) === 30, "…and NOT from inventory ammo");
  check(player.attackCooldown > 0, "…and starting the fire cooldown");

  // Drain the rest of the mag (reset the cooldown between pulls).
  for (let i = 0; i < MAG - 1; i++) {
    player.attackCooldown = 0;
    sys.performAttack(state, player, undefined);
  }
  check(player.inventory[0].mag === 0 && shots(state) === MAG, `mag drains to 0 over ${MAG} pulls`);

  // Empty click → NO shot, auto-reload channel opens instead (reserve exists).
  player.attackCooldown = 0;
  sys.performAttack(state, player, undefined);
  check(shots(state) === MAG, "empty mag: trigger pull fires NOTHING");
  check(player.action !== null && player.action.kind === "reload", "…and auto-starts the reload channel");
  check(player.inventory[0].mag === 0 && reserve(player.inventory) === 30, "…with nothing consumed at start (doc 11 §1)");

  // Trigger is dead mid-reload.
  const before = shots(state);
  player.attackCooldown = 0;
  sys.performAttack(state, player, undefined);
  check(shots(state) === before && player.action?.kind === "reload", "firing mid-reload is ignored (cast keeps running)");

  // Reload SURVIVES movement (doc 11 Open Q4 — combat's call) and completes.
  const ticksNeeded = Math.ceil(PISTOL.reloadS / DT) + 1;
  runTicks(state, player, ticksNeeded, { moving: true });
  check(player.action === null, "reload completed while MOVING every tick");
  check(player.inventory[0].mag === MAG, `completion fills the mag (${MAG})`);
  check(reserve(player.inventory) === 30 - MAG, `…moving exactly ${MAG} rounds out of reserve`);
}

console.log("\nreload channel interrupts (real tickActiveActions):");
{
  // Damage cancels, nothing consumed.
  const state = makeState();
  const player = makePlayer(state, [{ type: "pistol", count: 1, mag: 0 }, { type: "ammo_9mm", count: 8 }, null, null]);
  sys.startReload(state, player);
  check(player.action?.kind === "reload", "manual startReload opens the cast");
  runTicks(state, player, 3);
  player.tookDamageThisTick = true;
  runTicks(state, player, 1);
  check(player.action === null, "taking damage cancels the reload");
  check(player.inventory[0].mag === 0 && reserve(player.inventory) === 8, "…with nothing consumed");

  // Slot swap cancels at the equip site.
  sys.startReload(state, player);
  sys.equipSlot(state, player, 1);
  check(player.action === null, "equipping another slot cancels the reload");
  check(player.inventory[0].mag === 0 && reserve(player.inventory) === 8, "…with nothing consumed");
  sys.equipSlot(state, player, 0);

  // Full-mag / no-reserve preconditions refuse to start.
  player.inventory[0].mag = MAG;
  sys.startReload(state, player);
  check(player.action === null, "full mag: reload refuses to start");
  player.inventory[0].mag = 0;
  player.inventory[1] = null;
  sys.startReload(state, player);
  check(player.action === null, "no reserve ammo: reload refuses to start");
  player.attackCooldown = 0;
  sys.performAttack(state, player, undefined);
  check(shots(state) === 0 && player.action === null, "empty mag + no reserve: pull is a silent no-op");
}

console.log("\nR-key wire path ({t:\"use\"} on the equipped gun via startUse):");
{
  const state = makeState();
  const player = makePlayer(state, [{ type: "pistol", count: 1, mag: 3 }, { type: "ammo_9mm", count: 4 }, null, null]);
  sys.startUse(state, player, 0);
  check(player.action?.kind === "reload" && player.action.slot === 0, "use-on-equipped-ranged starts the reload channel");
  check(Math.abs(player.action.totalS - PISTOL.reloadS) < 1e-9, `cast duration is the weapon's reloadS (${PISTOL.reloadS}s)`);
  runTicks(state, player, Math.ceil(PISTOL.reloadS / DT) + 1);
  check(player.inventory[0].mag === 7 && reserve(player.inventory) === 0, "partial reload: 3+4 ⇒ 7 in the mag, reserve emptied");
}

console.log("\nmag travels through drop → pickup:");
{
  const state = makeState();
  const player = makePlayer(state, [{ type: "pistol", count: 1, mag: 3 }, null, null, null]);
  sys.dropSlot(state, player, 0);
  const dropped = [...state.loot.values()][0];
  check(dropped?.mag === 3, "dropped gun's loot entity carries mag=3");
  sys.pickupLoot(state, player, dropped.id);
  const got = player.inventory.find((s) => s && s.type === "pistol");
  check(got?.mag === 3, "picked-up gun still holds 3 rounds (no free refill)");
}

console.log("");
if (failures > 0) {
  console.error(`RELOAD-MAGAZINE: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("RELOAD-MAGAZINE: PASS — magazine accounting + reload channel hold");
