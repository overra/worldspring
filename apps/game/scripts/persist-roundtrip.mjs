// Offline round-trip + write-count test for the single-row world snapshot.
//   node --experimental-strip-types apps/game/scripts/persist-roundtrip.mjs
//
// Mocks the DO SqlStorage with an in-memory table, runs saveWorld -> loadWorld,
// asserts the dynamic world is preserved exactly, and proves the per-save
// rows-written dropped from O(entities) (the old wipe-and-reinsert) to O(1).
// This guards the production save path — a regression here is silent data loss.
import { saveWorld, loadWorld } from "../src/server/persistence.ts";

function makeFakeSql() {
  let rows = []; // { kind, payload }
  let deletes = 0;
  let inserts = 0;
  const sql = {
    exec(query, ...bindings) {
      if (/^DELETE FROM world_state/.test(query)) {
        deletes += rows.length; // SQLite counts each deleted row as a write
        rows = [];
        return { toArray: () => [] };
      }
      if (/^INSERT INTO world_state/.test(query)) {
        rows.push({ kind: "snapshot", payload: bindings[0] });
        inserts += 1;
        return { toArray: () => [] };
      }
      if (/SELECT payload FROM world_state WHERE kind = 'snapshot'/.test(query)) {
        return {
          toArray: () =>
            rows.filter((r) => r.kind === "snapshot").map((r) => ({ payload: r.payload })),
        };
      }
      return { toArray: () => [] };
    },
  };
  return {
    sql,
    storage: { transactionSync: (fn) => fn() },
    rowCount: () => rows.length,
    writes: () => deletes + inserts,
  };
}

function freshGame() {
  return {
    loot: new Map(),
    corpses: new Map(),
    fires: [],
    lootRespawns: [],
    drops: new Map(),
    time: 0,
    tick: 0,
    nextEntityId: 1,
    weather: 0,
    weatherNextAt: 0,
    weatherRaining: false,
    airdropNextAt: 0,
  };
}

function sampleGame() {
  const g = freshGame();
  g.loot.set(11, { id: 11, type: 3, x: 1, z: 2, stack: { type: 3, count: 5 } });
  g.loot.set(12, { id: 12, type: 4, x: 3, z: 4 });
  g.corpses.set(21, { id: 21, x: 5, z: 6, inventory: [{ type: 1, count: 1 }], ttl: 60 });
  g.fires.push({ id: 31, x: 7, z: 8, fuel: 100 });
  g.lootRespawns.push({ spawnId: 0, at: 123 });
  g.drops.set(41, { id: 41, x: 9, z: 10, landsAt: 200, expiresAt: 400 });
  g.time = 1234.5;
  g.tick = 5678;
  g.nextEntityId = 42;
  g.weather = 0.7;
  g.weatherNextAt = 999;
  g.weatherRaining = true;
  g.airdropNextAt = 1500;
  return g;
}

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`${m}\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`);
  }
};

const { sql, storage, rowCount, writes } = makeFakeSql();
const orig = sampleGame();

// First save into an empty table.
saveWorld(storage, sql, orig);
if (rowCount() !== 1) fail(`expected 1 world_state row after save, got ${rowCount()}`);

// Steady-state save (a snapshot row already exists): 1 delete + 1 insert.
const before = writes();
saveWorld(storage, sql, orig);
const perSave = writes() - before;
const entities =
  orig.loot.size + orig.corpses.size + orig.fires.length + orig.lootRespawns.length + orig.drops.size;
console.log(
  `per-save rows written: ${perSave}  (old wipe-and-reinsert: ~${2 * entities} for ${entities} entities)`,
);
if (perSave > 2) fail(`expected <=2 rows written per save, got ${perSave}`);

// Round-trip: hydrate a fresh game and assert the world matches exactly.
const loaded = freshGame();
if (loadWorld(sql, loaded) !== true) fail("loadWorld returned false on a saved world");
eq([...loaded.loot.values()], [...orig.loot.values()], "loot mismatch");
eq([...loaded.corpses.values()], [...orig.corpses.values()], "corpses mismatch");
eq(loaded.fires, orig.fires, "fires mismatch");
eq(loaded.lootRespawns, orig.lootRespawns, "lootRespawns mismatch");
eq([...loaded.drops.values()], [...orig.drops.values()], "drops mismatch");
eq(
  [loaded.time, loaded.tick, loaded.nextEntityId],
  [orig.time, orig.tick, orig.nextEntityId],
  "time/tick/nextEntityId mismatch",
);
eq(
  [loaded.weather, loaded.weatherNextAt, loaded.weatherRaining, loaded.airdropNextAt],
  [orig.weather, orig.weatherNextAt, orig.weatherRaining, orig.airdropNextAt],
  "weather/airdrop scheduling mismatch",
);

// Empty table -> loadWorld returns false (caller stocks a fresh world).
const empty = makeFakeSql();
if (loadWorld(empty.sql, freshGame()) !== false) {
  fail("loadWorld on an empty world_state should return false");
}

console.log("ROUND-TRIP: PASS — world preserved exactly, false-on-empty, O(1) writes/save");
