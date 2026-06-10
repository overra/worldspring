// Attack resolution: fists/melee cone vs zombies and players, or ranged
// hitscan (pistol/rifle/shotgun, driven by each ItemDef's RangedConfig) with
// static occlusion. The server decides melee vs ranged from the attacker's
// equipped slot.

import {
  ATTACK_COOLDOWN_S,
  FIST_DMG,
  HIT_CAPSULE_RADIUS,
  MELEE_HALF_ANGLE_RAD,
  MELEE_RANGE,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
} from "@/shared/constants";
import { ITEM_DEFS, type ItemDef } from "@/shared/items";
import {
  distSq2D,
  inMeleeCone,
  lookDir,
  rayVerticalCylinder,
  type Vec3,
} from "@/shared/math";
import { consumeFromSlot, sendInventory } from "./players";
import { queueEvent, type GameState, type ServerPlayer, type Zombie } from "./state";
import { damagePlayer } from "./survival";
import { killZombie } from "./zombies";

/** Contract gap: ANIM_ATTACKING duration is specified as "~0.3s" in prose. */
const ATTACK_ANIM_S = 0.3;
/** Cosmetic: melee impact effect height as a fraction of body height. */
const HIT_EFFECT_HEIGHT = PLAYER_HEIGHT * 0.6;
/** Max vertical separation for a melee hit (no axe-ing through floors). */
const MELEE_MAX_DY = 2.5;
/** Chest height used for the melee wall-occlusion ray. */
const MELEE_RAY_HEIGHT = 1.2;

/** True when a wall/roof blocks the line from attacker chest to target chest. */
function meleeBlocked(
  state: GameState,
  ax: number,
  ay: number,
  az: number,
  tx: number,
  ty: number,
  tz: number,
): boolean {
  const dx = tx - ax;
  const dy = ty + MELEE_RAY_HEIGHT - (ay + MELEE_RAY_HEIGHT);
  const dz = tz - az;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-4) return false;
  const origin: Vec3 = { x: ax, y: ay + MELEE_RAY_HEIGHT, z: az };
  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  // Walls only — terrain bumps between two slope-standing fighters must not
  // eat point-blank swings.
  const t = state.world.raycastStatics(origin, dir, dist, false);
  return t !== null && t < dist - 0.05;
}

/** Entry point for an "attack" message. */
export function performAttack(state: GameState, player: ServerPlayer): void {
  if (!player.alive) return;
  if (player.attackCooldown > 0) return;
  const stack = player.inventory[player.selectedSlot];
  const def: ItemDef | null = stack ? ITEM_DEFS[stack.type] : null;
  if (def && def.kind === "ranged") {
    fireRanged(state, player, def);
    return;
  }
  meleeAttack(state, player, def);
}

