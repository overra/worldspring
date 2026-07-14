// Arena — the first non-survival GameMode (docs/plans/00). A round-based frag
// deathmatch on the same procedural island: everyone spawns with a pistol,
// fights, and the first to ARENA_FRAG_LIMIT kills wins the round; after a short
// intermission the score resets and everyone respawns for the next round.
//
// What makes it a different game is entirely in these hooks — NOT the config.
// The per-tick composition runs only the combat-relevant systems (channels +
// attack resolution + corpse cleanup); none of survival's world (zombies,
// vitals, trees, wildlife, weather, loot, building, portals) ticks. onWorldReady
// seeds nothing. The lifecycle hooks place fighters at spread spawns with a
// combat loadout and auto-respawn the dead so the fight never pauses on a death
// screen.
//
// Round state lives in this factory's closure — one instance per room (the DO
// is a singleton room), created by mode/registry.ts. It is transient by design:
// a DO restart resets the round, which is exactly right for an ephemeral match
// (arena, unlike survival, persists nothing).
import type { GameMode, PhaseTimer } from "./GameMode";
import type { GameState, ServerPlayer } from "../systems/state";
import {
  ARENA_FRAG_LIMIT,
  ARENA_ROUND_INTERMISSION_S,
  INVENTORY_SLOTS,
  MAX_FOOD,
  MAX_HP,
  MAX_WATER,
  TEMP_NORMAL,
} from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import { performAttack } from "../systems/combat";
import { addToInventory, createPlayer, respawnPlayer, sendInventory, tickActiveActions } from "../systems/players";
import { tickCorpses } from "../systems/loot";
import { broadcast } from "../systems/state";

/** Reserve 9mm handed out with the pistol (two full 30-round stacks). */
const ARENA_AMMO = 60;

export function createArenaMode(): GameMode {
  // Per-round frag tally, keyed by player id. Cleared each round.
  const scores = new Map<string, number>();
  let roundPhase: "active" | "intermission" = "active";
  let round = 1;
  let nextRoundAt = 0;

  /** Place a fighter at a random spawn with full health and the combat loadout,
   *  overwriting whatever survival spawn state a reused players.ts helper set. */
  function equip(game: GameState, player: ServerPlayer): void {
    const spawns = game.world.spawnPoints;
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    player.core = {
      x: s.x,
      y: game.world.groundHeight(s.x, s.z),
      z: s.z,
      vy: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
    };
    player.vitals = { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL };
    const inv: (ItemStack | null)[] = Array.from({ length: INVENTORY_SLOTS }, () => null);
    // A fresh pistol carries no `mag` field → reads as a full magazine.
    addToInventory(inv, "pistol", 1);
    addToInventory(inv, "ammo_9mm", ARENA_AMMO);
    player.inventory = inv;
    player.worn = { body: null, back: null };
    player.selectedSlot = 0;
    sendInventory(game, player);
  }

  /** Revive + re-kit a player: reuse survival's transient-state reset (cooldowns,
   *  channel, seat, realm) then override the spawn to arena's. */
  function reset(game: GameState, player: ServerPlayer): void {
    respawnPlayer(game, player);
    equip(game, player);
  }

  function endRound(game: GameState, winner: ServerPlayer): void {
    roundPhase = "intermission";
    nextRoundAt = game.time + ARENA_ROUND_INTERMISSION_S;
    broadcast(game, {
      t: "notice",
      msg: `${winner.name} wins round ${round} — next round in ${ARENA_ROUND_INTERMISSION_S}s`,
    });
  }

  function startRound(game: GameState): void {
    round++;
    scores.clear();
    roundPhase = "active";
    for (const player of game.players.values()) {
      if (!player.offline) reset(game, player);
    }
    broadcast(game, { t: "notice", msg: `Round ${round} — fight!` });
  }

  return {
    id: "arena",

    simBeforePhysics(game: GameState, dt: number, phase: PhaseTimer): void {
      // Combat-relevant gameplay only — reload/use channels then attack
      // resolution (same order survival runs them in), no structures/portals.
      tickActiveActions(game, dt);
      for (const player of game.players.values()) {
        if (player.wantsAttack) {
          player.wantsAttack = false;
          const aimTime = player.wantsAttackAt ?? undefined;
          player.wantsAttackAt = null;
          if (player.alive) performAttack(game, player, aimTime);
        }
      }
      phase("actions");

      // Round lifecycle. In intermission we wait out the timer; otherwise we
      // auto-respawn anyone who has served the respawn delay (arena never sits
      // on a death screen).
      if (roundPhase === "intermission") {
        if (game.time >= nextRoundAt) startRound(game);
      } else {
        const delay = game.config.session.respawnDelayS;
        for (const player of game.players.values()) {
          if (!player.alive && !player.offline && game.time - player.diedAt >= delay) {
            reset(game, player);
          }
        }
      }
      phase("arena");
    },

    simAfterPhysics(game: GameState, dt: number, phase: PhaseTimer): void {
      // The only survival entity arena leaves behind: the empty corpse husk a
      // kill drops (fullLoot:false). Tick it so husks despawn on their TTL.
      tickCorpses(game, dt);
      phase("world");
    },

    // Nothing to seed — the terrain is the engine's; fighters arrive kitted.
    onWorldReady(): void {},

    createPlayer(game: GameState, id: string, name: string, tokenHash: string): ServerPlayer {
      const player = createPlayer(game, id, name, tokenHash);
      equip(game, player);
      return player;
    },

    respawnPlayer(game: GameState, player: ServerPlayer): void {
      reset(game, player);
    },

    respawnDelayS(game: GameState): number {
      return game.config.session.respawnDelayS;
    },

    onKill(game: GameState, killer: ServerPlayer, victim: ServerPlayer): void {
      if (roundPhase !== "active") return; // no scoring between rounds
      const next = (scores.get(killer.id) ?? 0) + 1;
      scores.set(killer.id, next);
      broadcast(game, {
        t: "notice",
        msg: `${killer.name} fragged ${victim.name}  (${next}/${ARENA_FRAG_LIMIT})`,
      });
      if (next >= ARENA_FRAG_LIMIT) endRound(game, killer);
    },
  };
}
