#!/usr/bin/env node
// Tree-lifecycle harness (follow-up to #85) — CI-run via `pnpm test`.
//
//   node --experimental-strip-types apps/game/scripts/trees.mjs
//
// Four layers:
//   1. WIRE — PROTOCOL_VERSION 11→12 floor + the {t:"use"} verb that carries
//      planting (seeds are placeable, so there is NO new ClientMsg).
//   2. SHARED — the real createWorld + planted index: world.queryStatics folds
//      planted young/mature trees in (collision parity with the client) and
//      excludes walk-through saplings.
//   3. SYSTEMS — bundles the REAL systems/trees.ts (+ players.ts) with esbuild
//      (the structures.mjs data-URL pattern) and drives plantSeed, the useItem
//      seed branch, tickTreeGrowth, tryChopTree and tickAmbientSeeds over a fake
//      GameState: placement rejection classes, consume-on-plant vs keep-on-
//      reject, wall-clock growth + collider resize, young-not-choppable vs
//      mature-fells, fell-seed drop chance, and the budgeted ambient scan.
//   4. PERSISTENCE — saveWorld → loadWorld round-trips the planted collection,
//      offline growth re-stages by wall clock, and a pre-lifecycle snapshot
//      (no `planted` key) loads clean.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  MELEE_RANGE,
  PLANTED_TREE_CAP,
  TREE_CHOPS_TO_FELL,
  TREE_PLANT_DIST,
  TREE_SEED_LOOSE_CAP,
} from "@worldspring/shared/constants";
import { yawToDir } from "@worldspring/shared/math";
import { parseClientMsg, PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { TREE_MATURE_AT_MS, treeStageAt } from "@worldspring/shared/trees";
import { saveWorld, loadWorld } from "../src/server/persistence.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

// Non-leaf shared modules (world/config/movement value-import each other with
// extensionless relative paths) can't be strip-types-imported directly — bundle
// them with esbuild (the structures.mjs data-URL pattern).
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const systemsDir = fileURLToPath(new URL("../src/server/systems", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");

async function bundleModule(contents, resolveDir, sourcefile) {
  const out = await build({
    stdin: { contents, resolveDir, loader: "ts", sourcefile },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const shared = await bundleModule(
  'export { createWorld } from "./src/world.ts";\n' + 'export { DEFAULT_CONFIG, worldParamsOf } from "./src/config.ts";\n',
  sharedDir,
  "trees-shared-entry.ts",
);
const { createWorld, DEFAULT_CONFIG, worldParamsOf } = shared;

const sys = await bundleModule(
  'export { plantSeed, tryChopTree, tickTreeGrowth, tickAmbientSeeds } from "./trees.ts";\n' +
    'export { useItem } from "./players.ts";\n',
  systemsDir,
  "trees-systems-entry.ts",
);
const { plantSeed, tryChopTree, tickTreeGrowth, tickAmbientSeeds, useItem } = sys;

// --- helpers ----------------------------------------------------------------

function makePhysics() {
  const calls = [];
  let bodyId = 5000;
  return {
    calls,
    addPlantedTree: (id, x, gy, z, r, h) => calls.push(["addPlanted", id, r, h]),
    removePlantedTree: (id) => calls.push(["removePlanted", id]),
    fellTree: (i) => calls.push(["fellTree", i]),
    spawnBody: () => ++bodyId,
    applyImpulseAtPoint: () => calls.push(["impulse"]),
    expireSettled: () => [],
  };
}

function makeState(world) {
  return {
    world,
    config: {
      physics: { enabled: true, bodyCap: 64 },
      building: { enabled: true },
    },
    time: 100,
    tick: 10,
    players: new Map(),
    loot: new Map(),
    events: [],
    outbox: [],
    nextEntityId: 1,
    felledTrees: new Set(),
    felledDelta: [],
    treeChops: new Map(),
    plantedTreeChops: new Map(),
    plantedTreeDelta: [],
    seedDropAt: new Map(),
    treeGrowthNextAtMs: 0,
    physics: makePhysics(),
  };
}

function makePlayer(state, id, x, z, yaw, inventory) {
  const player = {
    id,
    name: id,
    tokenHash: id,
    core: { x, y: state.world.groundHeight(x, z), z, vy: 0, yaw, pitch: 0, grounded: true },
    vitals: { hp: 100, food: 100, water: 100, temp: 37 },
    inventory,
    worn: { body: null, back: null },
    selectedSlot: 0,
    alive: true,
    offline: false,
    realm: "overworld",
    action: null,
  };
  state.players.set(id, player);
  return player;
}

const seedCount = (state) => {
  let n = 0;
  for (const l of state.loot.values()) if (l.type === "pine_cone" || l.type === "acorn") n += l.count;
  return n;
};
const noticeText = (state) => state.outbox.filter((o) => o.msg.t === "notice").map((o) => o.msg.msg);
function resetPlanted(world) {
  for (const id of [...world.plantedTrees.trees.keys()]) world.plantedTrees.remove(id);
}
function upsertPlanted(world, id, x, z, stage, species = "oak") {
  return world.plantedTrees.upsert({
    id,
    species,
    appearanceSeed: 12345,
    x,
    z,
    groundY: world.groundHeight(x, z),
    plantedAtMs: 0,
    stage,
  });
}

/** A dry, in-bounds spot with NO natural tree/wall within 6m, so a planted test
 * tree in front is the sole chop candidate. */
function findOpenSpot(world) {
  const lim = world.size / 2 - 12;
  for (let r = 24; r < lim; r += 6.5) {
    for (const [sx, sz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
    ]) {
      const x = sx * r;
      const z = sz * r;
      if (world.waterAt(x, z) !== null) continue;
      const near = world.queryStatics(x, z, 6);
      if (near.trees.length === 0 && near.walls.length === 0) return [x, z];
    }
  }
  throw new Error("no open spot found at seed 1337");
}

function findWater(world) {
  const lim = world.size / 2 - 5;
  for (let r = 40; r < lim; r += 4) {
    for (let a = 0; a < 360; a += 12) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      if (world.waterAt(x, z) !== null) return [x, z];
    }
  }
  return null;
}

// --- 1. wire ----------------------------------------------------------------
console.log("protocol (tree-lifecycle wire):");
{
  check(PROTOCOL_VERSION >= 12, `PROTOCOL_VERSION is at least 12 (got ${PROTOCOL_VERSION})`);
  // Planting rides the existing use verb — no new ClientMsg.
  const use = parseClientMsg(JSON.stringify({ t: "use", slot: 2 }));
  check(use?.t === "use" && use.slot === 2, "use parses (carries planting)");
}

// --- 2. shared index + queryStatics parity ----------------------------------
console.log("shared (queryStatics folds planted trees):");
const world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
{
  const [ox, oz] = findOpenSpot(world);
  upsertPlanted(world, 900001, ox, oz, "mature");
  const hit = world.queryStatics(ox, oz, 2).trees.some((t) => t.x === ox && t.z === oz);
  check(hit, "world.queryStatics returns a mature planted tree (client/server collision parity)");
  resetPlanted(world);
  upsertPlanted(world, 900002, ox, oz, "sapling");
  const sap = world.queryStatics(ox, oz, 2).trees.some((t) => t.stage === "sapling");
  check(!sap, "world.queryStatics EXCLUDES walk-through saplings");
  resetPlanted(world);
}

// --- 3. systems (real server systems/trees.ts + players.ts) ------------------
console.log("systems (plantSeed / useItem / growth / chop / ambient):");
const [OX, OZ] = findOpenSpot(world);

// plantSeed — success at an open spot.
{
  const state = makeState(world);
  const player = makePlayer(state, "p1", OX, OZ, 0, [{ type: "pine_cone", count: 4 }]);
  const ok = plantSeed(state, player, "conifer");
  check(ok === true, "plantSeed returns true on open ground");
  check(world.plantedTrees.trees.size === 1, "a sapling entered the index");
  const [only] = [...world.plantedTrees.trees.values()];
  check(only.stage === "sapling" && only.species === "conifer", "planted a conifer sapling");
  check(
    state.plantedTreeDelta.length === 1 && state.plantedTreeDelta[0].op === "upsert",
    "an upsert delta was queued",
  );
  check(
    state.physics.calls.some((c) => c[0] === "addPlanted"),
    "physics.addPlantedTree was called (sapling collider is a no-op, but the call is made)",
  );
  resetPlanted(world);
}

// plantSeed — rejection classes (each returns false + notice, seed uncommitted).
{
  const state = makeState(world);
  // water: put the plant point on water.
  const w = findWater(world);
  if (w) {
    const [dfx, dfz] = yawToDir(0);
    const px = w[0] - dfx * TREE_PLANT_DIST;
    const pz = w[1] - dfz * TREE_PLANT_DIST;
    const p = makePlayer(state, "pw", px, pz, 0, [{ type: "acorn", count: 1 }]);
    check(plantSeed(state, p, "oak") === false, "plantSeed rejects water");
    check(world.plantedTrees.trees.size === 0, "no tree planted in water");
  } else {
    console.log("  (skip water rejection — dry world at this seed)");
  }

  // out of bounds: front lands beyond the world limit.
  const edge = world.size / 2 - 1.5;
  const pb = makePlayer(state, "pb", 0, -edge, 0, [{ type: "acorn", count: 1 }]);
  check(plantSeed(state, pb, "oak") === false, "plantSeed rejects out-of-bounds");

  // clearance: a mature tree already occupies the plant point.
  const [dfx, dfz] = yawToDir(0);
  const px = OX;
  const pz = OZ;
  upsertPlanted(world, 900010, px + dfx * TREE_PLANT_DIST, pz + dfz * TREE_PLANT_DIST, "mature");
  const pc = makePlayer(state, "pc", px, pz, 0, [{ type: "acorn", count: 1 }]);
  check(plantSeed(state, pc, "oak") === false, "plantSeed rejects when too close to another tree");
  check(world.plantedTrees.trees.size === 1, "clearance rejection planted nothing new");
  resetPlanted(world);

  // cap: fill to PLANTED_TREE_CAP, then the next plant is rejected.
  for (let i = 0; i < PLANTED_TREE_CAP; i++) upsertPlanted(world, 800000 + i, world.size / 2 - 3, -(world.size / 2) + 3 + (i % 5), "young");
  const pcap = makePlayer(state, "pcap", OX, OZ, 0, [{ type: "acorn", count: 1 }]);
  check(world.plantedTrees.trees.size === PLANTED_TREE_CAP, "index filled to the planted cap");
  check(plantSeed(state, pcap, "oak") === false, "plantSeed rejects at the planted cap");
  check(noticeText(state).length >= 3, "each rejection sent a player notice");
  resetPlanted(world);
}

// useItem seed branch — consume on success, KEEP on reject.
{
  const state = makeState(world);
  const player = makePlayer(state, "pu", OX, OZ, 0, [{ type: "pine_cone", count: 3 }]);
  useItem(state, player, 0);
  check(player.inventory[0] && player.inventory[0].count === 2, "useItem plants and consumes ONE seed on success");
  check(world.plantedTrees.trees.size === 1, "useItem grew a sapling");
  resetPlanted(world);

  // reject (out of bounds) — the seed must NOT be consumed.
  const edge = world.size / 2 - 1.5;
  const keeper = makePlayer(state, "pk", 0, -edge, 0, [{ type: "acorn", count: 2 }]);
  useItem(state, keeper, 0);
  check(keeper.inventory[0] && keeper.inventory[0].count === 2, "useItem KEEPS the seed on a rejected plant");
  check(world.plantedTrees.trees.size === 0, "rejected useItem planted nothing");
  resetPlanted(world);
}

// tickTreeGrowth — wall-clock stage advance + collider resize + delta.
{
  const state = makeState(world);
  // Plant "in the past" so it's already due to be mature.
  const past = Date.now() - (TREE_MATURE_AT_MS + 60_000);
  world.plantedTrees.upsert({
    id: 700001,
    species: "oak",
    appearanceSeed: 999,
    x: OX,
    z: OZ,
    groundY: world.groundHeight(OX, OZ),
    plantedAtMs: past,
    stage: "sapling", // stale stage; the scan should correct it
  });
  state.treeGrowthNextAtMs = 0; // due now
  tickTreeGrowth(state);
  const grown = world.plantedTrees.trees.get(700001);
  check(grown.stage === "mature", "tickTreeGrowth advances a long-planted sapling to mature");
  check(grown.r > 0, "grown tree has a collidable radius");
  check(
    state.physics.calls.some((c) => c[0] === "addPlanted" && c[1] === 700001 && c[2] > 0),
    "growth resized the Rapier collider (addPlantedTree with r>0)",
  );
  check(
    state.plantedTreeDelta.some((d) => d.op === "upsert" && d.tree.id === 700001 && d.tree.stage === "mature"),
    "growth queued a mature upsert delta",
  );
  // Cadence gate: a not-yet-due scan is a no-op.
  state.plantedTreeDelta.length = 0;
  state.treeGrowthNextAtMs = Date.now() + 10 * 60_000;
  tickTreeGrowth(state);
  check(state.plantedTreeDelta.length === 0, "growth scan is cadence-gated (no work before due)");
  resetPlanted(world);
}

// tryChopTree — young is NOT choppable; mature chops down over TREE_CHOPS_TO_FELL.
{
  const state = makeState(world);
  const [dfx, dfz] = yawToDir(0);
  const tx = OX + dfx * 1.4;
  const tz = OZ + dfz * 1.4;

  // young: in the cone, collidable, but not a wood source yet.
  upsertPlanted(world, 600001, tx, tz, "young");
  const youngPlayer = makePlayer(state, "py", OX, OZ, 0, [{ type: "axe", count: 1 }]);
  check(tryChopTree(state, youngPlayer) === false, "tryChopTree does NOT chop a young planted tree");
  check(world.plantedTrees.trees.has(600001), "young tree survived the swing");
  resetPlanted(world);

  // mature: three chops fell it.
  upsertPlanted(world, 600002, tx, tz, "mature");
  const chopper = makePlayer(state, "pm", OX, OZ, 0, [{ type: "axe", count: 1 }]);
  check(tryChopTree(state, chopper) === true, "chop 1 lands on a mature planted tree");
  check(state.plantedTreeChops.get(600002) === 1, "planted chop counter increments (keyed by id)");
  tryChopTree(state, chopper); // chop 2
  check(world.plantedTrees.trees.has(600002) && state.plantedTreeChops.get(600002) === 2, "still standing at 2 chops");
  check(TREE_CHOPS_TO_FELL === 3, "sanity: 3 chops to fell");
  tryChopTree(state, chopper); // chop 3 → fell
  check(!world.plantedTrees.trees.has(600002), "the mature planted tree is felled (removed from the index)");
  check(
    state.plantedTreeDelta.some((d) => d.op === "remove" && d.id === 600002),
    "felling queued a remove delta",
  );
  check(
    state.physics.calls.some((c) => c[0] === "removePlanted" && c[1] === 600002),
    "felling removed the planted collider",
  );
  check(state.physics.calls.filter((c) => c[0] === "impulse").length === 1, "a dynamic trunk was toppled");
  resetPlanted(world);
}

// fell-seed drop — Math.random gated, matching species, cap-respecting.
{
  const realRandom = Math.random;
  const [dfx, dfz] = yawToDir(0);
  const tx = OX + dfx * 1.4;
  const tz = OZ + dfz * 1.4;
  try {
    // Force the roll to always drop.
    Math.random = () => 0;
    const state = makeState(world);
    upsertPlanted(world, 600100, tx, tz, "mature", "conifer");
    const chopper = makePlayer(state, "pf", OX, OZ, 0, [{ type: "axe", count: 1 }]);
    for (let i = 0; i < TREE_CHOPS_TO_FELL; i++) tryChopTree(state, chopper);
    const coneDrops = [...state.loot.values()].filter((l) => l.type === "pine_cone").length;
    check(coneDrops === 1, "felling a conifer drops a matching pine_cone (roll < chance)");
    resetPlanted(world);

    // Force the roll to never drop.
    Math.random = () => 0.99;
    const state2 = makeState(world);
    upsertPlanted(world, 600101, tx, tz, "mature", "oak");
    const chopper2 = makePlayer(state2, "pf2", OX, OZ, 0, [{ type: "axe", count: 1 }]);
    for (let i = 0; i < TREE_CHOPS_TO_FELL; i++) tryChopTree(state2, chopper2);
    check(seedCount(state2) === 0, "no seed drops when the roll is above the chance");
    resetPlanted(world);
  } finally {
    Math.random = realRandom;
  }
}

// tickAmbientSeeds — budgeted per-player, cooldown-gated, cap-respecting.
{
  const state = makeState(world);
  // Guarantee a mature tree in ambient range.
  upsertPlanted(world, 500001, OX + 8, OZ, "mature");
  const player = makePlayer(state, "pa", OX, OZ, 0, [{ type: "axe", count: 1 }]);
  tickAmbientSeeds(state);
  check(seedCount(state) === 1, "ambient scan drops exactly one seed per player when due");
  const due = state.seedDropAt.get("pa");
  check(due > state.time, "the per-player cooldown was armed");
  tickAmbientSeeds(state); // same game-time → still on cooldown
  check(seedCount(state) === 1, "ambient scan is cooldown-gated (no second drop same tick)");
  resetPlanted(world);

  // Loose cap short-circuit.
  const capped = makeState(world);
  upsertPlanted(world, 500002, OX + 8, OZ, "mature");
  capped.loot.set(1, { id: 1, type: "pine_cone", count: TREE_SEED_LOOSE_CAP, x: 0, y: 0, z: 0, spawnId: null, ttl: 60 });
  makePlayer(capped, "pcap2", OX, OZ, 0, [{ type: "axe", count: 1 }]);
  tickAmbientSeeds(capped);
  check(seedCount(capped) === TREE_SEED_LOOSE_CAP, "ambient scan respects the global loose-seed cap");
  resetPlanted(world);
}

// --- 4. persistence ---------------------------------------------------------
console.log("persistence (save/load + offline growth):");

function makeFakeSql() {
  let rows = [];
  return {
    sql: {
      exec(query, ...bindings) {
        if (/^DELETE FROM world_state/.test(query)) {
          rows = [];
          return { toArray: () => [] };
        }
        if (/^INSERT INTO world_state/.test(query)) {
          rows.push({ payload: bindings[0] });
          return { toArray: () => [] };
        }
        if (/SELECT payload FROM world_state/.test(query)) return { toArray: () => rows.map((r) => ({ payload: r.payload })) };
        return { toArray: () => [] };
      },
    },
    storage: { transactionSync: (fn) => fn() },
    payload: () => rows[0]?.payload,
    setPayload: (p) => {
      rows = [{ payload: p }];
    },
  };
}

const persistBase = () => ({
  loot: new Map(),
  corpses: new Map(),
  fires: [],
  lootRespawns: [],
  drops: new Map(),
  time: 10,
  tick: 150,
  nextEntityId: 1,
  weather: 0,
  weatherNextAt: 0,
  weatherRaining: false,
  airdropNextAt: 0,
  physics: { serialize: () => [], restore: () => {}, fellTree: () => {} },
  felledTrees: new Set(),
  structureMeta: new Map(),
});

{
  const g = persistBase();
  g.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const nowMs = Date.now();
  // A young tree planted recently, and a sapling planted long ago (stale stage —
  // wall-clock age says it should be mature on reload).
  g.world.plantedTrees.upsert({ id: 71, species: "oak", appearanceSeed: 11, x: 30, z: 40, groundY: g.world.groundHeight(30, 40), plantedAtMs: nowMs - 60_000, stage: "young" });
  g.world.plantedTrees.upsert({ id: 72, species: "conifer", appearanceSeed: 22, x: -30, z: 10, groundY: g.world.groundHeight(-30, 10), plantedAtMs: nowMs - (TREE_MATURE_AT_MS + 120_000), stage: "sapling" });
  g.nextEntityId = 73;

  const fake = makeFakeSql();
  saveWorld(fake.storage, fake.sql, g);
  check(fake.payload().includes('"planted"'), "snapshot payload carries the planted key");

  const g2 = persistBase();
  g2.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(loadWorld(fake.sql, g2) === true, "loadWorld returns true on a snapshot row");
  check(g2.world.plantedTrees.trees.size === 2, "both planted trees restored");
  const restoredYoung = g2.world.plantedTrees.trees.get(71);
  const restoredOld = g2.world.plantedTrees.trees.get(72);
  check(restoredYoung?.stage === treeStageAt(restoredYoung.plantedAtMs, Date.now()), "recent tree keeps its wall-clock stage");
  check(restoredOld?.stage === "mature", "a sapling planted long ago restores as MATURE (offline growth)");
  check(g2.nextEntityId >= 73, `id ceiling folds planted ids (nextEntityId=${g2.nextEntityId})`);

  // Pre-lifecycle snapshot: strip the planted key entirely → must load clean.
  const stripped = JSON.parse(fake.payload());
  delete stripped.planted;
  const oldFake = makeFakeSql();
  oldFake.setPayload(JSON.stringify(stripped));
  const g3 = persistBase();
  g3.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(
    loadWorld(oldFake.sql, g3) === true && g3.world.plantedTrees.trees.size === 0,
    "pre-lifecycle snapshot (no planted key) loads clean (empty planted set)",
  );
}

console.log(failures === 0 ? "\nALL TREE-LIFECYCLE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
