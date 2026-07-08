// Magazine accounting (doc 11 M3 — combat-owned). The per-weapon rounds
// counter is `ItemStack.mag` (absent ⇒ full, see items.ts); this module owns
// every read/write of it: the fire-side decrement, the reload-start
// precondition, and the reload-completion refill that drains inventory ammo.
// players.ts wires these into the doc-11 channel primitive; combat.ts calls
// the fire side.
//
// Deliberately dependency-light: value imports come only from
// @worldspring/shared, relative imports are type-only — so the
// reload-magazine.mjs harness can drive this module directly under
// `node --experimental-strip-types` (the loot-invariant.mjs precedent).

import { ITEM_DEFS, type ItemStack, type RangedConfig } from "@worldspring/shared/items";

/** The RangedConfig of a stack, or null when it isn't a ranged weapon. */
export function rangedOf(stack: ItemStack | null): RangedConfig | null {
  if (!stack) return null;
  const def = ITEM_DEFS[stack.type];
  return def.kind === "ranged" && def.ranged ? def.ranged : null;
}

/**
 * Rounds currently in the stack's magazine. Absent `mag` reads as FULL —
 * old saves, loot-table spawns and pre-M3 drops all hold a topped-off gun
 * (no surprise nerf; rollback-safe).
 */
export function roundsInMag(stack: ItemStack, ranged: RangedConfig): number {
  // Clamp defends against a persisted mag from a config whose magSize shrank.
  return Math.max(0, Math.min(ranged.magSize, stack.mag ?? ranged.magSize));
}

/**
 * Fire-side gate: take one round out of the magazine. Returns false (and
 * writes nothing) on an empty mag — the trigger pull fires nothing.
 */
export function tryConsumeRound(stack: ItemStack, ranged: RangedConfig): boolean {
  const rounds = roundsInMag(stack, ranged);
  if (rounds <= 0) return false;
  stack.mag = rounds - 1;
  return true;
}

/** Total `ranged.ammo` rounds across the inventory (players.ts countOf twin —
 * duplicated so this module stays value-import-free of players.ts). */
export function reserveAmmo(inv: (ItemStack | null)[], ranged: RangedConfig): number {
  let total = 0;
  for (const stack of inv) {
    if (stack && stack.type === ranged.ammo) total += stack.count;
  }
  return total;
}

/**
 * Reload START precondition (doc 11 M3): the slot holds a ranged weapon whose
 * mag is not full AND the inventory holds at least one matching round.
 * Returns the weapon's RangedConfig (the caller reads `reloadS` off it) or
 * null when a reload cannot start. Pure check — consumes NOTHING (doc 11 §1:
 * nothing is applied or consumed at channel start).
 */
export function canStartReload(
  inv: (ItemStack | null)[],
  slot: number,
): RangedConfig | null {
  const stack = inv[slot] ?? null;
  const ranged = rangedOf(stack);
  if (!stack || !ranged) return null;
  if (roundsInMag(stack, ranged) >= ranged.magSize) return null;
  if (reserveAmmo(inv, ranged) <= 0) return null;
  return ranged;
}

/**
 * Reload COMPLETION: move `min(magSize - current, reserve)` rounds from the
 * inventory's ammo stacks into the weapon's magazine. Ammo drains
 * BACK-TO-FRONT (the removeFromInventory rule — low hotbar slots keep their
 * stacks longest). Re-validates from scratch — the slot may have changed
 * contents during the cast — and returns whether anything moved (the caller
 * sends the inv update only on a real change).
 */
export function completeReload(inv: (ItemStack | null)[], slot: number): boolean {
  const stack = inv[slot] ?? null;
  const ranged = rangedOf(stack);
  if (!stack || !ranged) return false;
  const rounds = roundsInMag(stack, ranged);
  const need = ranged.magSize - rounds;
  if (need <= 0) return false;

  let taken = 0;
  for (let i = inv.length - 1; i >= 0 && taken < need; i--) {
    const ammo = inv[i];
    if (!ammo || ammo.type !== ranged.ammo) continue;
    const take = Math.min(ammo.count, need - taken);
    ammo.count -= take;
    taken += take;
    if (ammo.count <= 0) inv[i] = null;
  }
  if (taken <= 0) return false;
  stack.mag = rounds + taken;
  return true;
}
