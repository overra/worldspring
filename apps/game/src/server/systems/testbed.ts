// Preview-only test provisioning (doc 10 M1). Gated behind env.TESTBED, which is
// set ONLY by .github/workflows/preview.yml's `--var TESTBED:1` on per-PR
// worldspring-pr-<N> deploys, and is NEVER declared in wrangler.jsonc (see
// env.d.ts). The official deploy is var-less, so in prod env.TESTBED is
// undefined, isTestbedEnabled() is false, provisionTestbed() is never called,
// and GameRoom.handleJoin path 3 is byte-identical to today. There is no new
// wire surface: every mutation here goes through existing authoritative state,
// and the welcome message's you/inv fields already serialize all of it.

import { CAMPFIRE_BURN_S, MAX_CAMPFIRES, TEMP_NORMAL } from "@worldspring/shared/constants";
import { ITEM_DEFS, type ItemStack, type ItemType } from "@worldspring/shared/items";
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

/**
 * Known vitals baseline so the documented deltas land observably: below the
 * caps (eat → food +, drink → water +) and above the hp floor (raw-eat → hp −).
 * See doc 10's "Open questions" — half-vitals over a full fresh spawn.
 */
export const TESTBED_VITALS = { hp: 50, food: 50, water: 20, temp: TEMP_NORMAL } as const;

/**
 * The universal testbed loadout. Keyed on STRING ids (not ItemType) on purpose:
 * naming an item absent from this build — e.g. doc 05's canteen_ and fishing_rod
 * items before they land — COMPILES today and is simply skipped at runtime (no-op),
 * then "lights up" automatically once those ids enter ITEM_DEFS. Sized to fit
 * INVENTORY_SLOTS (8): one slot per type, each count within its stack.
 */
export const TESTBED_LOADOUT: ReadonlyArray<{ id: string; count: number }> = [
  { id: "beans", count: 3 },
  { id: "water_bottle", count: 2 },
  { id: "bandage", count: 2 },
  { id: "raw_venison", count: 3 },
  { id: "canteen_empty", count: 1 },
  { id: "canteen_dirty", count: 1 },
  { id: "canteen_clean", count: 1 },
  { id: "fishing_rod", count: 1 },
];

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
 * `node --experimental-strip-types` cannot resolve. M3's scenario layer can
 * consolidate the two copies.
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
 * Seed a freshly-created testbed player so a tester (a human or the headless
 * harness) lands ready to QA: a deterministic dry-beach coast station facing the
 * ocean, a lit campfire at their feet, the universal loadout, and a known vitals
 * baseline. Mutates the already-created player and state.fires in place through
 * existing authoritative code; introduces no entity the server doesn't own.
 *
 * Called from GameRoom.handleJoin path 3 (fresh-token life) AFTER the
 * keep-inventory restore (so it isn't clobbered) and BEFORE sendWelcome (so the
 * welcome carries it) — only when isTestbedEnabled(env).
 */
export function provisionTestbed(state: GameState, player: ServerPlayer): void {
  // Deterministic position: spawnPoints[0] is the beach-ring march at angle 0,
  // computed once by the server's OWN worldgen (world.ts) — so the agent/client
  // never reconstruct geometry and the macOS↔Linux worldgen-drift hazard is moot.
  // The island is radial: away-from-origin is open ocean, toward-origin is dry
  // land, for any seed. Face the player seaward (inland is yaw + π).
  const station = state.world.spawnPoints[0] ?? { x: 0, z: 0 };
  const len = Math.hypot(station.x, station.z) || 1;
  player.core.x = station.x;
  player.core.z = station.z;
  player.core.y = state.world.groundHeight(station.x, station.z);
  // forward = (-sin yaw, -cos yaw); solve so it points away from origin (seaward).
  player.core.yaw = Math.atan2(-station.x / len, -station.z / len);
  player.core.pitch = 0;
  player.core.vy = 0;
  player.core.grounded = true;

  // Lit campfire AT the player's feet: distance 0 < FIRE_WARMTH_RADIUS, so the
  // server's nearFire() is true (cook venison now; boil-canteen once doc 05
  // lands). Same shape as the useItem placeable branch; respect the world cap.
  if (state.fires.length >= MAX_CAMPFIRES) state.fires.shift();
  state.fires.push({
    id: state.nextEntityId++,
    x: player.core.x,
    y: player.core.y,
    z: player.core.z,
    burnRemaining: CAMPFIRE_BURN_S,
  });

  // Loadout: ids absent from this build are skipped (the forward-compat rule).
  for (const { id, count } of TESTBED_LOADOUT) {
    if (isItemType(id)) {
      addToInventory(player.inventory, id, count);
    } else {
      console.warn(`[testbed] item "${id}" not in ITEM_DEFS on this build — skipped`);
    }
  }
  player.selectedSlot = 0;

  // Known baseline so vitals deltas are observable; clear the attack cooldown.
  player.vitals.hp = TESTBED_VITALS.hp;
  player.vitals.food = TESTBED_VITALS.food;
  player.vitals.water = TESTBED_VITALS.water;
  player.vitals.temp = TESTBED_VITALS.temp;
  player.attackCooldown = 0;
}
