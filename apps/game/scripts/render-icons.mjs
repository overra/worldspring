// Render the 2D inventory icons in apps/game/public/icons/ from
// apps/game/assets/items.blend via headless Blender.
//
//   pnpm --filter @worldspring/game models:icons [outDir] [itemType ...]
//
// Each icon is a 128x128 transparent PNG of the same low-poly mesh items.glb
// uses, shot from the authoring camera angle — see render-icons.py for the rig.
// A MANUAL authoring step (run after editing items.blend), NOT a CI step — CI has
// no Blender. Point at a specific Blender with BLENDER=/path/to/blender; otherwise
// the macOS app bundle and a `blender` on PATH are tried.
//
// With no args it (re)renders every item icon into public/icons. Pass an explicit
// outDir (e.g. a temp dir) and/or a list of item types to render a subset without
// touching the committed icons.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(scriptsDir, ".."); // apps/game
const blendFile = join(gameRoot, "assets", "items.blend");
const pyScript = join(scriptsDir, "render-icons.py");

const [outArg, ...only] = process.argv.slice(2);
const outDir = outArg ? outArg : join(gameRoot, "public", "icons");

const candidates = [
  process.env.BLENDER,
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "blender", // on PATH (Linux/CI-less authoring boxes)
].filter((c) => typeof c === "string" && c.length > 0);

const blender = candidates.find((c) => c === "blender" || existsSync(c));
if (!blender) {
  console.error(
    `models:icons: Blender not found. Install it, or set BLENDER=/path/to/blender.\n  tried: ${candidates.join(", ")}`,
  );
  process.exit(1);
}
if (!existsSync(blendFile)) {
  console.error(`models:icons: source blend missing at ${blendFile}`);
  process.exit(1);
}

console.log(`models:icons: ${blender}\n             ${blendFile} -> ${outDir}`);
const r = spawnSync(
  blender,
  ["--background", blendFile, "--python", pyScript, "--", outDir, ...only],
  { stdio: "inherit" },
);
if (r.error) {
  console.error(`models:icons: failed to launch Blender — ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
