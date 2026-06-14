// Loot stocking, respawn timers and corpses. Non-seeded randomness is
// fine here — loot rolls are server-only and never need to match the client.

import {
  INVENTORY_SLOTS,
  LOOT_RESPAWN_FORCE_OVERDUE_S,
  LOOT_RESPAWN_MAX_S,
  LOOT_RESPAWN_MIN_PLAYER_DIST,
  LOOT_RESPAWN_MIN_S,
  PLAYER_CORPSE_TTL_S,
  ZOMBIE_CORPSE_TTL_S,
  ZOMBIE_LOOT_CHANCE,
} from "@worldspring/shared/constants";
import { LOOT_TABLES, ZOMBIE_LOOT_TABLE, type ItemStack, type LootTier } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import type { LootSpawn } from "@worldspring/shared/world";
import type { GameState, ServerPlayer, Zombie } from "./state";

export type WeightedTable = Array<{
  type: ItemStack["type"];
  weight: number;
  min: number;
  max: number;
}>;

/** Weighted roll with a random count in [min, max]. Exported for airdrops. */
export function rollFromTable(table: WeightedTable): ItemStack {
  const total = table.reduce((sum, entry) => sum + entry.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) {
      return {
        type: entry.type,
        count: entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1)),
      };
    }
  }
  // Float edge case: fall back to the last entry.
  const last = table[table.length - 1];
  return { type: last.type, count: last.min };
}

/** Low weight — the map is a rare find, not a renewable resource. */
const MAP_LOOT_WEIGHT = 5;

/**
 * The tier table, plus (doc 12) the map item in coastal/inland ONLY when the
 * server makes the map findable (map.acquire === "loot"). On "spawn"/"none"
 * servers the map never enters the loot economy.
 */
function effectiveTable(state: GameState, tier: LootTier): WeightedTable {
  const base = LOOT_TABLES[tier];
  // `?.` tolerates the hand-rolled GameState fixtures in apps/game/scripts/*.mjs
  // (untyped, predate `map`); production configs always carry it. undefined ->
  // the comparison is false -> no map in loot, which is the right "off" default.
  if (state.config.map?.acquire === "loot" && (tier === "coastal" || tier === "inland")) {
    return [...base, { type: "map", weight: MAP_LOOT_WEIGHT, min: 1, max: 1 }];
  }
  return base;
}

/** Roll one stack from the zone tier's table (coastal/inland/military). */
export function rollLootStack(state: GameState, tier: LootTier): ItemStack {
  return rollFromTable(effectiveTable(state, tier));
}

/**
 * Resolved loot tier + effective density for a spawn under the active config.
 * Military spawns roll the inland table when the garrison is disabled
 * (threats.militaryZone=false); effective = density * tierDensity[resolved].
 */
function lootEffect(state: GameState, spawn: LootSpawn): { tier: LootTier; eff: number } {
  const tier: LootTier =
    spawn.tier === "military" && !state.config.threats.militaryZone ? "inland" : spawn.tier;
  return { tier, eff: state.config.loot.density * state.config.loot.tierDensity[tier] };
}

function spawnLootAt(state: GameState, spawn: LootSpawn): void {
  const { tier, eff } = lootEffect(state, spawn);
  const stack = rollLootStack(state, tier);
  // density > 1 fattens stacks. The < 1 case is a per-spawn STOCKING probability
  // owned by the callers — never a silent no-op here, which would orphan the
  // spawn point (neither entity nor timer; see stockInitialLoot's invariant).
  if (eff > 1) stack.count = Math.max(1, Math.round(stack.count * eff));
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: stack.type,
    count: stack.count,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    spawnId: spawn.id,
    ttl: null,
  });
}

/**
 * Stock every world loot spawn once at room boot. Binding invariant (doc 04
 * §5): every spawn point ends up holding exactly one of {a stocked entity, a
 * pending respawn timer}. Under density < 1 each point stocks with probability
 * `eff` and otherwise arms a respawn timer, so it cycles forever at that rate
 * rather than dying — a silent skip would leave neither entity nor timer.
 */
export function stockInitialLoot(state: GameState): void {
  for (const spawn of state.world.lootSpawns) {
    const { eff } = lootEffect(state, spawn);
    if (eff < 1 && Math.random() >= eff) {
      startLootRespawn(state, spawn.id);
    } else {
      spawnLootAt(state, spawn);
    }
  }
}

