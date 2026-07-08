// Preview-only test provisioning (doc 10 M1 + M3). Gated behind env.TESTBED,
// set ONLY by .github/workflows/preview.yml's `--var TESTBED:1` on per-PR
// worldspring-pr-<N> deploys, and NEVER declared in wrangler.jsonc (see
// env.d.ts). In prod env.TESTBED is undefined, isTestbedEnabled() is false,
// provisionTestbed() is never called, and GameRoom.handleJoin path 3 is
// byte-identical to today. There is no new authoritative wire surface: every
// mutation here goes through existing state, and the welcome's you/inv fields
// already serialize all of it.
//
// M3: provisionTestbed now walks a typed Scenario's `provision[]` (the set is
// chosen per-join via the gated join.scenario field, resolved by
// ./scenarios.ts) instead of a hardcoded loadout — so a single preview can
// switch between sets by rejoining.

import {
  CAMPFIRE_BURN_S,
  MAX_CAMPFIRES,
  VEHICLE_FUEL_MAX,
  VEHICLE_HALF_Y,
  VEHICLE_HP_MAX,
  VEHICLE_SEATS,
} from "@worldspring/shared/constants";
import { yawToDir } from "@worldspring/shared/math";
import { ITEM_DEFS, type ItemStack, type ItemType } from "@worldspring/shared/items";
import type { Provision, Scenario, ScenarioFace, ScenarioZone } from "@worldspring/shared/scenario";
import type { GameState, ServerPlayer } from "./state";

/**
 * The single prod-safety gate. True ONLY when the deploy-time var is exactly the
 * string "1" — anything else (undefined, "0", a number, "true") is off, so a
 * var-less prod deploy can never provision. Read once in the GameRoom
 * constructor; never trusted from a client.
 */
export function isTestbedEnabled(env: { TESTBED?: unknown } | undefined): boolean {
  return env?.TESTBED === "1";
}

/** Runtime narrow to a real ItemType — the guard behind the no-op-unknowns rule. */
function isItemType(id: string): id is ItemType {
  return id in ITEM_DEFS;
}

/**
 * Faithful mirror of systems/players.ts `addToInventory` (tops up existing
 * stacks, then fills empty slots; returns the leftover that didn't fit). Kept
 * inline ON PURPOSE: this module's only runtime imports are @worldspring/shared/*,
 * so the strip-types test harness (scripts/testbed-provision.mjs) can import it
 * without pulling in players.ts's sibling value-import chain (./loot), which
 * `node --experimental-strip-types` cannot resolve.
 */
function addToInventory(inv: (ItemStack | null)[], type: ItemType, count: number): number {
  const maxStack = ITEM_DEFS[type].stack;
  let remaining = count;
  for (const stack of inv) {
    if (remaining <= 0) return 0;
    if (stack && stack.type === type && stack.count < maxStack) {
      const add = Math.min(maxStack - stack.count, remaining);
      stack.count += add;
      remaining -= add;
    }
  }
  for (let i = 0; i < inv.length && remaining > 0; i++) {
    if (inv[i] !== null) continue;
    const add = Math.min(maxStack, remaining);
    inv[i] = { type, count: add };
    remaining -= add;
  }
  return remaining;
}

/**
 * Seed a freshly-created testbed player from a Scenario so a tester (human or the
 * headless harness) lands ready to QA. Walks the scenario's ordered `provision[]`
 * and mutates the already-created player + state in place through existing
 * authoritative shapes — it introduces no entity the server doesn't own, and the
 * welcome serializes a legal state. Always resets the hotbar selection.
 *
 * Called from GameRoom.handleJoin path 3 (fresh-token life) AFTER the
 * keep-inventory restore and BEFORE sendWelcome, only when isTestbedEnabled(env).
 */
export function provisionTestbed(state: GameState, player: ServerPlayer, scenario: Scenario): void {
  for (const p of scenario.provision) {
    applyProvision(state, player, p);
  }
  player.selectedSlot = 0;
}