function meleeAttack(state: GameState, player: ServerPlayer, def: ItemDef | null): void {
  player.attackCooldown = ATTACK_COOLDOWN_S;
  player.attackAnimT = ATTACK_ANIM_S;
  const dmg = def && def.kind === "melee" ? def.power : FIST_DMG;
  const { x, z, yaw } = player.core;

  // The swing is always visible, hit or miss.
  queueEvent(state, { e: "swing", id: player.id }, x, z);

  // Nearest target inside the cone wins, zombie or player alike.
  let bestSq = Infinity;
  let hitZombie: Zombie | null = null;
  let hitPlayer: ServerPlayer | null = null;
  const py = player.core.y;
  for (const zombie of state.zombies.values()) {
    if (Math.abs(zombie.y - py) > MELEE_MAX_DY) continue;
    if (!inMeleeCone(x, z, yaw, zombie.x, zombie.z, MELEE_RANGE, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, zombie.x, zombie.z);
    if (dSq < bestSq && !meleeBlocked(state, x, py, z, zombie.x, zombie.y, zombie.z)) {
      bestSq = dSq;
      hitZombie = zombie;
      hitPlayer = null;
    }
  }
  for (const other of state.players.values()) {
    if (other.id === player.id || !other.alive) continue;
    if (Math.abs(other.core.y - py) > MELEE_MAX_DY) continue;
    if (!inMeleeCone(x, z, yaw, other.core.x, other.core.z, MELEE_RANGE, MELEE_HALF_ANGLE_RAD)) {
      continue;
    }
    const dSq = distSq2D(x, z, other.core.x, other.core.z);
    if (
      dSq < bestSq &&
      !meleeBlocked(state, x, py, z, other.core.x, other.core.y, other.core.z)
    ) {
      bestSq = dSq;
      hitZombie = null;
      hitPlayer = other;
    }
  }

  if (hitZombie) {
    queueEvent(
      state,
      { e: "hit", x: hitZombie.x, y: hitZombie.y + HIT_EFFECT_HEIGHT, z: hitZombie.z },
      hitZombie.x,
      hitZombie.z,
    );
    hitZombie.hp -= dmg;
    if (hitZombie.hp <= 0) {
      killZombie(state, hitZombie);
      player.stats.zombieKills++;
    }
    return;
  }
  if (hitPlayer) {
    queueEvent(
      state,
      {
        e: "hit",
        x: hitPlayer.core.x,
        y: hitPlayer.core.y + HIT_EFFECT_HEIGHT,
        z: hitPlayer.core.z,
      },
      hitPlayer.core.x,
      hitPlayer.core.z,
    );
    if (damagePlayer(state, hitPlayer, dmg, player.name, true)) player.stats.kills++;
  }
}

/**
 * Hitscan fire driven by the equipped weapon's RangedConfig: consumes one
 * round of `ranged.ammo` per trigger pull, then casts `ranged.pellets` rays
 * (each perturbed by up to `spreadRad`) — `def.power` damage per pellet hit.
 * One "shot" event per pellet: the tracer fan IS the shotgun visual.
 */
function fireRanged(state: GameState, player: ServerPlayer, def: ItemDef): void {
  const ranged = def.ranged;
  if (!ranged) return; // guaranteed present for kind "ranged"; belt-and-braces

  // Needs a round anywhere in the inventory — one per pull, however many pellets.
  const ammoSlot = player.inventory.findIndex(
    (stack) => stack !== null && stack.type === ranged.ammo,
  );
  if (ammoSlot === -1) return;

  player.attackCooldown = ranged.cooldownS;
  player.attackAnimT = ATTACK_ANIM_S;
  consumeFromSlot(player.inventory, ammoSlot);
  sendInventory(state, player);

  const origin: Vec3 = {
    x: player.core.x,
    y: player.core.y + PLAYER_EYE_HEIGHT,
    z: player.core.z,
  };

  for (let pellet = 0; pellet < ranged.pellets; pellet++) {
    // Per-pellet random cone: offsets vanish exactly when spreadRad is 0.
    // Non-seeded randomness is fine server-side — pellets never need to
    // match anything client-side.
    const yaw = player.core.yaw + (Math.random() * 2 - 1) * ranged.spreadRad;
    const pitch = player.core.pitch + (Math.random() * 2 - 1) * ranged.spreadRad;
    const dir = lookDir(yaw, pitch);

    // Walls/roofs/terrain occlude; nothing beyond the closest static hit counts.
    const staticT = state.world.raycastStatics(origin, dir, ranged.range);
    const maxT = staticT ?? ranged.range;

    let hitT = Infinity;
    let hitZombie: Zombie | null = null;
    let hitPlayer: ServerPlayer | null = null;
    for (const zombie of state.zombies.values()) {
      const t = rayVerticalCylinder(
        origin,
        dir,
        zombie.x,
        zombie.z,
        zombie.y,
        zombie.y + PLAYER_HEIGHT,
        HIT_CAPSULE_RADIUS,
        maxT,
      );
      if (t !== null && t < hitT) {
        hitT = t;
        hitZombie = zombie;
        hitPlayer = null;
      }
    }
    for (const other of state.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      const t = rayVerticalCylinder(
        origin,
        dir,
        other.core.x,
        other.core.z,
        other.core.y,
        other.core.y + PLAYER_HEIGHT,
        HIT_CAPSULE_RADIUS,
        maxT,
      );
      if (t !== null && t < hitT) {
        hitT = t;
        hitZombie = null;
        hitPlayer = other;
      }
    }

    const endT = hitT < Infinity ? hitT : maxT;
    const tx = origin.x + dir.x * endT;
    const ty = origin.y + dir.y * endT;
    const tz = origin.z + dir.z * endT;
    queueEvent(
      state,
      { e: "shot", w: ranged.sound, sx: origin.x, sy: origin.y, sz: origin.z, tx, ty, tz },
      player.core.x,
      player.core.z,
    );
    if (hitT < Infinity || staticT !== null) {
      queueEvent(state, { e: "hit", x: tx, y: ty, z: tz }, tx, tz);
    }

    // Kill credit lands at most once per victim per trigger pull: killZombie
    // removes the zombie (later pellets can't re-hit it) and damagePlayer
    // returns true only on the living->dead transition (dead players are
    // skipped above).
    if (hitZombie) {
      hitZombie.hp -= def.power;
      if (hitZombie.hp <= 0) {
        killZombie(state, hitZombie);
        player.stats.zombieKills++;
      }
      continue;
    }
    if (hitPlayer && damagePlayer(state, hitPlayer, def.power, player.name, true)) {
      player.stats.kills++;
    }
  }
}
