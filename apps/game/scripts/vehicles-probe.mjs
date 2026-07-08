#!/usr/bin/env node
// Vehicles probe (doc 13 M4) — drives a REAL GameRoom over WS and proves the
// vehicle slice end to end across the actual wire + persistence path (the
// committed vehicles-smoke.mjs pins the gameplay math IN-PROCESS; this pins the
// protocol/routing/snapshot/DO-restart layer the offline harness never touches):
//
//   1. the two-sided protocol gate: proto 10 is REFUSED, proto 11 joins;
//   2. enterVehicle boards the driver seat — YouState.seat appears and the
//      vehicle WireBody.seats[0] carries the driver's WirePlayer id;
//   3. a second client boards the PASSENGER seat, and its `drive` is IGNORED
//      (only seat 0 steers) — the hull does not move on passenger throttle;
//   4. the DRIVER's `drive` MOVES the hull (WireBody pose delta) and burns fuel;
//   5. once the tank empties, full throttle produces NO drive force (the hull
//      coasts/decelerates) — out-of-fuel cutoff over the wire;
//   6. exitVehicle frees the seat and lands the player on valid (dry) ground;
//   7. persist -> DO restart rehydrates the SAME vehicle at its pose with its
//      fuel/hp, seats cleared (modes `persist` then `verify`).
//
//   node --experimental-strip-types apps/game/scripts/vehicles-probe.mjs [mode] [ws-url]
//   modes: slice (default; 1-6, self-contained), persist <file>, verify <file>
//   default url: ws://localhost:5174/ws  (worktree dev server; .dev.vars TESTBED=1)
//
// Requires a TESTBED server with physics enabled (the buggy + fuel come from the
// gated "vehicles"/"vehicles_ride" scenarios). Run slice against a FRESH world.
// Not part of `pnpm test` — like props-smoke/trees-probe it needs a live server;
// CI covers the physics + gameplay layers via physics-replay.mjs + vehicles-smoke.mjs.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { VEHICLE_ENTER_RANGE, WATER_WALK_MIN } from "@worldspring/shared/constants";

// world.ts uses extensionless relative imports strip-types can't resolve — bundle
// it with esbuild (the props-smoke / fingerprint.mjs precedent) for ground checks.
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { clampConfig, worldParamsOf } from "./config.ts";\n',
    resolveDir: sharedDir + "/src", loader: "ts", sourcefile: "veh-probe-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
});
const { createWorld, clampConfig, worldParamsOf } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

const argv = process.argv.slice(2);
const MODE = ["slice", "persist", "verify"].includes(argv[0]) ? argv[0] : "slice";
const rest = ["slice", "persist", "verify"].includes(argv[0]) ? argv.slice(1) : argv;
const STATE_FILE = MODE !== "slice" ? (rest.find((a) => !a.startsWith("ws")) ?? "/tmp/vehicles-probe-state.json") : null;
const WS_URL = rest.find((a) => a.startsWith("ws")) ?? "ws://localhost:5174/ws";

if (typeof WebSocket === "undefined") { console.error("vehicles-probe: need Node 22+ (global WebSocket)"); process.exit(2); }

