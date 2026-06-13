// Player lifecycle (join/spawn/respawn), input application and inventory
// operations (use/equip/pickup/drop).

import {
  CAMPFIRE_BURN_S,
  CAMPFIRE_PLACE_DIST,
  DROPPED_LOOT_TTL_S,
  FIRE_WARMTH_RADIUS,
  FISH_CHANCE,
  FISHING_COOLDOWN_S,
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
  WATER_LEVEL,
  WATER_SAMPLE_DIST,
} from "@worldspring/shared/constants";
import { ITEM_DEFS, type ItemStack, type ItemType } from "@worldspring/shared/items";
import { clamp, distSq2D, yawToDir } from "@worldspring/shared/math";
import { stepPlayer } from "@worldspring/shared/movement";
import type { InputCmd, PlayerCore } from "@worldspring/shared/protocol";
import type { CharacterState } from "../persistence";
import { startLootRespawn } from "./loot";
import { sendTo, type GameState, type PlayerStats, type ServerPlayer } from "./state";

/** Contract gap: queue cap is specified as "~60 cmds" with no shared constant. */
const INPUT_QUEUE_CAP = 60;
/** Sanity clamp for client-supplied pitch (client clamps to ±1.45 itself). */
const PITCH_LIMIT = 1.6;

/**
 * Characters stripped from all player-supplied text (names, chat): C0
 * controls, DEL + C1 controls, zero-width chars (ZWSP/ZWNJ/ZWJ U+200B-D,
 * word joiner + invisible operators U+2060-2064), bidi controls (LRM/RLM,
 * embeddings/overrides U+202A-E, isolates U+2066-2069), and BOM U+FEFF.
 * Zero-width chars defeat empty-string guards (\s does not match U+200B);
 * bidi overrides visually reverse rendered text in recipients' clients.
 */
