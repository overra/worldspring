// Authoritative server-side game state. Systems are pure-ish functions that
// take this state and mutate it in place. Outbound traffic is queued rather
// than sent directly: world-visible VFX go into `events` (interest-filtered
// per recipient at snapshot time), direct/broadcast messages go into `outbox`
// (drained by GameRoom after each handled message and each tick).

import type { ServerConfig } from "@worldspring/shared/config";
import { LAG_COMP_MAX_REWIND_S } from "@worldspring/shared/constants";
import type { ExploredGrid } from "@worldspring/shared/fog";
import type { ItemStack, ItemType } from "@worldspring/shared/items";
import type {
  ChannelKind,
  DeathRecap,
  GameEvent,
  InputCmd,
  PlayerCore,
  Realm,
  ServerMsg,
  Vitals,
  WornState,
  ZombieState,
} from "@worldspring/shared/protocol";
import { pieceAabbs } from "@worldspring/shared/structures";
import type { World } from "@worldspring/shared/world";
import { PhysicsSystem } from "../physics/PhysicsSystem";

/**
 * A server-authoritative channeled (timed) action in progress (doc 11). The
 * primitive does not interpret `arg` — the per-kind completion fn does. Lives
 * on ServerPlayer as a transient field (never persisted); a non-null value
 * means the player is mid-cast. See startChannel / tickActiveActions in
 * systems/players.ts.
 */
export interface ActiveAction {
  kind: ChannelKind;
  /**
   * Inventory slot the cast's effect resolves against (which stack to consume on
   * completion). use/cook bind to the consumable slot; craft uses -1 (no source
   * slot). NOT the slot-swap interrupt key — that cancels at the equip site
   * (equipSlot), so a use issued from the inventory panel on a non-equipped slot
   * still completes.
   */
  slot: number;
  /** Opaque per-kind payload resolved at completion (e.g. a recipe index). */
  arg: number;
  /** Full cast duration in game-seconds (the bar's denominator). */
  totalS: number;
  /** Game-seconds left; counted down by tickActiveActions, completes at <= 0. */
  remainingS: number;
}

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
  /**
   * Worn equipment (doc 05 M6): body = jacket (insulation multiplies the
   * survival temp-fall terms), back = backpack (extraSlots extends `inventory`
   * with pack slots 8+ while worn). Persisted additively as
   * `CharacterState.worn`; on a fullLoot death the corpse takes both and this
   * resets to nulls (spawnPlayerCorpse).
   */
  worn: WornState;
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
  /**
   * Lag compensation: client-reported game-time their screen showed when the
   * pending attack was fired (`attack.at`). Consumed together with
   * `wantsAttack`; null/absent = resolve against current positions. Clamped
   * at resolve time to at most LAG_COMP_MAX_REWIND_S in the past — a
   * malicious past timestamp gains no more rewind than any laggy-but-honest
   * client gets. Optional so existing construction sites need no changes.
   */
  wantsAttackAt?: number | null;
  /** Game-time seconds of the last accepted chat message (rate limit).
   * Transient — never persisted; -Infinity until the first message. */
  lastChatAt: number;
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
  /**
   * Fishing cooldown — seconds until the player may cast again.
   * Transient (never persisted); 0 at spawn / on restore.
   */
  fishCooldownT: number;
  /** doc 12 — persisted fog-of-war: cells this character has explored. */
  explored: ExploredGrid;
  /** Transient: indices revealed since the last snapshot (cleared on send). */
  fogDelta: number[];
  /** Transient: last center cell marked, so we only re-stamp on a cell cross. */
  lastFogCell: number;
  /**
   * Channeled (timed) action in progress, or null when not casting (doc 11).
   * Transient like the cooldowns above — never persisted, so a DO restart
   * mid-cast simply drops the cast. One cast at a time: a second start while
   * this is non-null is a silent no-op.
   */
  action: ActiveAction | null;
  /**
   * Set true by any hp-reducing combat hit (the same chokepoint that emits the
   * victim-only {e:"hurt"} event in damagePlayer — combat + zombie paths;
   * passive survival drains pass hurt=false and do NOT set it). Read by
   * tickActiveActions to cancel an in-progress cast, then cleared there
   * (consume-on-read): combat damage lands LATER in the tick than the channel
   * sweep, so a hit on tick N is observed on tick N+1. Transient (never
   * persisted).
   */
  tookDamageThisTick: boolean;
  /** Which realm this player is in. Render-only on the client; the sim/world
   * is identical across realms. Transient — not persisted (restored players
   * resume in the overworld). */
  realm: Realm;
  /** Portal-crossing latch: false right after a teleport so the player must
   * step OUT of the destination portal's radius before it can fire again
   * (prevents instant bounce-back). Re-armed once clear of all portals. */
  portalArmed: boolean;
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
  /** Loaded rounds of a DROPPED ranged weapon (doc 11 M3): carried through
   * drop → pickup so a fired-empty gun can't be dropped-and-recovered full
   * (ItemStack.mag reads absent as full). Absent on world-spawned loot. */
  mag?: number;
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

