// Offline test of the fail-closed world-wipe decision (doc 04 M2).
//   node --experimental-strip-types apps/game/scripts/persist-wipe.mjs
//
// Encodes the binding wipe decision table: schema bump, fingerprint match,
// pre-M2 graceful migration, the fail-closed refusal (varAbsent / worldTainted),
// the sanctioned wipe, a benign LIVE-edit no-op, and scheduled-wipe epochs —
// plus the captureBookmark try/catch. The leaderboard must survive EVERY wipe.
// This guards the only code in the project that can destroy a live world.
import { captureBookmark, initSchema } from "../src/server/persistence.ts";

// Canonical 5-part form (doc 07 M1 added `gen:` = WORLDGEN_VERSION); the
// 4-part legacy form is what pre-M1 databases stored (absent gen == 1).
const FP_1337 = "v1|seed:1337|size:standard|water:0|gen:1";
const FP_9999 = "v1|seed:9999|size:standard|water:0|gen:1";
const FP_1337_LEGACY = "v1|seed:1337|size:standard|water:0";
const FP_1337_LARGE = "v1|seed:1337|size:large|water:0|gen:1";

// In-memory SqlStorage. meta is a Map; characters/world_state/leaderboard are
// row counts (initSchema only ever DELETEs them wholesale, and the test seeds
// them), so counts are enough to assert what was wiped vs preserved.
function makeDb(meta = {}) {
  const m = new Map(Object.entries(meta));
  let characters = 0;
  let world = 0;
  let leaderboard = 0;
  const sql = {
    exec(q, ...b) {
      if (/^CREATE TABLE/i.test(q)) return { toArray: () => [] };
      if (/^SELECT value FROM meta WHERE key/i.test(q)) {
        const v = m.get(b[0]);
        return { toArray: () => (v === undefined ? [] : [{ value: v }]) };
      }
      if (/^INSERT OR REPLACE INTO meta/i.test(q)) {
        m.set(b[0], b[1]);
        return { toArray: () => [] };
      }
      if (/^DELETE FROM characters/i.test(q)) {
        characters = 0;
        return { toArray: () => [] };
      }
      if (/^DELETE FROM world_state/i.test(q)) {
        world = 0;
        return { toArray: () => [] };
      }
      if (/^DELETE FROM meta/i.test(q)) {
        m.clear();
        return { toArray: () => [] };
      }
      // No DELETE FROM leaderboard handler on purpose: initSchema must NEVER wipe
      // the leaderboard, so such a statement (or any other unhandled SQL) throws —
      // failing fast on stub/persistence drift instead of silently passing.
      throw new Error(`Unhandled SQL in persist-wipe stub: ${q}`);
    },
  };
  return {
    sql,
    meta: m,
    seed(c, w, l) {
      characters = c;
      world = w;
      leaderboard = l;
    },
    counts: () => ({ characters, world, leaderboard }),
  };
}

function boot(overrides = {}) {
  return {
    fingerprint: FP_1337,
    seed: 1337,
    wipeSchedule: "never",
    wipeEpoch: 0,
    configJson: '{"preset":"deadcoast"}',
    varAbsent: false,
    worldTainted: false,
    bookmark: "bm-test",
    ...overrides,
  };
}

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const eq = (a, b, m) => {
  if (a !== b) fail(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

let passed = 0;
const scenario = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fresh DB → initializes meta, nothing to wipe, returns the running fingerprint.
scenario("fresh DB initializes meta and returns the running fingerprint", () => {
  const db = makeDb();
  eq(initSchema(db.sql, boot()), FP_1337, "returned fingerprint");
  eq(db.meta.get("schema_version"), "2", "schema_version written");
  eq(db.meta.get("world_fingerprint"), FP_1337, "fingerprint written");
});

// 2. Pre-M2 graceful migration: schema 2 + world_seed, no fingerprint row, seed
//    matches → adopt the live world WITHOUT wiping.
scenario("pre-M2 migration adopts the live world without wiping", () => {
  const db = makeDb({ schema_version: "2", world_seed: "1337" });
  db.seed(5, 2, 3);
  eq(initSchema(db.sql, boot()), FP_1337, "returned fingerprint");
  eq(db.counts().characters, 5, "characters preserved");
  eq(db.counts().world, 2, "world_state preserved");
  eq(db.meta.get("world_fingerprint"), FP_1337, "fingerprint back-filled");
});

// 2b. gen-component adopt (doc 07 M1): a stored pre-gen 4-part fingerprint
//     whose remaining components match is the SAME world — rewrite in place
//     (never wipe). This is the routine deploy path for every pre-doc-07 DB.
scenario("a stored legacy 4-part fingerprint is adopted in place (no wipe)", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_1337_LEGACY });
  db.seed(5, 2, 3);
  eq(initSchema(db.sql, boot()), FP_1337, "returned the canonical 5-part fingerprint");
  eq(db.counts().characters, 5, "characters preserved");
  eq(db.counts().world, 2, "world_state preserved");
  eq(db.meta.get("world_fingerprint"), FP_1337, "stored string rewritten in place");
});

