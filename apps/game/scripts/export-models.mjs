// Regenerate the authored GLBs in apps/game/public/models/ ({items,building_kit,
// props}.glb) from apps/game/assets/items.blend via headless Blender, then
// compress them with the version-pinned gltf-transform CLI (meshopt + WebP).
//
//   pnpm --filter @worldspring/game models:export
//
// A MANUAL authoring step (run after editing items.blend), NOT a CI step — CI has
// no Blender. Point at a specific Blender with BLENDER=/path/to/blender; otherwise
// the macOS app bundle and a `blender` on PATH are tried. See export-models.py for
// the per-collection / at-origin rules and docs/plans/research/ for the asset
// conventions CharacterRig.ts consumes (node name == ItemType, +Y up).
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(scriptsDir, ".."); // apps/game
const blendFile = join(gameRoot, "assets", "items.blend");
const outDir = join(gameRoot, "public", "models");
const pyScript = join(scriptsDir, "export-models.py");

const candidates = [
  process.env.BLENDER,
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "blender", // on PATH (Linux/CI-less authoring boxes)
].filter((c) => typeof c === "string" && c.length > 0);

// "blender" is accepted as a PATH lookup; absolute candidates must exist.
const blender = candidates.find((c) => c === "blender" || existsSync(c));
if (!blender) {
  console.error(
    `models:export: Blender not found. Install it, or set BLENDER=/path/to/blender.\n  tried: ${candidates.join(", ")}`,
  );
  process.exit(1);
}
if (!existsSync(blendFile)) {
  console.error(`models:export: source blend missing at ${blendFile}`);
  process.exit(1);
}

console.log(`models:export: ${blender}\n             ${blendFile} -> ${outDir}`);
const r = spawnSync(
  blender,
  ["--background", blendFile, "--python", pyScript, "--", outDir],
  { stdio: "inherit" },
);
if (r.error) {
  console.error(`models:export: failed to launch Blender — ${r.error.message}`);
  process.exit(1);
}
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

// Post-export: gltf-transform optimize (meshopt + 512px WebP), version-pinned
// via the @gltf-transform/cli devDependency — same settings as the Meshy asset
// pipeline (crate.glb, items/*.glb). Structural passes stay OFF: the runtime
// fetches nodes by name and clones them (CharacterRig.ts conventions), so
// flatten/join/instance/palette must not rewrite the scene graph, and simplify
// is pointless on these low-poly meshes. drei's useGLTF decodes meshopt by
// default, proven in-app by the already-compressed crate.glb.
const gltfTransform = join(gameRoot, "node_modules", ".bin", "gltf-transform");
// Keep in sync with MANIFEST in export-models.py.
const EXPORTED_GLBS = ["items.glb", "building_kit.glb", "props.glb"];

if (!existsSync(gltfTransform)) {
  console.error(
    "models:export: gltf-transform CLI missing — run `pnpm install` (@gltf-transform/cli is a devDependency of @worldspring/game)",
  );
  process.exit(1);
}
for (const fname of EXPORTED_GLBS) {
  const glbPath = join(outDir, fname);
  // Blender exiting 0 does not guarantee every expected GLB landed (e.g. this
  // list drifting from the .py MANIFEST) — fail with a clear message instead
  // of an ENOENT stack trace from statSync.
  if (!existsSync(glbPath)) {
    console.error(
      `models:export: expected ${fname} missing from ${outDir} after Blender export — check MANIFEST in export-models.py`,
    );
    process.exit(1);
  }
  const before = statSync(glbPath).size;
  const o = spawnSync(
    gltfTransform,
    [
      "optimize",
      glbPath,
      glbPath,
      "--compress", "meshopt",
      "--texture-compress", "webp",
      "--texture-size", "512",
      "--flatten", "false",
      "--join", "false",
      "--instance", "false",
      "--palette", "false",
      "--simplify", "false",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (o.error || (o.status ?? 1) !== 0) {
    console.error(
      `models:export: gltf-transform optimize failed for ${fname}${o.error ? ` — ${o.error.message}` : ""}`,
    );
    process.exit(o.status ?? 1);
  }
  const after = statSync(glbPath).size;
  console.log(
    `models:export: optimized ${fname} ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB`,
  );
}
process.exit(0);
