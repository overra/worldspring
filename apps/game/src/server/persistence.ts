// All Durable Object SQLite storage code in one module. The GameRoom DO is
// declared with new_sqlite_classes, so `ctx.storage.sql` (synchronous
// `exec(query, ...bindings)` returning a cursor) and
// `ctx.storage.transactionSync(closure)` are available.
//
// Schema choice: the dynamic world is persisted as a FEW `world_state` rows,
// split by write cadence (doc 06 M8 follow-up):
//   - kind `snapshot`  — everything that drifts every tick (loot/corpses/
//     fires/timers/drops/bodies/vehicles + time/tick/ids/scheduling),
//     rewritten on every save;
//   - kind `trees`     — felled indices + planted records, rewritten only when
//     game.treesDirty (tree events are rare);
//   - kind `structures:<b>` (b in 0..STRUCTURE_BUCKET_COUNT-1) — fixed spatial
//     buckets of the player structures, rewriting only the buckets in
//     game.dirtyStructureBuckets. At the 3000-piece cap structures were ~97%
//     of a 564 KB per-save blob (~158 ms in-tick on miniflare) while being
//     near-static — dirty-skipping them makes the steady save ~20 KB.
// Nothing is queried per-column, so JSON payloads keep the save/load code
// trivially in sync with the in-memory structs, and rows written per save stay
// O(1)+O(dirty): the original wipe-and-reinsert wrote one row per entity every
// 20s and exhausted the Cloudflare free-plan SQLite rows-written cap ~80 min
// into a session.
//
// Forward/backward compatible without a SCHEMA_VERSION bump: a legacy fat
// `snapshot` row (inline structures/felled/planted keys) hydrates fully and
// migrates to the split rows on its first save (loadWorld marks everything
// dirty); a ROLLBACK binary reads only the `snapshot` row (drops structures/
// trees — the sanctioned doc-06 posture, not a wipe) and its next save
// wholesale-deletes world_state, clearing the split rows it can't read. A
// pre-single-row database (per-entity rows, no snapshot) reads as "no
// snapshot" -> a fresh dynamic world, stale rows cleared on that load.
//
// Versioning: meta rows `schema_version` and `world_seed`. When either
// mismatches the current constants, characters + world state are cleared
// (positions/inventories from an old world layout would be nonsense) but the
// leaderboard survives — finished lives stay comparable across wipes.

import {
  CRATE_SLOTS,
  LEADERBOARD_MAX,
  VEHICLE_FUEL_MAX,
  VEHICLE_HP_MAX,
  VEHICLE_SEATS,
  WORLDGEN_VERSION,
} from "@worldspring/shared/constants";
import type { WipeSchedule } from "@worldspring/shared/config";
import { encodeExplored } from "@worldspring/shared/fog";
import type { ItemStack } from "@worldspring/shared/items";
import type {
  DeathRecap,
  LeaderboardEntry,
  PlayerCore,
  Vitals,
  WornState,
} from "@worldspring/shared/protocol";
import type { PieceKind, StructurePiece } from "@worldspring/shared/structures";
import type { PersistedBody } from "./physics/PhysicsSystem";

/** doc 06 — valid persisted piece kinds. A literal mirror of structures.ts
 * `PieceKind` (the full 7-kind union), duplicated because this module must
 * stay value-import-free of non-leaf shared modules for the node strip-types
 * persistence tests (the recoverableFingerprint string-only precedent).
 * structures.mjs asserts it matches PIECE_DEFS' keys. */
const PIECE_KINDS: ReadonlySet<string> = new Set([
  "foundation",
  "wall",
  "doorway",
  "window",
  "door",
  "gate",
  "crate",
]);
import type {
  Airdrop,
  Campfire,
  Corpse,
  GameState,
  LootEntity,
  LootRespawnTimer,
  PlayerStats,
  ServerPlayer,
  StructureMeta,
  VehicleMeta,
} from "./systems/state";
import { toPlantedRecord, treeStageAt } from "@worldspring/shared/trees";
import type { PlantedTreeRecord, TreeGrowthStage, TreeSpecies } from "@worldspring/shared/trees";

/** doc 13 M4 — a fresh/restored vehicle meta: persisted fuel/hp/wrecked from the
 * caller; seats empty + input idle (transient, never seated across a restart). */
function newVehicleMeta(id: number, fuel: number, hp: number, wrecked: boolean): VehicleMeta {
  return {
    id,
    fuel,
    hp,
    wrecked,
    seats: new Array(VEHICLE_SEATS).fill(null),
    input: { throttle: 0, steer: 0, brake: 0 },
    lastInputAt: 0,
    lastForward: 0,
    ramCooldown: 0,
  };
}

/** Bump when the persisted shape changes incompatibly (wipes world+characters). */
export // v2: military compound changed worldgen — persisted world/character
// positions from v1 are invalid (leaderboard survives the wipe). The later
// single-row world snapshot did NOT bump this: it is forward-compatible (see
// the snapshot note above) and preserves characters instead of wiping them.
const SCHEMA_VERSION = 2;

/** The serializable core of a character, stored as `characters.state_json`. */
export interface CharacterState {
  core: PlayerCore;
  vitals: Vitals;
  inventory: (ItemStack | null)[];
  selectedSlot: number;
  stats: PlayerStats;
  /** Game-time seconds when this snapshot was written. On restore, the gap
   * between savedAt and the current clock is offline time — stats.bornAt is
   * shifted forward by it so survivedS never credits time spent logged out. */
  savedAt: number;
  /** doc 12 — base64 fog-of-war explored bitset. ADDITIVE/optional: pre-feature
   * rows lack it and load as all-unexplored, so SCHEMA_VERSION stays 2. */
  explored?: string;
  /** doc 05 M6 — worn equipment (body jacket / back backpack). ADDITIVE/
   * optional: pre-feature rows lack it and restore as nothing-worn, so
   * SCHEMA_VERSION stays 2. Saved atomically with `inventory` in this one
   * JSON, so a 12-length pack-extended array always arrives with its
   * worn.back. */
  worn?: WornState;
}

/** A characters-table row, decoded. */
export interface SavedCharacter {
  id: string;
  name: string;
  alive: boolean;
  state: CharacterState;
  pendingRecap: DeathRecap | null;
}

// --- meta helpers ---

function getMeta(sql: SqlStorage, key: string): string | null {
  const rows = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
    .toArray();
  return rows.length > 0 ? rows[0].value : null;
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
}

// --- Schema ---

/** Boot-time inputs to the fail-closed wipe decision (doc 04 M2). Assembled in
 * the GameRoom constructor from the resolved config + a PITR bookmark. */
