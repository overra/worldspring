// Attack resolution: fists/melee cone vs zombies and players, or ranged
// hitscan (pistol/rifle/shotgun, driven by each ItemDef's RangedConfig) with
// static occlusion. The server decides melee vs ranged from the attacker's
// equipped slot.
//
// Lag compensation: hit DETECTION runs against target positions rewound to
// the game-time the shooter's screen showed (`attack.at`), LERPed from the
// posHistory frames captured each tick. Damage/kill application still hits
// the CURRENT entity objects; the shooter is never rewound.

import {
  ATTACK_COOLDOWN_S,
  FIST_DMG,
  HIT_CAPSULE_RADIUS,
  LAG_COMP_MAX_REWIND_S,
  MELEE_HALF_ANGLE_RAD,
  MELEE_RANGE,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
} from "@worldspring/shared/constants";
import { ITEM_DEFS, type ItemDef } from "@worldspring/shared/items";
import {
  distSq2D,
  inMeleeCone,
  lookDir,
  rayVerticalCylinder,
  type Vec3,
} from "@worldspring/shared/math";
import { consumeFromSlot, sendInventory } from "./players";
import {
  queueEvent,
  type Deer,
  type GameState,
  type PosHistoryFrame,
  type PosSnapshot,
  type ServerPlayer,
  type Zombie,
} from "./state";
import { damagePlayer } from "./survival";
import { tryChopTree } from "./trees";
import { killDeer } from "./wildlife";
import { killZombie } from "./zombies";

/** Contract gap: ANIM_ATTACKING duration is specified as "~0.3s" in prose. */
const ATTACK_ANIM_S = 0.3;
/** Cosmetic: melee impact effect height as a fraction of body height. */
const HIT_EFFECT_HEIGHT = PLAYER_HEIGHT * 0.6;
/** Max vertical separation for a melee hit (no axe-ing through floors). */
const MELEE_MAX_DY = 2.5;
/** Chest height used for the melee wall-occlusion ray. */
const MELEE_RAY_HEIGHT = 1.2;

/** True when a wall/roof blocks the line from attacker chest to target chest.
 * Exported for trees.ts — chops obey the same occlusion as living targets. */
