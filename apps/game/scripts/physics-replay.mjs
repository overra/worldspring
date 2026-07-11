#!/usr/bin/env node
// doc 13 M1 — physics replay + orientation harness (CI-run via `pnpm test`).
//
// 1. ORIENTATION PROBES: builds a PhysicsSystem over a fake world whose
//    heightAt has DISTINCT slopes along +x and +z, drops probes, and asserts
//    each settles at its column's terrain height — catching a transposed
//    heightfield (rapier's column-major data) as a hard failure instead of a
//    silent tilt.
// 2. REPLAY DETERMINISM: runs a fixed scripted scenario through the REAL
//    PhysicsSystem (spawns, impulses, cap eviction, serialize round-trip) and
//    FNV-hashes the serialized state, diffing against the committed baseline
//    (physics-replay.hash). Rapier is bit-deterministic across platforms (M0,
//    doc 13 §M0 findings) — any drift here is an ENGINE UPGRADE or a code
//    change and must re-baseline deliberately, like the worldgen fingerprint.
//
// Runs on Node via rapier3d-compat's normal init (the workerd wasm loader is
// exactly the piece this harness does NOT exercise; the preview covers it).

import RAPIER from "@dimforge/rapier3d-compat";
import { readFile } from "node:fs/promises";
import { PhysicsSystem } from "../src/server/physics/PhysicsSystem.ts";
// doc 13 M3 — the REAL server-side barrel-break loot roller + table, so the
// break→loot section below exercises production code, not a re-implementation.
import { rollFromTable } from "../src/server/systems/loot.ts";
import { breakBarrel } from "../src/server/systems/barrelBreak.ts";
import { BARREL_LOOT_TABLE } from "@worldspring/shared/items";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

// Fake statics source: x>50 is a 6m plateau, z>50 is a 3m plateau, else flat 0.
// Piecewise-constant (no transcendentals) — bit-identical everywhere.
const fakeWorld = {
  // size 800 keeps the heightfield extent + sample count identical to the
  // pre-doc-07 constant (WORLD_SIZE) so the committed replay hash stands.
  size: 800,
  heightAt: (x, z) => (x > 50 ? 6 : z > 50 ? 3 : 0),
  buildings: [],
  militaryWalls: [],
  trees: [],
};

await RAPIER.init();
const dt = 1 / 15;

// --- 1. orientation probes -------------------------------------------------
{
  const sys = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sys.attachEngine(RAPIER, dt);
  sys.spawnBody(1, "crate", 100, 20, 0); // over the +x plateau (6m)
  sys.spawnBody(2, "crate", 0, 20, 100); // over the +z plateau (3m)
  sys.spawnBody(3, "crate", -100, 20, -100); // over flat 0
  for (let i = 0; i < 450; i++) sys.step(dt, i * dt); // 30s — plenty to settle
  const poses = new Map([...sys.poses()].map((b) => [b.id, b]));
  const settleOk = (id, h) => {
    const y = poses.get(id)?.y ?? NaN;
    // center rests half-extent (0.4) above ground; heightfield sampling adds
    // ≤ half-cell error near plateau EDGES, but probes sit far from them.
    return Math.abs(y - (h + 0.4)) < 0.35;
  };
  check(settleOk(1, 6), `+x plateau probe settled at ~6.4 (y=${poses.get(1)?.y.toFixed(2)}) — x axis maps to heightfield columns`);
  check(settleOk(2, 3), `+z plateau probe settled at ~3.4 (y=${poses.get(2)?.y.toFixed(2)}) — z axis maps to heightfield rows`);
  check(settleOk(3, 0), `flat probe settled at ~0.4 (y=${poses.get(3)?.y.toFixed(2)})`);
}