export interface SchemaBootContext {
  /** worldFingerprintOf(config.world) — the running config's WIPE-class identity
   * (seed/size/water), compared by exact string equality against the persisted
   * fingerprint. */
  fingerprint: string;
  /** config.world.seed — lets the pre-M2 migration match the legacy world_seed
   * row without this module having to parse the fingerprint string. */
  seed: number;
  /** config.session.wipeSchedule — drives the scheduled-wipe epoch counter. */
  wipeSchedule: WipeSchedule;
  /** wipeEpochOf(wipeSchedule, Date.now()) — the current scheduled-wipe period. */
  wipeEpoch: number;
  /** JSON.stringify(config) — stored as meta.config_json for admin/debug. */
  configJson: string;
  /** No GAME_CONFIG var was set (config is DEFAULT_CONFIG). A fingerprint
   * mismatch under this flag is treated as an accident (dropped var), not intent. */
  varAbsent: boolean;
  /** A world.* field came from a fallback/coercion (unparseable JSON, unknown
   * preset, bad value). Same fail-closed treatment as varAbsent. */
  worldTainted: boolean;
  /** PITR bookmark captured BEFORE any wipe (or "unavailable" in local dev),
   * stored as meta.pre_wipe_bookmark so a mistaken wipe is recoverable. */
  bookmark: string;
}

function createTables(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec(
    `CREATE TABLE IF NOT EXISTS characters (
      token_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      alive INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      pending_recap_json TEXT,
      updated_at INTEGER NOT NULL
    )`,
  );
  sql.exec("CREATE TABLE IF NOT EXISTS world_state (kind TEXT NOT NULL, payload TEXT NOT NULL)");
  sql.exec(
    `CREATE TABLE IF NOT EXISTS leaderboard (
      name TEXT NOT NULL,
      survived_s REAL NOT NULL,
      kills INTEGER NOT NULL,
      zombie_kills INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      died_to TEXT NOT NULL,
      ended_at INTEGER NOT NULL
    )`,
  );
}

/**
 * Create tables and run the fail-closed world-wipe decision (doc 04 M2).
 * Returns the world fingerprint the DO must actually generate: normally
 * boot.fingerprint, but the fail-closed refusal returns the PERSISTED fingerprint
 * so the server keeps generating the world its characters live in (GameRoom
 * parses it back into config.world). Run once in the DO constructor under
 * blockConcurrencyWhile. NEVER throws — a throwing constructor crash-loops the
 * object. The leaderboard survives every wipe.
 *
 * Works in fingerprint STRINGS (the comparison is exact string equality) so this
 * module keeps no runtime dependency on the config package — that keeps the
 * node-based persistence tests resolvable. The canonical string format lives in
 * @worldspring/shared/config `worldFingerprintOf` (pinned by config.test.ts).
 */
export function initSchema(sql: SqlStorage, boot: SchemaBootContext): string {
  createTables(sql);

  // 1. Schema bump or fresh DB → unconditional wipe. Old-shape rows may not parse
  //    under new code, and a bump is always a deliberate code change, so this
  //    must NEVER be reachable by the fail-closed refusal below.
  if (getMeta(sql, "schema_version") !== String(SCHEMA_VERSION)) {
    wipeWorld(sql, boot);
    return boot.fingerprint;
  }

  const storedRaw = getMeta(sql, "world_fingerprint");
  // doc 07 M1: an explicit `|gen:1` suffix is the SAME world as the 4-part
  // legacy form (the gen component counts formula changes; absent == 1 on
  // every parse path). Canonical = suffix OMITTED while gen is 1 — the 4-part
  // form is the only one every deployed binary (including rollback targets)
  // can read, so normalization strips a redundant `gen:1` rather than
  // appending it. Normalize BEFORE any comparison — treating the redundant
  // component as a mismatch would route a routine deploy into case 5's
  // sanctioned wipe. On a match the stored string is rewritten in place below
  // (adopt, never wipe — the world_seed-adopt precedent).
  const stored = normalizeStoredFingerprint(storedRaw);
  // What a pre-fingerprint database's world_seed row says the persisted world
  // is (default shape, gen 1) — null when absent/garbage or a fingerprint row
  // already exists (the row supersedes the seed).
  const legacy = stored === null ? legacyFingerprint(sql) : null;

  // 2. Pre-M2 database (schema 2 from the single-row persist fix, no fingerprint
  //    row yet). Adopt WITHOUT wiping so the live deployed world survives this
  //    code landing — but ONLY when the boot fingerprint is exactly the world
  //    that database was running: default shape at the stored seed, gen 1 (the
  //    doc 07 §1 binding adopt rule: seed matches AND "the rest of the
  //    fingerprint is default"). A bare seed match is NOT sufficient now that
  //    tiers are honored (doc 07 M2): a clean large/huge boot against a legacy
  //    standard-world DB must fall through to the fail-closed table below, not
  //    silently rehydrate 800m-world characters into different geometry. The
  //    strict equality also fails once WORLDGEN_VERSION >= 2 (boot carries
  //    `gen:N`, legacy pins gen 1), closing the same hole for gen bumps.
  if (stored === null && legacy !== null && legacy === boot.fingerprint) {
    setMeta(sql, "world_fingerprint", boot.fingerprint);
    setMeta(sql, "config_json", boot.configJson);
    reconcileWipeSchedule(sql, boot);
    return boot.fingerprint;
  }

  // 3. Fingerprint matches → benign boot (only LIVE fields, which are not in the
  //    fingerprint, can have changed). Refresh config_json (and canonicalize the
  //    stored fingerprint when the match came via gen-normalization — the
  //    rewrite DROPS a redundant `gen:1`, so it only ever moves the row toward
  //    the form rollback binaries can read), run the scheduled-wipe epoch
  //    check; no world wipe.
  if (stored !== null && stored === boot.fingerprint) {
    if (stored !== storedRaw) setMeta(sql, "world_fingerprint", stored);
    setMeta(sql, "config_json", boot.configJson);
    reconcileWipeSchedule(sql, boot);
    return boot.fingerprint;
  }

  // 4. Fingerprint MISMATCH. The persisted fingerprint is the world the
  //    characters live in. Fail closed: if the config justifying the change is
  //    untrustworthy (no var set, or a world field fell back/coerced), REFUSE to
  //    wipe and boot the persisted world — a dropped or typo'd GAME_CONFIG must
  //    never nuke a live world. Only an explicit, clean change (case 5) wipes.
  const persistedFp = recoverableFingerprint(stored ?? legacy);

  if (boot.varAbsent || boot.worldTainted) {
    if (persistedFp !== null) {
      console.error(
        `[persist] world fingerprint mismatch (persisted ${persistedFp} != config ${boot.fingerprint})` +
          ` with ${boot.varAbsent ? "no GAME_CONFIG var" : "a tainted world config"}; REFUSING to wipe,` +
          ` booting the persisted world.`,
      );
      setMeta(sql, "world_fingerprint", persistedFp);
      setMeta(sql, "config_json", boot.configJson);
      reconcileWipeSchedule(sql, boot);
      return persistedFp;
    }
    // The persisted world is unknowable (the stored fingerprint is absent or
    // malformed). Preserving the characters would rehydrate them into the wrong
    // generated world — the exact desync this path exists to prevent — so treat
    // it as unrecoverable and start fresh.
    console.error(
      `[persist] world fingerprint mismatch but the persisted fingerprint (${stored ?? "absent"}) is` +
        ` unreadable; wiping to a fresh world rather than rehydrate into the wrong one.`,
    );
    wipeWorld(sql, boot);
    return boot.fingerprint;
  }

  // 5. Explicit, clean, non-tainted config deliberately changed a WIPE-class
  //    field → sanctioned wipe. The operator asked for a new world.
  console.warn(
    `[persist] sanctioned world change (${persistedFp ?? "fresh"} -> ${boot.fingerprint});` +
      ` clearing characters + world_state, keeping the leaderboard.`,
  );
  wipeWorld(sql, boot);
  return boot.fingerprint;
}