let checks = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) { failed = true; } checks++; };
let failed = false;
const fail = (msg) => { console.error(`\nVEHICLES-PROBE (${MODE}): FAIL — ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// --- a live connection to the room -----------------------------------------
class Conn {
  constructor(name) { this.name = name; this.id = null; this.you = null; this.seat = null; this.bodies = new Map(); this.world = null; this.snaps = 0; this._welcome = null; }
  connect(scenario, proto) {
    this.ws = new WebSocket(WS_URL);
    this.pinger = setInterval(() => { try { this.send({ t: "ping", ts: Date.now() }); } catch { /* closing */ } }, 4000);
    return new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`${this.name}: no welcome/reject in 12s`)); } }, 12000);
      this.ws.addEventListener("open", () => {
        this.send({ t: "join", name: this.name, token: randomBytes(16).toString("hex"), proto, scenario });
      });
      this.ws.addEventListener("error", () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error(`cannot connect to ${WS_URL} — is the worktree dev server running?`)); } });
      this.ws.addEventListener("close", () => { if (!settled) { settled = true; clearTimeout(to); resolve({ rejected: true, reason: "closed" }); } });
      this.ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "error" && !settled) { settled = true; clearTimeout(to); resolve({ rejected: true, reason: m.msg }); return; }
        if (m.t === "welcome") {
          this.id = m.id; this._welcome = m; this.you = { x: m.you.x, y: m.you.y, z: m.you.z };
          const cfg = clampConfig(m.config).world; if (cfg.seed !== m.seed) cfg.seed = m.seed;
          this.world = createWorld(worldParamsOf(cfg));
          if (!settled) { settled = true; clearTimeout(to); resolve({ rejected: false, welcome: m }); }
        }
        if (m.t === "snap") {
          this.snaps++;
          if (m.you) { this.you = { x: m.you.x, y: m.you.y, z: m.you.z, grounded: m.you.grounded }; this.seat = m.you.seat ?? null; }
          for (const b of m.bodies ?? []) { if (b.kind === "vehicle") this.bodies.set(b.id, b); }
        }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { clearInterval(this.pinger); this.ws.close(); } catch { /* done */ } }
  nearestVehicle() {
    let best = null, bestD = Infinity;
    for (const b of this.bodies.values()) { const d = dist2(this.you.x, this.you.z, b.x, b.z); if (d < bestD) { bestD = d; best = b; } }
    return best ? { body: best, dist: bestD } : null;
  }
  async waitSnaps(n) { const target = this.snaps + n; while (this.snaps < target) await sleep(20); }
  // Wait until a vehicle body is in range (settled snapshot), return it.
  async acquireVehicle(maxWaitMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) { const nv = this.nearestVehicle(); if (nv && nv.dist <= VEHICLE_ENTER_RANGE + 0.5) return nv.body; await sleep(60); }
    return this.nearestVehicle()?.body ?? null;
  }
}

async function runSlice() {
  console.log(`VEHICLES-PROBE (slice) @ ${WS_URL} — proto ${PROTOCOL_VERSION}`);

  // (1) protocol gate: an OLD proto is refused before any welcome.
  const bad = new Conn("veh-oldproto");
  const r = await bad.connect("vehicles", PROTOCOL_VERSION - 1);
  check(r.rejected === true, `old proto ${PROTOCOL_VERSION - 1} is REFUSED (${r.reason ?? "closed"})`);
  bad.close();

  // (2) driver joins at the live proto and boards the driver seat.
  const driver = new Conn("veh-driver");
  const dj = await driver.connect("vehicles", PROTOCOL_VERSION);
  if (dj.rejected) fail(`driver join refused: ${dj.reason}`);
  const veh0 = await driver.acquireVehicle();
  if (!veh0) fail("no vehicle body near the driver spawn — is the 'vehicles' scenario provisioning one? (TESTBED=1, physics on)");
  check(Array.isArray(veh0.seats) && veh0.seats[0] === null && veh0.seats[1] === null, `a fresh buggy is in range, both seats empty (id=${veh0.id})`);
  const vid = veh0.id;

  driver.send({ t: "enterVehicle", id: vid, seat: 0 });
  await driver.waitSnaps(4);
  check(driver.seat != null && driver.seat.index === 0 && driver.seat.id === vid, `enter occupies the DRIVER seat (YouState.seat index 0, id ${vid})`);
  check((driver.bodies.get(vid)?.seats ?? [])[0] === driver.id, `WireBody.seats[0] carries the driver's player id (${driver.id})`);

  // (3) passenger boards seat 1; their `drive` must be IGNORED.
  const pax = new Conn("veh-pax");
  const pj = await pax.connect("vehicles_ride", PROTOCOL_VERSION);
  if (pj.rejected) fail(`passenger join refused: ${pj.reason}`);
  const vehForPax = await pax.acquireVehicle();
  check(vehForPax && vehForPax.id === vid, `passenger sees the SAME buggy (${vehForPax?.id} == ${vid})`);
  pax.send({ t: "enterVehicle", id: vid, seat: 1 });
  await pax.waitSnaps(4);
  check(pax.seat != null && pax.seat.index === 1, "passenger occupies the PASSENGER seat (YouState.seat index 1)");
  const seatsNow = pax.bodies.get(vid)?.seats ?? [];
  check(seatsNow[0] === driver.id && seatsNow[1] === pax.id, "WireBody.seats = [driver, passenger] (both ids present)");

  // passenger-drive rejection: driver idle, passenger full throttle for ~25 ticks.
  const before = driver.bodies.get(vid);
  const pStart = { x: before.x, z: before.z };
  for (let i = 0; i < 25; i++) { pax.send({ t: "drive", throttle: 1, steer: 0, brake: 0 }); await pax.waitSnaps(1); }
  await driver.waitSnaps(2);
  const afterPax = driver.bodies.get(vid);
  const paxDelta = dist2(pStart.x, pStart.z, afterPax.x, afterPax.z);
  check(paxDelta < 2, `a PASSENGER's drive does NOT move the hull (Δ=${paxDelta.toFixed(2)}m < 2)`);

  // (4)+(5) DRIVER drive: a donut (stays local, phantom-crash-safe) MOVES the
  // hull and drains the tank; then full throttle on an empty tank makes no force.
  const driveStart = { x: afterPax.x, z: afterPax.z };
  let maxDelta = 0, emptyAtSpeed = null, wrecked = false;
  for (let i = 0; i < 90 && emptyAtSpeed === null; i++) {
    driver.send({ t: "drive", throttle: 1, steer: 1, brake: 0 });
    await driver.waitSnaps(1);
    const b = driver.bodies.get(vid);
    if (b) maxDelta = Math.max(maxDelta, dist2(driveStart.x, driveStart.z, b.x, b.z));
    if (b?.wrecked) { wrecked = true; break; }
    if (driver.seat == null) { break; } // ejected unexpectedly
    if (driver.seat && driver.seat.fuel <= 0) emptyAtSpeed = driver.seat.speed;
  }
  check(!wrecked, "the buggy did not self-wreck on the cornering donut (phantom-crash guard holds)");
  check(maxDelta > 3, `the DRIVER's drive MOVES the hull (max Δ=${maxDelta.toFixed(2)}m > 3)`);
  check(emptyAtSpeed !== null, `driving drained the tank to empty (speed at empty ${emptyAtSpeed?.toFixed?.(1) ?? "n/a"} m/s)`);

  // out-of-fuel: keep full throttle on the dry tank; the hull must not re-accelerate.
  let maxSpeedAfterEmpty = 0;
  for (let i = 0; i < 22; i++) {
    driver.send({ t: "drive", throttle: 1, steer: 1, brake: 0 });
    await driver.waitSnaps(1);
    if (driver.seat) maxSpeedAfterEmpty = Math.max(maxSpeedAfterEmpty, driver.seat.speed);
  }
  const stillEmpty = driver.seat && driver.seat.fuel <= 0;
  check(stillEmpty, "the empty tank stays empty under continued throttle (no negative/rebound fuel)");
  check(emptyAtSpeed !== null && maxSpeedAfterEmpty <= emptyAtSpeed + 0.25,
    `out of fuel => full throttle adds NO drive force (peak ${maxSpeedAfterEmpty.toFixed(1)} <= empty ${emptyAtSpeed?.toFixed(1)} m/s)`);

  // (6) exit frees the seat and lands on valid ground.
  driver.send({ t: "exitVehicle" });
  await driver.waitSnaps(4);
  check(driver.seat == null, "exitVehicle frees the seat (YouState.seat gone — on foot)");
  const ex = driver.you;
  const gh = driver.world.heightAt(ex.x, ex.z);
  check(gh >= WATER_WALK_MIN, `the ex-driver is placed on DRY ground (heightAt=${gh.toFixed(2)} >= ${WATER_WALK_MIN})`);
  check(Math.abs(ex.y - driver.world.groundHeight(ex.x, ex.z)) < 2.5 && ex.grounded !== false, `the ex-driver is grounded at ground level (y=${ex.y.toFixed(2)})`);
  const seatsAfterExit = driver.bodies.get(vid)?.seats ?? [];
  check(seatsAfterExit[0] === null, "the vacated driver seat reads empty on the wire again");

  pax.close(); driver.close();
  finish();
}

async function runPersist() {
  console.log(`VEHICLES-PROBE (persist) @ ${WS_URL} -> ${STATE_FILE}`);
  const c = new Conn("veh-persist");
  const j = await c.connect("vehicles", PROTOCOL_VERSION);
  if (j.rejected) fail(`join refused: ${j.reason}`);
  const veh = await c.acquireVehicle();
  if (!veh) fail("no vehicle to persist");
  const vid = veh.id;
  // Read fuel/hp from the driver HUD (only exposed while seated), then step off.
  c.send({ t: "enterVehicle", id: vid, seat: 0 });
  await c.waitSnaps(4);
  if (c.seat == null) fail("could not board to read fuel/hp");
  const fuel = c.seat.fuel, hp = c.seat.hp;
  c.send({ t: "exitVehicle" });
  await c.waitSnaps(6);
  const rest = c.bodies.get(vid);
  const state = { id: vid, x: rest.x, y: rest.y, z: rest.z, fuel, hp };
  console.log(`  captured buggy ${vid}: pose=(${rest.x.toFixed(1)},${rest.y.toFixed(2)},${rest.z.toFixed(1)}) fuel=${fuel} hp=${hp}`);
  // Wait out a world save (WORLD_SAVE_INTERVAL_S=20) so the DO row is written.
  console.log("  waiting ~24s for a world save...");
  await sleep(24000);
  writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`  wrote ${STATE_FILE}`);
  c.close();
  console.log(`\nVEHICLES-PROBE (persist): DONE — restart the server KEEPING state, then run: verify ${STATE_FILE}`);
  process.exit(0);
}

