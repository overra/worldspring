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

import { LEADERBOARD_MAX, WORLD_SEED } from "@worldspring/shared/constants";
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

/**
 * Create tables and enforce schema/seed versioning. On any mismatch the
 * characters and world tables are cleared (NOT the leaderboard) and fresh
 * meta rows are written. Run once in the DO constructor under
 * blockConcurrencyWhile.
 */
export function initSchema(sql: SqlStorage): void {
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
  sql.exec(
    "CREATE TABLE IF NOT EXISTS world_state (kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
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

  const version = getMeta(sql, "schema_version");
  const seed = getMeta(sql, "world_seed");
  if (version === String(SCHEMA_VERSION) && seed === String(WORLD_SEED)) return;
  // Fresh database, or a schema/seed change: old world + character state is
  // meaningless against the new world. The leaderboard is kept.
  sql.exec("DELETE FROM characters");
  sql.exec("DELETE FROM world_state");
  sql.exec("DELETE FROM meta");
  setMeta(sql, "schema_version", String(SCHEMA_VERSION));
  setMeta(sql, "world_seed", String(WORLD_SEED));
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