/** The 4-part fingerprint shape (canonical while WORLDGEN_VERSION === 1: the
 * gen suffix is omitted when it would say `gen:1` — absent == 1 on every parse
 * path, and the 4-part form is the only one pre-doc-07 rollback binaries can
 * read). Kept string-only so persistence needs no runtime config dependency. */
const LEGACY_FP_RE = /^v1\|seed:-?\d+\|size:(standard|large|huge)\|water:[01]$/;
/** The explicit 5-part shape (`gen:N`), gen component captured. Written only
 * once WORLDGEN_VERSION >= 2 (doc 07 M5+); accepted from storage at any time. */
const GEN_FP_RE = /^v1\|seed:-?\d+\|size:(standard|large|huge)\|water:[01]\|gen:(\d+)$/;

/** Normalize a stored fingerprint for comparison: a well-formed 5-part string
 * whose gen component is the implicit default (`gen:1`) drops the redundant
 * suffix — canonicalizing toward the form every deployed binary can read (a
 * rollback-safety invariant; see config `worldFingerprintOf`). Anything else
 * passes through untouched (a `gen:>=2` string is already canonical; garbage
 * stays garbage for the downstream recoverability check). */
function normalizeStoredFingerprint(fp: string | null): string | null {
  if (fp === null) return null;
  const m = GEN_FP_RE.exec(fp);
  return m !== null && Number(m[2]) === 1 ? fp.replace(/\|gen:\d+$/, "") : fp;
}

/** The fingerprint a pre-fingerprint database was running: the legacy
 * world_seed at the default shape, gen 1 implicit (everything generated before
 * the gen component existed is by definition formula version 1). The format
 * mirrors config `worldFingerprintOf` (both pinned by config.test.ts); used as
 * the "persisted world" when no fingerprint row exists yet. */
function legacyFingerprint(sql: SqlStorage): string | null {
  const raw = getMeta(sql, "world_seed");
  if (raw === null || !Number.isFinite(Number(raw))) return null;
  return `v1|seed:${Number(raw)}|size:standard|water:0`;
}

/** A stored fingerprint is usable on the refusal path only if it round-trips the
 * canonical v1 format AND its worldgen version matches the running binary's —
 * this code literally cannot regenerate a world from another formula version,
 * so booting "from the stored string" across a gen difference would rehydrate
 * characters into divergent geometry (the exact desync the refusal path exists
 * to prevent). A 4-part string carries the implicit gen 1; an explicit `gen:N`
 * must equal the running WORLDGEN_VERSION. A malformed value would make
 * GameRoom's parseWorldFingerprint return null with the same effect — rejected
 * too. These regexes MUST match @worldspring/shared/config
 * `parseWorldFingerprint` (string-only here so the node-based persistence
 * tests stay resolvable; covered by persist-wipe.mjs). */
function recoverableFingerprint(fp: string | null): string | null {
  if (fp === null) return null;
  if (LEGACY_FP_RE.test(fp)) return (WORLDGEN_VERSION as number) === 1 ? fp : null;
  const m = GEN_FP_RE.exec(fp);
  if (!m) return null;
  return Number(m[2]) === WORLDGEN_VERSION ? fp : null;
}

/** Clear characters + world_state (NEVER the leaderboard), capturing the PITR
 * bookmark first, then rewrite the meta rows enumerated in full. Used by schema
 * bumps and sanctioned world changes. */
function wipeWorld(sql: SqlStorage, boot: SchemaBootContext): void {
  sql.exec("DELETE FROM characters");
  sql.exec("DELETE FROM world_state");
  sql.exec("DELETE FROM meta");
  setMeta(sql, "schema_version", String(SCHEMA_VERSION));
  setMeta(sql, "world_fingerprint", boot.fingerprint);
  setMeta(sql, "config_json", boot.configJson);
  setMeta(sql, "wipe_schedule", boot.wipeSchedule);
  setMeta(sql, "wipe_epoch", String(boot.wipeEpoch));
  setMeta(sql, "pre_wipe_bookmark", boot.bookmark);
}

/** Maintain the wipe-schedule meta pair and fire a scheduled wipe once per
 * crossed epoch (a first write or a schedule change re-anchors without wiping).
 * Returns true if a scheduled wipe fired. */
function reconcileWipeSchedule(sql: SqlStorage, boot: SchemaBootContext): boolean {
  const schedule = getMeta(sql, "wipe_schedule");
  const epoch = getMeta(sql, "wipe_epoch");
  if (schedule === null || epoch === null || schedule !== boot.wipeSchedule) {
    setMeta(sql, "wipe_schedule", boot.wipeSchedule);
    setMeta(sql, "wipe_epoch", String(boot.wipeEpoch));
    return false;
  }
  if (boot.wipeSchedule !== "never" && boot.wipeEpoch > Number(epoch)) {
    console.warn(
      `[persist] scheduled ${boot.wipeSchedule} wipe (epoch ${epoch} -> ${boot.wipeEpoch});` +
        ` clearing characters + world_state.`,
    );
    sql.exec("DELETE FROM characters");
    sql.exec("DELETE FROM world_state");
    setMeta(sql, "wipe_epoch", String(boot.wipeEpoch));
    setMeta(sql, "pre_wipe_bookmark", boot.bookmark);
    return true;
  }
  return false;
}

/** Capture the PITR bookmark before a potential wipe, or "unavailable" when PITR
 * is unsupported (local dev) or errors — a wipe must never be blocked, and the
 * DO constructor must never crash, on bookmark capture. */
export async function captureBookmark(storage: {
  getCurrentBookmark(): Promise<string>;
}): Promise<string> {
  try {
    return await storage.getCurrentBookmark();
  } catch {
    return "unavailable";
  }
}

// --- World snapshot ---