async function runVerify() {
  const want = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  console.log(`VEHICLES-PROBE (verify) @ ${WS_URL} — expecting buggy ${want.id} rehydrated`);
  // vehicles_ride provisions NO vehicle (so we don't spawn a second one); it
  // just lands us next to the rehydrated one at the same inland spot.
  const c = new Conn("veh-verify");
  const j = await c.connect("vehicles_ride", PROTOCOL_VERSION);
  if (j.rejected) fail(`join refused: ${j.reason}`);
  await c.waitSnaps(6);
  const veh = c.bodies.get(want.id);
  check(veh != null, `the SAME buggy id ${want.id} survived the restart (not re-spawned at a new id)`);
  if (veh) {
    const poseDelta = dist2(want.x, want.z, veh.x, veh.z);
    check(poseDelta < 3 && Math.abs(veh.y - want.y) < 3, `rehydrated at its persisted pose (Δxz=${poseDelta.toFixed(2)}m, Δy=${Math.abs(veh.y - want.y).toFixed(2)})`);
    check(Array.isArray(veh.seats) && veh.seats[0] === null && veh.seats[1] === null, "seats are CLEARED across the restart (nobody rides a restored hull)");
    check(veh.wrecked !== true, "the restored buggy is intact (not spuriously wrecked)");
  }
  // Board to read the rehydrated fuel/hp (the persisted gameplay meta).
  const nv = c.nearestVehicle();
  if (nv && nv.body.id === want.id && nv.dist <= VEHICLE_ENTER_RANGE + 0.5) {
    c.send({ t: "enterVehicle", id: want.id, seat: 0 });
    await c.waitSnaps(4);
    if (c.seat != null) {
      check(Math.abs(c.seat.fuel - want.fuel) <= 1.0, `fuel persisted across the restart (${c.seat.fuel} ≈ ${want.fuel})`);
      check(Math.abs(c.seat.hp - want.hp) <= 1.0, `hp persisted across the restart (${c.seat.hp} ≈ ${want.hp})`);
    } else check(false, "could not board the restored buggy to read fuel/hp");
  } else {
    console.log(`  (note) restored buggy is ${nv?.dist?.toFixed?.(1) ?? "?"}m away — fuel/hp read skipped; pose+seats verified from the wire`);
  }
  c.close();
  finish();
}

function finish() {
  setTimeout(() => {
    if (failed) { console.error(`\nVEHICLES-PROBE (${MODE}): FAIL (${checks} checks)`); process.exit(1); }
    console.log(`\nVEHICLES-PROBE (${MODE}): PASS (${checks} checks)`);
    process.exit(0);
  }, 200);
}

const DEADLINE = setTimeout(() => fail(`timed out after 180s in mode ${MODE}`), 180000);
try {
  if (MODE === "slice") await runSlice();
  else if (MODE === "persist") await runPersist();
  else await runVerify();
} catch (e) { fail(e?.stack ?? String(e)); }
clearTimeout(DEADLINE);