// --- 1.5 felled trees + trunk bodies (doc 13 M2) -----------------------------
// New assertions only — the hashed replay scenario below is UNTOUCHED, so the
// committed baseline stands.
{
  // A world with one 8m tree at the origin (flat ground elsewhere).
  const treeWorld = {
    size: 800,
    heightAt: () => 0,
    buildings: [],
    militaryWalls: [],
    trees: [{ x: 0, z: 0, r: 0.35, height: 8 }],
  };
  const settleY = (sys, id) => [...sys.poses()].find((b) => b.id === id)?.y ?? NaN;

  // a) Standing tree collides: a crate dropped over it rests on TOP (~8.4).
  const sysA = new PhysicsSystem(treeWorld, { enabled: true, bodyCap: 64 });
  sysA.attachEngine(RAPIER, dt);
  sysA.spawnBody(1, "crate", 0, 12, 0);
  for (let i = 0; i < 450; i++) sysA.step(dt, i * dt);
  check(Math.abs(settleY(sysA, 1) - 8.4) < 0.5, `crate rests ON the standing tree (y=${settleY(sysA, 1).toFixed(2)} ≈ 8.4)`);

  // b) RUNTIME removal: felling the tree drops that same crate to the ground.
  sysA.fellTree(0);
  for (let i = 450; i < 900; i++) sysA.step(dt, i * dt);
  check(Math.abs(settleY(sysA, 1) - 0.4) < 0.35, `after fellTree the crate falls to the ground (y=${settleY(sysA, 1).toFixed(2)} ≈ 0.4)`);

  // c) PRE-ATTACH exclusion (the restored-world path): fellTree before
  //    attachEngine must skip building the static collider entirely.
  const sysB = new PhysicsSystem(treeWorld, { enabled: true, bodyCap: 64 });
  sysB.fellTree(0);
  sysB.attachEngine(RAPIER, dt);
  sysB.spawnBody(1, "crate", 0, 12, 0);
  for (let i = 0; i < 450; i++) sysB.step(dt, i * dt);
  check(Math.abs(settleY(sysB, 1) - 0.4) < 0.35, `restored felled set excludes the collider at attach (y=${settleY(sysB, 1).toFixed(2)} ≈ 0.4)`);

  // d) Trunk body: upright spawn + off-center top impulse TOPPLES it — it
  //    settles lying down (center ≈ its half-WIDTH above ground, not half-
  //    height), then expireSettled reaps it with a resting pose.
  const sysC = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysC.attachEngine(RAPIER, dt);
  const halfH = 4, r = 0.35;
  sysC.spawnBody(7, "trunk", 0, halfH + 0.3, 0, [r, halfH, r]);
  // Mirrors systems/trees.ts: impulse = mass * TOPPLE_SPEED at the trunk top.
  const mass = 8 * r * halfH * r;
  sysC.applyImpulseAtPoint(7, mass * 2.5, 0, 0, 0, 2 * halfH, 0);
  let steps = 0;
  for (; steps < 1200; steps++) {
    sysC.step(dt, steps * dt);
    const pose = [...sysC.poses()].find((b) => b.id === 7);
    if (pose?.asleep) break;
  }
  const trunk = [...sysC.poses()].find((b) => b.id === 7);
  check(trunk !== undefined && trunk.asleep === true, `trunk fell asleep after ${steps} steps`);
  check(trunk !== undefined && trunk.y < 1.0, `trunk settled LYING DOWN (y=${trunk?.y.toFixed(2)} < 1.0 — toppled, not standing at ~4)`);
  check(trunk?.dims?.[1] === halfH, "trunk pose carries its dims for the wire");
  // Not yet expired: 10s < TTL.
  const sleepT = steps * dt;
  check(sysC.expireSettled("trunk", 30, sleepT + 10).length === 0, "expireSettled holds before the TTL");
  const reaped = sysC.expireSettled("trunk", 30, sleepT + 40);
  check(reaped.length === 1 && Math.abs(reaped[0].y - (trunk?.y ?? NaN)) < 0.01, "expireSettled reaps the trunk after the TTL with its resting pose");
  check(sysC.count === 0, "reaped trunk left the body registry");
  // Kind filter: a crate settled just as long is NOT reaped by the trunk sweep.
  const sysD = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysD.attachEngine(RAPIER, dt);
  sysD.spawnBody(9, "crate", 0, 2, 0);
  for (let i = 0; i < 450; i++) sysD.step(dt, i * dt);
  check(sysD.expireSettled("trunk", 30, 450 * dt + 100).length === 0, "expireSettled('trunk') ignores settled crates");
}

