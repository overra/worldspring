// Player lifecycle (join/spawn/respawn), input application and inventory
// operations (use/equip/pickup/drop).

import {
  CAMPFIRE_BURN_S,
  CAMPFIRE_PLACE_DIST,
  COOK_CHANNEL_S,
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
  MAX_PORTALS,
  MAX_WATER,
  PICKUP_RANGE,
  PLACEABLE_CHANNEL_S,
  PORTAL_PLACE_DIST,
  PORTAL_RADIUS,
  TEMP_NORMAL,
  USE_CHANNEL_S,
  WATER_LEVEL,
  WATER_SAMPLE_DIST,
  WORLD_SIZE,
} from "@worldspring/shared/constants";
import {
  createExploredGrid,
  decodeExplored,
  exploredCellAt,
  FOG_REVEAL_RADIUS_M,
  markExploredDisk,
} from "@worldspring/shared/fog";
import { ITEM_DEFS, RECIPES, type ItemStack, type ItemType } from "@worldspring/shared/items";
import { clamp, distSq2D, yawToDir } from "@worldspring/shared/math";
import { stepPlayer } from "@worldspring/shared/movement";
import type { ChannelKind, InputCmd, PlayerCore, Realm } from "@worldspring/shared/protocol";
import type { CharacterState } from "../persistence";
import { startLootRespawn } from "./loot";
import { canStartReload, completeReload, rangedOf } from "./magazine";
import { sendTo, type GameState, type PlayerStats, type Portal, type ServerPlayer } from "./state";

/** Contract gap: queue cap is specified as "~60 cmds" with no shared constant. */
const INPUT_QUEUE_CAP = 60;
/** Sanity clamp for client-supplied pitch (client clamps to ±1.45 itself). */
const PITCH_LIMIT = 1.6;

// STRIP_TEXT_RE was hoisted to @worldspring/shared/text (doc 02 §7 M1: the
// directory needs the one true regex without dragging game-state types).
// Re-exported here so existing game-side call sites are untouched.
import { STRIP_TEXT_RE } from "@worldspring/shared/text";
export { STRIP_TEXT_RE };

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

/** Build the inventory a brand-new player spawns with: a flashlight, a bandage,
 * and (doc 12) the map item iff the server grants it at spawn (acquire "loot"
 * makes it a find; "none" disables the full map). */
function startingInventory(state: GameState): (ItemStack | null)[] {
  const inv = emptyInventory();
  addToInventory(inv, "flashlight", 1);
  addToInventory(inv, "bandage", 1);
  // `?.` tolerates the untyped .mjs test fixtures that predate `map` (production
  // configs always carry it); undefined -> no map granted, the right default.
  if (state.config.map?.acquire === "spawn") addToInventory(inv, "map", 1);
  return inv;
}

/** Spawn a brand-new player: random beach spawn, full vitals, starting loadout. */
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
    inventory: startingInventory(state),
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
    explored: createExploredGrid(WORLD_SIZE),
    fogDelta: [],
    lastFogCell: -1,
    action: null,
    tookDamageThisTick: false,
    realm: "overworld",
    portalArmed: true,
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
    // Per-token fog: explored knowledge accrues across lives (doc 12 Open Q4).
    explored: decodeExplored(WORLD_SIZE, saved.explored),
    fogDelta: [],
    lastFogCell: -1,
    action: null,
    tookDamageThisTick: false,
    realm: "overworld",
    portalArmed: true,
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
  // than starting empty. fullLoot (default) resets to the starting loadout.
  if (state.config.pvp.fullLoot) {
    player.inventory = startingInventory(state);
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
  player.fishCooldownT = 0;
  player.sprinting = false;
  // Keep the explored set (per-token), but re-stamp from the new spawn position.
  player.lastFogCell = -1;
  // Drop any cast belt-and-braces (death already cancels it in tickActiveActions,
  // but a respawn must never inherit a stale channel from the previous life).
  player.action = null;
  player.tookDamageThisTick = false;
  // A new life always starts back in the overworld (freshSpawnCore put them on
  // the beach), regardless of which realm the old life died in.
  player.realm = "overworld";
  player.portalArmed = true;
  sendInventory(state, player);
}

