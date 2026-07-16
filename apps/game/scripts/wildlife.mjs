#!/usr/bin/env node
// Deer AI harness (CI-run via `pnpm test`) — the flee/relocate fix.
//
//   node --experimental-strip-types apps/game/scripts/wildlife.mjs
//
// Drives the REAL tickWildlife over a fake GameState and asserts a spooked deer
// FLEES AWAY and RELOCATES its grazing home there, so once the threat clears it
// settles instead of wandering back toward its spawn (the player) and
// re-triggering flee — the "run off, turn around, walk back" oscillation.
// tickWildlife is esbuild-bundled (the structures.mjs pattern) because
// wildlife.ts value-imports movement/config via extensionless paths.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const out = await build({
  stdin: {
    contents: 'export { tickWildlife } from "./apps/game/src/server/systems/wildlife.ts";\n',
    resolveDir: rootDir,
    loader: "ts",
    sourcefile: "wildlife-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
});
const { tickWildlife } = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

// Flat inland world (heightAt 2 keeps deer off the water full-stop).
const world = {
  size: 512,
  heightAt: () => 2,
  groundHeight: () => 2,
  queryStatics: () => ({ walls: [], trees: [] }),
};
const makeDeer = () => ({
  id: 1, x: 0, y: 2, z: 0, yaw: 0, hp: 30, state: "idle",
  homeX: 0, homeZ: 0, wanderX: 0, wanderZ: 0, wanderWait: 1,
});
const makePlayer = (x, z) => ({ id: "p", alive: true, core: { x, y: 2, z } });
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

const state = {
  config: {},
  animals: new Map(),
  players: new Map(),
  world,
};
const deer = makeDeer();
state.animals.set(1, deer);
const PLAYER = makePlayer(2, 0); // 2 m away, well inside DEER_FLEE_RADIUS
state.players.set("p", PLAYER);

const tick = (n) => { for (let i = 0; i < n; i++) tickWildlife(state, 1 / 15); };

// --- 1. flees away + relocates its home -----------------------------------
console.log("deer flee + relocate:");
{
  tick(10); // player parked at +x → deer bolts toward -x
  check(deer.state === "flee", "deer is fleeing while the player is close");
  check(deer.x < -1, `deer fled AWAY from the player (x = ${deer.x.toFixed(1)} < 0, player at +x)`);
  check(deer.homeX === deer.x && deer.homeZ === deer.z, "grazing home followed the deer to where it fled");
  check(dist(deer.homeX, deer.homeZ, PLAYER.core.x, PLAYER.core.z) > dist(0, 0, PLAYER.core.x, PLAYER.core.z),
    "home is now FARTHER from the player than the original spawn");
}

// --- 2. once calm, it settles near the new home (no walk-back) -------------
console.log("no oscillation after the threat leaves:");
{
  const fledX = deer.x, fledZ = deer.z;
  state.players.delete("p"); // player walks away
  let maxDrift = 0;
  let reFled = false;
  for (let i = 0; i < 200; i++) {
    tickWildlife(state, 1 / 15);
    maxDrift = Math.max(maxDrift, dist(deer.x, deer.z, fledX, fledZ));
    if (deer.state === "flee") reFled = true;
  }
  check(!reFled, "deer never re-enters 'flee' after the threat is gone (no ping-pong)");
  // Assert the HOME, not the deer's instantaneous x. The deer lands ~6m from
  // spawn and then grazes anywhere within WANDER_RADIUS (14m) of home, so
  // `deer.x < 0` is not an invariant at all — a random wander carries it back
  // across x=0 in ~5% of runs, which is exactly how this went red in CI. Home
  // only ever moves in the flee branch, so it IS deterministic here, and it is
  // the thing the fix buys: pre-fix it stayed pinned at spawn (0,0) and dragged
  // the deer back for another lap.
  check(
    deer.homeX === fledX && deer.homeZ === fledZ,
    `grazing home stays where it fled — never migrates back toward spawn (home x = ${deer.homeX.toFixed(1)}, fled x = ${fledX.toFixed(1)})`,
  );
  check(maxDrift < 20, `deer grazes near its NEW home, not back toward the player (max drift ${maxDrift.toFixed(1)} m)`);
}

console.log(failures === 0 ? "\nwildlife: ALL OK" : `\nwildlife: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
