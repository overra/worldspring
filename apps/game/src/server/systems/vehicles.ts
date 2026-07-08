// doc 13 M4 — vehicles v1: a rugged, server-authoritative ground buggy.
//
// A vehicle is a dynamic "vehicle" physics body (PhysicsSystem) PLUS a gameplay
// meta record (VehicleMeta in state.ts): fuel, hull hp, seat occupancy, and the
// latest driver input. This module owns the gameplay half; the driven-body
// CONTROLLER itself lives on PhysicsSystem.driveVehicle (engine-adjacent, so the
// replay harness exercises production code and determinism is pinned there).
//
// DISCIPLINE (doc 13 §"Threatens"): NO client-side prediction. The server steps
// the hull in the physics tick; clients interpolate its WireBody pose exactly
// like trunks/barrels. Players stay KINEMATIC — a seated player's walking is
// short-circuited in the input handler (applyQueuedInputs), their steering rides
// a separate `drive` ClientMsg, and their core is synced to the hull here. The
// shared movement.ts integrator is untouched.
//
// DETERMINISM: spawn placement is the pure, seeded vehicleSpawns (shared/
// vehicles.ts) — ZERO worldgen rng, so the fingerprint is byte-identical. The
// controller reads only server state + parse-clamped, fuel-gated driver input.

import {
  FUEL_PER_CAN,
  MAX_VEHICLES,
  PLAYER_RADIUS,
  VEHICLE_CRASH_DMG_PER_MS,
  VEHICLE_CRASH_MAX_LATERAL,
  VEHICLE_CRASH_MIN_DROP,
  VEHICLE_ENTER_RANGE,
  VEHICLE_EXIT_RAM_GRACE_S,
  VEHICLE_FUEL_BURN_PER_S,
  VEHICLE_FUEL_MAX,
  VEHICLE_HALF_X,
  VEHICLE_HALF_Y,
  VEHICLE_HP_MAX,
  VEHICLE_INPUT_STALE_S,
  VEHICLE_RAM_COOLDOWN_S,
  VEHICLE_RAM_DMG_PER_SPEED,
  VEHICLE_RAM_MAX_DMG,
  VEHICLE_RAM_MIN_SPEED,
  VEHICLE_RAM_RADIUS,
  VEHICLE_SEATS,
  WATER_WALK_MIN,
} from "@worldspring/shared/constants";
import { distSq2D } from "@worldspring/shared/math";
import { resolveStatics } from "@worldspring/shared/movement";
import { vehicleSpawns } from "@worldspring/shared/vehicles";
import type { VehicleSensors } from "../physics/PhysicsSystem";
import { meleeBlocked } from "./combat";
import { countOf, removeFromInventory, sendInventory } from "./players";
import { queueEvent, sendTo, type GameState, type ServerPlayer, type VehicleMeta } from "./state";
import { damagePlayer } from "./survival";
import { killZombie } from "./zombies";

/** Lift the hull base a hair above the sampled heightfield seam at spawn (the
 * trunk/barrel spawn-lift precedent — the physics terrain is sampled, so a flush
 * base could start intersecting it and pop). */
const VEHICLE_SPAWN_LIFT = 0.3;
/** How far to place an exiting/ejected player from the hull center. */
const VEHICLE_EXIT_OFFSET = VEHICLE_HALF_X + 1.4;

const ZERO_INPUT = { throttle: 0, steer: 0, brake: 0 } as const;

/**
 * Spawn the world's deterministic vehicles as dynamic bodies + meta. Called ONCE
 * at boot on a FRESH world (GameRoom's stockInitialLoot branch); a RESTORED world
 * rebuilds vehicles from the persisted `bodies` + `vehicles` snapshots instead,
 * so this never double-spawns (the barrel precedent). No-op when physics is off.
 */
