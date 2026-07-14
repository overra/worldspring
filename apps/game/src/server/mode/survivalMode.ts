// The flagship survival mode: the per-tick gameplay composition extracted verbatim
// from GameRoom.tick() (docs/plans/00, engine⟷game seam). Behaviour and phase
// telemetry are IDENTICAL to the pre-seam monolithic tick — this is a pure move,
// verified bit-identical by the loadtest + worldgen fingerprint. The individual
// systems still live in ../systems and are still called by GameRoom for message
// handlers + world seeding; only the tick ORDER lives here now.
import type { GameMode, ModeTickCtx, PhaseTimer } from "./GameMode";
import type { GameState, ServerPlayer } from "../systems/state";
import { DECAY_SWEEP_INTERVAL_S } from "@worldspring/shared/constants";
import { performAttack } from "../systems/combat";
import { createPlayer, respawnPlayer, stepPortals, tickActiveActions } from "../systems/players";
import { spawnInitialProps } from "../systems/props";
import { sweepDecay, tickStructures } from "../systems/structures";
import { tickAmbientSeeds, tickTreeGrowth, tickTrunks } from "../systems/trees";
import { spawnInitialZombies, tickZombieRespawns, tickZombies } from "../systems/zombies";
import { tickFires, tickSurvival } from "../systems/survival";
import { tickWeather } from "../systems/weather";
import { tickAirdrops } from "../systems/airdrops";
import { spawnInitialDeer, tickDeerRespawns, tickWildlife } from "../systems/wildlife";
import { spawnInitialVehicles } from "../systems/vehicles";
import { stockInitialLoot, tickCorpses, tickDroppedLoot, tickLootRespawns } from "../systems/loot";

export const survivalMode: GameMode = {
  id: "survival",

  simBeforePhysics(game: GameState, dt: number, phase: PhaseTimer, ctx: ModeTickCtx): void {
    // doc 06 M7 — stamp owner presence (the offline-shield grace window reads it)
    // BEFORE attacks resolve, and run the decay sweep on its cadence.
    tickStructures(game, ctx.lastSeenMs);
    phase("structures");
    // Channeled actions (doc 11) advance HERE — load-bearing ordering: this MUST
    // run AFTER applyQueuedInputs (so it reads THIS tick's freshly-computed
    // movedThisTick for the move-cancel rule) and BEFORE attack resolution.
    tickActiveActions(game, dt);
    // Attacks resolve after this tick's movement so aim is current; the
    // client-reported aim time rides along for target rewind (lag comp).
    for (const player of game.players.values()) {
      if (player.wantsAttack) {
        player.wantsAttack = false;
        const aimTime = player.wantsAttackAt ?? undefined;
        player.wantsAttackAt = null;
        if (player.alive) performAttack(game, player, aimTime);
      }
    }
    // Portal crossings resolve against this tick's post-movement positions.
    stepPortals(game);
    phase("actions");
  },

  simAfterPhysics(game: GameState, dt: number, phase: PhaseTimer): void {
    // Tree lifecycle — cap-evicted trunks pay their wood out where they rested;
    // budgeted ambient seed rain + the wall-clock growth-stage scan.
    tickTrunks(game);
    tickAmbientSeeds(game);
    tickTreeGrowth(game);
    phase("trees");
    tickZombies(game, dt);
    tickZombieRespawns(game, dt);
    phase("zombies");
    tickSurvival(game, dt);
    tickWeather(game, dt);
    tickAirdrops(game, dt);
    phase("survival");
    tickWildlife(game, dt);
    tickDeerRespawns(game, dt);
    phase("wildlife");
    tickFires(game, dt);
    tickLootRespawns(game, dt);
    tickCorpses(game, dt);
    tickDroppedLoot(game, dt);
    phase("world");
  },

  onWorldReady(game: GameState, fresh: boolean, ctx: ModeTickCtx): void {
    // loadWorld hydrated loot/corpses/fires/timers (and rebuilt vehicles/barrels
    // from the persisted bodies snapshot) for a RESTORED world; a fresh database
    // stocks them here instead — never both, so nothing double-spawns.
    if (fresh) {
      stockInitialLoot(game);
      // doc 13 M3/M4 — deterministic barrels + vehicles (buffer in PhysicsSystem
      // until the async engine attaches).
      spawnInitialProps(game);
      spawnInitialVehicles(game);
    }
    // Zombies and deer are never persisted — always spawn fresh.
    spawnInitialZombies(game);
    spawnInitialDeer(game);
    // doc 06 M7 — boot decay sweep: an abandoned base disappears the first time
    // anyone wakes the room past the window; the tick's tickStructures owns the
    // cadence from here.
    sweepDecay(game, ctx.lastSeenMs);
    game.decayNextAt = game.time + DECAY_SWEEP_INTERVAL_S;
  },

  // Player lifecycle — survival's answers delegate verbatim to systems/players.ts
  // (a fresh beach spawn with the starting loadout) and the operator-tuned
  // respawn delay. Behaviour is identical to the pre-seam direct calls.
  createPlayer(game: GameState, id: string, name: string, tokenHash: string): ServerPlayer {
    return createPlayer(game, id, name, tokenHash);
  },

  respawnPlayer(game: GameState, player: ServerPlayer): void {
    respawnPlayer(game, player);
  },

  respawnDelayS(game: GameState): number {
    return game.config.session.respawnDelayS;
  },

  // Survival scores finished lives on the persisted longest-life leaderboard
  // (the engine's death sink), not per-kill — so a kill needs no mode reaction.
  onKill(): void {},
};
