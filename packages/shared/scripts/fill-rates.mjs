// Doc 07 M2 acceptance harness — town/tree placement fill rates.
//
//   node scripts/fill-rates.mjs [moduleDir]     (default: ../src)
//
// The large/huge tiers place content by seeded rejection sampling under caps
// (min separation, height band, slope), so the target counts are NOT safe by
// construction — an unlucky seed could under-fill. Doc 07 M2's acceptance:
// "large/huge worlds generate with >=90% of target town counts across 50
// seeds (report fill rates)". This script IS that report + gate: it generates
// 50 seeds per non-standard tier, prints per-tier min/mean fill for towns and
// trees, and exits 1 if any seed lands under 90% of either target.
//
// Unlike fingerprint.mjs this is NOT platform-canonical — fill counts are
// integer-threshold outcomes and could in principle flip on a cross-OS ULP
// difference, but the gate has 10% slack, so run it anywhere. It is also not
// wired into CI's hot path (it generates 100 big worlds, ~O(minutes)); run it
// whenever packages/shared/src/world.ts placement logic or the tier tables
// change.
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
    sourcefile: "fill-rates-entry.ts",
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

const SEED_COUNT = 50; // seeds 1..50 (doc 07 M2 acceptance: 50 seeds)
const MIN_FILL = 0.9;

let failed = false;

for (const tier of ["large", "huge"]) {
  const tp = tierParamsOf(tier);
  const townRates = [];
  const treeRates = [];
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const w = createWorld({ seed, ...tp });
    const townRate = w.towns.length / tp.towns;
    const treeRate = w.trees.length / tp.trees;
    townRates.push(townRate);
    treeRates.push(treeRate);
    if (townRate < MIN_FILL || treeRate < MIN_FILL) {
      failed = true;
      console.error(
        `FAIL ${tier} seed ${seed}: towns ${w.towns.length}/${tp.towns} ` +
          `(${(townRate * 100).toFixed(1)}%), trees ${w.trees.length}/${tp.trees} ` +
          `(${(treeRate * 100).toFixed(1)}%)`,
      );
    }
  }
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const stats = (rates) => ({
    min: Math.min(...rates),
    mean: rates.reduce((a, b) => a + b, 0) / rates.length,
  });
  const t = stats(townRates);
  const r = stats(treeRates);
  console.log(
    `${tier.padEnd(5)} (${SEED_COUNT} seeds): towns min ${pct(t.min)} mean ${pct(t.mean)}` +
      ` | trees min ${pct(r.min)} mean ${pct(r.mean)} (targets: ${tp.towns} towns, ${tp.trees} trees)`,
  );
}

if (failed) {
  console.error(`FILL-RATES: FAIL — a seed under-filled below ${MIN_FILL * 100}%`);
  process.exit(1);
}
console.log(`FILL-RATES: PASS — all ${SEED_COUNT} seeds >= ${MIN_FILL * 100}% on both tiers`);
