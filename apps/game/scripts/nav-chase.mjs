#!/usr/bin/env node
// doc 14 M2 — zombie chase path-following harness (CI-run via `pnpm test`).
//
//   node --experimental-strip-types apps/game/scripts/nav-chase.mjs
//
// Drives the REAL tickZombies over a fake GameState with a real NavSystem and a
// synthetic wall, and asserts the M2 acceptance behavior: a chasing zombie
// ROUTES AROUND a wall (instead of straight-lining into it), the attack state is
// LINE-OF-SIGHT gated (a wall-separated zombie in range keeps chasing, not
// freezing), and a missing navmesh degrades to straight-line steering. Scenarios
// stop short of melee range so the attack/damage path (survival machinery) never
// fires. tickZombies + NavSystem are esbuild-bundled (the structures.mjs pattern).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ZOMBIE_ATTACK_RANGE, ZOMBIE_CHASE_SPEED } from "@worldspring/shared/constants";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
async function bundleModule(contents, resolveDir, sourcefile) {
  const out = await build({
    stdin: { contents, resolveDir, loader: "ts", sourcefile },
    bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const { tickZombies, NavSystem } = await bundleModule(
  'export { tickZombies } from "./apps/game/src/server/systems/zombies.ts";\n' +
    'export { NavSystem } from "./apps/game/src/server/nav/navMesh.ts";\n',
  rootDir,
  "nav-chase-entry.ts",
);

/** 2D ray-vs-rect (slab) in XZ — entry distance along a normalized dir, or null. */
function rayRectXZ(ox, oz, dx, dz, r, maxT) {
  let t0 = 0, t1 = maxT;
  for (const [o, d, mn, mx] of [[ox, dx, r.minX, r.maxX], [oz, dz, r.minZ, r.maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return null; }
    else {
      let ta = (mn - o) / d, tb = (mx - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
  }
  return t0 >= 0 && t0 <= maxT ? t0 : null;
}

/** Fake World satisfying what tickZombies/stepZombie/resolveStatics/attackBlocked
 *  read: flat ground + a controlled wall list. `walls` captured by reference. */
function fakeWorld(walls) {
  return {
    size: 512,
    heightAt: () => 0,
    groundHeight: () => 0,
    queryStatics: (x, z, r) => ({
      walls: walls.filter((w) => w.maxX > x - r && w.minX < x + r && w.maxZ > z - r && w.minZ < z + r),
      trees: [],
    }),
    raycastStatics: (origin, dir, dist) => {
      let best = null;
      for (const w of walls) {
        const t = rayRectXZ(origin.x, origin.z, dir.x, dir.z, w, dist);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
  };
}

function makeZombie(id, x, z) {
  return {
    id, x, y: 0, z, yaw: 0, hp: 100, mil: false, state: "idle",
    homeX: x, homeZ: z, targetId: null, wanderX: x, wanderZ: z, wanderWait: 99,
    attackCooldown: 0, path: null, pathIndex: 1, repathT: 0, pathGoalX: 0, pathGoalZ: 0,
  };
}
const makePlayer = (id, x, z) => ({ id, alive: true, core: { x, y: 0, z } });

function makeState(walls, withNav = true) {
  const world = fakeWorld(walls);
  return {
    config: {
      threats: { zombies: true, zombieSpeed: 1, zombieDamage: 1, militaryZone: false },
      nav: { enabled: true, tileCap: 9999 }, // M4 dial (flipped off in a test below)
    },
    zombies: new Map(),
    players: new Map(),
    world,
    nav: withNav ? new NavSystem(world, { tileCap: 9999 }) : undefined,
  };
}
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
/** Advance N ticks, building all queued nav tiles each tick (the phase("nav")). */
function run(state, n, onTick) {
  for (let i = 0; i < n; i++) {
    tickZombies(state, 1 / 15);
    state.nav?.stepBuild(100000);
    if (onTick && onTick(i) === false) return i + 1;
  }
  return n;
}

// A 16 m wall along x at z=0 between a north zombie and a south player.
const WALL = { minX: -8, maxX: 8, minZ: -0.2, maxZ: 0.2, y0: 0, y1: 2.2 };

// --- 1. routes AROUND a wall (the headline) -------------------------------
console.log("chase routing (path around a wall):");
{
  const state = makeState([WALL]);
  state.nav.ensureBuilt(0, 0, 60);
  state.nav.stepBuild(100000);
  const z = makeZombie(1, 0, -4);
  state.zombies.set(1, z);
  state.players.set("p", makePlayer("p", 0, 4));
  run(state, 4); // let the chase plan a path (nav pre-built)
  check(Array.isArray(z.path) && z.path.length > 0, "chasing zombie has a nav path");
  // Must route BEYOND the wall end (|x| > WALL.maxX), not merely off the centerline
  // — a point inside the wall's x-extent doesn't prove it cleared the end.
  check(!!z.path && z.path.some((w) => Math.abs(w.x) > WALL.maxX), "path routes beyond the wall end, not straight through");
  // Progress: run until the zombie reaches the player side (stop short of melee).
  // It must have CLEARED the wall end AND completed the route — not just wedged
  // somewhere closer than it started.
  let maxAbsX = 0;
  const start = dist2(z.x, z.z, 0, 4);
  run(state, 200, () => {
    maxAbsX = Math.max(maxAbsX, Math.abs(z.x));
    return dist2(z.x, z.z, 0, 4) > ZOMBIE_ATTACK_RANGE + 0.8; // stop before melee
  });
  const end = dist2(z.x, z.z, 0, 4);
  check(maxAbsX > WALL.maxX, `zombie cleared the wall end (max |x| = ${maxAbsX.toFixed(1)} > ${WALL.maxX})`);
  check(end <= ZOMBIE_ATTACK_RANGE + 0.8, `zombie completed the route to the player (${start.toFixed(1)} → ${end.toFixed(1)} m)`);
  check(z.state === "chase", "state stays 'chase' while routing (no new wire enum)");
}

// --- 2. attack is LINE-OF-SIGHT gated -------------------------------------
console.log("attack LOS gate (in range but wall-blocked → keeps chasing):");
{
  // Short wall right between a very close zombie and player: within attack range
  // (1.7 m) but no line of sight.
  const wall = { minX: -3, maxX: 3, minZ: 0.35, maxZ: 0.65, y0: 0, y1: 2.2 };
  const state = makeState([wall]);
  state.nav.ensureBuilt(0, 0, 40);
  state.nav.stepBuild(100000);
  const z = makeZombie(1, 0, 1.1);
  state.zombies.set(1, z);
  state.players.set("p", makePlayer("p", 0, 0));
  const inRange = dist2(z.x, z.z, 0, 0) <= ZOMBIE_ATTACK_RANGE;
  run(state, 1);
  check(inRange, `zombie is within attack range of the player (${dist2(0, 1.1, 0, 0).toFixed(2)} ≤ ${ZOMBIE_ATTACK_RANGE})`);
  check(z.state === "chase", "wall-blocked target → state 'chase', NOT 'attack' (the base-cheese fix)");
}

// --- 3. no navmesh → straight-line fallback, no crash ---------------------
console.log("straight-line fallback (no navmesh):");
{
  const state = makeState([], false); // nav = undefined
  const z = makeZombie(1, 0, -10);
  state.zombies.set(1, z);
  state.players.set("p", makePlayer("p", 0, 0));
  const start = dist2(z.x, z.z, 0, 0);
  run(state, 20);
  check(dist2(z.x, z.z, 0, 0) < start - 3, `zombie without a navmesh still straight-lines toward the player (${start.toFixed(1)} → ${dist2(z.x, z.z, 0, 0).toFixed(1)} m)`);
  check(z.path === null, "no path cached when nav is absent");
}

// --- 4. open-terrain chase is unchanged (no regression) -------------------
console.log("open-terrain chase (no wall) closes distance normally:");
{
  const state = makeState([]);
  state.nav.ensureBuilt(0, 0, 40);
  state.nav.stepBuild(100000);
  const z = makeZombie(1, 0, -10);
  state.zombies.set(1, z);
  state.players.set("p", makePlayer("p", 0, 0));
  const start = dist2(z.x, z.z, 0, 0);
  run(state, 30, () => dist2(z.x, z.z, 0, 0) > ZOMBIE_ATTACK_RANGE + 0.8);
  const moved = start - dist2(z.x, z.z, 0, 0);
  check(moved > 3, `open chase closes distance at ~chase speed (${moved.toFixed(1)} m; ~${(ZOMBIE_CHASE_SPEED / 15).toFixed(2)} m/tick)`);
}

// --- 5. M4 dial off → straight-line even WITH a navmesh present -----------
console.log("config.nav.enabled=false (M4 dial) → straight-line, no nav used:");
{
  const state = makeState([WALL]);
  state.config.nav.enabled = false; // operator disabled pathfinding
  state.nav.ensureBuilt(0, 0, 60);
  state.nav.stepBuild(100000);
  const z = makeZombie(1, 0, -4);
  state.zombies.set(1, z);
  state.players.set("p", makePlayer("p", 0, 4));
  run(state, 6);
  check(z.path === null, "no path planned when the dial is off (nav present but unused)");
  check(Math.abs(z.x) < 1, "zombie steers straight at the wall (no detour) — today's behavior");
}

console.log(failures === 0 ? "\nnav-chase: ALL OK" : `\nnav-chase: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