/**
 * The per-save dynamic world — the `snapshot` row. Everything here genuinely
 * changes between saves (loot/corpses/timers/physics/scheduling), so the row
 * is rewritten on every save. The mostly-STATIC subsystems moved to their own
 * dirty-skipped rows (doc 06 M8 follow-up — the 158 ms in-tick save at the
 * 3000-piece cap was ~97% re-serialized unchanged structures):
 *   - `trees`            felled indices + planted records (TreesRow);
 *   - `structures:<b>`   spatial bucket b of the player structures.
 * Old snapshots may still carry the three keys INLINE (LegacyWorldSnapshot);
 * loadWorld migrates them by marking everything dirty so the first save
 * materializes the split rows atomically. A ROLLBACK binary reads only this
 * row, normalizes the absent keys to [] (drops structures/trees — the
 * sanctioned doc-06 posture), and its next save wholesale-deletes world_state,
 * cleanly removing the split rows. SCHEMA_VERSION stays 2.
 */
interface WorldSnapshot {
  loot: LootEntity[];
  corpses: Corpse[];
  fires: Campfire[];
  lootRespawns: LootRespawnTimer[];
  drops: Airdrop[];
  time: number;
  tick: number;
  nextEntityId: number;
  weather: number;
  weatherNextAt: number;
  weatherRaining: boolean;
  airdropNextAt: number;
  /** doc 13 — dynamic physics bodies (poses + velocities + sleep). ADDITIVE:
   * older snapshots lack it (normalized to []), older code ignores it — no
   * SCHEMA_VERSION bump (same posture as weather/airdrop fields above). */
  bodies: PersistedBody[];
  /** doc 13 M4 — vehicle GAMEPLAY meta (fuel/hp/wrecked); the hull POSE rides
   * the `bodies` array like any body. Seats are NOT persisted (players aren't
   * seated across a restart — doc 13 §5). ADDITIVE (the bodies posture):
   * older snapshots normalize to [], older code ignores the key — no
   * SCHEMA_VERSION bump, old saves load clean (no vehicles). */
  vehicles: PersistedVehicle[];
}

/** A legacy fat snapshot's READ shape: the split-row subsystems inline. Never
 * written anymore; asWorldSnapshot normalizes absent keys to [] so both a
 * legacy row (keys present) and a current row (keys absent) parse to this. */
interface LegacyWorldSnapshot extends WorldSnapshot {
  /** doc 13 M2 — felled tree indices (into the seed-derived world.trees). */
  felled: number[];
  /** Stable planted entities; stage is re-derived from plantedAtMs on load. */
  planted: PlantedTreeRecord[];
  /** doc 06 — player structures (shared piece + server ownership meta). */
  structures: PersistedStructure[];
}

/** The `trees` row payload: felled indices + planted records, written only
 * when game.treesDirty (tree events are rare vs the 20 s save cadence). */
interface TreesRow {
  felled: number[];
  planted: PlantedTreeRecord[];
}

// --- Structure buckets -------------------------------------------------------
// Structures are persisted as up to STRUCTURE_BUCKET_COUNT `structures:<b>`
// rows keyed by a FIXED spatial hash of the piece's build cell: 8×8 regions of
// 16×16 cells (48 m at BUILD_CELL 3 m), so one base spans a handful of buckets
// and a door toggle / raid hit rewrites ~8.5 KB instead of the whole ~545 KB
// piece set. STABILITY CONTRACT: persisted bucket keys must keep meaning the
// same region across deploys — changing the shift/count requires rewriting
// every bucket on first save (the markAllStructureBucketsDirty migration).

export const STRUCTURE_BUCKET_COUNT = 64;
const STRUCTURES_KIND_PREFIX = "structures:";

/** The persistence bucket of build cell (gx, gz). `>>` keeps negative cells
 * deterministic (arithmetic shift), `& 7` folds the world into the 8×8 tile. */
export function structureBucketOf(gx: number, gz: number): number {
  return ((gx >> 4) & 7) | (((gz >> 4) & 7) << 3);
}

/** Mark every structure bucket dirty — the legacy-snapshot migration and the
 * only sanctioned way to force a full structure rewrite. `?.`-style guard:
 * untyped harness fixtures predating the dirty tracking simply skip it. */
function markAllStructureBucketsDirty(game: GameState): void {
  const dirty: Set<number> | undefined = game.dirtyStructureBuckets;
  if (!dirty) return;
  for (let b = 0; b < STRUCTURE_BUCKET_COUNT; b++) dirty.add(b);
}

/** Per-phase saveWorld instrumentation, surfaced additively on /api/health via
 * GameRoom.persistAll (the doc 06 M8 measurement loop). Bytes are JSON string
 * lengths (ASCII-dominated payloads — close enough to bytes for budgeting). */
export interface SaveWorldStats {
  snapshotMs: number;
  treesMs: number;
  structuresMs: number;
  /** Buckets rewritten this save (0 on a steady save with idle bases). */
  dirtyBuckets: number;
  snapshotBytes: number;
  treesBytes: number;
  structuresBytes: number;
}

/** doc 13 M4 — a persisted vehicle's gameplay state, keyed to its `bodies` row
 * by `id`. Pose/velocity are the physics body's job; this is the survival state
 * (fuel/hp/wrecked) that must ride a DO restart. */
export interface PersistedVehicle {
  id: number;
  fuel: number;
  hp: number;
  wrecked: boolean;
}

/** A persisted piece: the wire/shared record + server-only meta. The doc 06
 * M5/M6 fields (code/authorized/contents) are ADDITIVE-optional: pre-lock
 * snapshots lack them and normalize to unlocked/empty on load — no
 * SCHEMA_VERSION bump; old saves load clean. */
export interface PersistedStructure extends StructurePiece {
  ownerHash: string;
  placedAtMs: number;
  /** Door/gate 4-digit code; null/absent = unlocked. */
  code?: string | null;
  /** tokenHashes granted via tryCode (cap 16). */
  authorized?: string[];
  /** Crates only: fixed CRATE_SLOTS-length slot array. */
  contents?: (ItemStack | null)[] | null;
}

/**
 * Persist the dynamic world inside transactionSync (nested inside
 * persistAll's — the whole save stays ONE transaction):
 *   - `snapshot` row: loot/corpses/fires/timers/drops/bodies/vehicles + game
 *     time/tick/ids/scheduling — rewritten EVERY save (it all drifts per tick);
 *   - `trees` row: only when game.treesDirty;
 *   - `structures:<b>` rows: only the buckets in game.dirtyStructureBuckets
 *     (one O(pieces) partition scan; a dirty bucket with zero pieces just
 *     deletes its row).
 * Skipping a clean row is sound because the on-disk row is byte-equivalent to
 * its in-memory serialization — every mutation marks dirty (systems/
 * structures.ts touchPiece, systems/trees.ts treesDirty) and every prior
 * write was atomic. The CALLER clears the dirty sets after its enclosing
 * transaction commits (GameRoom.persistAll) — never here, where a later
 * rollback of the outer transaction would strand cleared flags.
 * Zombies + deer are intentionally NOT persisted (respawned fresh on boot).
 * Airdrop crates ARE kept: their timestamps are game-time, which is in the
 * snapshot, so landsAt/expiresAt stay coherent across a restart.
 */