export function spawnInitialVehicles(state: GameState): void {
  if (!state.config.physics.enabled) return;
  for (const s of vehicleSpawns(state.world, MAX_VEHICLES)) {
    const id = state.nextEntityId++;
    state.physics.spawnBody(id, "vehicle", s.x, s.y + VEHICLE_HALF_Y + VEHICLE_SPAWN_LIFT, s.z);
    state.vehicleMeta.set(id, freshVehicleMeta(id, VEHICLE_FUEL_MAX, VEHICLE_HP_MAX, false));
  }
}

/** A default-transient meta for a fresh or restored vehicle (seats empty, input
 * idle) — the persisted trio (fuel/hp/wrecked) is supplied by the caller. */
export function freshVehicleMeta(
  id: number,
  fuel: number,
  hp: number,
  wrecked: boolean,
): VehicleMeta {
  return {
    id,
    fuel,
    hp,
    wrecked,
    seats: new Array(VEHICLE_SEATS).fill(null),
    input: { throttle: 0, steer: 0, brake: 0 },
    lastInputAt: 0,
    lastForward: 0,
    ramCooldown: 0,
  };
}

// --- Seat protocol ---

/** doc 13 M4 — board vehicle `id` at `seat`. Requires: alive, overworld (bodies
 * are overworld-only), on foot, an in-range vehicle that isn't wrecked, and an
 * EMPTY seat. Rejections are silent (no round-trip cost) except a couple of
 * useful notices. */
export function enterVehicle(state: GameState, player: ServerPlayer, id: number, seat: number): void {
  if (!player.alive || player.realm !== "overworld") return;
  if (player.seatedVehicle !== null) return; // already seated
  if (seat < 0 || seat >= VEHICLE_SEATS) return;
  const meta = state.vehicleMeta.get(id);
  if (!meta || meta.wrecked) return;
  if (meta.seats[seat] !== null) {
    sendTo(state, player.id, { t: "notice", msg: "Seat taken" });
    return;
  }
  const s = state.physics.vehicleSensors(id);
  if (!s) return; // body not materialized yet (pre-attach) — can't board
  if (distSq2D(player.core.x, player.core.z, s.x, s.z) > VEHICLE_ENTER_RANGE * VEHICLE_ENTER_RANGE) {
    return; // out of range
  }
  meta.seats[seat] = player.tokenHash;
  player.seatedVehicle = id;
  player.seatIndex = seat;
  player.core.vy = 0;
  player.core.grounded = true;
  player.cmdQueue.length = 0;
  if (seat === 0) meta.input = { ...ZERO_INPUT }; // a fresh driver starts idle
}

/** doc 13 M4 — leave the seat you're in; place you on valid ground beside the
 * hull. No-op on foot. */
export function exitVehicle(state: GameState, player: ServerPlayer): void {
  const id = player.seatedVehicle;
  if (id === null) return;
  const s = state.physics.vehicleSensors(id);
  placeBesideVehicle(state, player, s);
  // Grace so the hull you just left can't roadkill you: the exit spot can sit
  // inside VEHICLE_RAM_RADIUS while the (still-moving) hull coasts past.
  player.ramGrace = { vehicle: id, until: state.time + VEHICLE_EXIT_RAM_GRACE_S };
  vacateSeat(state, player);
}

/**
 * doc 13 M4 — free a player's seat WITHOUT placing them (used by GameRoom on
 * disconnect/logout, and internally after placement). Clears the seat slot and
 * the player's seat fields; a departing DRIVER resets the vehicle to idle input
 * so a leftover throttle can't keep driving a driverless hull. Idempotent.
 */
export function vacateSeat(state: GameState, player: ServerPlayer): void {
  const id = player.seatedVehicle;
  if (id === null) return;
  const meta = state.vehicleMeta.get(id);
  if (meta) {
    for (let i = 0; i < meta.seats.length; i++) {
      if (meta.seats[i] === player.tokenHash) meta.seats[i] = null;
    }
    if (player.seatIndex === 0) meta.input = { ...ZERO_INPUT };
  }
  player.seatedVehicle = null;
  player.seatIndex = -1;
}

