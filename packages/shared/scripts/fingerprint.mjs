// Worldgen determinism fingerprint — the doc 09 M2 HARD GATE.
//
//   node scripts/fingerprint.mjs [moduleDir]     (default: ../src)
//
// Hashes createWorld()'s geometry data (functions are dropped by JSON.stringify)
// plus a heightAt/groundHeight grid, over a fixed seed matrix. The committed
// world.fingerprint.txt is the regression baseline: ANY change to worldgen
// output — including a simplex-noise version drift — flips a hash. Determinism
// is load-bearing (client prediction must match server authority bit-for-bit),
// so re-run this on anything that touches packages/shared/src/world.ts.
//
// esbuild bundles the target module (resolving the extensionless ./ imports and
// simplex-noise, fully transpiling TS). It only transpiles for this hash — the
// numeric worldgen semantics are unchanged vs the game's own bundler, so the
// fingerprint faithfully represents runtime worldgen output.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "src"));

const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { WORLD_SIZE } from "./constants.ts";\n',
    resolveDir: dir,
    loader: "ts",
    sourcefile: "fingerprint-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const { createWorld, WORLD_SIZE } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const SEEDS = [1337, 0, 1, 42, 7, 2026, 65535, 99991];
const GRID = 48; // (GRID+1)^2 sample points per seed

const lines = [];
for (const seed of SEEDS) {
  const w = createWorld(seed);
  const h = createHash("sha256");
  // All geometry data (seed/towns/buildings/military/props/trees/loot/spawns);
  // function members serialize to undefined and drop out — deterministic order.
  h.update(JSON.stringify(w));
  // Sample the height functions on a fixed grid — captures the seeded noise.
  const heights = [];
  const half = WORLD_SIZE / 2;
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      const x = -half + (i / GRID) * WORLD_SIZE;
      const z = -half + (j / GRID) * WORLD_SIZE;
      heights.push(w.heightAt(x, z), w.groundHeight(x, z));
    }
  }
  h.update(Buffer.from(Float64Array.from(heights).buffer)); // exact float bytes
  lines.push(`seed ${String(seed).padStart(6)} : ${h.digest("hex")}`);
}
process.stdout.write(lines.join("\n") + "\n");