// --- 1.6 physics props: barrels (doc 13 M3) ----------------------------------
// New assertions only — the hashed replay scenario (section 2) is UNTOUCHED, so
// the committed baseline stands (no re-baseline). Barrels are a fixed-size,
// dims-less "barrel" BodyKind spawned near loot zones and shoved by melee.
{
  const poseOf = (sys, id) => [...sys.poses()].find((b) => b.id === id);

  // a) Fixed-size dynamic body: dropped over flat ground it settles upright at
  //    ~BARREL_HALF_Y (0.5) above the ground and carries NO dims on the wire
  //    (the WireBody shape stays unchanged — dims is trunk-only).
  const sysA = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysA.attachEngine(RAPIER, dt);
  sysA.spawnBody(1, "barrel", -100, 6, -100); // over flat 0, clear of the plateaus
  for (let i = 0; i < 450; i++) sysA.step(dt, i * dt);
  const settled = poseOf(sysA, 1);
  check(settled !== undefined && Math.abs(settled.y - 0.5) < 0.35, `barrel settles at ~0.5 (y=${settled?.y.toFixed(2)})`);
  check(settled !== undefined && settled.dims === undefined, "barrel pose carries NO dims (fixed-size wire shape unchanged)");

  // b) A scripted impulse moves a barrel to a REPRODUCIBLE resting pose: settle
  //    it, shove it along +x (mirroring systems/props.ts), it re-settles asleep
  //    having moved +x. Tolerance/direction — NOT hashed (determinism itself is
  //    pinned by section 2's replay hash), so the committed baseline stands.
  const shoveMass = 8 * 0.3 * 0.5 * 0.3; // BARREL cuboid mass at density 1
  const runShove = () => {
    const sys = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
    sys.attachEngine(RAPIER, dt);
    sys.spawnBody(1, "barrel", -100, 0.7, -100);
    for (let i = 0; i < 200; i++) sys.step(dt, i * dt); // settle first
    const x0 = poseOf(sys, 1).x;
    sys.applyImpulse(1, shoveMass * 4.5, shoveMass * 1.2, 0); // += props.ts shove
    let s = 200;
    for (; s < 1200; s++) {
      sys.step(dt, s * dt);
      if (poseOf(sys, 1)?.asleep) break;
    }
    for (let k = 0; k < 60; k++) sys.step(dt, (s + k) * dt); // hold past sleep
    return { pose: poseOf(sys, 1), x0, sleepStep: s };
  };
  const r1 = runShove();
  check(r1.pose?.asleep === true, `shoved barrel re-settled asleep (~${r1.sleepStep - 200} steps after the shove)`);
  check(r1.pose !== undefined && r1.pose.x - r1.x0 > 0.5, `shove moved the barrel along +x (Δx=${(r1.pose.x - r1.x0).toFixed(2)} > 0.5)`);
  const r2 = runShove();
  check(
    r2.pose !== undefined && Math.abs(r2.pose.x - r1.pose.x) < 1e-6 && Math.abs(r2.pose.z - r1.pose.z) < 1e-6,
    `shove is reproducible (resting pose matches to <1e-6: Δx=${Math.abs(r2.pose.x - r1.pose.x).toExponential(1)})`,
  );

  // c) Body cap with props+trunks MIXED: a small cap, a mix of barrels+trunks
  //    over it, step to settle — the cap holds (oldest-settled-first eviction).
  const sysC = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 6 });
  sysC.attachEngine(RAPIER, dt);
  let id = 1;
  for (let i = 0; i < 6; i++) sysC.spawnBody(id++, "barrel", -80 + i * 2, 3, -80);
  for (let i = 0; i < 6; i++) sysC.spawnBody(id++, "trunk", -80 + i * 2, 4.3, -60, [0.35, 4, 0.35]);
  for (let s = 0; s < 400; s++) sysC.step(dt, s * dt);
  check(sysC.count <= 6, `body cap holds with props+trunks mixed (count=${sysC.count} ≤ 6)`);
  // Trunk-FIRST eviction: trunks are the unbounded population now that they
  // persist until axed, so they pay their own cap cost — barrels are bounded
  // loot fixtures and must never be silently deleted by logging pressure.
  const evictedKinds = sysC.drainEvicted().map((b) => b.kind);
  check(
    evictedKinds.length > 0 && evictedKinds.every((k) => k === "trunk"),
    `cap eviction picks trunks, never barrels (evicted: ${evictedKinds.join(",")})`,
  );
  const barrelSurvivors = [...sysC.poses()].filter((b) => b.kind === "barrel").length;
  check(barrelSurvivors === 6, `all 6 barrels survive trunk cap pressure (barrels=${barrelSurvivors})`);

  // d) Restore round-trip preserves a barrel (kind, dims-less, pose) alongside a
  //    trunk — the persisted `bodies` snapshot rebuilds props exactly.
  const sysD = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysD.attachEngine(RAPIER, dt);
  sysD.spawnBody(1, "barrel", -100, 0.7, -100);
  sysD.spawnBody(2, "trunk", -60, 4.3, -60, [0.35, 4, 0.35]);
  for (let i = 0; i < 300; i++) sysD.step(dt, i * dt);
  const persisted = sysD.serialize();
  const barrelRow = persisted.find((b) => b.id === 1);
  check(barrelRow?.kind === "barrel" && barrelRow.dims === undefined, "barrel serializes as kind 'barrel' with no dims");
  const sysD2 = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysD2.attachEngine(RAPIER, dt);
  sysD2.restore(persisted);
  const restored = new Map([...sysD2.poses()].map((b) => [b.id, b]));
  check(restored.get(1)?.kind === "barrel", "restore rebuilds the barrel body (kind preserved)");
  check(restored.get(2)?.kind === "trunk", "restore rebuilds the mixed trunk body too");
  check(Math.abs((restored.get(1)?.y ?? NaN) - (barrelRow?.y ?? NaN)) < 0.01, "restored barrel resumes its persisted pose");

  // e) break→loot rolls SERVER-SIDE: the real rollFromTable over the real
  //    BARREL_LOOT_TABLE yields valid stacks (renderable types, counts in
  //    range) — exactly what breakBarrel spills on the final swing.
  let rollOk = true;
  for (let i = 0; i < 300 && rollOk; i++) {
    const stack = rollFromTable(BARREL_LOOT_TABLE);
    const entry = BARREL_LOOT_TABLE.find((e) => e.type === stack.type);
    rollOk = !!entry && stack.count >= entry.min && stack.count <= entry.max;
    if (!rollOk) check(false, `barrel loot roll out of range: ${JSON.stringify(stack)}`);
  }
  if (rollOk) check(true, "barrel break loot rolls valid server-side stacks (300 rolls, all in range)");

  // f) The production break path captures the body's FINAL unquantized pose,
  //    queues exactly one additive cosmetic event, then removes the body and
  //    spills authoritative loot at that same location. This direct probe is
  //    independent of the websocket smoke harness's route to a distant prop.
  const sysE = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysE.attachEngine(RAPIER, dt);
  sysE.spawnBody(42, "barrel", -100, 0.7, -100);
  for (let i = 0; i < 200; i++) sysE.step(dt, i * dt);
  sysE.applyImpulse(42, shoveMass * 2.5, shoveMass * 1.2, shoveMass * 0.7);
  for (let i = 200; i < 225; i++) sysE.step(dt, i * dt);
  const finalPose = sysE.bodyPose(42);
  const breakState = {
    physics: sysE,
    propHits: new Map([[42, 2]]),
    events: [],
    nextEntityId: 500,
    loot: new Map(),
    world: { groundHeight: fakeWorld.heightAt },
  };
  breakBarrel(breakState, 42, 999, 999, 999);
  const breakEvent = breakState.events[0]?.ev;
  const samePose = breakEvent?.e === "break" && finalPose !== null
    && Math.abs(breakEvent.x - finalPose.x) < 1e-9
    && Math.abs(breakEvent.y - finalPose.y) < 1e-9
    && Math.abs(breakEvent.z - finalPose.z) < 1e-9
    && breakEvent.q.every((v, i) => Number.isFinite(v) && Math.abs(v - finalPose.q[i]) < 1e-9);
  check(
    breakState.events.length === 1 && breakEvent?.e === "break" && breakEvent.id === 42 && breakEvent.kind === "barrel",
    "barrel break queues exactly one typed break event",
  );
  check(samePose, "break event carries the body's exact final position and quaternion");
  check(sysE.bodyPose(42) === null && !breakState.propHits.has(42), "break removes the authoritative body and transient hit counter");
  const spilled = breakState.loot.get(500);
  check(
    breakState.loot.size === 1 && spilled?.spawnId === null && spilled.x === finalPose?.x && spilled.z === finalPose?.z,
    "break spills one authoritative loot stack at the captured final pose",
  );
}

