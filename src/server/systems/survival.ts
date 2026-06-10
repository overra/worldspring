// Per-tick vitals: hunger/thirst decay, starvation/dehydration drain, regen,
// body temperature vs time-of-day and campfires, and centralized damage/death
// handling (death bags, death message, global notice).

import {
  AMBIENT_WARM_HOUR_END,
  AMBIENT_WARM_HOUR_START,
  DAY_DURATION_S,
  FIRE_WARMTH_RADIUS,
  FOOD_DECAY_PER_S,
  FREEZE_HP_PER_S,
  MAX_HP,
  REGEN_FOOD_MIN,
  REGEN_HP_PER_S,
  REGEN_WATER_MIN,
  SPRINT_FOOD_MULT,
  STARVE_HP_PER_S,
  START_HOUR,
  TEMP_FALL_PER_S,
  TEMP_MIN,
  TEMP_NORMAL,
  TEMP_RISE_PER_S,
  TEMP_SHIVER,
  WATER_DECAY_PER_S,
} from "@/shared/constants";
import { distSq2D } from "@/shared/math";
import { gameHours, type DeathRecap } from "@/shared/protocol";
import { spawnPlayerCorpse } from "./loot";
import { sendInventory } from "./players";
import { broadcast, queueEvent, sendTo, type GameState, type ServerPlayer } from "./state";

/**
 * Persistence hook for finished lives. GameState is a pinned contract without
 * a deaths queue, so instead of queue+drain this is a callback registry (the
 * other option the persistence spec allows): GameRoom registers a sink at
 * construction and killPlayer invokes it synchronously after all death-state
 * mutation, so the sink sees the victim's final state (offline flag included)
 * and can write the leaderboard row + character row in the same tick.
 */
export type DeathSink = (victim: ServerPlayer, recap: DeathRecap) => void;

let deathSink: DeathSink | null = null;

export function setDeathSink(sink: DeathSink | null): void {
  deathSink = sink;
}

/**
 * Apply damage to a living player. Queues a "hurt" event (victim-only) when
 * `hurt` is set — combat damage flashes the vignette, gradual survival drains
 * do not. Returns true when the damage killed the player.
 */
export function damagePlayer(
  state: GameState,
  victim: ServerPlayer,
  amount: number,
  cause: string,
  hurt = false,
): boolean {
  if (!victim.alive) return false;
  victim.vitals.hp -= amount;
  if (hurt) queueEvent(state, { e: "hurt" }, victim.core.x, victim.core.z, victim.id);
  if (victim.vitals.hp > 0) return false;
  killPlayer(state, victim, cause);
  return true;
}

/**
 * Kill a player: leave their body (with their whole inventory) where they
 * fell, tell the victim why (with a recap of the life), notify everyone, and
 * hand the recap to the death sink for persistence. A connected player stays
 * and respawns on request; an offline lingering victim is cleaned up by the
 * sink (the recap is stored for their next join instead).
 */
export function killPlayer(state: GameState, victim: ServerPlayer, cause: string): void {
  if (!victim.alive) return;
  victim.alive = false;
  victim.vitals.hp = 0;
  victim.diedAt = state.time;
  victim.cmdQueue.length = 0;
  const recap: DeathRecap = {
    by: cause,
    // Clamped: an unclean restart can roll game.time back below bornAt.
    survivedS: Math.max(0, state.time - victim.stats.bornAt),
    kills: victim.stats.kills,
    zombieKills: victim.stats.zombieKills,
    distanceM: Math.round(victim.stats.distanceM),
  };
  victim.lastRecap = recap; // dead-character takeover joins re-deliver this
  spawnPlayerCorpse(state, victim);
  sendInventory(state, victim);
  sendTo(state, victim.id, { t: "death", by: cause, recap });
  broadcast(state, { t: "notice", msg: `${victim.name} died` });
  if (deathSink) deathSink(victim, recap);
}

function nearFire(state: GameState, x: number, z: number): boolean {
  const rSq = FIRE_WARMTH_RADIUS * FIRE_WARMTH_RADIUS;
  for (const fire of state.fires) {
    if (distSq2D(x, z, fire.x, fire.z) <= rSq) return true;
  }
  return false;
}

export function tickSurvival(state: GameState, dt: number): void {
  const hour = gameHours(state.time, DAY_DURATION_S, START_HOUR);
  const ambientWarm = hour >= AMBIENT_WARM_HOUR_START && hour < AMBIENT_WARM_HOUR_END;

  for (const player of state.players.values()) {
    if (!player.alive) continue;
    const v = player.vitals;

    // Hunger/thirst decay, faster while sprinting.
    const mult = player.sprinting ? SPRINT_FOOD_MULT : 1;
    v.food = Math.max(0, v.food - FOOD_DECAY_PER_S * mult * dt);
    v.water = Math.max(0, v.water - WATER_DECAY_PER_S * mult * dt);

    // Body temperature: warm hours or a nearby campfire pull you up toward
    // normal; otherwise exposure pulls you down toward the minimum.
    if (ambientWarm || nearFire(state, player.core.x, player.core.z)) {
      v.temp = Math.min(TEMP_NORMAL, v.temp + TEMP_RISE_PER_S * dt);
    } else {
      v.temp = Math.max(TEMP_MIN, v.temp - TEMP_FALL_PER_S * dt);
    }

    // Drains. Each can kill; stop processing the player once dead.
    if (v.food <= 0 || v.water <= 0) {
      const cause = v.food <= 0 ? "starvation" : "dehydration";
      if (damagePlayer(state, player, STARVE_HP_PER_S * dt, cause)) continue;
    }
    if (v.temp < TEMP_SHIVER) {
      if (damagePlayer(state, player, FREEZE_HP_PER_S * dt, "the cold")) continue;
    }

    // Regen while well fed and hydrated.
    if (v.hp < MAX_HP && v.food > REGEN_FOOD_MIN && v.water > REGEN_WATER_MIN) {
      v.hp = Math.min(MAX_HP, v.hp + REGEN_HP_PER_S * dt);
    }
  }
}

/** Burn down campfires and remove the ones that expired. */
export function tickFires(state: GameState, dt: number): void {
  for (let i = state.fires.length - 1; i >= 0; i--) {
    const fire = state.fires[i];
    fire.burnRemaining -= dt;
    if (fire.burnRemaining <= 0) state.fires.splice(i, 1);
  }
}
