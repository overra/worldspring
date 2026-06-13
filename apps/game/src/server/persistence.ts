// All Durable Object SQLite storage code in one module. The GameRoom DO is
// declared with new_sqlite_classes, so `ctx.storage.sql` (synchronous
// `exec(query, ...bindings)` returning a cursor) and
// `ctx.storage.transactionSync(closure)` are available.
//
// Schema choice: the entire dynamic world is persisted as ONE `world_state`
// row — kind `snapshot`, payload a single JSON object holding loot/corpses/
// fires/timers/drops plus game time/tick and scheduling. It is never queried
// per-column, so one JSON blob keeps the save/load code trivially in sync with
// the in-memory structs AND keeps rows-written per save at O(1): the prior
// wipe-and-reinsert wrote one row per entity every 20s and exhausted the
// Cloudflare free-plan SQLite rows-written cap ~80 min into a session.
//
// Forward-compatible with the old per-entity rows: loadWorld looks only for the
// `snapshot` row, so a pre-migration database reads as "no snapshot" -> a fresh
// dynamic world, and the next save clears the stale rows. So this change does
// NOT bump SCHEMA_VERSION (characters survive; only the dynamic world resets).
//
// Versioning: meta rows `schema_version` and `world_seed`. When either
// mismatches the current constants, characters + world state are cleared
// (positions/inventories from an old world layout would be nonsense) but the
// leaderboard survives — finished lives stay comparable across wipes.

import { LEADERBOARD_MAX } from "@worldspring/shared/constants";
import type { WipeSchedule } from "@worldspring/shared/config";
import type { ItemStack } from "@worldspring/shared/items";
import type { DeathRecap, LeaderboardEntry, PlayerCore, Vitals } from "@worldspring/shared/protocol";
import type {
  Airdrop,
  Campfire,
  Corpse,
  GameState,
  LootEntity,
  LootRespawnTimer,
  PlayerStats,
  ServerPlayer,
} from "./systems/state";

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

  const stored = getMeta(sql, "world_fingerprint");

  // 2. Pre-M2 database (schema 2 from the single-row persist fix, no fingerprint
  //    row yet). If the legacy world_seed matches the running seed, adopt it
  //    WITHOUT wiping so the live deployed world survives M2 landing. (Pre-M2 and
  //    current builds are both default-shape — size/water aren't wired until doc
  //    07 — so a matching seed is sufficient.)
  if (stored === null && getMeta(sql, "world_seed") === String(boot.seed)) {
    setMeta(sql, "world_fingerprint", boot.fingerprint);
    setMeta(sql, "config_json", boot.configJson);
    reconcileWipeSchedule(sql, boot);
    return boot.fingerprint;
  }

  // 3. Fingerprint matches → benign boot (only LIVE fields, which are not in the
  //    fingerprint, can have changed). Refresh config_json, run the scheduled-
  //    wipe epoch check; no world wipe.
  if (stored !== null && stored === boot.fingerprint) {
    setMeta(sql, "config_json", boot.configJson);
    reconcileWipeSchedule(sql, boot);
    return boot.fingerprint;
  }

  // 4. Fingerprint MISMATCH. The persisted fingerprint is the world the
  //    characters live in. Fail closed: if the config justifying the change is
  //    untrustworthy (no var set, or a world field fell back/coerced), REFUSE to
  //    wipe and boot the persisted world — a dropped or typo'd GAME_CONFIG must
  //    never nuke a live world. Only an explicit, clean change (case 5) wipes.
  const persistedFp = stored ?? legacyFingerprint(sql);

  if (boot.varAbsent || boot.worldTainted) {
    console.error(
      `[persist] world fingerprint mismatch (persisted ${persistedFp ?? "none"} != config ${boot.fingerprint})` +
        ` with ${boot.varAbsent ? "no GAME_CONFIG var" : "a tainted world config"}; REFUSING to wipe,` +
        ` booting the persisted world.`,
    );
    if (persistedFp !== null) {
      setMeta(sql, "world_fingerprint", persistedFp);
      setMeta(sql, "config_json", boot.configJson);
      reconcileWipeSchedule(sql, boot);
      return persistedFp;
    }
    return boot.fingerprint; // no recoverable persisted world — nothing to keep.
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

/** The fingerprint a pre-M2 database was running: the legacy world_seed at the
 * default shape. The format mirrors config `worldFingerprintOf` for a default-
 * shape world (both pinned to the same literal by config.test.ts); used as the
 * "persisted world" when no fingerprint row exists yet. */
function legacyFingerprint(sql: SqlStorage): string | null {
  const raw = getMeta(sql, "world_seed");
  if (raw === null || !Number.isFinite(Number(raw))) return null;
  return `v1|seed:${Number(raw)}|size:standard|water:0`;
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

/** The whole persisted dynamic world — stored as the single `snapshot` row. */
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
}

/**
 * Persist the dynamic world (loot, corpses, campfires, loot-respawn timers,
 * airdrop crates) plus game time/tick, the entity-id counter, and weather/
 * airdrop scheduling — as ONE `snapshot` JSON row inside transactionSync.
 * Zombies + deer are intentionally NOT persisted (respawned fresh on boot).
 * Airdrop crates ARE kept: their timestamps are game-time, which is in the
 * snapshot, so landsAt/expiresAt stay coherent across a restart.
 */
export function saveWorld(storage: DurableObjectStorage, sql: SqlStorage, game: GameState): void {
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
  };
  storage.transactionSync(() => {
    // O(1) rows written: delete the prior single snapshot row, insert the new
    // one — vs the old wipe-and-reinsert that wrote one row per entity.
    sql.exec("DELETE FROM world_state");
    sql.exec(
      "INSERT INTO world_state (kind, payload) VALUES ('snapshot', ?)",
      JSON.stringify(snapshot),
    );
  });
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
 * Structurally validate a parsed snapshot before any hydration. Valid JSON is
 * not enough: a non-object payload, or a collection that deserialized to a
 * non-array, would throw mid-hydration — leaving `game` half-populated AND
 * skipping the fresh-world fallback. Missing collections are normalized to []
 * (forward-compat with snapshots written before a field existed); a present
 * but wrong-typed collection rejects the whole snapshot (null -> caller starts
 * fresh). Scalars are left as-is; loadWorld finite-guards each as it applies it.
 */
function asWorldSnapshot(raw: unknown): WorldSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  for (const key of ["loot", "corpses", "fires", "lootRespawns", "drops"] as const) {
    const v = s[key];
    if (v === undefined || v === null) s[key] = [];
    else if (!Array.isArray(v)) return null;
  }
  return s as unknown as WorldSnapshot;
}

export function loadWorld(sql: SqlStorage, game: GameState): boolean {
  const rows = sql
    .exec<{ payload: string }>("SELECT payload FROM world_state WHERE kind = 'snapshot'")
    .toArray();
  if (rows.length === 0) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rows[0].payload);
  } catch (err) {
    // A corrupt snapshot must not brick boot — start the world fresh.
    console.error("persistence: corrupt world snapshot, starting fresh", err);
    return false;
  }

  // Guard the shape before touching `game`: a snapshot that is valid JSON but
  // structurally wrong must take the fresh-world path, never throw partway
  // through hydration and leave `game` half-populated.
  const snapshot = asWorldSnapshot(parsed);
  if (!snapshot) {
    console.error("persistence: malformed world snapshot, starting fresh");
    return false;
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
    selectedSlot: player.selectedSlot,
    stats: player.stats,
    savedAt: gameTime,
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