// --- 1.7 vehicles: driven-body controller (doc 13 M4) ------------------------
// New assertions only — the hashed replay scenario (section 2) is UNTOUCHED, so
// the committed baseline stands (no re-baseline). The controller
// (PhysicsSystem.driveVehicle) + sensors are exercised directly; determinism is
// pinned here by a run-twice reproducibility check (the barrel-shove precedent),
// NOT by the global hash. A vehicle is a fixed-size, dims-less "vehicle" body
// with its rotation locked upright (only yaw free).
{
  const poseOf = (sys, id) => [...sys.poses()].find((b) => b.id === id);

  // a) Fixed-size dims-less "vehicle" body settles UPRIGHT on flat ground at
  //    ~VEHICLE_HALF_Y (0.55), carrying NO dims on the wire.
  const sysA = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysA.attachEngine(RAPIER, dt);
  sysA.spawnBody(1, "vehicle", -100, 4, -100); // flat 0, clear of the plateaus
  for (let i = 0; i < 300; i++) sysA.step(dt, i * dt);
  const settled = poseOf(sysA, 1);
  check(settled !== undefined && Math.abs(settled.y - 0.55) < 0.35, `vehicle settles upright at ~0.55 (y=${settled?.y.toFixed(2)})`);
  check(settled !== undefined && settled.dims === undefined, "vehicle pose carries NO dims (fixed-size wire shape)");

  // b) DRIVE forward: a throttle-1 sequence moves the hull and the result is
  //    REPRODUCIBLE to <1e-6 (the controller is deterministic — no wall-clock,
  //    no transcendentals, reads only body state + clamped input).
  const runDrive = () => {
    const sys = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
    sys.attachEngine(RAPIER, dt);
    sys.spawnBody(1, "vehicle", -100, 0.9, -100);
    for (let i = 0; i < 60; i++) sys.step(dt, i * dt); // settle
    const start = poseOf(sys, 1);
    for (let i = 60; i < 260; i++) {
      sys.driveVehicle(1, 1, 0, 0, dt); // full throttle, no steer/brake
      sys.step(dt, i * dt);
    }
    return { start, end: poseOf(sys, 1), sensors: sys.vehicleSensors(1) };
  };
  const drv1 = runDrive();
  const moved = Math.hypot(drv1.end.x - drv1.start.x, drv1.end.z - drv1.start.z);
  check(moved > 3, `drive-forward moved the vehicle (${moved.toFixed(2)} m > 3)`);
  check(drv1.sensors.speed > 2, `vehicle reached driving speed (${drv1.sensors.speed.toFixed(2)} m/s)`);
  const drv2 = runDrive();
  check(
    Math.abs(drv2.end.x - drv1.end.x) < 1e-6 && Math.abs(drv2.end.z - drv1.end.z) < 1e-6,
    `drive is reproducible (Δx=${Math.abs(drv2.end.x - drv1.end.x).toExponential(1)})`,
  );

  // c) STEER changes the PATH: full throttle + full steer ends somewhere clearly
  //    different from driving straight (the hull turned).
  const runSteer = (steer) => {
    const sys = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
    sys.attachEngine(RAPIER, dt);
    sys.spawnBody(1, "vehicle", -100, 0.9, -100);
    for (let i = 0; i < 60; i++) sys.step(dt, i * dt);
    for (let i = 60; i < 210; i++) {
      sys.driveVehicle(1, 1, steer, 0, dt);
      sys.step(dt, i * dt);
    }
    return sys.vehicleSensors(1);
  };
  const straight = runSteer(0);
  const turned = runSteer(1);
  const pathDiff = Math.hypot(straight.x - turned.x, straight.z - turned.z);
  check(pathDiff > 2, `steering changed the path (Δpos=${pathDiff.toFixed(2)} m)`);

  // d) BODY-CAP EXEMPTION: a tiny cap flooded with barrels must NOT evict the
  //    vehicle, and the transient barrels stay capped.
  const sysD = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 3 });
  sysD.attachEngine(RAPIER, dt);
  sysD.spawnBody(1, "vehicle", -80, 1, -80);
  for (let i = 0; i < 10; i++) sysD.spawnBody(10 + i, "barrel", -60 + i * 2, 3, -60);
  for (let s = 0; s < 300; s++) sysD.step(dt, s * dt);
  check([...sysD.poses()].some((b) => b.id === 1 && b.kind === "vehicle"), "vehicle survives cap pressure (cap-exempt)");
  const barrelsLeft = [...sysD.poses()].filter((b) => b.kind === "barrel").length;
  check(barrelsLeft <= 3, `transient barrels still capped at 3 (${barrelsLeft} ≤ 3, vehicle uncounted)`);

  // e) RESTORE round-trip preserves the vehicle body (kind, dims-less, pose).
  const sysE = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysE.attachEngine(RAPIER, dt);
  sysE.spawnBody(1, "vehicle", -100, 0.9, -100);
  for (let i = 0; i < 200; i++) sysE.step(dt, i * dt);
  const persistedV = sysE.serialize();
  const vrow = persistedV.find((b) => b.id === 1);
  check(vrow?.kind === "vehicle" && vrow.dims === undefined, "vehicle serializes as kind 'vehicle' with no dims");
  const sysE2 = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 64 });
  sysE2.attachEngine(RAPIER, dt);
  sysE2.restore(persistedV);
  const rv = [...sysE2.poses()].find((b) => b.id === 1);
  check(rv?.kind === "vehicle" && Math.abs((rv?.y ?? NaN) - (vrow?.y ?? NaN)) < 0.01, "restore rebuilds the vehicle at its persisted pose");
}

