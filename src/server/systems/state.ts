// Authoritative server-side game state. Systems are pure-ish functions that
// take this state and mutate it in place. Outbound traffic is queued rather
// than sent directly: world-visible VFX go into `events` (interest-filtered
// per recipient at snapshot time), direct/broadcast messages go into `outbox`
// (drained by GameRoom after each handled message and each tick).

import type { ItemStack, ItemType } from "@/shared/items";
import type {
  DeathRecap,
  GameEvent,
  InputCmd,
  PlayerCore,
  ServerMsg,
  Vitals,
  ZombieState,
} from "@/shared/protocol";
import type { World } from "@/shared/world";

/** Per-life stats; reset on (re)spawn, written to the leaderboard on death. */
export interface PlayerStats {
  /** Game-time seconds when this life began. */
  bornAt: number;
  kills: number;
  zombieKills: number;
  distanceM: number;
}

export interface ServerPlayer {
  id: string;
  /** SHA-256 hex of the client identity token — the persistence key. */
  tokenHash: string;
  name: string;
  core: PlayerCore;
  vitals: Vitals;
  inventory: (ItemStack | null)[];
  selectedSlot: number;
  alive: boolean;
  /** Disconnected-but-lingering body (no socket); expires LOGOUT_LINGER_S
   * after offlineSince, then the character is saved and removed. */
  offline: boolean;
  /** Game-time seconds when the owning socket dropped (0 while online). */
  offlineSince: number;
  stats: PlayerStats;
  /** Recap of this character's death, kept for dead-character takeover joins. */
  lastRecap: DeathRecap | null;
  /** Game-time seconds when the player last died (gates respawn requests). */
  diedAt: number;
  /** Pending input commands; capped, carried across ticks. */
  cmdQueue: InputCmd[];
  /** Last input seq applied (echoed as `ack` in snapshots). */
  lastAck: number;
  /**
   * Anti-speedhack allowance: accrues at wall-clock rate each tick (capped at
   * INPUT_BUDGET_CAP_S); every applied cmd spends its dt from this budget.
   */
  inputBudget: number;
  /** Attack requested this tick; resolved after movement applies. */
  wantsAttack: boolean;
  /** Seconds remaining until the next attack is allowed. */
  attackCooldown: number;
  /** Seconds remaining of the ANIM_ATTACKING flag. */
  attackAnimT: number;
  /** True while the most recently applied cmd was sprinting AND moving. */
  sprinting: boolean;
  /** Input moved the player during the current tick (ANIM_MOVING). */
  movedThisTick: boolean;
  /** Sprint-moved during the current tick (ANIM_SPRINTING). */
  sprintedThisTick: boolean;
}

/** Structurally compatible with ZombieCore so stepZombie applies directly. */
export interface Zombie {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  /** Tougher military-compound variant (more hp/dmg/speed, darker render). */
  mil: boolean;
  state: ZombieState;
  homeX: number;
  homeZ: number;
  /** Player id currently being chased, or null. */
  targetId: string | null;
  wanderX: number;
  wanderZ: number;
  /** Seconds until a new wander target is rolled. */
  wanderWait: number;
  attackCooldown: number;
}

export interface LootEntity {
  id: number;
  type: ItemType;
  count: number;
  x: number;
  y: number;
  z: number;
  /** world.lootSpawns id this entity stocks, or null for drops. */
  spawnId: number | null;
  /** Seconds until despawn for player-dropped items; null = no expiry. */
  ttl: number | null;
}

/** A scavengeable body. Persists until ttl even after being picked clean. */
export interface Corpse {
  id: number;
  kind: "player" | "zombie";
  name: string | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  contents: ItemStack[];
  /** Seconds until the body despawns. */
  ttl: number;
}

export interface Campfire {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Seconds of burn time remaining. */
  burnRemaining: number;
}

export interface LootRespawnTimer {
  spawnId: number;
  /** Seconds remaining; held at <= 0 while a player camps the spawn. */
  t: number;
}

/** A pending zombie respawn — military zombies respawn inside the compound. */
export interface ZombieRespawn {
  /** Seconds remaining; held at <= 0 while the spawn area is blocked. */
  t: number;
  /** Respawn as the military variant (dead zombie's kind is preserved). */
  mil: boolean;
}

export interface QueuedEvent {
  ev: GameEvent;
  /** World position used for per-recipient interest filtering. */
  x: number;
  z: number;
  /** When set, deliver only to this player (e.g. "hurt" to the victim). */
  onlyTo?: string;
}

export interface OutboundMsg {
  to: string | "all";
  msg: ServerMsg;
}

export interface GameState {
  world: World;
  /** Game time in seconds since room boot. */
  time: number;
  tick: number;
  players: Map<string, ServerPlayer>;
  zombies: Map<number, Zombie>;
  loot: Map<number, LootEntity>;
  corpses: Map<number, Corpse>;
  fires: Campfire[];
  lootRespawns: LootRespawnTimer[];
  /** Pending zombie respawns (countdown + variant). */
  zombieRespawns: ZombieRespawn[];
  events: QueuedEvent[];
  outbox: OutboundMsg[];
  /** Shared id counter for zombies, loot entities and campfires. */
  nextEntityId: number;
}

export function createGameState(world: World): GameState {
  return {
    world,
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
    loot: new Map(),
    corpses: new Map(),
    fires: [],
    lootRespawns: [],
    zombieRespawns: [],
    events: [],
    outbox: [],
    nextEntityId: 1,
  };
}

export function queueEvent(
  state: GameState,
  ev: GameEvent,
  x: number,
  z: number,
  onlyTo?: string,
): void {
  state.events.push({ ev, x, z, onlyTo });
}

export function sendTo(state: GameState, playerId: string, msg: ServerMsg): void {
  state.outbox.push({ to: playerId, msg });
}

export function broadcast(state: GameState, msg: ServerMsg): void {
  state.outbox.push({ to: "all", msg });
}