/** doc 13 M4 — record the DRIVER's control for next tick's step. Passengers and
 * non-drivers are ignored (only seat 0 steers). Input is already parse-clamped. */
export function driveInput(
  state: GameState,
  player: ServerPlayer,
  throttle: number,
  steer: number,
  brake: number,
): void {
  if (player.seatedVehicle === null || player.seatIndex !== 0) return;
  const meta = state.vehicleMeta.get(player.seatedVehicle);
  if (!meta || meta.wrecked) return;
  meta.input = { throttle, steer, brake };
  meta.lastInputAt = state.time;
}

/** doc 13 M4 — top up a nearby vehicle's tank from ONE fuel item in inventory. */
export function refuelVehicle(state: GameState, player: ServerPlayer, id: number): void {
  if (!player.alive || player.realm !== "overworld") return;
  const meta = state.vehicleMeta.get(id);
  if (!meta) return;
  const s = state.physics.vehicleSensors(id);
  if (!s) return;
  if (distSq2D(player.core.x, player.core.z, s.x, s.z) > VEHICLE_ENTER_RANGE * VEHICLE_ENTER_RANGE) {
    return;
  }
  if (meta.fuel >= VEHICLE_FUEL_MAX) {
    sendTo(state, player.id, { t: "notice", msg: "Tank full" });
    return;
  }
  if (countOf(player.inventory, "fuel") <= 0) {
    sendTo(state, player.id, { t: "notice", msg: "No fuel to add" });
    return;
  }
  removeFromInventory(player.inventory, "fuel", 1);
  meta.fuel = Math.min(VEHICLE_FUEL_MAX, meta.fuel + FUEL_PER_CAN);
  sendInventory(state, player);
  sendTo(state, player.id, { t: "notice", msg: "Refueled" });
}

// --- Tick ---

/**
 * doc 13 M4 — PRE-step: apply each driven vehicle's control to its hull body
 * (must run BEFORE game.physics.step so the impulses ride this tick's substeps).
 * Throttle is fuel-gated (an empty tank produces no drive force — the hull
 * coasts); fuel burns proportional to throttle. Wrecked and driverless vehicles
 * get no control.
 */
export function stepVehicles(state: GameState, dt: number): void {
  for (const meta of state.vehicleMeta.values()) {
    if (meta.wrecked) {
      meta.input = { ...ZERO_INPUT };
      continue;
    }
    if (meta.seats[0] === null) continue; // no driver → no control
    // Stale-input guard: if no fresh `drive` arrived within the window (the
    // client backgrounded its rAF send loop, stalled, or silently dropped), the
    // stored throttle/steer go IDLE so the hull coasts to a stop instead of
    // ghost-driving on a leftover value until the tank empties.
    if (state.time - meta.lastInputAt > VEHICLE_INPUT_STALE_S) meta.input = { ...ZERO_INPUT };
    const inp = meta.input;
    const effThrottle = meta.fuel > 0 ? inp.throttle : 0;
    state.physics.driveVehicle(meta.id, effThrottle, inp.steer, inp.brake, dt);
    if (meta.fuel > 0 && effThrottle !== 0) {
      meta.fuel = Math.max(0, meta.fuel - VEHICLE_FUEL_BURN_PER_S * Math.abs(effThrottle) * dt);
    }
  }
}

/**
 * doc 13 M4 — POST-step: read each hull's new pose/velocity and resolve gameplay:
 * (1) CRASH damage — a large single-tick drop in forward-speed magnitude (a wall
 *     stops the hull far faster than the bounded brake ever can) chips hull hp;
 * (2) RAM damage — a fast-moving hull damages zombies/players inside its reach
 *     (rate-limited by a per-vehicle cooldown so it can't machine-gun);
 * (3) WRECK — hp<=0 immobilizes the hull and safely ejects its riders;
 * (4) RIDER SYNC — seated players' cores follow the hull (kinematic, no walking).
 */
