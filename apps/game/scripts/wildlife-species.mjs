// Wildlife species harness (doc 07 M8).
//   node --experimental-strip-types apps/game/scripts/wildlife-species.mjs
//
// Drives the server wildlife module over a real generated world without a DO:
// deterministic hash-salted spawn placement, rabbit-only config, dormancy, and
// kill -> land-meat drop -> species respawn timer.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Non-leaf shared modules import each other extensionlessly, so bundle the real
// modules before importing under node --experimental-strip-types.
const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { DEFAULT_CONFIG, effectiveAnimalMax, worldParamsOf } from "./packages/shared/src/config.ts";\n' +
      'export { createWorld } from "./packages/shared/src/world.ts";\n' +
      'export { damageAnimal, spawnInitialAnimals, tickAnimalRespawns, tickWildlife } from "./apps/game/src/server/systems/wildlife.ts";\n',
    resolveDir: repoDir,
    loader: "ts",
    sourcefile: "wildlife-harness-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const {
  DEFAULT_CONFIG,
  createWorld,
  damageAnimal,
  effectiveAnimalMax,
  spawnInitialAnimals,
  tickAnimalRespawns,
  tickWildlife,
  worldParamsOf,
} = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  }
}

function makeConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.wildlife.deerDensity = 0;
  cfg.wildlife.rabbitDensity = 1;
  cfg.wildlife.boarDensity = 0;
  cfg.wildlife.wolfPackDensity = 0;
  return cfg;
}

function makeState() {
  const config = makeConfig();
  return {
    world: createWorld(worldParamsOf(config.world)),
    config,
    time: 0,
    tick: 0,
    players: new Map(),
    animals: new Map(),
    activeAnimals: 0,
    loot: new Map(),
    animalRespawns: [],
    nextEntityId: 1,
  };
}

function animalRows(state) {
  return [...state.animals.values()].map((a) => ({
    species: a.species,
    x: Number(a.x.toFixed(3)),
    y: Number(a.y.toFixed(3)),
    z: Number(a.z.toFixed(3)),
  }));
}

const a = makeState();
const b = makeState();
spawnInitialAnimals(a);
spawnInitialAnimals(b);

const expectedRabbits = effectiveAnimalMax(a.config, "rabbit");
check(a.animals.size === expectedRabbits, `rabbit-only config spawns ${expectedRabbits} animals`);
check([...a.animals.values()].every((animal) => animal.species === "rabbit"), "all spawned animals are rabbits");
check(
  JSON.stringify(animalRows(a)) === JSON.stringify(animalRows(b)),
  "spawn placement is deterministic across identical states",
);

const first = a.animals.values().next().value;
const before = { x: first.x, z: first.z, state: first.state };
tickWildlife(a, 1);
check(a.activeAnimals === 0, "no players nearby means zero active animals");
check(first.x === before.x && first.z === before.z && first.state === before.state, "sleeping animal did not run AI");

a.players.set("hunter", {
  id: "hunter",
  alive: true,
  core: { x: first.x + 1, y: first.y, z: first.z, yaw: 0, pitch: 0 },
});
a.time = 10;
tickWildlife(a, 0.5);
check(a.activeAnimals > 0, "nearby player wakes wildlife AI");
check(first.state === "flee", `rabbit flees when threatened (state=${first.state})`);

const oldId = first.id;
const killed = damageAnimal(a, first, 999, "hunter");
check(killed === true, "lethal damage reports a kill");
check(!a.animals.has(oldId), "killed rabbit removed from animals map");
const meat = [...a.loot.values()].find((l) => l.type === "raw_venison");
check(meat?.count === 1, `rabbit drops one raw meat stack (got ${meat?.count ?? 0})`);
check(a.animalRespawns.length === 1 && a.animalRespawns[0].species === "rabbit", "rabbit respawn timer queued");

a.tick = 500;
tickAnimalRespawns(a, 999);
check(a.animalRespawns.length === 0, "due rabbit respawn timer consumed");
check(a.animals.size === expectedRabbits, "rabbit population restored to cap");

if (failures > 0) {
  console.error(`WILDLIFE-SPECIES: FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("WILDLIFE-SPECIES: PASS — species spawn, dormancy, drops and respawn work");
