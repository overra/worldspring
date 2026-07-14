// The engine ⟷ game seam (docs/plans/00). The ENGINE owns the tick scaffolding
// (upkeep, input application, fog, the physics step, lag-comp history, persistence,
// snapshot broadcast) and the deterministic sim primitives. A GameMode owns the
// GAMEPLAY that runs each tick — for the flagship that's survival (vitals, zombies,
// loot, building, wildlife, ...). This first increment (incremental internal seam)
// extracts the per-tick sim COMPOSITION out of GameRoom into a mode object; the
// individual systems stay in ./systems, and GameRoom still calls them directly for
// message handlers + world seeding. The GameState core/slice split, a mode-owned
// snapshot contribution, and physical @worldspring/engine + mode-survival packages
// are later increments.
import type { GameState, ServerPlayer } from "../systems/state";

/** Stamps the cost since the previous stamp into a named /api/health phase bucket. */
export type PhaseTimer = (label: string) => void;

/** Engine-provided callbacks a mode's tick may need. Kept tiny on purpose. */
export interface ModeTickCtx {
  /** doc 06 — owner-presence lookup (ms) for the offline-raid shield grace window. */
  lastSeenMs: (ownerHash: string) => number | null;
}

/**
 * A game mode is the set of per-tick gameplay phases the engine runs between its
 * own `inputs` (movement + fog) and `physics` phases, and again after `physics`.
 * The split around the physics step is load-bearing: some gameplay reads
 * pre-step positions (structure presence, channels, attacks, portals) and some
 * must run after bodies have moved (vehicles' riders, tree/loot/entity ticks).
 *
 * Phase ORDER within each hook is a hard contract (see the survival mode for the
 * load-bearing comments) and each hook stamps the same /api/health phase labels
 * the monolithic tick used, so telemetry is unchanged across the extraction.
 */
export interface GameMode {
  readonly id: string;
  /** Gameplay after the engine's input+fog phase, before the physics step. */
  simBeforePhysics(game: GameState, dt: number, phase: PhaseTimer, ctx: ModeTickCtx): void;
  /** Gameplay after the engine's physics step, before lag-comp history. */
  simAfterPhysics(game: GameState, dt: number, phase: PhaseTimer): void;
  /**
   * Seed the world when the room boots, after the engine has created the world +
   * GameState and attempted to restore a persisted one. `fresh` is false when a
   * saved world was loaded (so fresh-only spawns are skipped and rebuilt from the
   * persisted snapshot instead). Owns any always-fresh entities and boot upkeep.
   */
  onWorldReady(game: GameState, fresh: boolean, ctx: ModeTickCtx): void;

  // --- Player lifecycle (docs/plans/00 decision 4) --------------------------
  //
  // The mode owns WHERE a player enters and WHAT they carry — the flagship's
  // beach spawn + starting loadout is one mode's answer; an arena's spread
  // spawn + combat kit is another. The ENGINE (GameRoom) still owns the
  // plumbing around these: sockets, the players map, persistence + the
  // adopt/resume/new join-identity decision, testbed provisioning, and the
  // welcome/snapshot. It calls these at the two gameplay decision points a
  // joining or dying player hits.
  //
  // Granularity is whole-function-with-delegation, not a spawn-state callback,
  // because the survival spawn logic lives in ../systems/players.ts, which the
  // mode already imports — so the mode delegates INTO players.ts rather than
  // players.ts reaching back for a mode (which would be an import cycle). A
  // future engine/mode-survival package split extracts the reusable skeleton
  // (transient-field construction) so a mode fills only the spawn state; until
  // then survival owns the whole body and byte-identity is trivial.

  /**
   * Build a brand-new player entering the world for the first life: construct
   * the ServerPlayer, place it, kit it out, and insert it into `game.players`.
   * The caller (join path 3 — a fresh/dead-row identity) then layers on host
   * concerns (keep-inventory restore, testbed seeding, welcome). Survival:
   * random beach spawn, full vitals, flashlight + bandage (+ map).
   */
  createPlayer(game: GameState, id: string, name: string, tokenHash: string): ServerPlayer;

  /**
   * Re-spawn an existing dead player in place (mutates them alive again). The
   * engine gates this on `respawnDelayS` before calling. Survival: fresh beach
   * spawn + full vitals, keeping or resetting the loadout per `pvp.fullLoot`,
   * and restarting the per-life stats.
   */
  respawnPlayer(game: GameState, player: ServerPlayer): void;

  /**
   * Game-seconds a dead player must wait after `diedAt` before a respawn
   * request is honored. Survival returns the operator-tuned
   * `config.session.respawnDelayS`; a round-based mode can gate on match state.
   */
  respawnDelayS(game: GameState): number;

  /**
   * One player killed another in PvP combat. Called from the two combat kill
   * sites (melee + ranged) at the living→dead transition — `killer` and
   * `victim` are the real ServerPlayers, so a mode scores frags directly with
   * no fragile name-matching. `victim` is already dead (a respawn is the mode's
   * to schedule). Survival: no-op (its scoring is the persisted longest-life
   * leaderboard, written by the engine's death sink). Arena: award the frag and
   * check the round win condition. NOT called for non-PvP deaths (starvation,
   * zombies, the give-up respawn) — those have no killer.
   */
  onKill(game: GameState, killer: ServerPlayer, victim: ServerPlayer): void;
}
