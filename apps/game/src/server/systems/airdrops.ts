// Airdrop scheduling and lifecycle: every AIRDROP_INTERVAL_MIN..MAX_S a crate
// is announced, falls for AIRDROP_FALL_DELAY_S onto a random inland point,
// smokes for AIRDROP_SMOKE_S and despawns at expiresAt (or immediately once
// looted empty). Crate pickup itself lives in players.ts (shared id space);
// the crate's wire shape (smoke/falling) is derived in GameRoom's snapshot.

import {
  AIRDROP_FALL_DELAY_S,
  AIRDROP_INTERVAL_MAX_S,
  AIRDROP_INTERVAL_MIN_S,
  AIRDROP_MIN_TERRAIN_H,
  AIRDROP_TTL_S,
  WORLD_SIZE,
} from "@worldspring/shared/constants";
import { AIRDROP_ROLLS, AIRDROP_TABLE, type ItemStack } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import { rollFromTable } from "./loot";
import { broadcast, type GameState } from "./state";

// Contract gaps (no shared constants; spec'd in prose as "3-6 min after boot"):
/** First drop lands this long after room boot — early players get a goal. */
const FIRST_DROP_MIN_S = 3 * 60;
const FIRST_DROP_MAX_S = 6 * 60;
/** Rejection-sampling attempts for the landing point. */
const DROP_POINT_ATTEMPTS = 40;

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Random inland landing point: terrain at least AIRDROP_MIN_TERRAIN_H (never
 * the sea or the beach), within the central 80% of the island, and outside
 * the military compound (the compound is already the high-tier zone — a crate
 * inside its walls would double-stack the risk/reward there).
 */
function pickDropPoint(state: GameState): { x: number; z: number } | null {
  const limit = WORLD_SIZE * 0.4;
  const military = state.world.military;
  const militaryRadiusSq = military.radius * military.radius;
  for (let attempt = 0; attempt < DROP_POINT_ATTEMPTS; attempt++) {
    const x = (Math.random() * 2 - 1) * limit;
    const z = (Math.random() * 2 - 1) * limit;
    if (state.world.heightAt(x, z) < AIRDROP_MIN_TERRAIN_H) continue;
    if (distSq2D(x, z, military.cx, military.cz) < militaryRadiusSq) continue;
    return { x, z };
  }
  return null;
}

export function tickAirdrops(state: GameState, dt: number): void {
  void dt; // schedule runs on absolute game time; dt kept for tick-fn symmetry

  // Scheduling is gated on loot.airdrops: 0 disables NEW drops entirely; the
  // multiplier divides the interval (2 = twice as often). The expiry sweep
  // below runs every tick REGARDLESS — gating it would strand a persisted crate
  // as an immortal entity on a world switched to airdrops:0 (§4 LIVE-class).
  const airdrops = state.config.loot.airdrops;
  if (airdrops > 0) {
    // First tick ever: schedule the boot drop. airdropNextAt === 0 is the
    // uninitialized marker (persisted worlds restore a real timestamp).
    if (state.airdropNextAt === 0) {
      state.airdropNextAt =
        state.time + randBetween(FIRST_DROP_MIN_S, FIRST_DROP_MAX_S) / airdrops;
    }

    if (state.time >= state.airdropNextAt) {
      state.airdropNextAt =
        state.time + randBetween(AIRDROP_INTERVAL_MIN_S, AIRDROP_INTERVAL_MAX_S) / airdrops;
      const pos = pickDropPoint(state);
      // No landing point found (vanishingly unlikely at 40 attempts): skip this
      // cycle entirely rather than dropping into the sea.
      if (pos) {
        const contents: ItemStack[] = [];
        for (let roll = 0; roll < AIRDROP_ROLLS; roll++) {
          contents.push(rollFromTable(AIRDROP_TABLE));
        }
        const id = state.nextEntityId++;
        const landsAt = state.time + AIRDROP_FALL_DELAY_S;
        state.drops.set(id, {
          id,
          x: pos.x,
          y: state.world.groundHeight(pos.x, pos.z),
          z: pos.z,
          landsAt,
          expiresAt: landsAt + AIRDROP_TTL_S,
          contents,
        });
        broadcast(state, { t: "notice", msg: "supply drop inbound — watch for the smoke" });
      }
    }
  }

  // Expiry: past TTL, or looted empty (players.ts removes emptied crates on
  // pickup; this also catches any crate persisted in an emptied state). Runs
  // every tick even when airdrops are disabled — existing crates age out
  // naturally and are never force-deleted at deploy (§4 LIVE-class promise).
  for (const drop of state.drops.values()) {
    if (state.time >= drop.expiresAt || drop.contents.length === 0) {
      state.drops.delete(drop.id);
    }
  }
}