/** An airdrop crate (announced, falls, lands, lootable, despawns). */
export interface Airdrop {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Game-time when the crate touches down (falling until then). */
  landsAt: number;
  /** Game-time when the crate despawns. */
  expiresAt: number;
  contents: ItemStack[];
}

export type DeerState = "idle" | "wander" | "flee";

export interface Deer {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: DeerState;
  homeX: number;
  homeZ: number;
  wanderX: number;
  wanderZ: number;
  wanderWait: number;
}

export interface Campfire {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Seconds of burn time remaining. */
  burnRemaining: number;
}

/**
 * A placed red portal. Portals come in linked pairs (placeRedPortal): one in
 * the realm the player stood in, one at the same (x,z) in the destination
 * realm. They persist for the room's lifetime (no burn-down) so the player can
 * return. `realm` is the realm this portal physically lives in (interest +
 * realm filtered into snapshots); `to*` is where stepping through lands you.
 */
export interface Portal {
  id: number;
  x: number;
  y: number;
  z: number;
  realm: Realm;
  toRealm: Realm;
  toX: number;
  toZ: number;
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

/** Minimal position record cloned into the lag-comp history each tick. */
export interface PosSnapshot {
  x: number;
  y: number;
  z: number;
}

/**
 * One lag-compensation history frame: where every hittable mover stood at the
 * end of a tick, stamped with the same `time` the outgoing snapshots carry
 * (so client-reported aim times and frame times share one clock).
 */
export interface PosHistoryFrame {
  time: number;
  /** Alive, non-offline players only (offline lingerers never move — combat
   * falls back to their current position, which is exact). */
  players: Map<string, PosSnapshot>;
  zombies: Map<number, PosSnapshot>;
  animals: Map<number, PosSnapshot>;
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

/**
 * doc 06 — SERVER-ONLY per-piece extension, kept BESIDE the shared
 * world.structures index (keyed by the same piece id) so secrets never enter
 * shared code or the wire. Persisted with the world snapshot; toWirePiece
 * (systems/structures.ts) is the only wire path and copies NOTHING from this
 * map except the derived `locked` boolean.
 */
export interface StructureMeta {
  /** Placer's tokenHash — ownership key, stable like character rows. */
  ownerHash: string;
  /** Date.now() at placement — decay uses wall-clock. */
  placedAtMs: number;
  /** Door/gate 4-digit code, or null = unlocked (doc 06 M5). */
  code: string | null;
  /** tokenHashes granted via tryCode — cap 16, FIFO eviction (doc 06 M5). */
  authorized: string[];
  /** Crates only: fixed CRATE_SLOTS-length array. Slot indices are STABLE
   * identifiers — removal nulls a slot, never compacts — which is what makes
   * server-serialized concurrent cMove loss-free (doc 06 M6). Null for every
   * non-crate kind. */
  contents: (ItemStack | null)[] | null;
}

/** doc 06 M5 — per-DOOR global brute-force budget (transient; a DO restart
 * resets it by design). NEVER keyed per-identity: identities are free to
 * mint, so only a shared scarce thing (the door) can hold a budget. */
export interface DoorBackoff {
  /** Consecutive failed tryCodes (any identity combined) since the last
   * success/lockout. */
  fails: number;
  /** Game-time until which ALL tryCode on this door is rejected. */
  lockedUntil: number;
  /** Duration of the NEXT lockout — doubles per lockout, capped. */
  backoff: number;
}

export interface GameState {
  world: World;
  /** Resolved server config (deploy-time rules). Read by systems at their point
   * of use; the WIPE-class world fields here match `world` by construction. */
  config: ServerConfig;
  /** Game time in seconds since room boot. */
  time: number;
  tick: number;
  players: Map<string, ServerPlayer>;
  zombies: Map<number, Zombie>;
  loot: Map<number, LootEntity>;
  corpses: Map<number, Corpse>;
  fires: Campfire[];
  /** Placed red portals (linked pairs, persistent for the room's lifetime). */
  portals: Portal[];
  drops: Map<number, Airdrop>;
  animals: Map<number, Deer>;
  /** Rain intensity 0..1 (ramped by the weather machine). */
  weather: number;
  /** Game-time of the next weather flip and next airdrop. */
  weatherNextAt: number;
  weatherRaining: boolean;
  airdropNextAt: number;
  lootRespawns: LootRespawnTimer[];
  /** Pending zombie respawns (countdown + variant). */
  zombieRespawns: ZombieRespawn[];
  /** Pending deer respawns — seconds remaining, one entry per dead deer. */
  deerRespawns: number[];
  events: QueuedEvent[];
  outbox: OutboundMsg[];
  /** Shared id counter for zombies, loot entities and campfires. */
  nextEntityId: number;
  /** Server-auth dynamic physics (doc 13) — engine attaches async in the DO;
   * a no-op shell in harnesses/tests that never attach one. */
  physics: PhysicsSystem;
  /** doc 06 — server-only piece meta (ownership/locks/contents) beside
   * world.structures, same id space. Every mutation path keeps the two maps
   * in lockstep. */
  structureMeta: Map<number, StructureMeta>;
  /** doc 06 M5 — per-door brute-force budgets. Transient, never persisted. */
  doorBackoff: Map<number, DoorBackoff>;
  /** doc 06 M5 — per-identity tryCode anti-mash (tokenHash → last try game
   * time). UX throttle ONLY — Sybil-bypassable, so never a security control.
   * Transient. */
  codeTryAt: Map<string, number>;
  /** doc 06 M7 — tokenHash → last game-time an entry with that hash existed
   * in game.players (maintained on the tick). The offline-shield grace reads
   * this: ownerOnline holds for RAID_OFFLINE_GRACE_S after the entry leaves.
   * Transient. */
  ownerPresence: Map<string, number>;
  /** doc 06 M7 — game-time of the next decay sweep (5 game-minute cadence;
   * the boot sweep runs in ensureGame). Transient. */
  decayNextAt: number;
  /** doc 13 M2 — indices (into world.trees) of felled trees. Persisted with
   * the world snapshot; mirrored into PhysicsSystem (static-collider
   * exclusion) and to clients (welcome.felled + the per-tick delta below). */
  felledTrees: Set<number>;
  /** Transient: trees felled THIS tick — shipped as snap.felled to every
   * connected client, then cleared at end of tick (the events pattern). */
  felledDelta: number[];
  /** Transient per-tree axe-hit counters (doc 13 M2). Never persisted — a
   * partially-chopped tree "heals" across a room restart, matching doc 05's
   * transient-cooldown posture for tree state. */
  treeChops: Map<number, number>;
  /**
   * Lag-compensation ring of recent end-of-tick positions, oldest first.
   * Bounded by capturePosHistory to LAG_COMP_MAX_REWIND_S + slack — at 15Hz
   * that is ~9 frames of tiny {x,y,z} records.
   */
  posHistory: PosHistoryFrame[];
}

export function createGameState(
  world: World,
  config: ServerConfig,
): GameState {
  return {
    world,
    config,
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
    loot: new Map(),
    corpses: new Map(),
    fires: [],
    portals: [],
    drops: new Map(),
    animals: new Map(),
    weather: 0,
    weatherNextAt: 0,
    weatherRaining: false,
    airdropNextAt: 0,
    lootRespawns: [],
    zombieRespawns: [],
    deerRespawns: [],
    events: [],
    outbox: [],
    nextEntityId: 1,
    // pieceAabbs injected (doc 06) so attachEngine can build static colliders
    // for restored structures without PhysicsSystem value-importing shared
    // non-leaf modules (strip-types harness constraint).
    physics: new PhysicsSystem(world, config.physics, pieceAabbs),
    structureMeta: new Map(),
    doorBackoff: new Map(),
    codeTryAt: new Map(),
    ownerPresence: new Map(),
    decayNextAt: 0,
    felledTrees: new Set(),
    felledDelta: [],
    treeChops: new Map(),
    posHistory: [],
  };
}

/**
 * History slack kept beyond the max rewind so a frame at-or-below the clamp
 * floor still exists to bracket the oldest legal aim time. Local
 * implementation detail of the history buffer, not a gameplay tunable
 * (contract gap: not in shared constants).
 */
const POS_HISTORY_SLACK_S = 0.2;

/**
 * Push a lag-comp history frame and prune expired ones. Call once per tick
 * AFTER movement/AI systems and after `state.time` advances, so the frame's
 * positions and timestamp match what this tick's snapshots broadcast.
 */
export function capturePosHistory(state: GameState): void {
  const players = new Map<string, PosSnapshot>();
  for (const player of state.players.values()) {
    if (!player.alive || player.offline) continue;
    players.set(player.id, { x: player.core.x, y: player.core.y, z: player.core.z });
  }
  const zombies = new Map<number, PosSnapshot>();
  for (const zombie of state.zombies.values()) {
    zombies.set(zombie.id, { x: zombie.x, y: zombie.y, z: zombie.z });
  }
  const animals = new Map<number, PosSnapshot>();
  for (const deer of state.animals.values()) {
    animals.set(deer.id, { x: deer.x, y: deer.y, z: deer.z });
  }
  state.posHistory.push({ time: state.time, players, zombies, animals });

  const cutoff = state.time - (LAG_COMP_MAX_REWIND_S + POS_HISTORY_SLACK_S);
  while (state.posHistory.length > 0) {
    const oldest = state.posHistory[0];
    if (!oldest || oldest.time >= cutoff) break;
    state.posHistory.shift();
  }
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
