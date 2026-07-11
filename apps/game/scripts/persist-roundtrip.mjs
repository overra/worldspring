// Offline round-trip + write-count test for the split-row world persistence.
//   node --experimental-strip-types apps/game/scripts/persist-roundtrip.mjs
//
// Mocks the DO SqlStorage with an in-memory (kind, payload) table, runs
// saveWorld -> loadWorld, asserts the dynamic world is preserved exactly, and
// proves the per-save rows-written stays O(1)+O(dirty):
//   - the `snapshot` row (per-tick drift) rewrites every save;
//   - the `trees` row rewrites only when game.treesDirty;
//   - `structures:<b>` bucket rows rewrite only for dirty buckets — a steady
//     save with idle bases writes exactly 2 rows (snapshot delete+insert), a
//     one-piece mutation rewrites exactly its bucket, and a legacy fat
//     snapshot (inline structures/felled/planted) migrates to the split rows
//     on its first save.
// This guards the production save path — a regression here is silent data loss.
import {
  saveWorld,
  loadWorld,
  structureBucketOf,
  STRUCTURE_BUCKET_COUNT,
} from "../src/server/persistence.ts";
import { PhysicsSystem } from "../src/server/physics/PhysicsSystem.ts";

// Engineless PhysicsSystem (never attaches Rapier): serialize() passes the
// restored/pending buffer through, exactly the pre-attach DO behavior — so
// the round-trip covers doc 13 bodies without loading wasm here.
const fakeStatics = { size: 800, heightAt: () => 0, buildings: [], militaryWalls: [], trees: [] };
const freshPhysics = () => new PhysicsSystem(fakeStatics, { enabled: true, bodyCap: 64 });

function makeFakeSql() {
  let rows = []; // { kind, payload }
  let deletes = 0;
  let inserts = 0;
  const sql = {
    exec(query, ...bindings) {
      if (/^DELETE FROM world_state WHERE kind = \?/.test(query)) {
        const kind = bindings[0];
        deletes += rows.filter((r) => r.kind === kind).length; // SQLite counts each deleted row
        rows = rows.filter((r) => r.kind !== kind);
        return { toArray: () => [] };
      }
      if (/^DELETE FROM world_state$/.test(query)) {
        deletes += rows.length;
        rows = [];
        return { toArray: () => [] };
      }
      if (/^INSERT INTO world_state/.test(query)) {
        rows.push({ kind: bindings[0], payload: bindings[1] });
        inserts += 1;
        return { toArray: () => [] };
      }
      if (/SELECT kind, payload FROM world_state/.test(query)) {
        return { toArray: () => rows.map((r) => ({ kind: r.kind, payload: r.payload })) };
      }
      return { toArray: () => [] };
    },
  };
  return {
    sql,
    storage: { transactionSync: (fn) => fn() },
    rows: () => rows,
    rowOf: (kind) => rows.find((r) => r.kind === kind),
    rowCount: () => rows.length,
    writes: () => deletes + inserts,
    insert: (kind, payload) => rows.push({ kind, payload }),
  };
}

// Minimal shared-index stand-ins: just enough surface for saveWorld's
// partition scan and loadWorld's hydration (pieces Map + add; plantedTrees
// Map + upsert). The REAL index round-trip is covered by structures.mjs /
// trees.mjs with the bundled shared modules.
function fakeWorld() {
  const pieces = new Map();
  const planted = new Map();
  return {
    structures: {
      pieces,
      add: (p) => pieces.set(p.id, p),
      remove: (id) => pieces.delete(id),
    },
    plantedTrees: {
      trees: planted,
      upsert: (r) => {
        planted.set(r.id, { ...r });
        return planted.get(r.id);
      },
      remove: (id) => planted.delete(id),
    },
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
    vehicleMeta: new Map(),
    world: fakeWorld(),
    structureMeta: new Map(),
    dirtyStructureBuckets: new Set(),
    treesDirty: false,
  };
}

/** Mirror GameRoom.persistAll's post-commit contract for direct saveWorld
 * callers: the dirty tracking resets once the save lands. */