export function meleeBlocked(
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

/** Read-only position; Zombie/Deer/PlayerCore all satisfy it structurally. */
interface RewoundPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Resolves where each hittable target stood at the shooter's aim time. */
interface RewindLookup {
  player(p: ServerPlayer): RewoundPos;
  zombie(z: Zombie): RewoundPos;
  deer(d: Deer): RewoundPos;
}

/** No-rewind lookup: exactly today's behavior, current positions. */
const CURRENT_POSITIONS: RewindLookup = {
  player: (p) => p.core,
  zombie: (z) => z,
  deer: (d) => d,
};

/**
 * Build the rewound position lookup for one attack (built ONCE per shot, then
 * shared by every cone/cylinder test and pellet).
 *
 * `aimTime` is the game-time the shooter's screen showed when they fired.
 * Anti-abuse: it is clamped to [state.time - LAG_COMP_MAX_REWIND_S,
 * state.time] — a malicious past timestamp gains at most 350ms of rewind,
 * the same advantage any laggy-but-honest client gets; future timestamps
 * clamp to now. The two posHistory frames bracketing the clamped time are
 * LERPed; with only one side available we snap to that frame. Undefined
 * aimTime or empty history falls back to current positions (today's
 * behavior). Entities missing from the frames (newly spawned, or offline
 * lingerers which are never captured) also fall back to their current
 * position. Entities that died since aimTime are simply absent from the
 * current maps — callers never query them.
 */
function buildRewind(state: GameState, aimTime: number | undefined): RewindLookup {
  const history = state.posHistory;
  if (aimTime === undefined || history.length === 0) return CURRENT_POSITIONS;

  const t = Math.min(state.time, Math.max(state.time - LAG_COMP_MAX_REWIND_S, aimTime));

  // History is appended once per tick, so it is sorted ascending by time.
  let before: PosHistoryFrame | null = null;
  let after: PosHistoryFrame | null = null;
  for (const frame of history) {
    if (frame.time <= t) before = frame;
    if (frame.time >= t) {
      after = frame;
      break;
    }
  }
  // Snap to the nearest frame when only one side of t exists.
  const frameA = before ?? after;
  const frameB = after ?? before;
  if (!frameA || !frameB) return CURRENT_POSITIONS; // unreachable: history non-empty
  const span = frameB.time - frameA.time;
  const alpha = span > 0 ? (t - frameA.time) / span : 0;

  const resolve = (
    a: PosSnapshot | undefined,
    b: PosSnapshot | undefined,
    current: RewoundPos,
  ): RewoundPos => {
    if (a && b) {
      if (a === b) return a;
      return {
        x: a.x + (b.x - a.x) * alpha,
        y: a.y + (b.y - a.y) * alpha,
        z: a.z + (b.z - a.z) * alpha,
      };
    }
    // One-sided frames: lerp toward the current position rather than
    // returning the stale sample raw — a raw frameA could sit up to one tick
    // older than the clamped rewind floor (~67ms extra at 15Hz).
    if (a) {
      return {
        x: a.x + (current.x - a.x) * alpha,
        y: a.y + (current.y - a.y) * alpha,
        z: a.z + (current.z - a.z) * alpha,
      };
    }
    return b ?? current;
  };

  return {
    player: (p) => resolve(frameA.players.get(p.id), frameB.players.get(p.id), p.core),
    zombie: (z) => resolve(frameA.zombies.get(z.id), frameB.zombies.get(z.id), z),
    deer: (d) => resolve(frameA.animals.get(d.id), frameB.animals.get(d.id), d),
  };
}

/** Entry point for an "attack" message. `aimTime` = client `attack.at`. */
export function performAttack(
  state: GameState,
  player: ServerPlayer,
  aimTime: number | undefined,
): void {
  if (!player.alive) return;
  if (player.attackCooldown > 0) return;
  const stack = player.inventory[player.selectedSlot];
  const def: ItemDef | null = stack ? ITEM_DEFS[stack.type] : null;
  if (def && def.kind === "ranged") {
    fireRanged(state, player, def, aimTime);
    return;
  }
  meleeAttack(state, player, def, aimTime);
}

function meleeAttack(
  state: GameState,
  player: ServerPlayer,
  def: ItemDef | null,
  aimTime: number | undefined,
): void {
  player.attackCooldown = ATTACK_COOLDOWN_S;
  player.attackAnimT = ATTACK_ANIM_S;
  const dmg = def && def.kind === "melee" ? def.power : FIST_DMG;
  // Standard lag comp: the SHOOTER swings from their CURRENT server position;
  // only TARGET positions are rewound (detection + occlusion endpoint).
  const { x, z, yaw } = player.core;

  // The swing is always visible, hit or miss.
  queueEvent(state, { e: "swing", id: player.id }, x, z);

  const rewind = buildRewind(state, aimTime);

  // Nearest target inside the cone wins — zombie, deer or player alike.
  // `hitPos` is the winner's REWOUND position (where the swing connected).
  let bestSq = Infinity;
  let hitZombie: Zombie | null = null;
  let hitDeer: Deer | null = null;
  let hitPlayer: ServerPlayer | null = null;
  let hitPos: RewoundPos | null = null;
  const py = player.core.y;
  for (const zombie of state.zombies.values()) {
    const pos = rewind.zombie(zombie);
    if (Math.abs(pos.y - py) > MELEE_MAX_DY) continue;
    if (!inMeleeCone(x, z, yaw, pos.x, pos.z, MELEE_RANGE, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, pos.x, pos.z);
    // Walls are static, so occlusion stays consistent with the rewound world
    // by simply aiming the blocked-check at the rewound target point.
    if (dSq < bestSq && !meleeBlocked(state, x, py, z, pos.x, pos.y, pos.z)) {
      bestSq = dSq;
      hitZombie = zombie;
      hitDeer = null;
      hitPlayer = null;
      hitPos = pos;
    }
  }
  for (const deer of state.animals.values()) {
    const pos = rewind.deer(deer);
    if (Math.abs(pos.y - py) > MELEE_MAX_DY) continue;
    if (!inMeleeCone(x, z, yaw, pos.x, pos.z, MELEE_RANGE, MELEE_HALF_ANGLE_RAD)) continue;
    const dSq = distSq2D(x, z, pos.x, pos.z);
    if (dSq < bestSq && !meleeBlocked(state, x, py, z, pos.x, pos.y, pos.z)) {
      bestSq = dSq;
      hitZombie = null;
      hitDeer = deer;
      hitPlayer = null;
      hitPos = pos;
    }
  }
  // PvP off: players are not meleeable targets (zombies/deer still are).
  if (state.config.pvp.enabled) {
    for (const other of state.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      const pos = rewind.player(other);
      if (Math.abs(pos.y - py) > MELEE_MAX_DY) continue;
      if (!inMeleeCone(x, z, yaw, pos.x, pos.z, MELEE_RANGE, MELEE_HALF_ANGLE_RAD)) {
        continue;
      }
      const dSq = distSq2D(x, z, pos.x, pos.z);
      if (dSq < bestSq && !meleeBlocked(state, x, py, z, pos.x, pos.y, pos.z)) {
        bestSq = dSq;
        hitZombie = null;
        hitDeer = null;
        hitPlayer = other;
        hitPos = pos;
      }
    }
  }

  if (!hitPos) {
    // Whiffed every living target: an axe swing may still land on a tree
    // trunk (doc 13 M2 — chopping reuses the melee verb; living targets in
    // front of a tree always win the swing). Trees are static, so no rewind.
    tryChopTree(state, player);
    return;
  }
  // The impact flash lands at the REWOUND point (where the shooter saw the
  // target); damage/kill below applies to the CURRENT entity objects.
  queueEvent(
    state,
    { e: "hit", x: hitPos.x, y: hitPos.y + HIT_EFFECT_HEIGHT, z: hitPos.z },
    hitPos.x,
    hitPos.z,
  );
  if (hitZombie) {
    hitZombie.hp -= dmg;
    if (hitZombie.hp <= 0) {
      killZombie(state, hitZombie);
      player.stats.zombieKills++;
    }
    return;
  }
  if (hitDeer) {
    hitDeer.hp -= dmg;
    if (hitDeer.hp <= 0) killDeer(state, hitDeer);
    return;
  }
  if (hitPlayer) {
    const pvpDmg = dmg * state.config.pvp.damageMult;
    if (damagePlayer(state, hitPlayer, pvpDmg, player.name, true)) player.stats.kills++;
  }
}

/**
 * Hitscan fire driven by the equipped weapon's RangedConfig: consumes one
 * round of `ranged.ammo` per trigger pull, then casts `ranged.pellets` rays
 * (each perturbed by up to `spreadRad`) — `def.power` damage per pellet hit.
 * One "shot" event per pellet: the tracer fan IS the shotgun visual.
 */
function fireRanged(
  state: GameState,
  player: ServerPlayer,
  def: ItemDef,
  aimTime: number | undefined,
): void {
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

  // Lag comp: one rewound lookup per trigger pull, shared by every pellet.
  // TARGETS are tested at their rewound positions; the SHOOTER's ray origin
  // stays their CURRENT server position (never rewind the shooter).
  const rewind = buildRewind(state, aimTime);

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

    // Walls/roofs/terrain occlude; nothing beyond the closest static hit
    // counts. Statics never move, so the ray needs no rewinding: capping the
    // cylinder tests at `maxT` already rejects any REWOUND target point that
    // sits behind a wall — occlusion stays consistent with the rewound world.
    const staticT = state.world.raycastStatics(origin, dir, ranged.range);
    const maxT = staticT ?? ranged.range;

    let hitT = Infinity;
    let hitZombie: Zombie | null = null;
    let hitDeer: Deer | null = null;
    let hitPlayer: ServerPlayer | null = null;
    for (const zombie of state.zombies.values()) {
      const pos = rewind.zombie(zombie);
      const t = rayVerticalCylinder(
        origin,
        dir,
        pos.x,
        pos.z,
        pos.y,
        pos.y + PLAYER_HEIGHT,
        HIT_CAPSULE_RADIUS,
        maxT,
      );
      if (t !== null && t < hitT) {
        hitT = t;
        hitZombie = zombie;
        hitDeer = null;
        hitPlayer = null;
      }
    }
    for (const deer of state.animals.values()) {
      const pos = rewind.deer(deer);
      const t = rayVerticalCylinder(
        origin,
        dir,
        pos.x,
        pos.z,
        pos.y,
        pos.y + PLAYER_HEIGHT,
        HIT_CAPSULE_RADIUS,
        maxT,
      );
      if (t !== null && t < hitT) {
        hitT = t;
        hitZombie = null;
        hitDeer = deer;
        hitPlayer = null;
      }
    }
    // PvP off: players are not shootable targets (zombies/deer still are).
    if (state.config.pvp.enabled) {
      for (const other of state.players.values()) {
        if (other.id === player.id || !other.alive) continue;
        const pos = rewind.player(other);
        const t = rayVerticalCylinder(
          origin,
          dir,
          pos.x,
          pos.z,
          pos.y,
          pos.y + PLAYER_HEIGHT,
          HIT_CAPSULE_RADIUS,
          maxT,
        );
        if (t !== null && t < hitT) {
          hitT = t;
          hitZombie = null;
          hitDeer = null;
          hitPlayer = other;
        }
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

    // Kill credit lands at most once per victim per trigger pull: killZombie/
    // killDeer remove the target (later pellets can't re-hit it) and
    // damagePlayer returns true only on the living->dead transition (dead
    // players are skipped above).
    if (hitZombie) {
      hitZombie.hp -= def.power;
      if (hitZombie.hp <= 0) {
        killZombie(state, hitZombie);
        player.stats.zombieKills++;
      }
      continue;
    }
    if (hitDeer) {
      hitDeer.hp -= def.power;
      if (hitDeer.hp <= 0) killDeer(state, hitDeer);
      continue;
    }
    if (
      hitPlayer &&
      damagePlayer(state, hitPlayer, def.power * state.config.pvp.damageMult, player.name, true)
    ) {
      player.stats.kills++;
    }
  }
}