export const STRIP_TEXT_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Trim, strip control/invisible chars, cap length, default, de-duplicate. */
export function sanitizeName(raw: string, state: GameState): string {
  let base = [...raw.replace(STRIP_TEXT_RE, "").trim()]
    .slice(0, MAX_NAME_LENGTH)
    .join("")
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

function freshStats(state: GameState): PlayerStats {
  return { bornAt: state.time, kills: 0, zombieKills: 0, distanceM: 0 };
}

/** Spawn a brand-new player: random beach spawn, full vitals, empty inventory. */
export function createPlayer(
  state: GameState,
  id: string,
  name: string,
  tokenHash: string,
): ServerPlayer {
  const player: ServerPlayer = {
    id,
    tokenHash,
    name,
    core: freshSpawnCore(state),
    vitals: { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL },
    inventory: emptyInventory(),
    selectedSlot: 0,
    alive: true,
    offline: false,
    offlineSince: 0,
    stats: freshStats(state),
    diedAt: -Infinity,
    lastRecap: null,
    cmdQueue: [],
    lastAck: 0,
    inputBudget: INPUT_BUDGET_CAP_S,
    wantsAttack: false,
    lastChatAt: -Infinity,
    attackCooldown: 0,
    attackAnimT: 0,
    sprinting: false,
    movedThisTick: false,
    sprintedThisTick: false,
    fishCooldownT: 0,
  };
  state.players.set(id, player);
  return player;
}

/**
 * Rebuild a living ServerPlayer from a persisted character (room restarted
 * since they left): saved core/vitals/inventory/stats, fresh transient state
 * (cmdQueue, cooldowns, input budget). The saved id is kept unless another
 * live player somehow holds it.
 */
export function restorePlayer(
  state: GameState,
  savedId: string,
  name: string,
  tokenHash: string,
  saved: CharacterState,
): ServerPlayer {
  const id = state.players.has(savedId) ? crypto.randomUUID().slice(0, 8) : savedId;
  // Time between the snapshot and now is offline time — shift bornAt forward
  // so survivedS (and the leaderboard) never credit time spent logged out.
  // Rows written before savedAt existed fall back to "no shift".
  const offlineGap = Math.max(0, state.time - (saved.savedAt ?? state.time));
  const player: ServerPlayer = {
    id,
    tokenHash,
    name,
    core: { ...saved.core },
    vitals: { ...saved.vitals },
    inventory: saved.inventory.map((stack) => (stack ? { ...stack } : null)),
    selectedSlot: saved.selectedSlot,
    alive: true,
    offline: false,
    offlineSince: 0,
    stats: { ...saved.stats, bornAt: saved.stats.bornAt + offlineGap },
    lastRecap: null,
    diedAt: -Infinity,
    cmdQueue: [],
    lastAck: 0,
    inputBudget: INPUT_BUDGET_CAP_S,
    wantsAttack: false,
    lastChatAt: -Infinity,
    attackCooldown: 0,
    attackAnimT: 0,
    sprinting: false,
    movedThisTick: false,
    sprintedThisTick: false,
    fishCooldownT: 0,
  };
  state.players.set(id, player);
  return player;
}

/** Fresh spawn for a dead player who requested respawn. */
export function respawnPlayer(state: GameState, player: ServerPlayer): void {
  player.core = freshSpawnCore(state);
  player.vitals = { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL };
  // Keep-inventory (pvp.fullLoot=false): the corpse spawned empty (see
  // spawnPlayerCorpse), so the new life keeps the items held at death rather
  // than starting empty. fullLoot (default) wipes to a fresh inventory.
  if (state.config.pvp.fullLoot) {
    player.inventory = emptyInventory();
    player.selectedSlot = 0;
  }
  player.alive = true;
  // A new life: stats restart here. The stale pending recap (if any) is
  // storage-side state — GameRoom calls saveCharacter right after respawn,
  // which clears it.
  player.stats = freshStats(state);
  player.cmdQueue = [];
  player.inputBudget = INPUT_BUDGET_CAP_S;
  player.wantsAttack = false;
  player.wantsAttackAt = null;
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
    if (player.fishCooldownT > 0) player.fishCooldownT -= dt;
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
      const fromX = player.core.x;
      const fromZ = player.core.z;
      stepPlayer(player.core, clamped, state.world);
      // Lifetime odometer: horizontal displacement per applied cmd.
      player.stats.distanceM += Math.hypot(player.core.x - fromX, player.core.z - fromZ);
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

/** Within campfire warmth (duplicated from survival.ts's private nearFire to
 * avoid a players <-> survival import cycle — survival already imports us). */
function nearFire(state: GameState, x: number, z: number): boolean {
  const rSq = FIRE_WARMTH_RADIUS * FIRE_WARMTH_RADIUS;
  for (const fire of state.fires) {
    if (distSq2D(x, z, fire.x, fire.z) <= rSq) return true;
  }
  return false;
}

/** Drop a stack on the ground at the player's feet (inventory overflow). */
function dropAtFeet(state: GameState, player: ServerPlayer, type: ItemType, count: number): void {
  const { x, z } = player.core;
  const id = state.nextEntityId++;
  state.loot.set(id, {
    id,
    type,
    count,
    x,
    y: state.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
}

/**
 * Sample whether there is water ahead of the player (used for fishing +
 * canteen filling). Checks `heightAt` at WATER_SAMPLE_DIST along the yaw.
 */
function waterAhead(state: GameState, player: ServerPlayer): boolean {
  const [fx, fz] = yawToDir(player.core.yaw);
  const sx = player.core.x + fx * WATER_SAMPLE_DIST;
  const sz = player.core.z + fz * WATER_SAMPLE_DIST;
  return state.world.heightAt(sx, sz) < WATER_LEVEL;
}

/**
 * Use the item in `slot`. Handles data-driven cook/boil/drink/fill/fishing
 * paths, camping placement, and standard consumable/heal items.
 *
 * Priority for items with `cooksTo`: near fire → cook; else eat raw (penalty).
 * Priority for items with `water` config: near fire + boilsTo → boil;
 *   water ahead + fillsTo → fill; drink.drink → drink.
 */
export function useItem(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  const stack = player.inventory[slot];
  if (!stack) return;
  const def = ITEM_DEFS[stack.type];
  const vitals = player.vitals;
  const { x, z } = player.core;

  // --- Data-driven cook path (raw_venison, raw_fish, future raw items) ---
  if (def.cooksTo !== undefined) {
    if (nearFire(state, x, z)) {
      // Near campfire: convert raw → cooked.
      consumeFromSlot(player.inventory, slot);
      const cooked = def.cooksTo;
      const leftover = addToInventory(player.inventory, cooked, 1);
      if (leftover > 0) dropAtFeet(state, player, cooked, leftover);
      sendTo(state, player.id, { t: "notice", msg: `${def.name} cooked` });
      sendInventory(state, player);
      return;
    }
    // Away from fire: eat raw — food benefit with hp penalty.
    vitals.food = clamp(vitals.food + def.power, 0, MAX_FOOD);
    if (def.rawPenaltyHp !== undefined && def.rawPenaltyHp > 0) {
      // Never lethal: floor at 1, but don't raise hp already below 1.
      vitals.hp = Math.max(Math.min(vitals.hp, 1), vitals.hp - def.rawPenaltyHp);
    }
    consumeFromSlot(player.inventory, slot);
    // The cook-vs-raw split is otherwise an invisible, instant binary (#33): tell
    // the player WHY they took the hit and the exact range to avoid it next time.
    sendTo(state, player.id, {
      t: "notice",
      msg: `Ate it raw — stand within ${FIRE_WARMTH_RADIUS}m of a fire to cook it`,
    });
    sendInventory(state, player);
    return;
  }

  // --- Water vessel path (canteens) ---
  if (def.water !== undefined) {
    const wc = def.water;

    // 1. Boil (near campfire + boilsTo defined)
    if (wc.boilsTo !== undefined && nearFire(state, x, z)) {
      consumeFromSlot(player.inventory, slot);
      const leftover = addToInventory(player.inventory, wc.boilsTo, 1);
      if (leftover > 0) dropAtFeet(state, player, wc.boilsTo, leftover);
      sendTo(state, player.id, { t: "notice", msg: "water boiled clean" });
      sendInventory(state, player);
      return;
    }

    // 2. Fill (water ahead + fillsTo defined)
    if (wc.fillsTo !== undefined && waterAhead(state, player)) {
      consumeFromSlot(player.inventory, slot);
      const leftover = addToInventory(player.inventory, wc.fillsTo, 1);
      if (leftover > 0) dropAtFeet(state, player, wc.fillsTo, leftover);
      sendTo(state, player.id, { t: "notice", msg: "canteen filled" });
      sendInventory(state, player);
      return;
    }

    // 3. Drink
    if (wc.drink !== undefined) {
      const d = wc.drink;
      vitals.water = clamp(vitals.water + d.restore, 0, MAX_WATER);
      if (d.hpPenalty !== undefined && d.hpPenalty > 0) {
        vitals.hp = Math.max(Math.min(vitals.hp, 1), vitals.hp - d.hpPenalty);
      }
      consumeFromSlot(player.inventory, slot);
      const leftover = addToInventory(player.inventory, d.emptiesTo, 1);
      if (leftover > 0) dropAtFeet(state, player, d.emptiesTo, leftover);
      sendInventory(state, player);
      return;
    }

    // No applicable water action (e.g. canteen_empty with no water ahead).
    sendTo(state, player.id, { t: "notice", msg: "nothing to do here" });
    return;
  }

  // --- Fishing rod ---
  if (stack.type === "fishing_rod") {
    if (player.fishCooldownT > 0) {
      sendTo(state, player.id, { t: "notice", msg: "rod needs a moment" });
      return;
    }
    if (!waterAhead(state, player)) {
      sendTo(state, player.id, { t: "notice", msg: "no water ahead" });
      return;
    }
    player.fishCooldownT = FISHING_COOLDOWN_S;
    // Reuse attackAnimT for the swing feedback (same flag the hotbar reads).
    player.attackAnimT = 0.3;
    if (Math.random() < FISH_CHANCE) {
      const leftover = addToInventory(player.inventory, "raw_fish", 1);
      if (leftover > 0) dropAtFeet(state, player, "raw_fish", leftover);
      sendTo(state, player.id, { t: "notice", msg: "you caught a fish" });
      sendInventory(state, player);
    } else {
      sendTo(state, player.id, { t: "notice", msg: "nothing biting" });
    }
    return;
  }

  // --- Standard kind-based dispatch ---
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
      const px = player.core.x + fx * CAMPFIRE_PLACE_DIST;
      const pz = player.core.z + fz * CAMPFIRE_PLACE_DIST;
      // World-wide cap: the oldest fire goes out when the cap is hit.
      if (state.fires.length >= MAX_CAMPFIRES) state.fires.shift();
      state.fires.push({
        id: state.nextEntityId++,
        x: px,
        y: state.world.groundHeight(px, pz),
        z: pz,
        burnRemaining: CAMPFIRE_BURN_S,
      });
      break;
    }
    case "tool":
      // Generic tools (flashlight, torch) have no use action beyond equip.
      return;
    default:
      return; // weapons, ammo, material, wear are not usable via this path
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
 * Pick up a loot entity, scavenge a corpse, or loot a landed airdrop crate
 * within PICKUP_RANGE (all three share the entity id space). Plain items
 * support partial pickup (leftover stays in the world). Corpses transfer as
 * many stacks as fit, keep the remainder, and the body itself persists until
 * its TTL even when emptied. Crates work like corpses except the crate is
 * REMOVED once fully emptied (no husk).
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
  if (corpse) {
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
    return;
  }

  // Airdrop crate: lootable only once landed; transfers stacks like a corpse
  // but the crate disappears as soon as it's empty.
  const drop = state.drops.get(lootId);
  if (!drop) return;
  if (state.time < drop.landsAt) return; // still on the chute
  if (distSq2D(player.core.x, player.core.z, drop.x, drop.z) > rangeSq) return;
  let tookAny = false;
  const remaining: ItemStack[] = [];
  for (const stack of drop.contents) {
    const leftover = addToInventory(player.inventory, stack.type, stack.count);
    if (leftover < stack.count) tookAny = true;
    if (leftover > 0) remaining.push({ type: stack.type, count: leftover });
  }
  drop.contents = remaining;
  if (remaining.length === 0) state.drops.delete(drop.id);
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
