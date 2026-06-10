// All Durable Object SQLite storage code in one module. The GameRoom DO is
// declared with new_sqlite_classes, so `ctx.storage.sql` (synchronous
// `exec(query, ...bindings)` returning a cursor) and
// `ctx.storage.transactionSync(closure)` are available.
//
// Schema choice: world entities live in ONE `world_state` table as
// (kind, payload-JSON) rows rather than four typed tables — the world snapshot
// is tiny (<200 rows), is always rewritten wholesale inside a transaction and
// never queried per-column, so JSON rows keep the schema and the save/load
// code trivially in sync with the in-memory structs.
//
// Versioning: meta rows `schema_version` and `world_seed`. When either
// mismatches the current constants, characters + world state are cleared
// (positions/inventories from an old world layout would be nonsense) but the
// leaderboard survives — finished lives stay comparable across wipes.

import { LEADERBOARD_MAX, WORLD_SEED } from "@/shared/constants";
import type { ItemStack } from "@/shared/items";
import type { DeathRecap, LeaderboardEntry, PlayerCore, Vitals } from "@/shared/protocol";
import type {
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
// positions from v1 are invalid (leaderboard survives the wipe).
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

/**
 * Persist the dynamic world: loot entities, corpses, campfires, loot-respawn
 * timers, plus game time/tick and the entity id counter. Volumes are tiny
 * (<200 rows), so the snapshot is a wholesale wipe + reinsert inside
 * transactionSync. Zombies are intentionally NOT persisted — the caller
 * respawns them fresh on boot.
 */
export function saveWorld(storage: DurableObjectStorage, sql: SqlStorage, game: GameState): void {
  storage.transactionSync(() => {
    sql.exec("DELETE FROM world_state");
    for (const loot of game.loot.values()) {
      sql.exec("INSERT INTO world_state (kind, payload) VALUES ('loot', ?)", JSON.stringify(loot));
    }
    for (const corpse of game.corpses.values()) {
      sql.exec(
        "INSERT INTO world_state (kind, payload) VALUES ('corpse', ?)",
        JSON.stringify(corpse),
      );
    }
    for (const fire of game.fires) {
      sql.exec("INSERT INTO world_state (kind, payload) VALUES ('fire', ?)", JSON.stringify(fire));
    }
    for (const timer of game.lootRespawns) {
      sql.exec(
        "INSERT INTO world_state (kind, payload) VALUES ('loot_timer', ?)",
        JSON.stringify(timer),
      );
    }
    setMeta(sql, "game_time", String(game.time));
    setMeta(sql, "game_tick", String(game.tick));
    setMeta(sql, "next_entity_id", String(game.nextEntityId));
    setMeta(sql, "world_saved", "1");
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

export function loadWorld(sql: SqlStorage, game: GameState): boolean {
  if (getMeta(sql, "world_saved") !== "1") return false;

  let maxId = 0;
  const rows = sql
    .exec<{ kind: string; payload: string }>("SELECT kind, payload FROM world_state")
    .toArray();
  for (const row of rows) {
    try {
    switch (row.kind) {
      case "loot": {
        const loot = JSON.parse(row.payload) as LootEntity;
        game.loot.set(loot.id, loot);
        maxId = Math.max(maxId, loot.id);
        break;
      }
      case "corpse": {
        const corpse = JSON.parse(row.payload) as Corpse;
        game.corpses.set(corpse.id, corpse);
        maxId = Math.max(maxId, corpse.id);
        break;
      }
      case "fire": {
        const fire = JSON.parse(row.payload) as Campfire;
        game.fires.push(fire);
        maxId = Math.max(maxId, fire.id);
        break;
      }
      case "loot_timer": {
        game.lootRespawns.push(JSON.parse(row.payload) as LootRespawnTimer);
        break;
      }
    }
    } catch (err) {
      // One corrupt row must never brick the whole world load — skip it.
      console.error("persistence: corrupt world row skipped", row.kind, err);
    }
  }

  const time = Number(getMeta(sql, "game_time"));
  if (Number.isFinite(time)) game.time = time;
  const tick = Number(getMeta(sql, "game_tick"));
  if (Number.isFinite(tick)) game.tick = tick;
  const nextId = Number(getMeta(sql, "next_entity_id"));
  game.nextEntityId = Math.max(Number.isFinite(nextId) ? nextId : 1, maxId + 1, 1);
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
