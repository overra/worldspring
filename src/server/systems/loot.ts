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
} from "@/shared/constants";
import { LOOT_TABLES, ZOMBIE_LOOT_TABLE, type ItemStack, type LootTier } from "@/shared/items";
import { distSq2D } from "@/shared/math";
import type { LootSpawn } from "@/shared/world";
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

/** Roll one stack from the zone tier's table (coastal/inland/military). */
export function rollLootStack(tier: LootTier): ItemStack {
  return rollFromTable(LOOT_TABLES[tier]);
}

function spawnLootAt(state: GameState, spawn: LootSpawn): void {
  const stack = rollLootStack(spawn.tier);
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

/** Stock every world loot spawn once at room boot. */
export function stockInitialLoot(state: GameState): void {
  for (const spawn of state.world.lootSpawns) spawnLootAt(state, spawn);
}

/** Called when a spawn-point loot entity has been fully taken. */
export function startLootRespawn(state: GameState, spawnId: number): void {
  state.lootRespawns.push({
    spawnId,
    t: LOOT_RESPAWN_MIN_S + Math.random() * (LOOT_RESPAWN_MAX_S - LOOT_RESPAWN_MIN_S),
  });
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
    spawnLootAt(state, spawn);
    state.lootRespawns.splice(i, 1);
  }
}

/**
 * Leave the dead player's body where they fell, carrying their entire
 * inventory, and clear the inventory. The body spawns even when empty —
 * other players should see the corpse either way.
 */
export function spawnPlayerCorpse(state: GameState, player: ServerPlayer): void {
  const contents: ItemStack[] = [];
  for (const stack of player.inventory) {
    if (stack) contents.push({ type: stack.type, count: stack.count });
  }
  player.inventory = Array.from({ length: INVENTORY_SLOTS }, () => null);
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