export function tickVehicles(state: GameState, dt: number): void {
  for (const meta of state.vehicleMeta.values()) {
    if (meta.ramCooldown > 0) meta.ramCooldown -= dt;
    const s = state.physics.vehicleSensors(meta.id);
    if (!s) continue;

    if (!meta.wrecked) {
      // (1) Crash: a large single-tick DROP in |forward speed| — a wall stops the
      // hull far faster than the bounded brake ever can. But a big forward-speed
      // drop ALSO happens with NO impact during a hard drift/donut: as the hull
      // yaws, the (lagging) velocity swings sideways relative to the new facing,
      // so v·forward collapses while the car keeps moving. The tell is lateral
      // speed: a genuine head-on impact has the velocity aligned with the facing
      // (lateral ~0), a drift has it swung sideways (lateral high). Gate on low
      // lateral so cornering can't self-wreck the buggy on open ground.
      const drop = Math.abs(meta.lastForward) - Math.abs(s.forward);
      const lateral = Math.sqrt(Math.max(0, s.speed * s.speed - s.forward * s.forward));
      if (drop > VEHICLE_CRASH_MIN_DROP && lateral < VEHICLE_CRASH_MAX_LATERAL) {
        damageVehicle(state, meta, (drop - VEHICLE_CRASH_MIN_DROP) * VEHICLE_CRASH_DMG_PER_MS, s);
      }
      // (2) Ram: a fast hull hurts everything it plows through (cooldown-gated).
      if (!meta.wrecked && s.speed > VEHICLE_RAM_MIN_SPEED && meta.ramCooldown <= 0) {
        if (ramTargets(state, meta, s)) meta.ramCooldown = VEHICLE_RAM_COOLDOWN_S;
      }
    }
    meta.lastForward = s.forward;
  }

  // (4) Rider sync — after the wreck pass (which may have ejected riders).
  for (const player of state.players.values()) {
    if (player.seatedVehicle === null) continue;
    const s = state.physics.vehicleSensors(player.seatedVehicle);
    if (!s) continue;
    player.core.x = s.x;
    player.core.z = s.z;
    // Sit at ~ground level so the follow camera's eye height reads normally.
    player.core.y = s.y - VEHICLE_HALF_Y;
    player.core.vy = 0;
    player.core.grounded = true;
  }
}

/** Apply hull damage; hp<=0 wrecks the vehicle and safely spills its riders. */
function damageVehicle(state: GameState, meta: VehicleMeta, dmg: number, s: VehicleSensors): void {
  if (dmg <= 0 || meta.wrecked) return;
  meta.hp -= dmg;
  // A spark at the hull so the impact reads on every nearby client.
  queueEvent(state, { e: "hit", x: s.x, y: s.y, z: s.z }, s.x, s.z);
  if (meta.hp > 0) return;
  meta.hp = 0;
  meta.wrecked = true;
  meta.input = { ...ZERO_INPUT };
  // Spill every rider out onto valid ground beside the hulk.
  for (const player of state.players.values()) {
    if (player.seatedVehicle !== meta.id) continue;
    placeBesideVehicle(state, player, s);
    sendTo(state, player.id, { t: "notice", msg: "The vehicle is wrecked!" });
    vacateSeat(state, player);
  }
}

/** Damage every zombie/player inside the hull's ram reach. Returns true if any
 * target was struck (so the caller starts the ram cooldown). */