// 2c. A stored gen that this binary cannot regenerate (future formula version)
//     is NOT recoverable on the refusal path: booting "from the stored string"
//     would rehydrate characters into divergent geometry — wipe instead.
scenario("a stored future-gen fingerprint under refusal wipes (cannot regenerate)", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: "v1|seed:1337|size:standard|water:0|gen:2" });
  db.seed(5, 2, 3);
  const fp = initSchema(db.sql, boot({ varAbsent: true }));
  eq(fp, FP_1337, "returns the running fingerprint (fresh world)");
  eq(db.counts().characters, 0, "characters wiped (unrecoverable gen)");
  eq(db.counts().leaderboard, 3, "leaderboard survives");
});

// 3. Benign LIVE edit: fingerprint unchanged → no wipe (LIVE fields like
//    zombieDensity are NOT in the fingerprint, so editing them never wipes).
scenario("a benign LIVE config edit does not wipe", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_1337 });
  db.seed(7, 4, 2);
  const b = boot({ configJson: '{"preset":"deadcoast","overrides":{"threats":{"zombieDensity":2}}}' });
  eq(initSchema(db.sql, b), FP_1337, "returned fingerprint");
  eq(db.counts().characters, 7, "characters preserved");
});

// 4. Sanctioned wipe: an explicit, clean seed change → wipe characters +
//    world_state, KEEP the leaderboard, capture the pre-wipe bookmark.
scenario("an explicit clean seed change is a sanctioned wipe (leaderboard kept)", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_1337 });
  db.seed(5, 2, 3);
  eq(initSchema(db.sql, boot({ fingerprint: FP_9999, seed: 9999 })), FP_9999, "returned new fingerprint");
  eq(db.counts().characters, 0, "characters wiped");
  eq(db.counts().world, 0, "world_state wiped");
  eq(db.counts().leaderboard, 3, "leaderboard survives the wipe");
  eq(db.meta.get("pre_wipe_bookmark"), "bm-test", "pre-wipe bookmark captured");
});

// 4b. Sanctioned tier change: sizeTier is WIPE-class exactly like the seed
//     (doc 07 M2 un-restricted it) — an explicit clean change wipes.
scenario("an explicit clean sizeTier change is a sanctioned wipe", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_1337 });
  db.seed(5, 2, 3);
  eq(initSchema(db.sql, boot({ fingerprint: FP_1337_LARGE })), FP_1337_LARGE, "returned the new fingerprint");
  eq(db.counts().characters, 0, "characters wiped");
  eq(db.counts().leaderboard, 3, "leaderboard survives");
});

// 4c. Tier mismatch under refusal: a persisted LARGE world with a tainted
//     config boots the persisted large world (fail closed, tier included).
scenario("a tainted config refuses to wipe a persisted large world", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_1337_LARGE });
  db.seed(5, 2, 3);
  const fp = initSchema(db.sql, boot({ worldTainted: true }));
  eq(fp, FP_1337_LARGE, "boots the persisted large world");
  eq(db.counts().characters, 5, "characters preserved");
});

// 5. varAbsent refusal: a dropped GAME_CONFIG reverts to 1337 against a 9999
//    world → REFUSE, boot the persisted 9999 world, characters preserved.
scenario("a dropped GAME_CONFIG refuses to wipe and boots the persisted world", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_9999 });
  db.seed(5, 2, 3);
  const fp = initSchema(db.sql, boot({ fingerprint: FP_1337, seed: 1337, varAbsent: true }));
  eq(fp, FP_9999, "boots the PERSISTED world, not the config default");
  eq(db.counts().characters, 5, "characters preserved (fail-closed)");
});