function applyProvision(state: GameState, player: ServerPlayer, p: Provision): void {
  switch (p.kind) {
    case "position":
      applyPosition(state, player, p.zone, p.face);
      return;
    case "fire": {
      // Lit campfire AT the player's feet: distance 0 < FIRE_WARMTH_RADIUS, so
      // the server's nearFire() is true (cook venison; boil-canteen once doc 05
      // lands). Same shape as the useItem placeable branch; respect the world cap.
      if (state.fires.length >= MAX_CAMPFIRES) state.fires.shift();
      state.fires.push({
        id: state.nextEntityId++,
        x: player.core.x,
        y: state.world.groundHeight(player.core.x, player.core.z),
        z: player.core.z,
        burnRemaining: CAMPFIRE_BURN_S,
      });
      return;
    }
    case "loadout":
      // ids absent from this build are skipped (the forward-compat no-op rule).
      for (const { type, count } of p.items) {
        if (isItemType(type)) addToInventory(player.inventory, type, count);
        else console.warn(`[testbed] item "${type}" not in ITEM_DEFS on this build — skipped`);
      }
      return;
    case "vitals":
      if (p.hp !== undefined) player.vitals.hp = p.hp;
      if (p.food !== undefined) player.vitals.food = p.food;
      if (p.water !== undefined) player.vitals.water = p.water;
      if (p.temp !== undefined) player.vitals.temp = p.temp;
      return;
    case "clearCooldowns":
      // Only "attack" maps to a field that exists on main today; "respawn"/"item"/
      // "fish" have no server field yet and are intentional no-ops until the
      // systems that own them land (doc 05 fishing, etc.).
      if (p.which.includes("attack")) player.attackCooldown = 0;
      return;
    case "spawnBody": {
      // doc 13 M1 — drop `count` crates in a loose column a few meters ahead
      // of the player, high enough to visibly fall and settle. spawnBody
      // buffers if the engine hasn't attached yet and no-ops when disabled.
      if (!state.config.physics.enabled) {
        console.warn("[testbed] spawnBody ignored — config.physics.enabled is false");
        return;
      }
      const [fx, fz] = yawToDir(player.core.yaw);
      for (let i = 0; i < p.count; i++) {
        const x = player.core.x + fx * 4 + (Math.random() - 0.5) * 1.5;
        const z = player.core.z + fz * 4 + (Math.random() - 0.5) * 1.5;
        const y = state.world.groundHeight(x, z) + 4 + i * 1.1;
        state.physics.spawnBody(state.nextEntityId++, p.body, x, y, z);
      }
      return;
    }
    case "spawnVehicle": {
      // doc 13 M4 — drop ONE drivable buggy just ahead of the player on open
      // ground: a full VehicleMeta (seats/fuel/hp) + the dynamic "vehicle" body,
      // so a testbed can board and drive immediately instead of trekking to a
      // building-blocked worldgen spawn. spawnBody buffers if the engine hasn't
      // attached yet; no-op when physics is disabled. The meta literal is inlined
      // (this module's runtime imports stay @worldspring/shared-only, so the
      // strip-types harness need not pull systems/vehicles.ts's value chain — the
      // same discipline as the inlined addToInventory above).
      if (!state.config.physics.enabled) {
        console.warn("[testbed] spawnVehicle ignored — config.physics.enabled is false");
        return;
      }
      // ~2.8 m ahead: inside VEHICLE_ENTER_RANGE (3.2) so the player (and a
      // same-position passenger) boards without a walk, clear of the hull body.
      const [fx, fz] = yawToDir(player.core.yaw);
      const x = player.core.x + fx * 2.8;
      const z = player.core.z + fz * 2.8;
      const gy = state.world.groundHeight(x, z);
      const id = state.nextEntityId++;
      // Lift the hull base a hair above the sampled seam (the vehicles.ts spawn
      // lift), so it settles instead of starting intersected with the terrain.
      state.physics.spawnBody(id, "vehicle", x, gy + VEHICLE_HALF_Y + 0.3, z);
      const fuel = p.fuel === undefined ? VEHICLE_FUEL_MAX : Math.max(0, Math.min(VEHICLE_FUEL_MAX, p.fuel));
      state.vehicleMeta.set(id, {
        id,
        fuel,
        hp: VEHICLE_HP_MAX,
        wrecked: false,
        seats: new Array(VEHICLE_SEATS).fill(null),
        input: { throttle: 0, steer: 0, brake: 0 },
        lastInputAt: 0,
        lastForward: 0,
        ramCooldown: 0,
      });
      return;
    }
    default:
      // Reserved provision kinds (spawnZombie/spawnAnimal/setTime/setWeather/
      // config) are parsed by the schema but wired in M5 — inert here.
      return;
  }
}

/**
 * Place the player at a zone landmark, facing seaward or inland. The server
 * computes everything from its OWN world (spawnPoints/military/groundHeight), so
 * the client/agent never reconstruct geometry — the macOS↔Linux worldgen-drift
 * hazard is moot. The island is radial: away-from-origin is open ocean,
 * toward-origin is dry land, for any seed.
 */
function applyPosition(state: GameState, player: ServerPlayer, zone: ScenarioZone, face: ScenarioFace): void {
  let x: number;
  let z: number;
  if (zone === "military") {
    // Compound center (combat set). May land near a wall; movement collision
    // resolves it on the first tick — fine for a throwaway testbed spawn.
    x = state.world.military.cx;
    z = state.world.military.cz;
  } else if (zone === "inland") {
    // Halfway from the coast station toward the interior (dry, radial island).
    const s = state.world.spawnPoints[0] ?? { x: 0, z: 0 };
    x = s.x * 0.5;
    z = s.z * 0.5;
  } else {
    // coastal: the beach-ring march at angle 0, computed once at worldgen.
    const s = state.world.spawnPoints[0] ?? { x: 0, z: 0 };
    x = s.x;
    z = s.z;
  }
  player.core.x = x;
  player.core.z = z;
  player.core.y = state.world.groundHeight(x, z);
  // Unit vector away from origin = seaward; toward origin = inland.
  const len = Math.hypot(x, z) || 1;
  const sign = face === "ocean" ? 1 : -1;
  const dx = (sign * x) / len;
  const dz = (sign * z) / len;
  // forward = (-sin yaw, -cos yaw); solve so forward points the desired way.
  player.core.yaw = Math.atan2(-dx, -dz);
  player.core.pitch = 0;
  player.core.vy = 0;
  player.core.grounded = true;
}
