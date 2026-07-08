#!/usr/bin/env node
// doc 13 M4 — vehicle GAMEPLAY state machine (CI-run via `pnpm test`).
//
// Exercises the real systems/vehicles.ts against a real attached PhysicsSystem
// over a tiny fake GameState: the seat enter/exit machine, fuel consumption +
// out-of-fuel cutoff, collision (crash) damage + wreck ejection, and ram damage.
// The controller determinism itself is pinned by physics-replay.mjs section 1.7;
// this harness pins the gameplay wiring on top.
//
// vehicles.ts value-imports shared modules (movement/vehicles/constants) whose
// source uses extensionless relative imports that node --strip-types can't
// resolve — so bundle the server subgraph with esbuild (the props-smoke.mjs
// precedent) into one resolvable module.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  FUEL_PER_CAN,
  VEHICLE_ENTER_RANGE,
  VEHICLE_FUEL_MAX,
  VEHICLE_HP_MAX,
  VEHICLE_RAM_RADIUS,
} from "@worldspring/shared/constants";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const { build } = createRequire(
  fileURLToPath(new URL("../../../packages/shared/scripts/x.mjs", import.meta.url)),
)("esbuild");

// Bundle PhysicsSystem + the vehicles system (and their whole server/shared
// subgraph) into one ESM module esbuild can resolve.
const bundled = await build({
  stdin: {
    contents:
      'export { PhysicsSystem } from "../src/server/physics/PhysicsSystem.ts";\n' +
      'export { enterVehicle, exitVehicle, driveInput, refuelVehicle, stepVehicles, tickVehicles, vacateSeat, seatPlayerIds } from "../src/server/systems/vehicles.ts";\n',
    resolveDir: scriptsDir,
    loader: "ts",
    sourcefile: "vehicles-smoke-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  external: ["@dimforge/rapier3d-compat"],
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const {
  PhysicsSystem,
  enterVehicle,
  exitVehicle,
  driveInput,
  refuelVehicle,
  stepVehicles,
  tickVehicles,
  seatPlayerIds,
} = mod;

await RAPIER.init();
const dt = 1 / 15;

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

// --- fakes -------------------------------------------------------------------

const cfg = {
  physics: { enabled: true, bodyCap: 64 },
  pvp: { enabled: false, damageMult: 1, fullLoot: true },
};

// Gameplay world (vehicles.ts reads heightAt/groundHeight/queryStatics, and
// meleeBlocked — the ram occlusion ray — reads raycastStatics: no walls here).
const flatWorld = {
  size: 800,
  heightAt: () => 0,
  groundHeight: () => 0,
  queryStatics: () => ({ walls: [], trees: [] }),
  raycastStatics: () => null,
  buildings: [],
};

// PhysicsStaticsSource for the engine's static colliders. `wall` optionally adds
// a big cuboid at z=-25 so a vehicle driving forward (-Z) slams into it.
function makeStatics(withWall) {
  const buildings = withWall
    ? [{ walls: [{ minX: -20, maxX: 20, minZ: -27, maxZ: -23, y0: 0, y1: 4 }], roof: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, y0: 0, y1: 0 } }]
    : [];
  return { size: 800, heightAt: () => 0, buildings, militaryWalls: [], trees: [] };
}

function makeGame(withWall) {
  const physics = new PhysicsSystem(makeStatics(withWall), cfg.physics);
  physics.attachEngine(RAPIER, dt);
  return {
    world: flatWorld,
    config: cfg,
    physics,
    players: new Map(),
    zombies: new Map(),
    vehicleMeta: new Map(),
    events: [],
    outbox: [],
    nextEntityId: 100,
    time: 0,
  };
}

function makePlayer(id, tokenHash, x, z) {
  const p = {
    id,
    tokenHash,
    alive: true,
    realm: "overworld",
    core: { x, y: 0, z, vy: 0, yaw: 0, pitch: 0, grounded: true },
    inventory: new Array(8).fill(null),
    worn: { body: null, back: null },
    selectedSlot: 0,
    seatedVehicle: null,
    seatIndex: -1,
    cmdQueue: [],
  };
  return p;
}

function spawnVehicle(g, x, z, fuel = VEHICLE_FUEL_MAX, hp = VEHICLE_HP_MAX) {
  const id = g.nextEntityId++;
  g.physics.spawnBody(id, "vehicle", x, 0.9, z);
  g.vehicleMeta.set(id, {
    id,
    fuel,
    hp,
    wrecked: false,
    seats: [null, null],
    input: { throttle: 0, steer: 0, brake: 0 },
    lastInputAt: 0,
    lastForward: 0,
    ramCooldown: 0,
  });
  return id;
}

const settle = (g, n = 30) => {
  for (let i = 0; i < n; i++) g.physics.step(dt, (g.time += dt));
};

// --- 1. seat enter/exit state machine ---------------------------------------
{
  const g = makeGame(false);
  const id = spawnVehicle(g, 0, 0);
  settle(g);
  const s0 = g.physics.vehicleSensors(id);
  const p1 = makePlayer("p1", "hash1", s0.x, s0.z);
  const p2 = makePlayer("p2", "hash2", s0.x, s0.z);
  g.players.set(p1.id, p1);
  g.players.set(p2.id, p2);
  const meta = g.vehicleMeta.get(id);

  enterVehicle(g, p1, id, 0);
  check(p1.seatedVehicle === id && p1.seatIndex === 0, "enter occupies the driver seat");
  check(meta.seats[0] === "hash1", "meta records the driver's tokenHash");
  check(JSON.stringify(seatPlayerIds(g, meta)) === JSON.stringify(["p1", null]), "seatPlayerIds maps the driver to their player id");

  // Second player to the SAME (taken) seat is rejected.
  const outboxBefore = g.outbox.length;
  enterVehicle(g, p2, id, 0);
  check(p2.seatedVehicle === null, "a second enter to a TAKEN seat is rejected");
  check(g.outbox.some((o) => o.msg?.msg === "Seat taken"), "the rejected boarder gets a 'Seat taken' notice");
  void outboxBefore;

  // Passenger seat is free.
  enterVehicle(g, p2, id, 1);
  check(p2.seatedVehicle === id && p2.seatIndex === 1, "the passenger seat is boardable");
  check(meta.seats[1] === "hash2", "meta records the passenger");

  // Exit frees the seat and places the player on valid ground beside the hull.
  exitVehicle(g, p1);
  check(p1.seatedVehicle === null && meta.seats[0] === null, "exit frees the seat");
  const dExit = Math.hypot(p1.core.x - s0.x, p1.core.z - s0.z);
  check(dExit > 0.5 && dExit < 6, `exit places the player beside the hull (${dExit.toFixed(2)} m off-center)`);
  check(p1.core.y === 0 && p1.core.grounded === true, "exit places the player on valid ground");

  // Out of range: a distant player can't board.
  const far = makePlayer("p3", "hash3", s0.x + 50, s0.z);
  g.players.set(far.id, far);
  enterVehicle(g, far, id, 0);
  check(far.seatedVehicle === null, "a player out of enter-range can't board");
  void VEHICLE_ENTER_RANGE;
}

// --- 2. fuel consumption + out-of-fuel cutoff --------------------------------
{
  // Full tank: driving burns fuel and the vehicle accelerates.
  const g = makeGame(false);
  const id = spawnVehicle(g, 0, 0, VEHICLE_FUEL_MAX);
  settle(g);
  const p = makePlayer("d", "dh", g.physics.vehicleSensors(id).x, g.physics.vehicleSensors(id).z);
  g.players.set(p.id, p);
  enterVehicle(g, p, id, 0);
  driveInput(g, p, 1, 0, 0); // full throttle
  const meta = g.vehicleMeta.get(id);
  for (let i = 0; i < 60; i++) {
    driveInput(g, p, 1, 0, 0);
    stepVehicles(g, dt);
    g.physics.step(dt, (g.time += dt));
    tickVehicles(g, dt);
  }
  check(meta.fuel < VEHICLE_FUEL_MAX, `driving burns fuel (${meta.fuel.toFixed(1)} < ${VEHICLE_FUEL_MAX})`);
  const fueledSpeed = g.physics.vehicleSensors(id).speed;
  check(fueledSpeed > 3, `a fuelled vehicle accelerates (${fueledSpeed.toFixed(1)} m/s)`);

  // Empty tank: full throttle produces NO drive force — it coasts to a stop.
  const g2 = makeGame(false);
  const id2 = spawnVehicle(g2, 0, 0, 0); // empty
  settle(g2);
  const p2 = makePlayer("d2", "dh2", g2.physics.vehicleSensors(id2).x, g2.physics.vehicleSensors(id2).z);
  g2.players.set(p2.id, p2);
  enterVehicle(g2, p2, id2, 0);
  for (let i = 0; i < 60; i++) {
    driveInput(g2, p2, 1, 0, 0);
    stepVehicles(g2, dt);
    g2.physics.step(dt, (g2.time += dt));
    tickVehicles(g2, dt);
  }
  const drySpeed = g2.physics.vehicleSensors(id2).speed;
  check(drySpeed < 1, `out of fuel => no drive force (coasts, ${drySpeed.toFixed(2)} m/s < 1)`);
  check(g2.vehicleMeta.get(id2).fuel === 0, "an empty tank stays empty (no negative fuel)");

  // Refuel from a jerry can tops up and consumes the item.
  const g3 = makeGame(false);
  const id3 = spawnVehicle(g3, 0, 0, 50);
  settle(g3);
  const p3 = makePlayer("d3", "dh3", g3.physics.vehicleSensors(id3).x, g3.physics.vehicleSensors(id3).z);
  p3.inventory[0] = { type: "fuel", count: 1 };
  g3.players.set(p3.id, p3);
  refuelVehicle(g3, p3, id3);
  check(g3.vehicleMeta.get(id3).fuel === Math.min(VEHICLE_FUEL_MAX, 50 + FUEL_PER_CAN), `refuel adds ${FUEL_PER_CAN} units`);
  check(p3.inventory[0] === null, "refuel consumes one jerry can");
}

// --- 3. collision (crash) damage + wreck ejection ----------------------------
{
  // Drive into a wall: hull hp drops (a crash), and enough damage WRECKS the
  // hull and ejects the driver safely.
  const g = makeGame(true); // wall at z=-25
  const id = spawnVehicle(g, 0, -8, VEHICLE_FUEL_MAX, 40); // low hp so one crash wrecks
  settle(g);
  const p = makePlayer("c", "ch", g.physics.vehicleSensors(id).x, g.physics.vehicleSensors(id).z);
  g.players.set(p.id, p);
  enterVehicle(g, p, id, 0);
  const meta = g.vehicleMeta.get(id);
  const hp0 = meta.hp;
  for (let i = 0; i < 120 && !meta.wrecked; i++) {
    driveInput(g, p, 1, 0, 0); // full throttle toward the wall (forward -Z)
    stepVehicles(g, dt);
    g.physics.step(dt, (g.time += dt));
    tickVehicles(g, dt);
  }
  check(meta.hp < hp0, `crashing into a wall damaged the hull (${meta.hp.toFixed(0)} < ${hp0})`);
  check(meta.wrecked === true, "a hard enough crash WRECKS the vehicle");
  check(p.seatedVehicle === null, "a wreck ejects the driver from the seat");
  check(p.core.y === 0 && p.core.grounded, "the ejected driver lands on valid ground");

  // Control: driving on OPEN ground (no wall) never false-triggers a crash.
  const g2 = makeGame(false);
  const id2 = spawnVehicle(g2, 0, 0, VEHICLE_FUEL_MAX, VEHICLE_HP_MAX);
  settle(g2);
  const p2 = makePlayer("c2", "ch2", g2.physics.vehicleSensors(id2).x, g2.physics.vehicleSensors(id2).z);
  g2.players.set(p2.id, p2);
  enterVehicle(g2, p2, id2, 0);
  for (let i = 0; i < 120; i++) {
    // Accelerate, then brake hard — braking must NOT read as a crash.
    driveInput(g2, p2, i < 60 ? 1 : 0, 0, i < 60 ? 0 : 1);
    stepVehicles(g2, dt);
    g2.physics.step(dt, (g2.time += dt));
    tickVehicles(g2, dt);
  }
  check(g2.vehicleMeta.get(id2).hp === VEHICLE_HP_MAX, "open-ground driving + braking never false-triggers crash damage");

  // Hard cornering (a full-steer donut at speed) on OPEN ground must deal ZERO
  // hull damage: forward speed swings hard as the hull yaws (a drift), but with
  // no wall the crash detector must read the high lateral velocity as a turn,
  // not an impact. Regression guard for the phantom-crash self-wreck.
  const g3 = makeGame(false);
  const id3 = spawnVehicle(g3, 0, 0, VEHICLE_FUEL_MAX, VEHICLE_HP_MAX);
  settle(g3);
  const p3 = makePlayer("c3", "ch3", g3.physics.vehicleSensors(id3).x, g3.physics.vehicleSensors(id3).z);
  g3.players.set(p3.id, p3);
  enterVehicle(g3, p3, id3, 0);
  for (let i = 0; i < 40; i++) { // build to top speed straight first
    driveInput(g3, p3, 1, 0, 0);
    stepVehicles(g3, dt); g3.physics.step(dt, (g3.time += dt)); tickVehicles(g3, dt);
  }
  for (let i = 0; i < 240; i++) { // sustained full-steer donut
    driveInput(g3, p3, 1, 1, 0);
    stepVehicles(g3, dt); g3.physics.step(dt, (g3.time += dt)); tickVehicles(g3, dt);
  }
  check(g3.vehicleMeta.get(id3).hp === VEHICLE_HP_MAX, `a hard donut on open ground deals ZERO hull damage (${g3.vehicleMeta.get(id3).hp.toFixed(0)} == ${VEHICLE_HP_MAX})`);
}

// --- 4. ram damage -----------------------------------------------------------
{
  // A fast hull hurts a zombie it plows through (high hp so it survives the hit,
  // keeping killZombie out of this focused harness).
  const g = makeGame(false);
  const id = spawnVehicle(g, 0, 0, VEHICLE_FUEL_MAX);
  settle(g);
  const p = makePlayer("r", "rh", g.physics.vehicleSensors(id).x, g.physics.vehicleSensors(id).z);
  g.players.set(p.id, p);
  enterVehicle(g, p, id, 0);
  for (let i = 0; i < 60; i++) {
    driveInput(g, p, 1, 0, 0);
    stepVehicles(g, dt);
    g.physics.step(dt, (g.time += dt));
    tickVehicles(g, dt);
  }
  const s = g.physics.vehicleSensors(id);
  check(s.speed > 5, `vehicle is at ram speed (${s.speed.toFixed(1)} m/s)`);
  const zombie = { id: 1, x: s.x, y: s.y, z: s.z, hp: 1000, mil: false };
  g.zombies.set(zombie.id, zombie);
  driveInput(g, p, 1, 0, 0);
  stepVehicles(g, dt);
  g.physics.step(dt, (g.time += dt));
  tickVehicles(g, dt);
  check(zombie.hp < 1000, `ramming a zombie at speed damaged it (${zombie.hp.toFixed(0)} < 1000)`);
  void VEHICLE_RAM_RADIUS;
}

console.log(failures ? `VEHICLES-SMOKE: FAIL (${failures})` : "VEHICLES-SMOKE: PASS — seats + fuel + crash + ram");
process.exit(failures ? 1 : 0);
