// Player lifecycle (join/spawn/respawn), input application and inventory
// operations (use/equip/pickup/drop).

import {
  CAMPFIRE_BURN_S,
  CAMPFIRE_PLACE_DIST,
  DROPPED_LOOT_TTL_S,
  INPUT_BUDGET_CAP_S,
  INVENTORY_SLOTS,
  MAX_CAMPFIRES,
  MAX_FOOD,
  MAX_HP,
  MAX_INPUT_DT,
  MAX_NAME_LENGTH,
  MAX_WATER,
  PICKUP_RANGE,
  TEMP_NORMAL,
} from "@/shared/constants";
import { ITEM_DEFS, type ItemStack, type ItemType } from "@/shared/items";
import { clamp, distSq2D, yawToDir } from "@/shared/math";
import { stepPlayer } from "@/shared/movement";
import type { InputCmd, PlayerCore } from "@/shared/protocol";
import { startLootRespawn } from "./loot";
import { sendTo, type GameState, type ServerPlayer } from "./state";

/** Contract gap: queue cap is specified as "~60 cmds" with no shared constant. */
const INPUT_QUEUE_CAP = 60;
/** Sanity clamp for client-supplied pitch (client clamps to ±1.45 itself). */
const PITCH_LIMIT = 1.6;

/** Trim, strip control chars, cap length, default, and de-duplicate a name. */
export function sanitizeName(raw: string, state: GameState): string {
  let base = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  if (base.length === 0) base = "Survivor";
  const taken = new Set<string>();
  for (const player of state.players.values()) taken.add(player.name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = base.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)) + suffix;
    if (!taken.has(name)) return name;
  }
}

const SPAWN_SAFE_ZOMBIE_DIST_SQ = 60 * 60;

function freshSpawnCore(state: GameState): PlayerCore {
  const spawns = state.world.spawnPoints;
  // Prefer a spawn point with no zombie nearby; fall back to pure random.
  let spawn = spawns[Math.floor(Math.random() * spawns.length)];
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = spawns[Math.floor(Math.random() * spawns.length)];
    let safe = true;
    for (const zombie of state.zombies.values()) {
      if (distSq2D(zombie.x, zombie.z, candidate.x, candidate.z) < SPAWN_SAFE_ZOMBIE_DIST_SQ) {
        safe = false;
        break;
      }
    }
    if (safe) {
      spawn = candidate;
      break;
    }
  }
  return {
    x: spawn.x,
    y: state.world.groundHeight(spawn.x, spawn.z),
    z: spawn.z,
    vy: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
  };
}

function emptyInventory(): (ItemStack | null)[] {
  return Array.from({ length: INVENTORY_SLOTS }, () => null);
}

/** Spawn a brand-new player: random beach spawn, full vitals, empty inventory. */
export function createPlayer(state: GameState, id: string, name: string): ServerPlayer {
  const player: ServerPlayer = {
    id,
    name,
    core: freshSpawnCore(state),
    vitals: { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL },
    inventory: emptyInventory(),
    selectedSlot: 0,
    alive: true,
    diedAt: -Infinity,
    cmdQueue: [],
    lastAck: 0,
    inputBudget: INPUT_BUDGET_CAP_S,
    wantsAttack: false,
    attackCooldown: 0,
    attackAnimT: 0,
    sprinting: false,
    movedThisTick: false,
    sprintedThisTick: false,
  };
  state.players.set(id, player);
  return player;
}

/** Fresh spawn for a dead player who requested respawn. */
export function respawnPlayer(state: GameState, player: ServerPlayer): void {
  player.core = freshSpawnCore(state);
  player.vitals = { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL };
  player.inventory = emptyInventory();
  player.selectedSlot = 0;
  player.alive = true;
  player.cmdQueue = [];
  player.inputBudget = INPUT_BUDGET_CAP_S;
  player.wantsAttack = false;
  player.attackCooldown = 0;
  player.attackAnimT = 0;
  player.sprinting = false;
  sendInventory(state, player);
}

/** Enqueue input cmds, dropping the oldest beyond the queue cap. */
export function queueInput(player: ServerPlayer, cmds: InputCmd[]): void {
  for (const cmd of cmds) player.cmdQueue.push(cmd);
  const over = player.cmdQueue.length - INPUT_QUEUE_CAP;
  if (over > 0) player.cmdQueue.splice(0, over);
}

/**
 * Apply each player's queued input cmds with the shared movement step. Each
 * cmd's dt is clamped to MAX_INPUT_DT and spends from the player's input
 * budget, which accrues at wall-clock rate (capped at INPUT_BUDGET_CAP_S) —
 * so sustained movement can never exceed 1x real time regardless of how much
 * input time a client claims. Unspent cmds carry to the next tick (the queue
 * cap bounds backlog). Also ticks per-player combat timers.
 */
