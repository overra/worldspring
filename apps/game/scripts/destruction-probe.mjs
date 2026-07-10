#!/usr/bin/env node
// Headless gate for the exact production fracture geometry + Three Pinata
// template seeds — barrels AND tree cuts (both species). Bundling resolves the
// client's bundler-style TS imports.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/package.json")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export * from "./src/client/render/entities/barrelFracture.ts";\n' +
      'export * from "./src/client/render/entities/treeFracture.ts";\n',
    resolveDir: appDir,
    loader: "ts",
    sourcefile: "destruction-probe-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

function templateHash(template) {
  const hash = createHash("sha256");
  for (const fragment of template) {
    hash.update(Buffer.from(fragment.geometry.getAttribute("position").array.buffer));
    const index = fragment.geometry.index?.array;
    if (index) hash.update(Buffer.from(index.buffer));
    hash.update(JSON.stringify(fragment.geometry.groups));
    hash.update(new Float64Array([fragment.center.x, fragment.center.y, fragment.center.z, fragment.radius]));
  }
  return hash.digest("hex");
}

function validate(template, expectedCount) {
  if (template.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} fragments, got ${template.length}`);
  }
  for (const [index, fragment] of template.entries()) {
    const position = fragment.geometry.getAttribute("position");
    if (!position || position.count === 0) throw new Error(`fragment ${index} is empty`);
    for (const value of position.array) {
      if (!Number.isFinite(value)) throw new Error(`fragment ${index} has a non-finite vertex`);
    }
    const materialIndices = new Set(fragment.geometry.groups.map((group) => group.materialIndex));
    if (!materialIndices.has(0) || !materialIndices.has(1)) {
      throw new Error(`fragment ${index} lacks outer/inner material groups`);
    }
    const box = fragment.geometry.boundingBox ?? fragment.geometry.computeBoundingBox() ?? fragment.geometry.boundingBox;
    if (!box || !Number.isFinite(box.min.x) || !Number.isFinite(fragment.radius) || fragment.radius <= 0) {
      throw new Error(`fragment ${index} has invalid bounds`);
    }
  }
}

let cases = 0;
/** Build twice, validate both, and require identical hashes (determinism). */
function probe(label, buildTemplate, counts, seeds) {
  for (const count of counts) {
    for (const seed of seeds) {
      const first = buildTemplate(count, seed);
      const second = buildTemplate(count, seed);
      validate(first, count);
      validate(second, count);
      const a = templateHash(first), b = templateHash(second);
      if (a !== b) throw new Error(`${label} ${count}/${seed} is nondeterministic: ${a} != ${b}`);
      for (const fragment of [...first, ...second]) fragment.geometry.dispose();
      cases++;
    }
  }
}

probe("barrel", mod.buildBarrelFractureTemplate, mod.BARREL_FRAGMENT_COUNTS, mod.BARREL_FRACTURE_SEEDS);
for (const species of mod.TREE_SPECIES) {
  probe(
    `tree:${species}`,
    (count, seed) => mod.buildTreeCutTemplate(species, count, seed),
    mod.TREE_FRAGMENT_COUNTS,
    mod.TREE_FRACTURE_SEEDS,
  );
}

console.log(`destruction-probe: PASS (${cases} deterministic fracture templates)`);
