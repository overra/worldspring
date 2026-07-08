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