// 6. worldTainted refusal: a tainted world config (typo'd JSON, unknown preset)
//    gets the same fail-closed treatment.
scenario("a tainted world config refuses to wipe", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: FP_9999 });
  db.seed(5, 2, 3);
  const fp = initSchema(db.sql, boot({ fingerprint: FP_1337, seed: 1337, worldTainted: true }));
  eq(fp, FP_9999, "boots the persisted world");
  eq(db.counts().characters, 5, "characters preserved");
});

// 6b. Corrupt persisted fingerprint under refusal: the persisted world is
//     unknowable, so preserving characters would desync — wipe to fresh instead
//     of rehydrating them into the running world.
scenario("a corrupt persisted fingerprint under refusal wipes instead of desyncing", () => {
  const db = makeDb({ schema_version: "2", world_fingerprint: "garbage-not-a-fingerprint" });
  db.seed(5, 2, 3);
  const fp = initSchema(db.sql, boot({ fingerprint: FP_1337, seed: 1337, varAbsent: true }));
  eq(fp, FP_1337, "returns the running fingerprint (fresh world)");
  eq(db.counts().characters, 0, "characters wiped (unrecoverable, not misbooted)");
  eq(db.counts().leaderboard, 3, "leaderboard survives");
});

// 7. Schema bump overrides the refusal: even with an absent/garbage config, a
//    schema_version mismatch wipes unconditionally (old rows may not parse).
scenario("a schema bump wipes unconditionally even with an absent config", () => {
  const db = makeDb({ schema_version: "1", world_fingerprint: FP_9999 });
  db.seed(5, 2, 3);
  initSchema(db.sql, boot({ fingerprint: FP_1337, seed: 1337, varAbsent: true }));
  eq(db.counts().characters, 0, "characters wiped on schema bump");
  eq(db.counts().leaderboard, 3, "leaderboard still survives");
  eq(db.meta.get("schema_version"), "2", "schema_version updated");
});

// 8. Scheduled wipe: same fingerprint, weekly schedule, a crossed epoch → one
//    wipe; an un-crossed epoch does not.
scenario("a crossed weekly epoch fires exactly one scheduled wipe", () => {
  const db = makeDb({
    schema_version: "2",
    world_fingerprint: FP_1337,
    wipe_schedule: "weekly",
    wipe_epoch: "5",
  });
  db.seed(6, 3, 4);
  initSchema(db.sql, boot({ wipeSchedule: "weekly", wipeEpoch: 6 }));
  eq(db.counts().characters, 0, "characters wiped on epoch crossing");
  eq(db.counts().leaderboard, 4, "leaderboard survives");
  eq(db.meta.get("wipe_epoch"), "6", "epoch advanced");
});
scenario("an un-crossed weekly epoch does not wipe", () => {
  const db = makeDb({
    schema_version: "2",
    world_fingerprint: FP_1337,
    wipe_schedule: "weekly",
    wipe_epoch: "6",
  });
  db.seed(6, 3, 4);
  initSchema(db.sql, boot({ wipeSchedule: "weekly", wipeEpoch: 6 }));
  eq(db.counts().characters, 6, "characters preserved (epoch not crossed)");
});

// 9. captureBookmark: resolves → the value; throws → "unavailable" (a wipe must
//    never be blocked, and the DO constructor must never crash, on capture).
const okBookmark = await captureBookmark({ getCurrentBookmark: async () => "bm-123" });
eq(okBookmark, "bm-123", "captureBookmark returns the resolved bookmark");
const badBookmark = await captureBookmark({
  getCurrentBookmark: async () => {
    throw new Error("PITR unsupported in local dev");
  },
});
eq(badBookmark, "unavailable", "captureBookmark falls back to 'unavailable' on throw");
passed += 2;
console.log("  ok  captureBookmark resolves, and falls back to 'unavailable' on throw");

console.log(`WIPE-DECISION: PASS — ${passed} checks, leaderboard survived every wipe`);