/** Called when a spawn-point loot entity has been fully taken. The respawn
 * interval is divided by loot.respawnRate (2 = twice as fast). */
export function startLootRespawn(state: GameState, spawnId: number): void {
  const interval = LOOT_RESPAWN_MIN_S + Math.random() * (LOOT_RESPAWN_MAX_S - LOOT_RESPAWN_MIN_S);
  state.lootRespawns.push({ spawnId, t: interval / state.config.loot.respawnRate });
}

function playerNear(state: GameState, x: number, z: number, dist: number): boolean {
  const dSq = dist * dist;
  for (const player of state.players.values()) {
    if (distSq2D(x, z, player.core.x, player.core.z) <= dSq) return true;
  }
  return false;
}

export function tickLootRespawns(state: GameState, dt: number): void {
  for (let i = state.lootRespawns.length - 1; i >= 0; i--) {
    const timer = state.lootRespawns[i];
    timer.t -= dt;
    if (timer.t > 0) continue;
    const spawn = state.world.lootSpawns.find((s) => s.id === timer.spawnId);
    if (!spawn) {
      state.lootRespawns.splice(i, 1);
      continue;
    }
    // Prefer respawning out of sight, but force it once badly overdue so a
    // lingering player can't starve a town's loot economy indefinitely.
    const overdue = timer.t <= -LOOT_RESPAWN_FORCE_OVERDUE_S;
    if (!overdue && playerNear(state, spawn.x, spawn.z, LOOT_RESPAWN_MIN_PLAYER_DIST)) {
      continue;
    }
    // density < 1 stocking gate (same as stockInitialLoot): a failed roll
    // re-arms the timer instead of spawning, so the point is never left empty
    // AND timerless — the §5 entity-XOR-timer invariant holds across cycles.
    const { eff } = lootEffect(state, spawn);
    if (eff < 1 && Math.random() >= eff) {
      state.lootRespawns.splice(i, 1);
      startLootRespawn(state, spawn.id);
      continue;
    }
    spawnLootAt(state, spawn);
    state.lootRespawns.splice(i, 1);
  }
}

/**
 * Leave the dead player's body where they fell. On a full-loot server (default)
 * the body carries the player's entire inventory and the player is emptied. On
 * a keep-inventory server (pvp.fullLoot=false) the body spawns visibly but
 * EMPTY and the inventory is left intact — respawn restores it (and the dead
 * character row persists it for a death-screen-disconnect rejoin, see
 * GameRoom.handleJoin). The body spawns either way so others see the corpse.
 */
export function spawnPlayerCorpse(state: GameState, player: ServerPlayer): void {
  const contents: ItemStack[] = [];
  if (state.config.pvp.fullLoot) {
    for (const stack of player.inventory) {
      if (stack) contents.push({ type: stack.type, count: stack.count });
    }
    player.inventory = Array.from({ length: INVENTORY_SLOTS }, () => null);
  }
  const { x, z, yaw } = player.core;
  const id = state.nextEntityId++;
  state.corpses.set(id, {
    id,
    kind: "player",
    name: player.name,
    x,
    y: state.world.groundHeight(x, z),
    z,
    yaw,
    contents,
    ttl: PLAYER_CORPSE_TTL_S,
  });
}

/** Leave a zombie's body behind, sometimes with small pickings on it. */
export function spawnZombieCorpse(state: GameState, zombie: Zombie): void {
  const contents: ItemStack[] = [];
  if (Math.random() < ZOMBIE_LOOT_CHANCE) contents.push(rollFromTable(ZOMBIE_LOOT_TABLE));
  const id = state.nextEntityId++;
  state.corpses.set(id, {
    id,
    kind: "zombie",
    name: null,
    x: zombie.x,
    y: state.world.groundHeight(zombie.x, zombie.z),
    z: zombie.z,
    yaw: zombie.yaw,
    contents,
    ttl: ZOMBIE_CORPSE_TTL_S,
  });
}

/** Age out corpses. */
export function tickCorpses(state: GameState, dt: number): void {
  for (const corpse of state.corpses.values()) {
    corpse.ttl -= dt;
    if (corpse.ttl <= 0) state.corpses.delete(corpse.id);
  }
}

/** Age out player-dropped loot (spawn-point stock never expires). */
export function tickDroppedLoot(state: GameState, dt: number): void {
  for (const entity of state.loot.values()) {
    if (entity.ttl === null) continue;
    entity.ttl -= dt;
    if (entity.ttl <= 0) state.loot.delete(entity.id);
  }
}
