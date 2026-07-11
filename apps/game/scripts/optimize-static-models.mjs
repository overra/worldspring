// One-shot (but re-runnable) GPU-texture-memory pass over the STATIC committed
// GLBs that models:export does NOT regenerate: the Meshy-generated item models
// (crate.glb, items/*.glb) and the KayKit characters (survivor.glb, zombie.glb).
// Blender-authored items/building_kit/props.glb and generated trees.glb carry
// no textures and are intentionally not listed here.
//
//   pnpm --filter @worldspring/game models:optimize-static
//
// Why not plain `optimize` everywhere: (1) every gltf-transform command decodes
// EXT_meshopt_compression and does NOT re-apply it, so meshopt/optimize must be
// the LAST step per file; (2) the Meshy "Baked_Emit" textures are solid black
// but lossy-WebP pixel jitter defeats --prune-solid-textures at 512px —
// downsampling them to 4x4 first lets prune convert them to factors (i.e.
// remove them). Characters keep node-name contracts (CharacterRig.ts
// getObjectByName: handslot.l/.r) plus skins/animations, so they get
// resize+meshopt only — no optimize/prune/resample.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(scriptsDir, ".."); // apps/game
const modelsDir = join(gameRoot, "public", "models");
const gltfTransform = join(gameRoot, "node_modules", ".bin", "gltf-transform");

// Meshy-generated props whose emissive is solid black (verified pixel stats):
// the 4x4 shrink below lets optimize's prune-solid-textures delete it.
// items/flashlight.glb is NOT here — its emissive is real lens-glow content.
const MESHY_BLACK_EMISSIVE = [
  "crate.glb",
  "items/ammo_762.glb",
  "items/ammo_9mm.glb",
  "items/axe.glb",
  "items/bandage.glb",
  "items/beans.glb",
  "items/campfire_kit.glb",
  "items/cooked_venison.glb",
  "items/pistol.glb",
  "items/raw_venison.glb",
  "items/rifle.glb",
  "items/shells.glb",
  "items/shotgun.glb",
  "items/water_bottle.glb",
];
// Meshy props with REAL emissive content (flashlight lens glow) — resized, kept.
const MESHY_KEEP_EMISSIVE = ["items/flashlight.glb"];
// KayKit characters: 1024px near-flat palette baseColor -> 256px. Node names,
// skins, and animations must survive untouched (resize+meshopt only).
const CHARACTERS = ["survivor.glb", "zombie.glb"];

// Palm-size props and flat character palettes read identically at 256px; bump
// per-file if a hero weapon ever looks soft up close.
const TEXTURE_SIZE = "256";

// Same structural-pass lockdown as export-models.mjs: the runtime clones
// scenes/nodes by name (node name == ItemType), so flatten/join/instance/
// palette/simplify must stay off.
const OPTIMIZE_ARGS = [
  "--compress", "meshopt",
  "--texture-compress", "webp",
  "--texture-size", TEXTURE_SIZE,
  "--flatten", "false",
  "--join", "false",
  "--instance", "false",
  "--palette", "false",
  "--simplify", "false",
];

if (!existsSync(gltfTransform)) {
  console.error(
    "models:optimize-static: gltf-transform CLI missing — run `pnpm install` (@gltf-transform/cli is a devDependency of @worldspring/game)",
  );
  process.exit(1);
}

function run(fname, steps) {
  const glbPath = join(modelsDir, fname);
  if (!existsSync(glbPath)) {
    console.error(`models:optimize-static: ${fname} missing from ${modelsDir}`);
    process.exit(1);
  }
  const before = statSync(glbPath).size;
  for (const args of steps) {
    const r = spawnSync(gltfTransform, [args[0], glbPath, glbPath, ...args.slice(1)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (r.error || (r.status ?? 1) !== 0) {
      console.error(
        `models:optimize-static: gltf-transform ${args[0]} failed for ${fname}${r.error ? ` — ${r.error.message}` : ""}`,
      );
      process.exit(r.status ?? 1);
    }
  }
  const after = statSync(glbPath).size;
  console.log(
    `models:optimize-static: ${fname} ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB`,
  );
}

for (const f of MESHY_BLACK_EMISSIVE) {
  run(f, [
    ["resize", "--pattern", "Baked_Emit", "--width", "4", "--height", "4"],
    ["optimize", ...OPTIMIZE_ARGS],
  ]);
}
for (const f of MESHY_KEEP_EMISSIVE) {
  run(f, [["optimize", ...OPTIMIZE_ARGS]]);
}
for (const f of CHARACTERS) {
  run(f, [
    ["resize", "--width", TEXTURE_SIZE, "--height", TEXTURE_SIZE],
    ["meshopt", "--level", "high"],
  ]);
}
process.exit(0);