export function applyQueuedInputs(state: GameState, dt: number): void {
  for (const player of state.players.values()) {
    if (player.attackCooldown > 0) player.attackCooldown -= dt;
    if (player.attackAnimT > 0) player.attackAnimT -= dt;
    player.movedThisTick = false;
    player.sprintedThisTick = false;
    if (!player.alive) {
      player.cmdQueue.length = 0;
      continue;
    }
    player.inputBudget = Math.min(player.inputBudget + dt, INPUT_BUDGET_CAP_S);
    let appliedAny = false;
    while (player.cmdQueue.length > 0) {
      const next = player.cmdQueue[0];
      const cmdDt = clamp(next.dt, 0, MAX_INPUT_DT);
      if (cmdDt > player.inputBudget) break; // out of wall-clock allowance
      player.cmdQueue.shift();
      player.inputBudget -= cmdDt;
      const clamped: InputCmd = {
        ...next,
        dt: cmdDt,
        pitch: clamp(next.pitch, -PITCH_LIMIT, PITCH_LIMIT),
      };
      stepPlayer(player.core, clamped, state.world);
      appliedAny = true;
      player.lastAck = next.seq;
      const moving = clamped.mx !== 0 || clamped.mz !== 0;
      if (moving) player.movedThisTick = true;
      if (moving && clamped.sprint) player.sprintedThisTick = true;
      player.sprinting = moving && clamped.sprint;
    }
    // No input this tick (idle client/tab) — don't let a stale sprint flag
    // keep draining food and water at the sprint multiplier.
    if (!appliedAny) player.sprinting = false;
  }
}

/** Send the player's current inventory + selected slot. */
export function sendInventory(state: GameState, player: ServerPlayer): void {
  sendTo(state, player.id, {
    t: "inv",
    slots: player.inventory.map((stack) => (stack ? { ...stack } : null)),
    selected: player.selectedSlot,
  });
}

/**
 * Add `count` of `type` to an inventory: top up existing stacks first, then
 * fill empty slots. Returns the leftover count that did not fit.
 */
export function addToInventory(
  inv: (ItemStack | null)[],
  type: ItemType,
  count: number,
): number {
  const maxStack = ITEM_DEFS[type].stack;
  let remaining = count;
  for (const stack of inv) {
    if (remaining <= 0) return 0;
    if (stack && stack.type === type && stack.count < maxStack) {
      const add = Math.min(maxStack - stack.count, remaining);
      stack.count += add;
      remaining -= add;
    }
  }
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    if (inv[i] !== null) continue;
    const add = Math.min(maxStack, remaining);
    inv[i] = { type, count: add };
    remaining -= add;
  }
  return remaining;
}

/** Remove one item from a slot, clearing it when it hits zero. */
export function consumeFromSlot(inv: (ItemStack | null)[], slot: number): void {
  const stack = inv[slot];
  if (!stack) return;
  stack.count -= 1;
  if (stack.count <= 0) inv[slot] = null;
}

/** Use a consumable or place a campfire kit from the given slot. */
export function useItem(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  const stack = player.inventory[slot];
  if (!stack) return;
  const def = ITEM_DEFS[stack.type];
  const vitals = player.vitals;
  switch (def.kind) {
    case "food":
      vitals.food = clamp(vitals.food + def.power, 0, MAX_FOOD);
      break;
    case "drink":
      vitals.water = clamp(vitals.water + def.power, 0, MAX_WATER);
      break;
    case "heal":
      vitals.hp = clamp(vitals.hp + def.power, 0, MAX_HP);
      break;
    case "placeable": {
      const [fx, fz] = yawToDir(player.core.yaw);
      const x = player.core.x + fx * CAMPFIRE_PLACE_DIST;
      const z = player.core.z + fz * CAMPFIRE_PLACE_DIST;
      // World-wide cap: the oldest fire goes out when the cap is hit.
      if (state.fires.length >= MAX_CAMPFIRES) state.fires.shift();
      state.fires.push({
        id: state.nextEntityId++,
        x,
        y: state.world.groundHeight(x, z),
        z,
        burnRemaining: CAMPFIRE_BURN_S,
      });
      break;
    }
    default:
      return; // weapons and ammo are not usable
  }
  consumeFromSlot(player.inventory, slot);
  sendInventory(state, player);
}

/** Select a hotbar slot. */
export function equipSlot(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  player.selectedSlot = slot;
  sendInventory(state, player);
}

/**
 * Pick up a loot entity or scavenge a corpse within PICKUP_RANGE (the two
 * share the entity id space). Plain items support partial pickup (leftover
 * stays in the world). Corpses transfer as many stacks as fit, keep the
 * remainder, and the body itself persists until its TTL even when emptied.
 */
export function pickupLoot(state: GameState, player: ServerPlayer, lootId: number): void {
  if (!player.alive) return;
  const rangeSq = PICKUP_RANGE * PICKUP_RANGE;

  const entity = state.loot.get(lootId);
  if (entity) {
    if (distSq2D(player.core.x, player.core.z, entity.x, entity.z) > rangeSq) return;
    const leftover = addToInventory(player.inventory, entity.type, entity.count);
    if (leftover === entity.count) return; // nothing fit
    entity.count = leftover;
    if (leftover === 0) {
      state.loot.delete(entity.id);
      if (entity.spawnId !== null) startLootRespawn(state, entity.spawnId);
    }
    sendInventory(state, player);
    return;
  }

  const corpse = state.corpses.get(lootId);
  if (!corpse) return;
  if (distSq2D(player.core.x, player.core.z, corpse.x, corpse.z) > rangeSq) return;
  let tookAny = false;
  const remaining: ItemStack[] = [];
  for (const stack of corpse.contents) {
    const leftover = addToInventory(player.inventory, stack.type, stack.count);
    if (leftover < stack.count) tookAny = true;
    if (leftover > 0) remaining.push({ type: stack.type, count: leftover });
  }
  corpse.contents = remaining;
  if (tookAny) sendInventory(state, player);
}

/** Drop the whole stack in a slot as a loot entity at the player's feet. */
export function dropSlot(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  const stack = player.inventory[slot];
  if (!stack) return;
  player.inventory[slot] = null;
  const { x, z } = player.core;
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type: stack.type,
    count: stack.count,
    x,
    y: state.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
  sendInventory(state, player);
}
