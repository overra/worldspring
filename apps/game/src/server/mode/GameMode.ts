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
import type { GameState } from "../systems/state";

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
}