/** doc 06 — compose a persisted piece from the shared record (collision
 * truth) + the server-only meta (ownership). A piece whose meta somehow
 * vanished persists with an empty owner rather than being dropped. */
function serializePiece(piece: StructurePiece, meta: StructureMeta | undefined): PersistedStructure {
  return {
    ...piece,
    ownerHash: meta?.ownerHash ?? "",
    placedAtMs: meta?.placedAtMs ?? 0,
    // doc 06 M5/M6 — locks + crate contents ride the same transaction so items
    // moving between a player and a crate snapshot atomically with the
    // character rows (the persistAll no-dupe invariant). Omit-when-empty
    // keeps pre-lock pieces byte-identical.
    ...(meta?.code != null ? { code: meta.code } : {}),
    ...(meta?.authorized && meta.authorized.length > 0 ? { authorized: meta.authorized } : {}),
    ...(meta?.contents ? { contents: meta.contents } : {}),
  };
}

/** doc 13 M4 — persist each vehicle's gameplay state. The `?.` tolerates the
 * untyped .mjs harness fixtures that predate vehicleMeta (the serializePiece
 * precedent); production GameStates always carry the map. */
function serializeVehicles(game: GameState): PersistedVehicle[] {
  const out: PersistedVehicle[] = [];
  const metas = game.vehicleMeta;
  if (!metas) return out;
  for (const meta of metas.values()) {
    out.push({ id: meta.id, fuel: meta.fuel, hp: meta.hp, wrecked: meta.wrecked });
  }
  return out;
}

export function saveWorld(
  storage: DurableObjectStorage,
  sql: SqlStorage,
  game: GameState,
): SaveWorldStats {
  const t0 = performance.now();
  const snapshot: WorldSnapshot = {
    loot: [...game.loot.values()],
    corpses: [...game.corpses.values()],
    fires: game.fires,
    lootRespawns: game.lootRespawns,
    drops: [...game.drops.values()],
    time: game.time,
    tick: game.tick,
    nextEntityId: game.nextEntityId,
    weather: game.weather,
    weatherNextAt: game.weatherNextAt,
    weatherRaining: game.weatherRaining,
    airdropNextAt: game.airdropNextAt,
    bodies: game.physics.serialize(),
    vehicles: serializeVehicles(game),
  };
  const snapshotJson = JSON.stringify(snapshot);
  const stats: SaveWorldStats = {
    snapshotMs: 0,
    treesMs: 0,
    structuresMs: 0,
    dirtyBuckets: 0,
    snapshotBytes: snapshotJson.length,
    treesBytes: 0,
    structuresBytes: 0,
  };
  storage.transactionSync(() => {
    // Per-kind delete + insert: O(1)+O(dirty) rows written per save. The old
    // wholesale `DELETE FROM world_state` here would nuke the clean split rows
    // this save deliberately skips — the wipe paths (wipeWorld/scheduled wipe)
    // keep the wholesale delete, which covers every kind including these.
    sql.exec("DELETE FROM world_state WHERE kind = ?", "snapshot");
    sql.exec("INSERT INTO world_state (kind, payload) VALUES (?, ?)", "snapshot", snapshotJson);
    stats.snapshotMs = performance.now() - t0;

    // Trees: felled indices + planted records, rewritten only on a tree event
    // (fell/plant/growth). Defensive optional-chain like serializePiece: some
    // probes save a worldless minimal game.
    if (game.treesDirty) {
      const t1 = performance.now();
      sql.exec("DELETE FROM world_state WHERE kind = ?", "trees");
      const trees: TreesRow = {
        felled: [...game.felledTrees],
        planted: [...(game.world?.plantedTrees?.trees.values() ?? [])].map(toPlantedRecord),
      };
      if (trees.felled.length > 0 || trees.planted.length > 0) {
        const treesJson = JSON.stringify(trees);
        stats.treesBytes = treesJson.length;
        sql.exec("INSERT INTO world_state (kind, payload) VALUES (?, ?)", "trees", treesJson);
      }
      stats.treesMs = performance.now() - t1;
    }

    // Structures: rewrite ONLY the dirty buckets. One O(pieces) partition scan
    // (~0.1 ms at the 3000-piece cap) gathers each dirty bucket's pieces; a
    // dirty bucket that ended up empty just loses its row.
    const dirty: Set<number> | undefined = game.dirtyStructureBuckets;
    if (dirty && dirty.size > 0) {
      const t2 = performance.now();
      stats.dirtyBuckets = dirty.size;
      const byBucket = new Map<number, PersistedStructure[]>();
      const pieces = game.world?.structures?.pieces;
      if (pieces) {
        for (const piece of pieces.values()) {
          const b = structureBucketOf(piece.gx, piece.gz);
          if (!dirty.has(b)) continue;
          let arr = byBucket.get(b);
          if (!arr) byBucket.set(b, (arr = []));
          arr.push(serializePiece(piece, game.structureMeta?.get(piece.id)));
        }
      }
      for (const b of dirty) {
        sql.exec("DELETE FROM world_state WHERE kind = ?", STRUCTURES_KIND_PREFIX + b);
        const arr = byBucket.get(b);
        if (arr !== undefined && arr.length > 0) {
          const json = JSON.stringify(arr);
          stats.structuresBytes += json.length;
          sql.exec(
            "INSERT INTO world_state (kind, payload) VALUES (?, ?)",
            STRUCTURES_KIND_PREFIX + b,
            json,
          );
        }
      }
      stats.structuresMs = performance.now() - t2;
    }
  });
  return stats;
}

/**
 * Hydrate a persisted world snapshot into a fresh GameState: loot, corpses,
 * fires, loot-respawn timers, game time/tick. The entity id counter resumes
 * above both the persisted counter and the max persisted entity id. Returns
 * false when no snapshot exists (caller stocks a fresh world instead).
 */
/** Delete character rows untouched for 30 days (orphaned tokens). */
export function pruneStaleCharacters(sql: SqlStorage): void {
  sql.exec(
    "DELETE FROM characters WHERE updated_at < ?",
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  );
}

/** A snapshot entity is only hydratable if it carries a finite numeric id. */
function hasNumericId(v: unknown): v is { id: number } {
  return typeof v === "object" && v !== null && Number.isFinite((v as { id?: unknown }).id);
}

