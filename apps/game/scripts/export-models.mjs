// Regenerate the authored GLBs in apps/game/public/models/ ({items,building_kit,
// props}.glb) from apps/game/assets/items.blend via headless Blender.
//
//   pnpm --filter @worldspring/game models:export
//
// A MANUAL authoring step (run after editing items.blend), NOT a CI step — CI has
// no Blender. Point at a specific Blender with BLENDER=/path/to/blender; otherwise
// the macOS app bundle and a `blender` on PATH are tried. See export-models.py for
// the per-collection / at-origin rules and docs/plans/research/ for the asset
// conventions CharacterRig.ts consumes (node name == ItemType, +Y up).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
process.exit(r.status ?? 1);
