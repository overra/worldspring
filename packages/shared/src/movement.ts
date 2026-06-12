// Shared kinematic character movement. Client prediction and server authority
// run the exact same code so reconciliation corrections stay tiny.

import {
  GRAVITY,
  JUMP_VELOCITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  STEP_UP_MAX,
  WALK_SPEED,
  WATER_WALK_MIN,
  ZOMBIE_RADIUS,
} from "./constants";
import { pushCircleOutOfAabb, pushCircleOutOfCircle } from "./math";
import type { InputCmd, PlayerCore } from "./protocol";
import type { World } from "./world";

/**
 * Resolve a circle against nearby walls and tree trunks. Returns final [x, z].
 * Wall boxes are y-aware: anything low enough to step onto (door sills,
 * foundations seen from above) or entirely overhead is ignored.
 */
export function resolveStatics(
  world: World,
  x: number,
  z: number,
  y: number,
  r: number,
): [number, number] {
  const statics = world.queryStatics(x, z, r + 1.5);
  // Two iterations handles corner cases where one push creates a new overlap.
  for (let iter = 0; iter < 2; iter++) {
    let moved = false;
    for (const wall of statics.walls) {
      if (wall.y1 <= y + STEP_UP_MAX || wall.y0 >= y + PLAYER_HEIGHT) continue;
      const fixed = pushCircleOutOfAabb(x, z, r, wall);
      if (fixed) {
        [x, z] = fixed;
        moved = true;
      }
    }
    for (const tree of statics.trees) {
      const fixed = pushCircleOutOfCircle(x, z, r, tree.x, tree.z, tree.r);
      if (fixed) {
        [x, z] = fixed;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return [x, z];
}

/**
 * Advance one player input command. Mutates `state`. Deterministic: same
 * state + cmd + world always produces the same result.
 */
export function stepPlayer(state: PlayerCore, cmd: InputCmd, world: World): void {
  const dt = cmd.dt;
  state.yaw = cmd.yaw;
  state.pitch = cmd.pitch;

  // Local move intent -> world space. Forward (mz = -1) heads toward -Z at yaw 0.
  let dx = 0;
  let dz = 0;
  const lenSq = cmd.mx * cmd.mx + cmd.mz * cmd.mz;
  if (lenSq > 1e-6) {
    const inv = 1 / Math.sqrt(Math.max(1, lenSq)); // diagonal isn't faster
    const mx = cmd.mx * inv;
    const mz = cmd.mz * inv;
    const sin = Math.sin(cmd.yaw);
    const cos = Math.cos(cmd.yaw);
    // Rotate local (mx, mz) by yaw around Y. yaw 0 forward = (0, 0, -1).
    dx = mx * cos + mz * sin;
    dz = -mx * sin + mz * cos;
    const speed = cmd.sprint ? SPRINT_SPEED : WALK_SPEED;
    dx *= speed * dt;
    dz *= speed * dt;
  }

  let nx = state.x + dx;
  let nz = state.z + dz;

  // Deep water blocks horizontal movement; try axis-separated sliding.
  if (world.heightAt(nx, nz) < WATER_WALK_MIN) {
    if (world.heightAt(nx, state.z) >= WATER_WALK_MIN) {
      nz = state.z;
    } else if (world.heightAt(state.x, nz) >= WATER_WALK_MIN) {
      nx = state.x;
    } else {
      nx = state.x;
      nz = state.z;
    }
  }

  [nx, nz] = resolveStatics(world, nx, nz, state.y, PLAYER_RADIUS);
  state.x = nx;
  state.z = nz;

  // Vertical: walk the ground, with gravity when airborne.
  const ground = world.groundHeight(state.x, state.z);
  if (state.grounded) {
    if (ground - state.y <= STEP_UP_MAX) {
      state.y = Math.max(state.y, ground);
    }
    if (cmd.jump) {
      // Jump first — checking the walked-off-edge transition before this
      // silently ate jump inputs while moving downhill.
      state.vy = JUMP_VELOCITY;
      state.grounded = false;
      state.y += state.vy * dt;
    } else if (state.y - ground > 0.02) {
      // Walked off an edge.
      state.grounded = false;
    } else {
      state.y = ground;
      state.vy = 0;
    }
  }
  if (!state.grounded) {
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y <= ground && state.vy <= 0) {
      state.y = ground;
      state.vy = 0;
      state.grounded = true;
    }
  }
}

export interface ZombieCore {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Move a zombie toward (tx, tz) at `speed`. Zombies stick to the ground and
 * use the same static collision as players.
 */
export function stepZombie(
  zombie: ZombieCore,
  tx: number,
  tz: number,
  speed: number,
  dt: number,
  world: World,
): void {
  const dx = tx - zombie.x;
  const dz = tz - zombie.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-4 && speed > 0) {
    zombie.yaw = Math.atan2(-dx, -dz);
    let nx = zombie.x + (dx / d) * speed * dt;
    let nz = zombie.z + (dz / d) * speed * dt;
    if (world.heightAt(nx, nz) < WATER_WALK_MIN) {
      nx = zombie.x;
      nz = zombie.z;
    }
    [nx, nz] = resolveStatics(world, nx, nz, zombie.y, ZOMBIE_RADIUS);
    zombie.x = nx;
    zombie.z = nz;
  }
  zombie.y = world.groundHeight(zombie.x, zombie.z);
}
