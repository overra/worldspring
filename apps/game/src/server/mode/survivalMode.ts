// The flagship survival mode: the per-tick gameplay composition extracted verbatim
// from GameRoom.tick() (docs/plans/00, engine⟷game seam). Behaviour and phase
// telemetry are IDENTICAL to the pre-seam monolithic tick — this is a pure move,
// verified bit-identical by the loadtest + worldgen fingerprint. The individual
// systems still live in ../systems and are still called by GameRoom for message
// handlers + world seeding; only the tick ORDER lives here now.
import type { GameMode, ModeTickCtx, PhaseTimer } from "./GameMode";
import type { GameState } from "../systems/state";
import { performAttack } from "../systems/combat";
import { stepPortals, tickActiveActions } from "../systems/players";
import { tickStructures } from "../systems/structures";
import { tickAmbientSeeds, tickTreeGrowth, tickTrunks } from "../systems/trees";
import { tickZombieRespawns, tickZombies } from "../systems/zombies";
import { tickFires, tickSurvival } from "../systems/survival";
import { tickWeather } from "../systems/weather";
import { tickAirdrops } from "../systems/airdrops";
import { tickDeerRespawns, tickWildlife } from "../systems/wildlife";
import { tickCorpses, tickDroppedLoot, tickLootRespawns } from "../systems/loot";

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
};
