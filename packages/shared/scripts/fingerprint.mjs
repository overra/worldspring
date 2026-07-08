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
// PLATFORM-CANONICAL = Linux (the deployment platform: workerd runs on Linux).
// The hash mixes the EXACT Float64 bytes of the height grid (below), and V8's
// transcendental (sin/cos/…) results differ by an ULP across OSes — seed 0
// diverges between macOS and Linux today. So the committed baseline is the
// LINUX value (regenerate in CI, not on a Mac); `pnpm fingerprint` on macOS
// will mismatch seed 0 — a known cross-platform artifact, not a regression.
// (The cross-platform divergence itself is a separate latent client/server
// hazard tracked outside this gate; prod seed 1337 is stable on both.)
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
      'export { tierParamsOf } from "./config.ts";\n',
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
const { createWorld, tierParamsOf } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const SEEDS = [1337, 0, 1, 42, 7, 2026, 65535, 99991];
const GRID = 48; // (GRID+1)^2 sample points per seed

// doc 07 M2 added World.size (a config-derived scalar, not geometry). It is
// EXCLUDED from the JSON hash so the standard-tier hashes stay byte-identical
// to the pre-M2 baseline — the exclusion loses nothing (size fully determines
// via the params, and every geometry field reflects it). No nested field is
// named "size"; if one ever appears, rename it or version the baseline.
//
// doc 06 added World.structures (the MUTABLE player-structure index) — not
// worldgen geometry: created empty with zero rng draws, filled only by server
// deltas at runtime. Excluded for the same reason (and so the baseline stays
// byte-identical); no nested field shares either name.
const dropSize = (key, value) =>
  key === "size" || key === "structures" ? undefined : value;

function fingerprintWorld(seed, tier) {
  const w = createWorld({ seed, ...tierParamsOf(tier) });
  const h = createHash("sha256");
  // All geometry data (seed/towns/buildings/military/props/trees/loot/spawns);
  // function members serialize to undefined and drop out — deterministic order.
  h.update(JSON.stringify(w, dropSize));
  // Sample the height functions on a fixed grid — captures the seeded noise.
  // The grid spans the world's own size, so per-tier rows sample per-tier
  // extents (identical bytes at standard, where w.size === WORLD_SIZE).
  const heights = [];
  const size = w.size;
  const half = size / 2;
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      const x = -half + (i / GRID) * size;
      const z = -half + (j / GRID) * size;
      heights.push(w.heightAt(x, z), w.groundHeight(x, z));
    }
  }
  h.update(Buffer.from(Float64Array.from(heights).buffer)); // exact float bytes
  return h.digest("hex");
}

const lines = [];
// Standard rows FIRST and in the legacy line format — these 8 lines must stay
// byte-identical to the pre-doc-07 baseline (the CI diff proves M2 didn't
// drift prod worldgen).
for (const seed of SEEDS) {
  lines.push(`seed ${String(seed).padStart(6)} : ${fingerprintWorld(seed, "standard")}`);
}
// doc 07 M1: large/huge matrix rows (Linux-canonical baselines, like the
// standard rows — regenerate only on CI/Linux, never commit macOS hashes).
for (const tier of ["large", "huge"]) {
  for (const seed of SEEDS) {
    lines.push(`seed ${String(seed).padStart(6)} ${tier} : ${fingerprintWorld(seed, tier)}`);
  }
}
process.stdout.write(lines.join("\n") + "\n");