/**
 * Normalize a persisted crate contents array to the fixed CRATE_SLOTS shape
 * (doc 06 M6): always full length (slot indices are stable identifiers), each
 * slot either a shape-valid stack or null. Garbage slots degrade to null
 * rather than rejecting the crate — the same per-entry posture as the piece
 * loop. Pre-crate snapshots (absent field) come out empty.
 */
function normalizeContents(raw: unknown): (ItemStack | null)[] {
  const src = Array.isArray(raw) ? raw : [];
  const out: (ItemStack | null)[] = [];
  for (let i = 0; i < CRATE_SLOTS; i++) {
    const v = src[i] as Partial<ItemStack> | null | undefined;
    if (
      v &&
      typeof v === "object" &&
      typeof v.type === "string" &&
      Number.isFinite(v.count) &&
      (v.count as number) > 0
    ) {
      out.push({
        type: v.type as ItemStack["type"],
        count: Math.floor(v.count as number),
        ...(Number.isFinite(v.mag) ? { mag: v.mag as number } : {}),
      });
    } else {
      out.push(null);
    }
  }
  return out;
}

/**
 * Structurally validate a parsed snapshot before any hydration. Valid JSON is
 * not enough: a non-object payload, or a collection that deserialized to a
 * non-array, would throw mid-hydration — leaving `game` half-populated AND
 * skipping the fresh-world fallback. Missing collections are normalized to []
 * (forward-compat with snapshots written before a field existed); a present
 * but wrong-typed collection rejects the whole snapshot (null -> caller starts
 * fresh). Scalars are left as-is; loadWorld finite-guards each as it applies it.
 */
function asWorldSnapshot(raw: unknown): LegacyWorldSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  // felled/planted/structures are normalized here for LEGACY rows only —
  // current saves never write them (they live in the split rows), so on a
  // current row all three normalize to [].
  for (const key of ["loot", "corpses", "fires", "lootRespawns", "drops", "bodies", "felled", "planted", "structures", "vehicles"] as const) {
    const v = s[key];
    if (v === undefined || v === null) s[key] = [];
    else if (!Array.isArray(v)) return null;
  }
  return s as unknown as LegacyWorldSnapshot;
}