function clearDirty(g) {
  g.dirtyStructureBuckets.clear();
  g.treesDirty = false;
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
  g.nextEntityId = 60;
  g.weather = 0.7;
  g.weatherNextAt = 999;
  g.weatherRaining = true;
  g.airdropNextAt = 1500;
  // doc 13 M2 — felled tree indices ride the `trees` row.
  g.felledTrees.add(3);
  g.felledTrees.add(17);
  // Planted trees ride the `trees` row too; plantedAtMs "now" so the re-derived
  // stage matches the stored one (sapling) and deep-equality holds.
  g.world.plantedTrees.upsert({
    id: 51,
    species: "oak",
    appearanceSeed: 12345,
    x: 30,
    z: 40,
    groundY: 2.5,
    plantedAtMs: Date.now(),
    stage: "sapling",
  });
  g.treesDirty = true;
  // doc 06 — structures ride `structures:<b>` bucket rows. Two pieces in one
  // bucket, one in another (gx 100 ⇒ a different (gx>>4)&7 tile than gx 4).
  g.world.structures.add({ id: 55, kind: "foundation", tier: 0, gx: 4, gz: 4, floorY: 1.5, hp: 600 });
  g.world.structures.add({ id: 56, kind: "door", tier: 0, gx: 4, gz: 4, edge: 0, floorY: 1.5, hp: 250, open: true });
  g.world.structures.add({ id: 57, kind: "crate", tier: 0, gx: 100, gz: 4, x: 301.25, z: 13.5, floorY: 0.4, hp: 200 });
  g.structureMeta.set(55, { ownerHash: "own-a", placedAtMs: 111, code: null, authorized: [], contents: null });
  g.structureMeta.set(56, { ownerHash: "own-a", placedAtMs: 222, code: "4321", authorized: ["hash-f1"], contents: null });
  g.structureMeta.set(57, {
    ownerHash: "own-b",
    placedAtMs: 333,
    code: null,
    authorized: [],
    contents: [{ type: "wood", count: 8 }, ...Array.from({ length: 11 }, () => null)],
  });
  for (const p of g.world.structures.pieces.values()) {
    g.dirtyStructureBuckets.add(structureBucketOf(p.gx, p.gz));
  }
  // doc 13 M4 — a vehicle: the hull BODY rides the engineless physics buffer
  // (serialize passes it through), its gameplay meta (fuel/hp/wrecked) rides the
  // `vehicles` snapshot array. Seats are OCCUPIED here to prove they are CLEARED
  // on restore (players are never seated across a restart, doc 13 §5). Body id 40
  // stays under nextEntityId (60) so the id-counter assertion is unaffected.
  g.physics.spawnBody(40, "vehicle", 20, 1, 30);
  g.vehicleMeta.set(40, {
    id: 40,
    fuel: 42.5,
    hp: 180,
    wrecked: false,
    seats: ["deadbeefcafe", null],
    input: { throttle: 1, steer: 0, brake: 0 },
    lastForward: 3,
    ramCooldown: 0.2,
  });
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

const { sql, storage, rowCount, rowOf, rows, writes } = makeFakeSql();
const orig = sampleGame();
const BUCKET_A = structureBucketOf(4, 4); // pieces 55 + 56
const BUCKET_B = structureBucketOf(100, 4); // piece 57
if (BUCKET_A === BUCKET_B) fail("fixture bug: the two structure buckets must differ");

// First save into an empty table: snapshot + trees + 2 bucket rows.
saveWorld(storage, sql, orig);
clearDirty(orig);
if (rowCount() !== 4) fail(`expected 4 world_state rows after the first save, got ${rowCount()}`);
if (!rowOf("snapshot") || !rowOf("trees") || !rowOf(`structures:${BUCKET_A}`) || !rowOf(`structures:${BUCKET_B}`)) {
  fail(`missing expected row kinds; got ${rows().map((r) => r.kind).join(", ")}`);
}
// The snapshot row must be SLIM: the split subsystems never ride it anymore.
for (const key of ['"structures"', '"felled"', '"planted"']) {
  if (rowOf("snapshot").payload.includes(key)) fail(`snapshot row must not carry ${key}`);
}

// (b) Steady-state save with NOTHING dirty: exactly 2 rows written (the
// snapshot delete + insert) — the O(1)+O(dirty) invariant with dirty = 0.
{
  const before = writes();
  saveWorld(storage, sql, orig);
  const perSave = writes() - before;
  console.log(`steady-save rows written: ${perSave}  (old fat-blob save rewrote every subsystem)`);
  if (perSave !== 2) fail(`expected exactly 2 rows written on a clean steady save, got ${perSave}`);
}

// (c) Mutating one piece rewrites exactly its bucket row and no other.
{
  const bucketBBefore = rowOf(`structures:${BUCKET_B}`).payload;
  const treesBefore = rowOf("trees").payload;
  orig.world.structures.pieces.get(55).hp = 590;
  orig.dirtyStructureBuckets.add(BUCKET_A);
  const before = writes();
  saveWorld(storage, sql, orig);
  clearDirty(orig);
  const perSave = writes() - before;
  if (perSave !== 4) fail(`expected 4 rows written (snapshot + one bucket), got ${perSave}`);
  if (!rowOf(`structures:${BUCKET_A}`).payload.includes('"hp":590')) {
    fail("dirty bucket row was not rewritten with the mutated hp");
  }
  if (rowOf(`structures:${BUCKET_B}`).payload !== bucketBBefore) {
    fail("clean bucket row must be untouched (byte-identical) on a save");
  }
  if (rowOf("trees").payload !== treesBefore) fail("clean trees row must be untouched on a save");
}

// (d) Demolishing a bucket's LAST piece deletes that row outright.
{
  orig.world.structures.remove(57);
  orig.structureMeta.delete(57);
  orig.dirtyStructureBuckets.add(BUCKET_B);
  saveWorld(storage, sql, orig);
  clearDirty(orig);
  if (rowOf(`structures:${BUCKET_B}`) !== undefined) {
    fail("a dirty bucket with zero pieces must lose its row");
  }
  // Restore the crate for the round-trip below.
  orig.world.structures.add({ id: 57, kind: "crate", tier: 0, gx: 100, gz: 4, x: 301.25, z: 13.5, floorY: 0.4, hp: 200 });
  orig.structureMeta.set(57, {
    ownerHash: "own-b",
    placedAtMs: 333,
    code: null,
    authorized: [],
    contents: [{ type: "wood", count: 8 }, ...Array.from({ length: 11 }, () => null)],
  });
  orig.dirtyStructureBuckets.add(BUCKET_B);
  saveWorld(storage, sql, orig);
  clearDirty(orig);
}

// (a) Round-trip: hydrate a fresh game and assert the world matches exactly.
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
eq([...loaded.felledTrees], [...orig.felledTrees], "felled trees mismatch (split trees row)");
eq(
  [...loaded.world.plantedTrees.trees.values()],
  [...orig.world.plantedTrees.trees.values()],
  "planted trees mismatch (split trees row)",
);
eq(
  [...loaded.world.structures.pieces.values()].sort((a, b) => a.id - b.id),
  [...orig.world.structures.pieces.values()].sort((a, b) => a.id - b.id),
  "structure pieces mismatch (split bucket rows)",
);
{
  const m = loaded.structureMeta;
  if (m.get(56)?.code !== "4321") fail("door code did not round-trip through its bucket row");
  eq(m.get(56)?.authorized, ["hash-f1"], "authorized list mismatch");
  if (m.get(57)?.contents?.[0]?.type !== "wood") fail("crate contents did not round-trip");
  if (m.get(55)?.ownerHash !== "own-a") fail("ownership meta did not round-trip");
}
// Loading from CLEAN split rows must not dirty anything (disk == memory).
if (loaded.dirtyStructureBuckets.size !== 0 || loaded.treesDirty !== false) {
  fail("loading clean split rows must leave the dirty tracking empty");
}

// doc 13 M4 — vehicle meta round-trips fuel/hp/wrecked; seats are CLEARED (never
// seated across a restart); and the hull body itself round-trips as kind
// "vehicle" alongside the meta.
const vm = loaded.vehicleMeta.get(40);
if (!vm) fail("vehicle meta did not round-trip (id 40 missing)");
eq([vm.fuel, vm.hp, vm.wrecked], [42.5, 180, false], "vehicle fuel/hp/wrecked mismatch (doc 13 M4)");
eq(vm.seats, [null, null], "vehicle seats must be CLEARED on restore (doc 13 M4)");
const vbody = loaded.physics.serialize().find((b) => b.id === 40);
if (!vbody || vbody.kind !== "vehicle") fail("vehicle hull body did not round-trip as kind 'vehicle'");
if (vbody.dims !== undefined) fail("restored vehicle body must stay dims-less (fixed-size)");

// Empty table -> loadWorld returns false (caller stocks a fresh world).
const empty = makeFakeSql();
if (loadWorld(empty.sql, freshGame()) !== false) {
  fail("loadWorld on an empty world_state should return false");
}

const writeSnapshot = (obj) => {
  const f = makeFakeSql();
  f.insert("snapshot", JSON.stringify(obj));
  return f;
};

// Valid JSON, wrong shape: a collection that isn't an array must reject the
// WHOLE snapshot (fresh-world path) and must NOT partially hydrate the valid
// collections first — even though `loot` here is a perfectly good array.
const malformed = writeSnapshot({
  loot: [{ id: 99, type: "beans", count: 1, x: 0, y: 0, z: 0, spawnId: null, ttl: null }],
  corpses: "corrupt",
});
const g2 = freshGame();
if (loadWorld(malformed.sql, g2) !== false) {
  fail("loadWorld must reject a snapshot whose collection is the wrong type");
}
if (g2.loot.size !== 0) {
  fail("loadWorld must not partially hydrate before rejecting a malformed snapshot");
}
if (malformed.rowCount() !== 0) {
  fail("the fresh-world path must clear world_state (stale split rows would resurrect later)");
}

// A non-object payload (valid JSON) must also take the fresh-world path.
if (loadWorld(writeSnapshot(42).sql, freshGame()) !== false) {
  fail("loadWorld must reject a non-object snapshot payload");
}

// Split rows WITHOUT their anchor snapshot row (no supported write path
// produces this): fresh world, and the orphaned rows are cleared so they can
// never resurrect structures into a reset world.
{
  const f = makeFakeSql();
  f.insert("structures:3", JSON.stringify([{ id: 5, kind: "foundation", tier: 0, gx: 50, gz: 4, floorY: 1, hp: 600, ownerHash: "x", placedAtMs: 0 }]));
  if (loadWorld(f.sql, freshGame()) !== false) fail("bucket rows without a snapshot row must read as no-world");
  if (f.rowCount() !== 0) fail("orphaned split rows must be cleared on the fresh-world path");
}

// A single garbage entry inside an otherwise valid array is skipped, not fatal.
const dirty = writeSnapshot({
  loot: [
    null,
    { id: 7, type: "beans", count: 1, x: 0, y: 0, z: 0, spawnId: null, ttl: null },
  ],
});
const g3 = freshGame();
if (loadWorld(dirty.sql, g3) !== true) {
  fail("loadWorld should load a snapshot that has a skippable bad entry");
}
if (g3.loot.size !== 1 || !g3.loot.has(7)) {
  fail("loadWorld should skip the null entry and keep the valid one");
}

// (e) LEGACY fat snapshot (inline structures/felled/planted): loads fully,
// marks ALL buckets + trees dirty, and the next save materializes the split
// rows while slimming the snapshot row — the one-transaction migration.
{
  const legacy = writeSnapshot({
    loot: [],
    corpses: [],
    fires: [],
    lootRespawns: [],
    drops: [],
    time: 77,
    tick: 999,
    nextEntityId: 200,
    weather: 0,
    weatherNextAt: 0,
    weatherRaining: false,
    airdropNextAt: 0,
    bodies: [],
    vehicles: [],
    felled: [5, 9],
    planted: [
      { id: 60, species: "conifer", appearanceSeed: 7, x: -10, z: 12, groundY: 1, plantedAtMs: Date.now(), stage: "sapling" },
    ],
    structures: [
      { id: 70, kind: "foundation", tier: 0, gx: 4, gz: 4, floorY: 1, hp: 600, ownerHash: "legacy-own", placedAtMs: 1 },
      { id: 71, kind: "crate", tier: 0, gx: 100, gz: 4, x: 301, z: 13, floorY: 1, hp: 200, ownerHash: "legacy-own", placedAtMs: 2, contents: [{ type: "wood", count: 3 }] },
    ],
  });
  const g = freshGame();
  if (loadWorld(legacy.sql, g) !== true) fail("legacy fat snapshot must load");
  if (g.world.structures.pieces.size !== 2) fail("legacy inline structures must hydrate");
  if (![...g.felledTrees].every((i) => [5, 9].includes(i)) || g.felledTrees.size !== 2) {
    fail("legacy inline felled must hydrate");
  }
  if (g.world.plantedTrees.trees.size !== 1) fail("legacy inline planted must hydrate");
  if (g.dirtyStructureBuckets.size !== STRUCTURE_BUCKET_COUNT) {
    fail(`legacy load must mark ALL ${STRUCTURE_BUCKET_COUNT} buckets dirty (got ${g.dirtyStructureBuckets.size})`);
  }
  if (g.treesDirty !== true) fail("legacy load must mark treesDirty");
  saveWorld(legacy.storage, legacy.sql, g);
  clearDirty(g);
  if (!legacy.rowOf("trees")) fail("the first save after a legacy load must materialize the trees row");
  if (!legacy.rowOf(`structures:${structureBucketOf(4, 4)}`) || !legacy.rowOf(`structures:${structureBucketOf(100, 4)}`)) {
    fail("the first save after a legacy load must materialize the bucket rows");
  }
  for (const key of ['"structures"', '"felled"', '"planted"']) {
    if (legacy.rowOf("snapshot").payload.includes(key)) fail(`migrated snapshot row must be slim (still carries ${key})`);
  }
  // Round-trip the migrated form for good measure.
  const g5 = freshGame();
  if (loadWorld(legacy.sql, g5) !== true || g5.world.structures.pieces.size !== 2 || g5.structureMeta.get(71)?.contents?.[0]?.type !== "wood") {
    fail("migrated split rows must round-trip the legacy content");
  }
}

// (f) A corrupt bucket row is skipped without rejecting the rest — its bucket
// is marked dirty so the next save replaces it with the in-memory truth.
{
  const f = makeFakeSql();
  f.insert("snapshot", JSON.stringify({ time: 5, tick: 10, nextEntityId: 100 }));
  f.insert("structures:1", "{{{not json");
  f.insert(
    "structures:2",
    JSON.stringify([{ id: 80, kind: "foundation", tier: 0, gx: 33, gz: 4, floorY: 1, hp: 600, ownerHash: "z", placedAtMs: 0 }]),
  );
  f.insert("trees", "also not json");
  const g = freshGame();
  if (loadWorld(f.sql, g) !== true) fail("a corrupt bucket/trees row must not reject the whole load");
  if (!g.world.structures.pieces.has(80)) fail("the intact bucket row must still hydrate");
  if (!g.dirtyStructureBuckets.has(1)) fail("the corrupt bucket must be marked dirty (self-heal on next save)");
  if (g.treesDirty !== true) fail("a corrupt trees row must mark treesDirty (self-heal on next save)");
}

console.log(
  "ROUND-TRIP: PASS — world preserved exactly across split rows, steady save writes 2 rows, " +
    "dirty bucket isolation, legacy migration, false-on-empty, corrupt rows degrade per-row",
);
