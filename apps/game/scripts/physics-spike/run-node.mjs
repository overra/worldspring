#!/usr/bin/env node
// doc 13 M0 — Node runner (macOS locally, Linux via docker/CI).
//   node apps/game/scripts/physics-spike/run-node.mjs
// Prints one JSON line: hash (determinism) + step-cost sweep (budget).

import { runScenario } from "./scenario.mjs";
import RAPIER from "@dimforge/rapier3d-compat";
import { readFile } from "node:fs/promises";
import os from "node:os";

await RAPIER.init();

const version = JSON.parse(
  await readFile(new URL("../../node_modules/@dimforge/rapier3d-compat/package.json", import.meta.url), "utf8"),
).version;

// Determinism hash: the canonical 100-body/1000-step scenario.
const main = runScenario(RAPIER, { bodies: 100, steps: 1000 });

// Cost sweep: avg step ms at each body count (fresh world each, 600 steps,
// skipping the first 100 as settle/JIT warmup — measured around runScenario
// whole-runs to keep the scenario function untouched).
const sweep = {};
for (const bodies of [25, 50, 100, 200]) {
  runScenario(RAPIER, { bodies, steps: 100 }); // warmup
  const t0 = performance.now();
  runScenario(RAPIER, { bodies, steps: 600 });
  sweep[bodies] = +(((performance.now() - t0) / 600)).toFixed(3);
}

console.log(JSON.stringify({
  runtime: `node-${process.version}-${os.platform()}-${os.arch()}`,
  rapier: version,
  hash: main.hash,
  stepMsByBodies: sweep,
}));