/**
 * doc 12 — server-authoritative fog-of-war. For each alive, online player on a
 * fog server, reveal a disk around their authoritative (unrounded) position
 * whenever they cross into a new cell, accumulating the newly-lit cells in
 * fogDelta (shipped + cleared by the next snapshot). Pure XZ arithmetic — never
 * touches heightAt, so it stays off the tick's hot path. No-op on full-reveal
 * servers (the explored set is unused there).
 */
export function markExploration(state: GameState): void {
  if (state.config.map.reveal !== "explored") return;
  for (const player of state.players.values()) {
    if (player.offline || !player.alive) continue;
    const cell = exploredCellAt(player.explored, player.core.x, player.core.z);
    if (cell === player.lastFogCell) continue;
    player.lastFogCell = cell;
    const revealed = markExploredDisk(player.explored, player.core.x, player.core.z, FOG_REVEAL_RADIUS_M);
    if (revealed.length > 0) player.fogDelta.push(...revealed);
  }
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

/** Total count of `type` across all inventory stacks (sibling of addToInventory). */
export function countOf(inv: (ItemStack | null)[], type: ItemType): number {
  let total = 0;
  for (const stack of inv) {
    if (stack && stack.type === type) total += stack.count;
  }
  return total;
}

/**
 * Remove `count` of `type`, draining stacks BACK-TO-FRONT so the hotbar's low
 * slots keep their tools (a tool stack at slot 0 survives a craft that also
 * consumes loose materials in a higher slot). Caller must ensure the inventory
 * holds at least `count` (craftItem validates via countOf first).
 */
export function removeFromInventory(inv: (ItemStack | null)[], type: ItemType, count: number): void {
  let remaining = count;
  for (let i = inv.length - 1; i >= 0 && remaining > 0; i--) {
    const stack = inv[i];
    if (!stack || stack.type !== type) continue;
    const take = Math.min(stack.count, remaining);
    stack.count -= take;
    remaining -= take;
    if (stack.count <= 0) inv[i] = null;
  }
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
  // Cook is a channeled action (doc 11): startChannel only opens this cast when
  // nearFire, and tickActiveActions re-checks nearFire every tick — so by the
  // time we COMPLETE here we are (re-validated) in range. The old instant
  // out-of-range "eat it raw" path is gone: pressing use on a raw item away
  // from a fire is rejected at START with the "stand within Nm of a fire"
  // notice (see startUse), never silently eaten raw. Defensive early-return if
  // somehow out of range at completion (the channel should already have
  // cancelled with the "moved away from the fire" notice).
  if (def.cooksTo !== undefined) {
    if (!nearFire(state, x, z)) return;
    consumeFromSlot(player.inventory, slot);
    const cooked = def.cooksTo;
    const leftover = addToInventory(player.inventory, cooked, 1);
    if (leftover > 0) dropAtFeet(state, player, cooked, leftover);
    sendTo(state, player.id, { t: "notice", msg: `${def.name} cooked` });
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
      // The placeable kind dispatches on item type: the portal kit tears open a
      // realm gateway; everything else (campfire_kit) drops a campfire.
      if (stack.type === "portal_kit") {
        placeRedPortal(state, player);
        break; // consumed by the shared tail below
      }
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

// --- Channeled actions (doc 11) -------------------------------------------
//
// `useItem` above is the INSTANT completion body. The verbs that used to call
// it inline now call startUse, which opens a timed cast; tickActiveActions
// ticks it down in game-time and, on success, re-enters useItem (the SAME body)
// to apply + consume. Nothing is applied or consumed at start. See
// docs/plans/11-channeled-timed-actions.md §1–§3.

/**
 * Map a {t:"use"} on `slot` to its channeled kind + duration, or to the instant
 * path. M1 channels exactly the doc-11 §2 rows it owns — cook, and the
 * food/drink/heal/placeable consumables — and leaves the doc-05 interim water
 * vessel + fishing-rod paths resolving instantly through useItem (their
 * channels are their owners' to add). Returns null to mean "not a channeled
 * use — run the instant useItem path".
 */
function channelForUse(
  stack: ItemStack,
): { kind: ChannelKind; durationS: number } | null {
  const def = ITEM_DEFS[stack.type];
  // Cook takes priority exactly as in useItem (cooksTo is checked first there).
  if (def.cooksTo !== undefined) return { kind: "cook", durationS: COOK_CHANNEL_S };
  // Water vessels (boil/fill/drink) + the fishing rod stay instant for M1.
  if (def.water !== undefined) return null;
  if (stack.type === "fishing_rod") return null;
  // doc 11 M3: use-on-a-ranged-weapon IS the reload verb — reuses the existing
  // {t:"use"} message per doc 11 §4 ("no new top-level reload verb"); duration
  // is per-weapon (weapons-as-data), startChannel enforces the precondition.
  if (def.kind === "ranged" && def.ranged) {
    return { kind: "reload", durationS: def.ranged.reloadS };
  }
  switch (def.kind) {
    case "food":
    case "drink":
    case "heal":
      return { kind: "use", durationS: USE_CHANNEL_S };
    case "placeable":
      return { kind: "use", durationS: PLACEABLE_CHANNEL_S };
    default:
      return null; // tools / melee / ammo: instant (no-op) path
  }
}

/**
 * Open the reload channel on the EQUIPPED weapon (doc 11 M3). The combat-side
 * entry: fireRanged auto-calls this on an empty-mag trigger pull; the client's
 * R key arrives as {t:"use", slot: selectedSlot} and lands here via startUse.
 * startChannel's reload precondition validates (ranged equipped, mag not full,
 * reserve ammo present) — this wrapper only resolves the per-weapon duration.
 */
export function startReload(state: GameState, player: ServerPlayer): void {
  const ranged = rangedOf(player.inventory[player.selectedSlot] ?? null);
  if (!ranged) return;
  startChannel(state, player, "reload", player.selectedSlot, 0, ranged.reloadS);
}

/**
 * Entry point for a {t:"use"} message (replaces the inline useItem call). Decides
 * whether the item channels: if so it validates the START precondition and opens
 * a cast via startChannel; otherwise it falls back to the instant useItem path
 * (water vessels, fishing rod, tools). A second use mid-cast is a silent no-op
 * inside startChannel.
 */
export function startUse(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  // One action at a time: ignore ANY use mid-cast (a channeled use OR the instant
  // water/fishing fallback) so nothing mutates the inventory during a cast (§1/§3).
  if (player.action !== null) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  const stack = player.inventory[slot];
  if (!stack) return;
  const channel = channelForUse(stack);
  if (channel === null) {
    // Not a channeled use — resolve instantly exactly as before.
    useItem(state, player, slot);
    return;
  }
  startChannel(state, player, channel.kind, slot, 0, channel.durationS);
}

/**
 * Open a channeled action on `player` (doc 11 §1). No-op (silently) if the
 * player is already casting (one cast at a time), is dead, or the per-kind START
 * precondition fails. NOTHING is applied or consumed here — start only opens the
 * cast; effects run in the completion fn from tickActiveActions.
 *
 * Cook's start precondition is the headline fix (#33): a cook only STARTS when
 * nearFire, so pressing use on a raw item out of range is rejected up front with
 * the exact range — never silently eaten raw. The per-tick re-check in
 * tickActiveActions then cancels if you walk out mid-cook.
 */
export function startChannel(
  state: GameState,
  player: ServerPlayer,
  kind: ChannelKind,
  slot: number,
  arg: number,
  durationS: number,
): void {
  if (!player.alive) return;
  if (player.action !== null) return; // already casting — second use ignored
  if (slot >= 0) {
    const stack = player.inventory[slot];
    if (!stack) return;
    // Cook precondition: raw item AND in fire range. Out of range never starts;
    // tell the player the exact range (the old instant eat-raw notice, moved to
    // start — eating raw is no longer an action, it was the out-of-range path).
    if (kind === "cook") {
      const def = ITEM_DEFS[stack.type];
      if (def.cooksTo === undefined) return;
      if (!nearFire(state, player.core.x, player.core.z)) {
        sendTo(state, player.id, {
          t: "notice",
          msg: `Stand within ${FIRE_WARMTH_RADIUS}m of a fire to cook it`,
        });
        return;
      }
    }
    // Reload precondition (doc 11 M3): the EQUIPPED slot holds a ranged weapon
    // with a non-full mag and the inventory holds reserve ammo. Silent no-op
    // otherwise — a notice here would spam on every empty-mag trigger pull
    // (fireRanged auto-routes those pulls to startReload); the HUD's rounds
    // readout is the feedback. NOTHING is consumed at start (doc 11 §1) — the
    // refill happens only in completeChannel.
    if (kind === "reload") {
      if (slot !== player.selectedSlot) return; // cast binds to the equipped gun
      if (canStartReload(player.inventory, slot) === null) return;
    }
  }
  player.action = { kind, slot, arg, totalS: durationS, remainingS: durationS };
}

/**
 * Advance every player's in-progress channel one tick in game-time (doc 11 §2).
 *
 * Ordering is load-bearing: this MUST run after applyQueuedInputs (so movedThisTick
 * is this tick's value) and before attack resolution — GameRoom.tick enforces it.
 *
 * The §3 interrupt checks run FIRST, with strict early-return discipline: the
 * first matching trigger cancels (action = null, no effect, nothing consumed)
 * and moves to the next player. Only if none fire does remainingS count down;
 * at <= 0 the kind's completion fn runs (the EXISTING instant body) and the
 * cast clears.
 */
export function tickActiveActions(state: GameState, dt: number): void {
  for (const player of state.players.values()) {
    // Consume-on-read the damage flag for EVERY player (casting or not): combat,
    // zombie and survival damage all land LATER in the tick pipeline than this
    // sweep (attack resolution / tickZombies / tickSurvival run after us), so a
    // hit set on tick N is read here on tick N+1 — a one-tick (~67ms) latency.
    // Clearing it here (not in applyQueuedInputs) is what keeps the signal alive
    // long enough to be seen. Consuming it one tick late means a hit on tick N
    // also cancels a cast opened in the gap before tick N+1's sweep (started just
    // AFTER the hit) — fail-safe (over-cancels by at most one tick, never misses a
    // cancel) and imperceptible.
    const tookDamage = player.tookDamageThisTick;
    player.tookDamageThisTick = false;

    const action = player.action;
    if (action === null) continue;

    // §3 interrupts (first match cancels, no effect):
    // 1. Death.
    if (!player.alive) {
      player.action = null;
      continue;
    }
    // 2. Movement (default for cook/use) — PER-KIND, not global: reload
    //    survives movement (doc 11 Open Q4, resolved by combat at M3 — cancel-
    //    on-move would make ranged combat miserable; §Threatens called this
    //    out). Reload still cancels on damage/slot-swap/death below.
    //    movedThisTick is this tick's value because we run right after
    //    applyQueuedInputs.
    if (player.movedThisTick && action.kind !== "reload") {
      player.action = null;
      continue;
    }
    // 3. Took combat damage since the last sweep (set alongside the {e:"hurt"}
    //    emit in damagePlayer). Consumed above.
    if (tookDamage) {
      player.action = null;
      continue;
    }
    // (Slot-swap interrupt is handled at the equip site — see equipSlot — not
    //  here, so it fires the instant the equipped slot changes and catches an
    //  equip-away-and-back within one tick that a point-in-time check here would
    //  miss. Use from the inventory panel never equips, so it is unaffected.)
    // 4. Cook only: left fire range (the net-new per-tick predicate). Emit the
    //    one-shot "moved away from the fire" notice — invisible cancellation is
    //    exactly the pain we are fixing.
    if (action.kind === "cook" && !nearFire(state, player.core.x, player.core.z)) {
      player.action = null;
      sendTo(state, player.id, { t: "notice", msg: "Moved away from the fire" });
      continue;
    }

    // No interrupt — advance the cast.
    action.remainingS -= dt;
    if (action.remainingS > 0) continue;

    // Complete: run the kind's completion fn (the EXISTING instant body), which
    // re-validates its own precondition and applies + consumes. Clear FIRST so a
    // completion that itself opens nothing leaves a clean slate.
    player.action = null;
    completeChannel(state, player, action.kind, action.slot);
  }
}

/**
 * Run the completion (the existing instant body) for a finished channel. M1
 * owns cook + use; reload/craft/fish are wired by their owning docs as they
 * adopt the primitive (they early-return here until then).
 */
function completeChannel(
  state: GameState,
  player: ServerPlayer,
  kind: ChannelKind,
  slot: number,
): void {
  switch (kind) {
    case "cook":
    case "use":
      // useItem re-validates (the slot may have changed contents during a long
      // cast even without an interrupt) and applies + consumes.
      useItem(state, player, slot);
      return;
    case "reload":
      // doc 11 M3 (combat's refill): move min(magSize - current, reserve)
      // rounds from the inventory ammo stacks into the weapon's mag.
      // completeReload re-validates from scratch (slot contents may have
      // changed mid-cast) and reports whether anything actually moved.
      if (completeReload(player.inventory, slot)) sendInventory(state, player);
      return;
    default:
      // craft / fish: owned by doc 05 / doc 07 (later milestones).
      return;
  }
}

/**
 * Craft RECIPES[recipe] (doc 05 M2). Strict early-returns: alive; recipe in
 * range; every input present in the summed inventory; the tool (if any) held
 * anywhere; the station (if any) satisfied. On success consume the inputs
 * (back-to-front per stack so low-slot tools survive), grant the output
 * (overflow → dropAtFeet), and confirm with an inv message + a notice. The
 * tool is NEVER consumed.
 */
export function craftItem(state: GameState, player: ServerPlayer, recipe: number): void {
  if (!player.alive) return;
  // Range + integer guard. parseClientMsg already coerces via `| 0`, but craft
  // is the authority — reject any non-integer or out-of-range index outright.
  if (!Number.isInteger(recipe) || recipe < 0 || recipe >= RECIPES.length) return;
  const r = RECIPES[recipe];
  const inv = player.inventory;

  // Aggregate required inputs by type first. A recipe that lists the same type in
  // more than one row is summed (per-row checks would each pass on a quantity that
  // doesn't cover the total), and the tool guarantee below stays exact. No current
  // recipe repeats a type or names its tool as an input; this keeps it robust if
  // one ever does.
  const required = new Map<ItemType, number>();
  for (const input of r.inputs) {
    required.set(input.type, (required.get(input.type) ?? 0) + input.count);
  }
  // Inputs: every required type must be present in sufficient summed quantity.
  for (const [type, need] of required) {
    if (countOf(inv, type) < need) return;
  }
  // Tool: held somewhere AND never consumed. If the tool type is also an input,
  // require one beyond the consumed count so it survives the removal below.
  if (r.tool !== undefined && countOf(inv, r.tool) <= (required.get(r.tool) ?? 0)) return;
  // Station: campfire recipes need a nearby fire — notice on failure so the
  // greyed client button has a server-confirmed reason.
  if (r.station === "campfire" && !nearFire(state, player.core.x, player.core.z)) {
    sendTo(state, player.id, { t: "notice", msg: "needs a campfire" });
    return;
  }

  for (const [type, need] of required) removeFromInventory(inv, type, need);
  const leftover = addToInventory(inv, r.output.type, r.output.count);
  if (leftover > 0) dropAtFeet(state, player, r.output.type, leftover);
  sendInventory(state, player);
  sendTo(state, player.id, { t: "notice", msg: `crafted ${r.name}` });
}

/**
 * Open a linked portal pair: one in the player's current realm at the spot
 * ahead of them, and its twin at the SAME (x,z) in the destination realm.
 * Stepping into either (stepPortals) teleports to the other. The shared world
 * geometry means the twin sits on identical ground — only the rendering and the
 * player's realm flag change. Item consumption is handled by useItem's tail.
 */
function placeRedPortal(state: GameState, player: ServerPlayer): void {
  const [fx, fz] = yawToDir(player.core.yaw);
  const px = player.core.x + fx * PORTAL_PLACE_DIST;
  const pz = player.core.z + fz * PORTAL_PLACE_DIST;
  const y = state.world.groundHeight(px, pz);
  const here: Realm = player.realm;
  const there: Realm = here === "red" ? "overworld" : "red";

  // Cap world-wide: drop the oldest TWO entries so a full pair is always evicted
  // together (never a half-broken gateway).
  while (state.portals.length >= MAX_PORTALS) state.portals.splice(0, 2);

  const near: Portal = { id: state.nextEntityId++, x: px, y, z: pz, realm: here, toRealm: there, toX: px, toZ: pz };
  const far: Portal = { id: state.nextEntityId++, x: px, y, z: pz, realm: there, toRealm: here, toX: px, toZ: pz };
  state.portals.push(near, far);
  sendTo(state, player.id, { t: "notice", msg: "A red portal tears open ahead" });
}

/**
 * Per-tick portal crossing. A player standing within PORTAL_RADIUS of a portal
 * in their own realm is teleported to its destination — but only if armed
 * (cleared after each crossing, re-armed once they step clear of every portal),
 * so they never bounce straight back through the twin they land on.
 */
export function stepPortals(state: GameState): void {
  const rSq = PORTAL_RADIUS * PORTAL_RADIUS;
  for (const player of state.players.values()) {
    if (!player.alive) continue;
    let on: Portal | null = null;
    for (const portal of state.portals) {
      if (portal.realm !== player.realm) continue;
      if (distSq2D(player.core.x, player.core.z, portal.x, portal.z) <= rSq) {
        on = portal;
        break;
      }
    }
    if (!on) {
      player.portalArmed = true;
      continue;
    }
    if (!player.portalArmed) continue;
    // Cross: flip realm, teleport onto the twin, disarm until they step clear.
    player.portalArmed = false;
    player.realm = on.toRealm;
    player.core.x = on.toX;
    player.core.z = on.toZ;
    player.core.y = state.world.groundHeight(on.toX, on.toZ);
    player.core.vy = 0;
    player.core.grounded = true;
    sendTo(state, player.id, {
      t: "notice",
      msg: on.toRealm === "red" ? "You step into the red realm" : "You return to the overworld",
    });
  }
}

/** Select a hotbar slot. */
export function equipSlot(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  // §3 slot-swap interrupt, owned HERE (the mutation point) rather than in
  // tickActiveActions like the other interrupts: cancelling the instant the
  // equipped slot actually changes catches an equip-away-and-back within a single
  // tick that a once-per-tick check would miss. Checked before the assignment so
  // `selectedSlot` is still the pre-equip value. Inventory-panel use never calls
  // equipSlot, so a non-equipped-slot use is never cancelled by this.
  if (player.action !== null && slot !== player.selectedSlot) player.action = null;
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
    // A dropped gun carries its loaded-mag counter (doc 11 M3): place it whole
    // into an empty slot so `mag` survives — addToInventory's type+count merge
    // would erase it and the absent-⇒-full rule would refill it for free.
    if (entity.mag !== undefined) {
      const empty = player.inventory.findIndex((slot) => slot === null);
      if (empty === -1) return; // nothing fit
      player.inventory[empty] = { type: entity.type, count: entity.count, mag: entity.mag };
      state.loot.delete(entity.id);
      if (entity.spawnId !== null) startLootRespawn(state, entity.spawnId);
      sendInventory(state, player);
      return;
    }
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
      const leftover = takeStack(player.inventory, stack);
      if (leftover < stack.count) tookAny = true;
      if (leftover > 0) remaining.push({ ...stack, count: leftover });
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
    const leftover = takeStack(player.inventory, stack);
    if (leftover < stack.count) tookAny = true;
    if (leftover > 0) remaining.push({ ...stack, count: leftover });
  }
  drop.contents = remaining;
  if (remaining.length === 0) state.drops.delete(drop.id);
  if (tookAny) sendInventory(state, player);
}

/**
 * Transfer one container stack into the inventory, returning the leftover
 * count. Mag-carrying stacks (a dead player's gun — doc 11 M3) transfer WHOLE
 * into an empty slot so the loaded-rounds counter survives; everything else
 * goes through addToInventory's normal top-up-then-fill.
 */
function takeStack(inv: (ItemStack | null)[], stack: ItemStack): number {
  if (stack.mag === undefined) return addToInventory(inv, stack.type, stack.count);
  const empty = inv.findIndex((slot) => slot === null);
  if (empty === -1) return stack.count; // nothing fit
  inv[empty] = { ...stack };
  return 0;
}

/** Drop the whole stack in a slot as a loot entity at the player's feet. */
export function dropSlot(state: GameState, player: ServerPlayer, slot: number): void {
  if (!player.alive) return;
  if (slot < 0 || slot >= INVENTORY_SLOTS) return;
  const stack = player.inventory[slot];
  if (!stack) return;
  // Dropping the gun mid-reload cancels the cast (the doc 11 §3 slot-swap rule
  // generalized to the mutation point: the cast's source stack is gone).
  if (player.action !== null && player.action.slot === slot) player.action = null;
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
    // Loaded-mag counter travels with a dropped gun (doc 11 M3, Open Q5).
    ...(stack.mag !== undefined ? { mag: stack.mag } : {}),
  });
  sendInventory(state, player);
}
