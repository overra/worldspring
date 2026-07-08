// Offline round-trip + write-count test for the single-row world snapshot.
//   node --experimental-strip-types apps/game/scripts/persist-roundtrip.mjs
//
// Mocks the DO SqlStorage with an in-memory table, runs saveWorld -> loadWorld,
// asserts the dynamic world is preserved exactly, and proves the per-save
// rows-written dropped from O(entities) (the old wipe-and-reinsert) to O(1).
// This guards the production save path — a regression here is silent data loss.
import { saveWorld, loadWorld } from "../src/server/persistence.ts";
import { PhysicsSystem } from "../src/server/physics/PhysicsSystem.ts";

// Engineless PhysicsSystem (never attaches Rapier): serialize() passes the
// restored/pending buffer through, exactly the pre-attach DO behavior — so
// the round-trip covers doc 13 bodies without loading wasm here.
const fakeStatics = { heightAt: () => 0, buildings: [], militaryWalls: [], trees: [] };
const freshPhysics = () => new PhysicsSystem(fakeStatics, { enabled: true, bodyCap: 64 });

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
    physics: freshPhysics(),
    felledTrees: new Set(),
  };
}

function sampleGame() {
  const g = freshGame();
  // Fixtures mirror the server interfaces in src/server/systems/state.ts
  // exactly (field names, nesting, and value types — note ItemType is a string
  // union, not a number) so a shape regression there breaks this round-trip
  // instead of silently passing.
  g.loot.set(11, { id: 11, type: "rifle", count: 1, x: 1, y: 0, z: 2, spawnId: 7, ttl: null });
  g.loot.set(12, { id: 12, type: "ammo_762", count: 30, x: 3, y: 0, z: 4, spawnId: null, ttl: 120 });
  g.corpses.set(21, {
    id: 21,
    kind: "player",
    name: "Casey",
    x: 5,
    y: 0,
    z: 6,
    yaw: 1.57,
    contents: [{ type: "bandage", count: 2 }],
    ttl: 600,
  });
  g.fires.push({ id: 31, x: 7, y: 0, z: 8, burnRemaining: 300 });
  g.lootRespawns.push({ spawnId: 0, t: 45 });
  g.drops.set(41, {
    id: 41,
    x: 9,
    y: 12,
    z: 10,
    landsAt: 200,
    expiresAt: 400,
    contents: [{ type: "cooked_venison", count: 1 }],
  });
  g.time = 1234.5;
  g.tick = 5678;
  g.nextEntityId = 42;
  g.weather = 0.7;
  g.weatherNextAt = 999;
  g.weatherRaining = true;
  g.airdropNextAt = 1500;
  // doc 13 M2 — felled tree indices round-trip with the snapshot.
  g.felledTrees.add(3);
  g.felledTrees.add(17);
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
eq([...loaded.felledTrees], [...orig.felledTrees], "felled trees mismatch (doc 13 M2)");

// Empty table -> loadWorld returns false (caller stocks a fresh world).
const empty = makeFakeSql();
if (loadWorld(empty.sql, freshGame()) !== false) {
  fail("loadWorld on an empty world_state should return false");
}

const writeSnapshot = (obj) => {
  const f = makeFakeSql();
  f.sql.exec("INSERT INTO world_state (kind, payload) VALUES ('snapshot', ?)", JSON.stringify(obj));
  return f.sql;
};

// Valid JSON, wrong shape: a collection that isn't an array must reject the
// WHOLE snapshot (fresh-world path) and must NOT partially hydrate the valid
// collections first — even though `loot` here is a perfectly good array.
const malformed = writeSnapshot({
  loot: [{ id: 99, type: "beans", count: 1, x: 0, y: 0, z: 0, spawnId: null, ttl: null }],
  corpses: "corrupt",
});
const g2 = freshGame();
if (loadWorld(malformed, g2) !== false) {
  fail("loadWorld must reject a snapshot whose collection is the wrong type");
}
if (g2.loot.size !== 0) {
  fail("loadWorld must not partially hydrate before rejecting a malformed snapshot");
}

// A non-object payload (valid JSON) must also take the fresh-world path.
if (loadWorld(writeSnapshot(42), freshGame()) !== false) {
  fail("loadWorld must reject a non-object snapshot payload");
}

// A single garbage entry inside an otherwise valid array is skipped, not fatal.
const dirty = writeSnapshot({
  loot: [
    null,
    { id: 7, type: "beans", count: 1, x: 0, y: 0, z: 0, spawnId: null, ttl: null },
  ],
});
const g3 = freshGame();
if (loadWorld(dirty, g3) !== true) {
  fail("loadWorld should load a snapshot that has a skippable bad entry");
}
if (g3.loot.size !== 1 || !g3.loot.has(7)) {
  fail("loadWorld should skip the null entry and keep the valid one");
}

console.log(
  "ROUND-TRIP: PASS — world preserved exactly, false-on-empty, malformed-shape rejected, bad-entry skipped, O(1) writes/save",
);