export function loadWorld(sql: SqlStorage, game: GameState): boolean {
  const rows = sql
    .exec<{ kind: string; payload: string }>("SELECT kind, payload FROM world_state")
    .toArray();
  if (rows.length === 0) return false;

  // Route every row by kind in the one query. Unknown kinds (pre-single-row
  // per-entity legacy rows) are ignored — and cleared with everything else on
  // the fresh-world path below.
  let snapshotRaw: string | null = null;
  let treesRaw: string | null = null;
  const bucketRows: Array<{ bucket: number; payload: string }> = [];
  for (const row of rows) {
    if (row.kind === "snapshot") snapshotRaw = row.payload;
    else if (row.kind === "trees") treesRaw = row.payload;
    else if (row.kind.startsWith(STRUCTURES_KIND_PREFIX)) {
      const b = Number(row.kind.slice(STRUCTURES_KIND_PREFIX.length));
      if (Number.isInteger(b) && b >= 0 && b < STRUCTURE_BUCKET_COUNT) {
        bucketRows.push({ bucket: b, payload: row.payload });
      }
    }
  }

  // The snapshot row anchors the load (time/tick/id counter). Absent or
  // corrupt ⇒ fresh world — and the OTHER world_state rows must go with it:
  // the per-kind save no longer wholesale-deletes, so stale split rows left
  // behind would resurrect structures into a reset world on a later boot.
  const startFresh = (): false => {
    sql.exec("DELETE FROM world_state");
    return false;
  };
  if (snapshotRaw === null) {
    console.error("persistence: world_state rows without a snapshot row, starting fresh");
    return startFresh();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotRaw);
  } catch (err) {
    // A corrupt snapshot must not brick boot — start the world fresh.
    console.error("persistence: corrupt world snapshot, starting fresh", err);
    return startFresh();
  }

  // Guard the shape before touching `game`: a snapshot that is valid JSON but
  // structurally wrong must take the fresh-world path, never throw partway
  // through hydration and leave `game` half-populated.
  const snapshot = asWorldSnapshot(parsed);
  if (!snapshot) {
    console.error("persistence: malformed world snapshot, starting fresh");
    return startFresh();
  }

  // Structures: the split `structures:<b>` rows are the current format; a
  // non-empty inline `structures` key is a LEGACY row — hydrate from it and
  // mark EVERY bucket dirty so the first save materializes the split rows
  // (and the never-again-written inline key slims away) in one transaction.
  // A crash before that save leaves the intact legacy row — no window. When
  // both exist (impossible via any supported write path), the split rows win.
  let structureEntries: unknown[] = [];
  if (bucketRows.length > 0) {
    for (const { bucket, payload } of bucketRows) {
      try {
        const arr: unknown = JSON.parse(payload);
        if (!Array.isArray(arr)) throw new Error("bucket payload is not an array");
        structureEntries.push(...(arr as unknown[]));
      } catch (err) {
        // Per-row degrade (the per-entry skip posture): this bucket's pieces
        // are lost, and marking it dirty makes the next save replace the
        // corrupt row with the in-memory truth instead of keeping it forever.
        console.error(`persistence: corrupt structures bucket ${bucket}, dropping it`, err);
        game.dirtyStructureBuckets?.add(bucket);
      }
    }
  } else if (snapshot.structures.length > 0) {
    structureEntries = snapshot.structures;
    markAllStructureBucketsDirty(game);
  }

  // Trees: same split-row-wins / legacy-migrates / corrupt-degrades routing.
  let felledEntries: unknown[] = [];
  let plantedEntries: unknown[] = [];
  if (treesRaw !== null) {
    try {
      const t: unknown = JSON.parse(treesRaw);
      if (typeof t !== "object" || t === null) throw new Error("trees payload is not an object");
      const rec = t as { felled?: unknown; planted?: unknown };
      felledEntries = Array.isArray(rec.felled) ? rec.felled : [];
      plantedEntries = Array.isArray(rec.planted) ? rec.planted : [];
    } catch (err) {
      console.error("persistence: corrupt trees row, dropping it", err);
      game.treesDirty = true;
    }
  } else if (snapshot.felled.length > 0 || snapshot.planted.length > 0) {
    felledEntries = snapshot.felled;
    plantedEntries = snapshot.planted;
    game.treesDirty = true;
  }

  // Collections are guaranteed arrays by asWorldSnapshot; the per-entry id
  // guard skips an individual null/garbage entry rather than throwing on it.
  let maxId = 0;
  for (const loot of snapshot.loot) {
    if (!hasNumericId(loot)) continue;
    game.loot.set(loot.id, loot);
    maxId = Math.max(maxId, loot.id);
  }
  for (const corpse of snapshot.corpses) {
    if (!hasNumericId(corpse)) continue;
    game.corpses.set(corpse.id, corpse);
    maxId = Math.max(maxId, corpse.id);
  }
  for (const fire of snapshot.fires) {
    if (!hasNumericId(fire)) continue;
    game.fires.push(fire);
    maxId = Math.max(maxId, fire.id);
  }
  for (const timer of snapshot.lootRespawns) {
    if (timer && typeof timer === "object") game.lootRespawns.push(timer);
  }
  for (const drop of snapshot.drops) {
    if (!hasNumericId(drop)) continue;
    game.drops.set(drop.id, drop);
    maxId = Math.max(maxId, drop.id);
  }

  // doc 13 — physics bodies buffer in the PhysicsSystem until the engine
  // attaches (async on workerd); a save before attach round-trips this list.
  const bodies = snapshot.bodies.filter(hasNumericId);
  if (bodies.length > 0) {
    game.physics.restore(bodies);
    for (const b of bodies) maxId = Math.max(maxId, b.id);
  }

  // doc 13 M4 — rebuild vehicle gameplay meta from the persisted `vehicles`
  // array (seats empty, input idle — never seated across a restart). Fuel/hp are
  // clamped to their caps (a corrupt row can't over/under-fill). Any restored
  // "vehicle" body WITHOUT a matching meta (an older/corrupt save) gets a full-
  // tank default so it stays driveable rather than inert. The `?.` tolerates the
  // untyped .mjs persistence-harness fixtures (the structures precedent).
  if (game.vehicleMeta) {
    for (const v of snapshot.vehicles) {
      if (!hasNumericId(v)) continue;
      const raw = v as Partial<PersistedVehicle> & { id: number };
      const fuel = Number.isFinite(raw.fuel) ? Math.max(0, Math.min(VEHICLE_FUEL_MAX, raw.fuel as number)) : VEHICLE_FUEL_MAX;
      const hp = Number.isFinite(raw.hp) ? Math.max(0, Math.min(VEHICLE_HP_MAX, raw.hp as number)) : VEHICLE_HP_MAX;
      game.vehicleMeta.set(raw.id, newVehicleMeta(raw.id, fuel, hp, raw.wrecked === true));
      maxId = Math.max(maxId, raw.id);
    }
    for (const b of bodies) {
      if (b.kind === "vehicle" && !game.vehicleMeta.has(b.id)) {
        game.vehicleMeta.set(b.id, newVehicleMeta(b.id, VEHICLE_FUEL_MAX, VEHICLE_HP_MAX, false));
      }
    }
  }

  // doc 06 — structures: rebuild the shared index + server meta map. Per-
  // entry guards mirror hasNumericId (a single garbage entry is skipped, the
  // rest of the base survives). NO physics call here: loadWorld runs
  // synchronously in ensureGame BEFORE the async Rapier attach resolves, and
  // attachEngine builds static colliders for every piece already in the index.
  // The world/meta guards tolerate pre-structures harness fixtures (wornWire
  // precedent); production GameStates always carry both.
  for (const entry of game.world?.structures && game.structureMeta ? structureEntries : []) {
    if (!hasNumericId(entry)) continue;
    const raw = entry as Partial<PersistedStructure> & { id: number };
    if (typeof raw.kind !== "string" || !PIECE_KINDS.has(raw.kind)) continue;
    if (!Number.isInteger(raw.gx) || !Number.isInteger(raw.gz)) continue;
    if (!Number.isFinite(raw.floorY)) continue;
    // Edge-kind pieces (wall/doorway/window/door/gate) MUST carry a canonical
    // edge — restoring one without it would mint an invisible, collisionless
    // phantom (pieceAabbs returns [], no edge occupancy) that still counts
    // toward every cap and can never be aimed at to demolish. Skip the entry
    // instead (the placement invariant). Cell pieces (foundation/crate) must
    // NOT carry one — a stray edge would shift pieceCenter 1.5m; strip it.
    const isEdgeKind = raw.kind !== "foundation" && raw.kind !== "crate";
    if (isEdgeKind && raw.edge !== 0 && raw.edge !== 2) continue;
    const piece: StructurePiece = {
      id: raw.id,
      kind: raw.kind as PieceKind,
      tier: raw.tier === 1 ? 1 : 0,
      gx: raw.gx as number,
      gz: raw.gz as number,
      ...(isEdgeKind ? { edge: raw.edge as 0 | 2 } : {}),
      // A crate's free position (doc 06 M6) — both coords or neither.
      ...(raw.kind === "crate" && Number.isFinite(raw.x) && Number.isFinite(raw.z)
        ? { x: raw.x as number, z: raw.z as number }
        : {}),
      floorY: raw.floorY as number,
      hp: Number.isFinite(raw.hp) ? (raw.hp as number) : 0,
      ...(raw.kind === "door" || raw.kind === "gate" ? { open: raw.open === true } : {}),
    };
    game.world.structures.add(piece);
    game.structureMeta.set(piece.id, {
      ownerHash: typeof raw.ownerHash === "string" ? raw.ownerHash : "",
      placedAtMs: Number.isFinite(raw.placedAtMs) ? (raw.placedAtMs as number) : 0,
      // doc 06 M5/M6 — ADDITIVE fields: pre-lock snapshots lack them and
      // normalize to unlocked / no grants / (crates) an empty slot array.
      code:
        (raw.kind === "door" || raw.kind === "gate") &&
        typeof raw.code === "string" &&
        /^\d{4}$/.test(raw.code)
          ? raw.code
          : null,
      authorized: Array.isArray(raw.authorized)
        ? raw.authorized.filter((h): h is string => typeof h === "string").slice(0, 16)
        : [],
      contents: raw.kind === "crate" ? normalizeContents(raw.contents) : null,
    });
    maxId = Math.max(maxId, piece.id);
  }

  // doc 13 M2 — felled trees: rebuild the set AND tell the physics system
  // (pre-attach: fellTree just records the index, and attachEngine skips
  // building those static colliders). Per-entry guard mirrors hasNumericId.
  for (const idx of felledEntries) {
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) continue;
    game.felledTrees.add(idx);
    game.physics.fellTree(idx);
  }

  // Planted identities never enter world.trees. Wall-clock age advances while
  // the Durable Object is idle, so restore directly into the current stage.
  const nowMs = Date.now();
  for (const entry of plantedEntries) {
    if (!hasNumericId(entry)) continue;
    const raw = entry as Partial<PlantedTreeRecord> & { id: number };
    const species: TreeSpecies | null = raw.species === "conifer" || raw.species === "oak" ? raw.species : null;
    if (!species || !Number.isFinite(raw.x) || !Number.isFinite(raw.z) || !Number.isFinite(raw.groundY)) continue;
    if (!Number.isFinite(raw.plantedAtMs) || !Number.isInteger(raw.appearanceSeed)) continue;
    // Wall-clock re-stage: offline/idle time counts toward growth (treeStageAt
    // is the single source of the stage thresholds, shared with the tick scan).
    // EXCEPT stumps — terminal and event-driven; re-deriving by age would
    // resurrect a felled tree as mature across a restart.
    const stage: TreeGrowthStage =
      raw.stage === "stump" ? "stump" : treeStageAt(raw.plantedAtMs as number, nowMs);
    game.world.plantedTrees.upsert({
      id: raw.id,
      species,
      appearanceSeed: raw.appearanceSeed as number,
      x: raw.x as number,
      z: raw.z as number,
      groundY: raw.groundY as number,
      plantedAtMs: raw.plantedAtMs as number,
      stage,
    });
    maxId = Math.max(maxId, raw.id);
  }

  if (Number.isFinite(snapshot.time)) game.time = snapshot.time;
  if (Number.isFinite(snapshot.tick)) game.tick = snapshot.tick;
  game.nextEntityId = Math.max(
    Number.isFinite(snapshot.nextEntityId) ? snapshot.nextEntityId : 1,
    maxId + 1,
    1,
  );
  // Weather/airdrop scheduling — older snapshots without these fields leave the
  // defaults (0 = "initialize on first tick").
  if (Number.isFinite(snapshot.weather)) game.weather = Math.min(1, Math.max(0, snapshot.weather));
  if (Number.isFinite(snapshot.weatherNextAt)) game.weatherNextAt = snapshot.weatherNextAt;
  game.weatherRaining = snapshot.weatherRaining === true;
  if (Number.isFinite(snapshot.airdropNextAt)) game.airdropNextAt = snapshot.airdropNextAt;
  return true;
}