// --- 2. replay determinism ---------------------------------------------------
{
  const sys = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 24 });
  sys.attachEngine(RAPIER, dt);
  // Deterministic scripted run: 32 spawns (8 over cap → eviction exercised),
  // periodic impulses, then a serialize→restore→serialize round-trip.
  let id = 1;
  for (let i = 0; i < 32; i++) {
    sys.spawnBody(id++, "crate", -40 + (i % 8) * 3, 10 + (i >> 3) * 2, -40 + (i >> 3) * 3);
  }
  for (let s = 0; s < 600; s++) {
    if (s % 45 === 0) sys.applyImpulse(1 + (s / 45) % 24, 2, 3, -1);
    sys.step(dt, s * dt);
  }
  check(sys.count <= 24, `body cap enforced (count=${sys.count} ≤ 24)`);

  const state1 = sys.serialize();
  // Round-trip: a fresh system restored from state1 must serialize identically
  // (restore fidelity incl. velocities + sleep — doc 13 §4).
  const sys2 = new PhysicsSystem(fakeWorld, { enabled: true, bodyCap: 24 });
  sys2.attachEngine(RAPIER, dt);
  sys2.restore(state1);
  const state2 = sys2.serialize();
  const enc = (st) => new TextEncoder().encode(JSON.stringify(st));
  check(
    JSON.stringify(state1.map((b) => b.id)) === JSON.stringify(state2.map((b) => b.id)),
    "restore round-trip preserves the body set",
  );

  const hash = fnv1a(enc(state1));
  const baselinePath = new URL("./physics-replay.hash", import.meta.url);
  const baseline = (await readFile(baselinePath, "utf8").catch(() => "")).trim();
  if (baseline === "") {
    console.log(`  NOTE — no baseline committed yet; current hash: ${hash}`);
    console.log("  Write it to apps/game/scripts/physics-replay.hash to arm the gate.");
    failures++;
  } else {
    check(
      hash === baseline,
      `replay hash ${hash} matches baseline ${baseline} (drift = engine upgrade or physics code change; re-baseline DELIBERATELY)`,
    );
  }
}

console.log(failures ? `PHYSICS-REPLAY: FAIL (${failures})` : "PHYSICS-REPLAY: PASS — orientation + replay + round-trip hold");
process.exit(failures ? 1 : 0);
