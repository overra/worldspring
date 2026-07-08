#!/usr/bin/env node
// Wear-slots harness (doc 05 M6) — CI-run via `pnpm test`.
//
//   node --experimental-strip-types apps/game/scripts/wear-slots.mjs
//
// Three layers:
//   1. WIRE — parseClientMsg shape checks for {t:"wear"}/{t:"unwear"} and the
//      PROTOCOL_VERSION 7→8 bump (shared package imports resolve under
//      strip-types, the reload-magazine.mjs precedent).
//   2. SYSTEMS — bundles the REAL players.ts + survival.ts + loot.ts with
//      esbuild (the reload-magazine.mjs data-URL pattern) and drives
//      wearItem / unwearItem / useItem / startUse / equipSlot / dropSlot /
//      tickSurvival / spawnPlayerCorpse / respawnPlayer over a minimal fake
//      GameState: swap semantics, the truncate-then-add unwear order (the doc
//      §5 landmine — add-then-truncate would destroy the backpack), every
//      capacity-consumer bound, jacket insulation on both temp-fall terms,
//      and the fullLoot vs keep-inventory corpse paths.
//   3. PERSISTENCE — saveCharacter (real persistence.ts, fake sql) →
//      state_json → restorePlayer round-trips worn + the 12-length inventory;
//      an old row WITHOUT `worn` restores as nothing-worn.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  INVENTORY_SLOTS,
  RAIN_TEMP_FALL_PER_S,
  TEMP_FALL_PER_S,
  WORLD_SIZE,
} from "@worldspring/shared/constants";
import { createExploredGrid } from "@worldspring/shared/fog";
import { ITEM_DEFS } from "@worldspring/shared/items";
import { parseClientMsg, PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { saveCharacter } from "../src/server/persistence.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const JACKET_INSULATION = ITEM_DEFS.padded_jacket.wear.insulation; // 0.65
const PACK_EXTRA = ITEM_DEFS.backpack.wear.extraSlots; // 4
const PACK_LEN = INVENTORY_SLOTS + PACK_EXTRA; // 12

// --- 1. wire ------------------------------------------------------------------
console.log("protocol (doc 05 M6 wire):");
{
  check(PROTOCOL_VERSION === 8, `PROTOCOL_VERSION bumped to 8 (got ${PROTOCOL_VERSION})`);
  const wear = parseClientMsg(JSON.stringify({ t: "wear", slot: 3.7 }));
  check(wear?.t === "wear" && wear.slot === 3, "wear parses, slot coerced |0");
  check(parseClientMsg(JSON.stringify({ t: "wear", slot: "x" })) === null, "wear with non-numeric slot is malformed");
  const uw = parseClientMsg(JSON.stringify({ t: "unwear", ws: "back" }));
  check(uw?.t === "unwear" && uw.ws === "back", "unwear body/back parses");
  check(parseClientMsg(JSON.stringify({ t: "unwear", ws: "head" })) === null, "unwear with unknown ws is malformed");
  check(parseClientMsg(JSON.stringify({ t: "unwear" })) === null, "unwear without ws is malformed");
}

// --- 2. systems (real players.ts / survival.ts / loot.ts) ----------------------
const systemsDir = fileURLToPath(new URL("../src/server/systems", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { wearItem, unwearItem, useItem, startUse, equipSlot, dropSlot, respawnPlayer, restorePlayer, addToInventory } from "./players.ts";\n' +
      'export { tickSurvival } from "./survival.ts";\n' +
      'export { spawnPlayerCorpse } from "./loot.ts";\n',
    resolveDir: systemsDir,
    loader: "ts",
    sourcefile: "wear-harness-entry.ts",
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

function makeState() {
  return {
    world: {
      raycastStatics: () => null,
      groundHeight: () => 0,
      heightAt: () => 0,
      buildings: [],
      spawnPoints: [{ x: 10, z: 10 }],
    },
    config: {
      pvp: { enabled: false, fullLoot: true },
      map: { reveal: "full" },
      survival: { hungerRate: 0, thirstRate: 0, temperatureSeverity: 1, regenRate: 0 },
      // fixedHour 23 = exposed night (outside AMBIENT_WARM 7-20).
      time: { dayLengthMin: 48, startHour: 9, fixedHour: 23 },
    },
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
    weather: 0,
    events: [],
    outbox: [],
    nextEntityId: 1,
    posHistory: [],
  };
}

function makePlayer(state, inventory, id = "p1") {
  const player = {
    id,
    name: "wearbot",
    tokenHash: "t-" + id,
    core: { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: true },
    vitals: { hp: 100, food: 100, water: 100, temp: 37 },
    inventory,
    worn: { body: null, back: null },
    selectedSlot: 0,
    alive: true,
    offline: false,
    offlineSince: 0,
    stats: { bornAt: 0, kills: 0, zombieKills: 0, distanceM: 0 },
    diedAt: -Infinity,
    lastRecap: null,
    cmdQueue: [],
    lastAck: 0,
    inputBudget: 5,
    wantsAttack: false,
    lastChatAt: -Infinity,
    attackCooldown: 0,
    attackAnimT: 0,
    sprinting: false,
    movedThisTick: false,
    sprintedThisTick: false,
    fishCooldownT: 0,
    explored: createExploredGrid(WORLD_SIZE),
    fogDelta: [],
    lastFogCell: -1,
    action: null,
    tookDamageThisTick: false,
    realm: "overworld",
    portalArmed: true,
  };
  state.players.set(player.id, player);
  return player;
}

const lastNotice = (state) => {
  const notes = state.outbox.filter((o) => o.msg.t === "notice");
  return notes.length > 0 ? notes[notes.length - 1].msg.msg : null;
};
const lastInv = (state) => {
  const invs = state.outbox.filter((o) => o.msg.t === "inv");
  return invs.length > 0 ? invs[invs.length - 1].msg : null;
};

console.log("\nwear / unwear (swap semantics + wire mirror):");
{
  const state = makeState();
  const player = makePlayer(state, [
    { type: "axe", count: 1 },
    null,
    { type: "padded_jacket", count: 1 },
    { type: "padded_jacket", count: 1 },
    null, null, null, null,
  ]);

  sys.wearItem(state, player, 2);
  check(player.worn.body?.type === "padded_jacket", "wear moves the jacket to worn.body");
  check(player.inventory[2] === null, "…and frees its inventory slot");
  check(lastInv(state)?.worn?.body?.type === "padded_jacket", "…and the inv message mirrors worn");

  sys.wearItem(state, player, 3);
  check(player.worn.body?.type === "padded_jacket" && player.inventory[3]?.type === "padded_jacket",
    "wearing a second jacket SWAPS: occupant returns to the same slot");

  sys.wearItem(state, player, 0);
  check(player.worn.body?.type === "padded_jacket" && player.inventory[0]?.type === "axe",
    "wear on a non-wear item is a no-op");

  sys.unwearItem(state, player, "body");
  check(player.worn.body === null, "unwear clears worn.body");
  check(player.inventory[1]?.type === "padded_jacket", "…returning it to the first empty slot");

  // Reject when nothing fits — never drop.
  sys.wearItem(state, player, 1);
  for (let i = 0; i < player.inventory.length; i++) {
    if (player.inventory[i] === null) player.inventory[i] = { type: "wood", count: 1 };
  }
  sys.unwearItem(state, player, "body");
  check(player.worn.body?.type === "padded_jacket", "unwear into a FULL inventory keeps it worn");
  check(lastNotice(state) === "no room in inventory", "…with the reject notice");
  check(state.loot.size === 0, "…and nothing dropped to the ground");

  // Mid-cast: wear/unwear are refused (mutation-point rule).
  player.inventory[1] = null;
  player.action = { kind: "use", slot: 0, arg: 0, totalS: 1, remainingS: 1 };
  sys.unwearItem(state, player, "body");
  check(player.worn.body !== null, "unwear mid-cast is refused");
  sys.wearItem(state, player, 4);
  check(player.worn.body?.type === "padded_jacket" && player.inventory[4]?.type === "wood",
    "wear mid-cast is refused");
  player.action = null;
}

console.log("\nuse-path parity ({t:\"use\"} on a wear item wears it):");
{
  const state = makeState();
  const player = makePlayer(state, [
    { type: "padded_jacket", count: 1 },
    null, null, null, null, null, null, null,
  ]);
  sys.startUse(state, player, 0);
  check(player.worn.body?.type === "padded_jacket" && player.inventory[0] === null,
    "startUse routes kind:\"wear\" through the instant path to wearItem");
}

console.log("\nbackpack capacity (every bound the spec enumerated):");
{
  const state = makeState();
  const player = makePlayer(state, [
    { type: "axe", count: 1 },
    { type: "backpack", count: 1 },
    { type: "beans", count: 1 },
    null, null, null, null, null,
  ]);

  sys.wearItem(state, player, 1);
  check(player.worn.back?.type === "backpack", "wear moves the backpack to worn.back");
  check(player.inventory.length === PACK_LEN, `…and the inventory grows to ${PACK_LEN}`);
  check(player.inventory.slice(INVENTORY_SLOTS).every((s) => s === null), "…with null pack slots");
  check(lastInv(state)?.slots.length === PACK_LEN, "…and the inv message ships all 12 slots");

  // Pack slots are usable storage: USE + DROP work, equip/hotbar does not.
  player.inventory[9] = { type: "beans", count: 2 };
  const foodBefore = player.vitals.food = 50;
  sys.useItem(state, player, 9);
  check(player.vitals.food > foodBefore && player.inventory[9]?.count === 1,
    "useItem works on a pack slot (beans eaten)");
  sys.equipSlot(state, player, 9);
  check(player.selectedSlot === 0, "equipSlot REJECTS pack slots (hotbar stays 0-7)");
  sys.dropSlot(state, player, 9);
  check(player.inventory[9] === null && state.loot.size === 1, "dropSlot works on a pack slot");

  // Occupied pack slots block unwear.
  player.inventory[11] = { type: "wood", count: 3 };
  sys.unwearItem(state, player, "back");
  check(player.worn.back !== null && lastNotice(state) === "empty your pack first",
    "unwear with occupied pack slots is rejected with the notice");

  // The doc §5 landmine: hotbar FULL + pack slots empty passes the precondition;
  // truncate-then-add must reject WITHOUT destroying the backpack.
  player.inventory[11] = null;
  for (let i = 0; i < INVENTORY_SLOTS; i++) {
    if (player.inventory[i] === null) player.inventory[i] = { type: "scrap", count: 1 };
  }
  sys.unwearItem(state, player, "back");
  check(player.worn.back?.type === "backpack", "hotbar-full unwear keeps the backpack WORN (not destroyed)");
  check(player.inventory.length === PACK_LEN, "…re-extending the array to worn capacity");
  check(lastNotice(state) === "no room in inventory", "…with the reject notice");

  // Free one hotbar slot: unwear succeeds, truncates, lands in the freed slot.
  player.inventory[5] = null;
  sys.unwearItem(state, player, "back");
  check(player.worn.back === null, "unwear succeeds once a hotbar slot is free");
  check(player.inventory.length === INVENTORY_SLOTS, "…truncating back to 8");
  check(player.inventory[5]?.type === "backpack", "…with the backpack in the freed HOTBAR slot (truncate-first order)");

  // Pack-for-pack swap while worn: length invariant.
  sys.wearItem(state, player, 5);
  player.inventory[5] = { type: "backpack", count: 1 };
  sys.wearItem(state, player, 5);
  check(player.worn.back?.type === "backpack" && player.inventory[5]?.type === "backpack",
    "backpack-for-backpack swap while worn");
  check(player.inventory.length === PACK_LEN, "…keeps the length invariant (both packs +4)");
}

console.log("\njacket insulation (real tickSurvival, both fall terms):");
{
  // Cold night, no rain: base fall = TEMP_FALL_PER_S.
  const state = makeState();
  const bare = makePlayer(state, [null, null, null, null, null, null, null, null], "bare");
  const cozy = makePlayer(state, [null, null, null, null, null, null, null, null], "cozy");
  cozy.worn.body = { type: "padded_jacket", count: 1 };
  const dt = 10;
  sys.tickSurvival(state, dt);
  const bareFall = 37 - bare.vitals.temp;
  const cozyFall = 37 - cozy.vitals.temp;
  check(Math.abs(bareFall - TEMP_FALL_PER_S * dt) < 1e-9, `bare night fall = TEMP_FALL_PER_S·dt (${bareFall.toFixed(3)})`);
  check(Math.abs(cozyFall - bareFall * (1 - JACKET_INSULATION)) < 1e-9,
    `jacket negates ${JACKET_INSULATION} of the night fall (${cozyFall.toFixed(4)} vs ${bareFall.toFixed(3)})`);

  // Rain-exposed at night: fall = (RAIN·weather + TEMP_FALL) — jacket scales BOTH.
  const state2 = makeState();
  state2.weather = 1;
  const bare2 = makePlayer(state2, [null, null, null, null, null, null, null, null], "bare2");
  const cozy2 = makePlayer(state2, [null, null, null, null, null, null, null, null], "cozy2");
  cozy2.worn.body = { type: "padded_jacket", count: 1 };
  sys.tickSurvival(state2, dt);
  const bareRain = 37 - bare2.vitals.temp;
  const cozyRain = 37 - cozy2.vitals.temp;
  check(Math.abs(bareRain - (RAIN_TEMP_FALL_PER_S + TEMP_FALL_PER_S) * dt) < 1e-9,
    `bare rain-night fall = (RAIN+NIGHT)·dt (${bareRain.toFixed(3)})`);
  check(Math.abs(cozyRain - bareRain * (1 - JACKET_INSULATION)) < 1e-9,
    "jacket negates the same fraction of the rain-exposed fall");

  // Warm-up is NOT boosted: near a fire both warm at the same rate.
  const state3 = makeState();
  state3.fires.push({ id: 1, x: 0, y: 0, z: 0, burnRemaining: 100 });
  const bare3 = makePlayer(state3, [null, null, null, null, null, null, null, null], "bare3");
  const cozy3 = makePlayer(state3, [null, null, null, null, null, null, null, null], "cozy3");
  bare3.vitals.temp = 33;
  cozy3.vitals.temp = 33;
  cozy3.worn.body = { type: "padded_jacket", count: 1 };
  sys.tickSurvival(state3, 1);
  check(bare3.vitals.temp === cozy3.vitals.temp && bare3.vitals.temp > 33,
    "warm-up rate is unchanged by the jacket");
}

console.log("\ndeath / respawn (fullLoot corpse vs keep-inventory):");
{
  const state = makeState(); // fullLoot: true
  const player = makePlayer(state, [
    { type: "axe", count: 1 },
    null, null, null, null, null, null, null,
    null, null, null, null, // pack slots (backpack worn below)
  ]);
  player.worn.body = { type: "padded_jacket", count: 1 };
  player.worn.back = { type: "backpack", count: 1 };
  sys.spawnPlayerCorpse(state, player);
  const corpse = [...state.corpses.values()][0];
  const types = corpse.contents.map((s) => s.type).sort();
  check(types.join(",") === "axe,backpack,padded_jacket", "fullLoot corpse holds inventory + BOTH worn items");
  check(player.worn.body === null && player.worn.back === null, "…and the player is stripped");
  check(player.inventory.length === INVENTORY_SLOTS && player.inventory.every((s) => s === null),
    "…with the inventory reset to 8 empty slots (after the strip — order matters)");

  // Keep-inventory: corpse empty, worn + pack slots kept.
  const state2 = makeState();
  state2.config.pvp.fullLoot = false;
  const keeper = makePlayer(state2, [
    { type: "axe", count: 1 },
    null, null, null, null, null, null, null,
    { type: "wood", count: 2 }, null, null, null,
  ], "keeper");
  keeper.worn.back = { type: "backpack", count: 1 };
  sys.spawnPlayerCorpse(state2, keeper);
  const corpse2 = [...state2.corpses.values()][0];
  check(corpse2.contents.length === 0, "keep-inventory corpse spawns EMPTY");
  check(keeper.worn.back?.type === "backpack" && keeper.inventory.length === PACK_LEN,
    "…and worn + pack slots survive");
  sys.respawnPlayer(state2, keeper);
  check(keeper.worn.back?.type === "backpack" && keeper.inventory[8]?.type === "wood",
    "keep-inventory respawn keeps worn AND the 12-slot inventory");

  // fullLoot respawn: fresh 8-slot loadout, nothing worn.
  player.worn.body = { type: "padded_jacket", count: 1 }; // simulate stale state
  sys.respawnPlayer(state, player);
  check(player.worn.body === null && player.inventory.length === INVENTORY_SLOTS,
    "fullLoot respawn resets worn + 8 slots (belt-and-braces)");
}

// --- 3. persistence round-trip -------------------------------------------------
console.log("\npersistence (saveCharacter → restorePlayer):");
{
  const rows = new Map();
  const fakeSql = {
    exec(query, ...bindings) {
      if (/^INSERT INTO characters/.test(query)) {
        rows.set(bindings[0], bindings[4]); // token_hash -> state_json
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
  const state = makeState();
  const player = makePlayer(state, [
    { type: "axe", count: 1 },
    null, null, null, null, null, null, null,
    { type: "beans", count: 2 }, null, null, null,
  ]);
  player.worn.body = { type: "padded_jacket", count: 1 };
  player.worn.back = { type: "backpack", count: 1 };
  saveCharacter(fakeSql, player, 123);
  const saved = JSON.parse(rows.get(player.tokenHash));
  check(saved.worn?.body?.type === "padded_jacket" && saved.worn?.back?.type === "backpack",
    "state_json carries worn");
  check(saved.inventory.length === PACK_LEN, "…and the 12-length inventory in the SAME row (atomic)");

  const state2 = makeState();
  const restored = sys.restorePlayer(state2, "r1", "wearbot", "t-r1", saved);
  check(restored.worn.body?.type === "padded_jacket" && restored.worn.back?.type === "backpack",
    "restorePlayer rebuilds worn");
  check(restored.worn.body !== saved.worn.body, "…as deep copies (no aliasing into the saved blob)");
  check(restored.inventory.length === PACK_LEN && restored.inventory[8]?.type === "beans",
    "…with the pack-extended inventory intact");

  // Old save without worn (pre-M6 row): restores as nothing worn.
  delete saved.worn;
  const state3 = makeState();
  const legacy = sys.restorePlayer(state3, "r2", "wearbot2", "t-r2", saved);
  check(legacy.worn.body === null && legacy.worn.back === null,
    "pre-M6 save without `worn` restores cleanly as nothing worn");
}

console.log("");
if (failures > 0) {
  console.error(`WEAR-SLOTS: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("WEAR-SLOTS: PASS — wear/unwear, insulation, pack capacity, corpse + persistence hold");