// --- Characters ---

/**
 * Upsert a character row keyed by token hash. Always clears any pending
 * recap: a fresh save supersedes it (markCharacterDead is the only writer of
 * pending_recap_json, and joins deliver + clear it before the post-join save).
 */
export function saveCharacter(sql: SqlStorage, player: ServerPlayer, gameTime: number): void {
  const state: CharacterState = {
    core: player.core,
    vitals: player.vitals,
    inventory: player.inventory,
    worn: player.worn,
    selectedSlot: player.selectedSlot,
    stats: player.stats,
    savedAt: gameTime,
    explored: encodeExplored(player.explored),
  };
  sql.exec(
    `INSERT INTO characters (token_hash, id, name, alive, state_json, pending_recap_json, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(token_hash) DO UPDATE SET
       id = excluded.id,
       name = excluded.name,
       alive = excluded.alive,
       state_json = excluded.state_json,
       pending_recap_json = NULL,
       updated_at = excluded.updated_at`,
    player.tokenHash,
    player.id,
    player.name,
    player.alive ? 1 : 0,
    JSON.stringify(state),
    Date.now(),
  );
}

/**
 * doc 06 M7 — wall-clock ms this token's character row was last written
 * (characters.updated_at, maintained on every save), or null when no row
 * exists (pruned after 30 days ⇒ the decay sweep treats the owner as
 * decayed). One indexed point read; called per distinct owner per sweep.
 */
export function lastSeenMs(sql: SqlStorage, tokenHash: string): number | null {
  const rows = sql
    .exec<{ updated_at: number }>(
      "SELECT updated_at FROM characters WHERE token_hash = ?",
      tokenHash,
    )
    .toArray();
  if (rows.length === 0) return null;
  return Number.isFinite(rows[0].updated_at) ? rows[0].updated_at : null;
}

/** Load a character row by token hash, or null when none exists. */
export function loadCharacter(sql: SqlStorage, tokenHash: string): SavedCharacter | null {
  const rows = sql
    .exec<{
      id: string;
      name: string;
      alive: number;
      state_json: string;
      pending_recap_json: string | null;
    }>(
      "SELECT id, name, alive, state_json, pending_recap_json FROM characters WHERE token_hash = ?",
      tokenHash,
    )
    .toArray();
  if (rows.length === 0) return null;
  const row = rows[0];
  // A corrupt row must never brick joins for this token: treat it as absent
  // (the next save overwrites it) and log loudly.
  try {
    return {
      id: row.id,
      name: row.name,
      alive: row.alive === 1,
      state: JSON.parse(row.state_json) as CharacterState,
      pendingRecap:
        row.pending_recap_json !== null ? (JSON.parse(row.pending_recap_json) as DeathRecap) : null,
    };
  } catch (err) {
    console.error("persistence: corrupt character row, treating as absent", row.id, err);
    return null;
  }
}

/**
 * Flag a character's life as over. `recapJson` is stored as the pending recap
 * when the owner was offline at death (delivered on their next join); pass
 * null when the death message reached a live socket.
 */
export function markCharacterDead(
  sql: SqlStorage,
  tokenHash: string,
  recapJson: string | null,
): void {
  sql.exec(
    "UPDATE characters SET alive = 0, pending_recap_json = ?, updated_at = ? WHERE token_hash = ?",
    recapJson,
    Date.now(),
    tokenHash,
  );
}

/** Clear a delivered offline-death recap. */
export function clearPendingRecap(sql: SqlStorage, tokenHash: string): void {
  sql.exec(
    "UPDATE characters SET pending_recap_json = NULL WHERE token_hash = ?",
    tokenHash,
  );
}

// --- Leaderboard ---

/** Record a finished life, trimming to the LEADERBOARD_MAX longest. */
export function appendLeaderboard(sql: SqlStorage, entry: LeaderboardEntry): void {
  sql.exec(
    `INSERT INTO leaderboard (name, survived_s, kills, zombie_kills, distance_m, died_to, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entry.name,
    entry.survivedS,
    entry.kills,
    entry.zombieKills,
    entry.distanceM,
    entry.by,
    entry.endedAt,
  );
  sql.exec(
    `DELETE FROM leaderboard WHERE rowid NOT IN (
       SELECT rowid FROM leaderboard ORDER BY survived_s DESC, ended_at DESC LIMIT ?
     )`,
    LEADERBOARD_MAX,
  );
}

/** The `n` longest lives, longest first. */
export function topLeaderboard(sql: SqlStorage, n: number): LeaderboardEntry[] {
  const rows = sql
    .exec<{
      name: string;
      survived_s: number;
      kills: number;
      zombie_kills: number;
      distance_m: number;
      died_to: string;
      ended_at: number;
    }>(
      `SELECT name, survived_s, kills, zombie_kills, distance_m, died_to, ended_at
       FROM leaderboard ORDER BY survived_s DESC, ended_at DESC LIMIT ?`,
      n,
    )
    .toArray();
  return rows.map((row) => ({
    name: row.name,
    survivedS: row.survived_s,
    kills: row.kills,
    zombieKills: row.zombie_kills,
    distanceM: row.distance_m,
    by: row.died_to,
    endedAt: row.ended_at,
  }));
}