function ramTargets(state: GameState, meta: VehicleMeta, s: VehicleSensors): boolean {
  const dmg = Math.min(VEHICLE_RAM_MAX_DMG, (s.speed - VEHICLE_RAM_MIN_SPEED) * VEHICLE_RAM_DMG_PER_SPEED);
  if (dmg <= 0) return false;
  const rSq = VEHICLE_RAM_RADIUS * VEHICLE_RAM_RADIUS;
  let hit = false;
  for (const zombie of state.zombies.values()) {
    if (distSq2D(s.x, s.z, zombie.x, zombie.z) > rSq) continue;
    // Wall occlusion — the same discipline melee/ranged enforce: a target behind
    // a wall from the hull can't be plowed through it.
    if (meleeBlocked(state, s.x, s.y, s.z, zombie.x, zombie.y, zombie.z)) continue;
    zombie.hp -= dmg;
    queueEvent(state, { e: "hit", x: zombie.x, y: zombie.y + 1, z: zombie.z }, zombie.x, zombie.z);
    if (zombie.hp <= 0) killZombie(state, zombie);
    hit = true;
  }
  // PvP off: players are never ram targets (zombies still are), matching the
  // melee/ranged PvP gate. Never ram your OWN riders.
  if (state.config.pvp.enabled) {
    for (const player of state.players.values()) {
      if (!player.alive || player.seatedVehicle === meta.id) continue;
      // A rider who just left THIS hull is ram-immune for a short grace, so
      // bailing out of a moving car doesn't roadkill them as it coasts past.
      if (player.ramGrace && player.ramGrace.vehicle === meta.id && state.time < player.ramGrace.until) continue;
      if (distSq2D(s.x, s.z, player.core.x, player.core.z) > rSq) continue;
      if (meleeBlocked(state, s.x, s.y, s.z, player.core.x, player.core.y, player.core.z)) continue;
      damagePlayer(state, player, dmg, "roadkill", true);
      hit = true;
    }
  }
  return hit;
}

// --- Helpers ---

/**
 * Place `player` on valid ground beside the hull: try right/left/behind/front of
 * the vehicle's facing at a fixed offset, pick the first candidate that is not in
 * deep water/void and push it clear of any wall (shared resolveStatics). Falls
 * back to the right-side spot if every candidate is over water (never inside the
 * hull, never in the sea if we can help it). `s` null (body gone) leaves the
 * player where they are.
 */
function placeBesideVehicle(state: GameState, player: ServerPlayer, s: VehicleSensors | null): void {
  if (!s) return;
  // Right vector on XZ (perpendicular to the forward vector).
  const rx = s.fz;
  const rz = -s.fx;
  const candidates: Array<[number, number]> = [
    [s.x + rx * VEHICLE_EXIT_OFFSET, s.z + rz * VEHICLE_EXIT_OFFSET],
    [s.x - rx * VEHICLE_EXIT_OFFSET, s.z - rz * VEHICLE_EXIT_OFFSET],
    [s.x - s.fx * VEHICLE_EXIT_OFFSET, s.z - s.fz * VEHICLE_EXIT_OFFSET],
    [s.x + s.fx * VEHICLE_EXIT_OFFSET, s.z + s.fz * VEHICLE_EXIT_OFFSET],
  ];
  let px = candidates[0][0];
  let pz = candidates[0][1];
  for (const [cx, cz] of candidates) {
    if (state.world.heightAt(cx, cz) < WATER_WALK_MIN) continue; // not the sea/void
    px = cx;
    pz = cz;
    break;
  }
  // Push out of any wall the spot landed inside (spawning in geometry is worse
  // than a slightly-off placement).
  [px, pz] = resolveStatics(state.world, px, pz, player.core.y, PLAYER_RADIUS);
  player.core.x = px;
  player.core.z = pz;
  player.core.y = state.world.groundHeight(px, pz);
  player.core.vy = 0;
  player.core.grounded = true;
}

/**
 * doc 13 M4 — the WirePlayer ids seated in a vehicle, by seat index (null =
 * empty). Maps the meta's stored tokenHashes to live player ids for the wire so
 * clients can hide riders' walking avatars. O(seats × players) — trivial at a
 * handful of vehicles and ≤ MAX_PLAYERS.
 */
export function seatPlayerIds(state: GameState, meta: VehicleMeta): (string | null)[] {
  return meta.seats.map((hash) => {
    if (hash === null) return null;
    for (const player of state.players.values()) {
      if (player.tokenHash === hash) return player.id;
    }
    return null;
  });
}
