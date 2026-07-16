#!/usr/bin/env node
// doc 14 M1 — NavSystem harness (CI-run via `pnpm test`).
//
//   node --experimental-strip-types apps/game/scripts/nav.mjs
//
// Validates the server-side navmesh substrate against BOTH synthetic statics
// (deterministic obstacles — the doorway/window vertical-passability contract,
// routing, generate-twice determinism, dirty-tile rebuild, eviction) and a REAL
// createWorld region (the actual queryStatics/heightAt pipeline). NavSystem +
// createWorld are bundled with esbuild (the structures.mjs data-URL pattern)
// because navMesh.ts value-imports navcat + shared via extensionless paths.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WATER_WALK_MIN } from "@worldspring/shared/constants";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");

async function bundleModule(contents, resolveDir, sourcefile) {
  const out = await build({
    stdin: { contents, resolveDir, loader: "ts", sourcefile },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const mod = await bundleModule(
  'export { createWorld } from "./packages/shared/src/world.ts";\n' +
    'export { worldParamsOf, DEFAULT_CONFIG } from "./packages/shared/src/config.ts";\n' +
    'export { NavSystem } from "./apps/game/src/server/nav/navMesh.ts";\n',
  rootDir,
  "nav-harness-entry.ts",
);
const { createWorld, worldParamsOf, DEFAULT_CONFIG, NavSystem } = mod;

/** A synthetic statics source: flat ground (y=0) + a fixed wall list we control.
 *  `walls` is captured by reference so tests can mutate it and re-query. */
function flatSource(walls, size = 512, heightFn = () => 0) {
  return {
    size,
    heightAt: (x, z) => heightFn(x, z),
    queryStatics: (x, z, r) => ({
      walls: walls.filter((w) => w.maxX > x - r && w.minX < x + r && w.maxZ > z - r && w.minZ < z + r),
      trees: [],
    }),
  };
}
const drain = (nav) => nav.stepBuild(100000);

// --- 1. builds from flat ground ------------------------------------------
console.log("build:");
{
  const nav = new NavSystem(flatSource([]), { tileCap: 999 });
  nav.ensureBuilt(0, 0, 40);
  drain(nav);
  check(nav.builtTileCount > 0, `builds tiles from flat ground (${nav.builtTileCount} tiles)`);
  check(nav.isWalkable(0, 4), "open flat ground is walkable");
  check(!nav.isWalkable(9999, 9999), "far off-mesh point is not walkable");
}

// --- 2. vertical passability (the doc 14 §2 reconciliation) ---------------
console.log("vertical passability (doorway walk-under vs window sill):");
{
  const t = 0.15; // wall half-thickness in z
  const walls = [
    // Doorway at z=0: wall either side of x[-1,1], header ABOVE head height.
    { minX: -10, maxX: -1, minZ: -t, maxZ: t, y0: 0, y1: 2.2 },
    { minX: 1, maxX: 10, minZ: -t, maxZ: t, y0: 0, y1: 2.2 },
    { minX: -1, maxX: 1, minZ: -t, maxZ: t, y0: 2.2, y1: 3.0 }, // header (walk-under)
    // Window at z=6: sill (0–0.75) + head (1.85–2.2) — the real WINDOW geometry,
    // a 1.1 m opening under PLAYER_HEIGHT, so no walkable span survives.
    { minX: -10, maxX: -1, minZ: 6 - t, maxZ: 6 + t, y0: 0, y1: 2.2 },
    { minX: 1, maxX: 10, minZ: 6 - t, maxZ: 6 + t, y0: 0, y1: 2.2 },
    { minX: -1, maxX: 1, minZ: 6 - t, maxZ: 6 + t, y0: 0, y1: 0.75 }, // sill
    { minX: -1, maxX: 1, minZ: 6 - t, maxZ: 6 + t, y0: 1.85, y1: 2.2 }, // head
  ];
  const nav = new NavSystem(flatSource(walls), { tileCap: 999 });
  nav.ensureBuilt(0, 3, 40);
  drain(nav);
  check(nav.isWalkable(0, 0), "doorway (overhead header) is WALKABLE — walk-under");
  check(!nav.isWalkable(5, 0), "solid wall is NOT walkable");
  check(!nav.isWalkable(0, 6), "window sill blocks the ground — NOT walkable (matches sim IMPASSABLE)");
  check(nav.isWalkable(0, 3), "open ground between the walls is walkable");
}

// --- 3. routing around an obstacle ----------------------------------------
console.log("routing:");
{
  const wall = [{ minX: -12, maxX: 12, minZ: -0.15, maxZ: 0.15, y0: 0, y1: 2.2 }];
  const nav = new NavSystem(flatSource(wall), { tileCap: 999 });
  nav.ensureBuilt(0, 0, 64);
  drain(nav);
  const path = nav.findPath(0, -6, 0, 6);
  check(Array.isArray(path) && path.length > 0, "path around a solid wall exists");
  check(!!path && path.some((p) => Math.abs(p.x) > 11), "path detours around the wall end (|x|>11)");
  check(nav.findPath(0, -6, 99999, 99999) === null, "unreachable/off-mesh endpoint → null (straight-line fallback)");
}

// --- 4. generate-twice determinism ----------------------------------------
console.log("determinism (generate-twice):");
{
  const wall = [{ minX: -12, maxX: 12, minZ: -0.15, maxZ: 0.15, y0: 0, y1: 2.2 }];
  const nav = new NavSystem(flatSource(wall), { tileCap: 999 });
  nav.ensureBuilt(0, 0, 20);
  drain(nav);
  const h1 = nav.debugTileHash(0, -10);
  nav.dirtyTile(-16, -16, 16, 16);
  drain(nav);
  const h2 = nav.debugTileHash(0, -10);
  check(h1 !== "" && h1 === h2, `a tile re-carves to an identical signature (${h1})`);
}

// --- 5. dirty-tile rebuild flips walkability ------------------------------
console.log("dirty-tile rebuild:");
{
  const walls = [];
  const nav = new NavSystem(flatSource(walls), { tileCap: 999 });
  nav.ensureBuilt(10, 10, 20);
  drain(nav);
  // Probe a point well inside one tile (world 0 is a 4-tile seam — avoid it).
  check(nav.isWalkable(10, 10), "point walkable before a wall exists");
  // A placed wall is a thin panel (the real dirty trigger) — it blocks its own
  // footprint, unlike a hollow box which has a walkable interior.
  walls.push({ minX: 2, maxX: 18, minZ: 9.7, maxZ: 10.3, y0: 0, y1: 2.2 });
  nav.dirtyTile(2, 9.7, 18, 10.3);
  drain(nav);
  check(!nav.isWalkable(10, 10), "same point on the wall line NOT walkable after place + dirtyTile re-carve");
}

// --- 6. eviction respects the cap -----------------------------------------
console.log("eviction:");
{
  const nav = new NavSystem(flatSource([], 2048), { tileCap: 8 });
  nav.ensureBuilt(0, 0, 120); // far more than 8 tiles
  drain(nav);
  check(nav.builtTileCount <= 8, `eviction caps resident tiles at 8 (got ${nav.builtTileCount})`);
}

// --- 7. the REAL world pipeline -------------------------------------------
console.log("real world (createWorld standard tier):");
{
  const world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const nav = new NavSystem(world, { tileCap: 999 });
  const town = world.towns[0];
  nav.ensureBuilt(town.cx, town.cz, 48);
  drain(nav);
  check(nav.builtTileCount > 0, `builds non-empty tiles from the real world near a town (${nav.builtTileCount} tiles)`);
  // Find two walkable land points near the town and path between them.
  const pts = [];
  for (let a = 0; a < 360 && pts.length < 2; a += 15) {
    const x = town.cx + Math.cos((a * Math.PI) / 180) * 20;
    const z = town.cz + Math.sin((a * Math.PI) / 180) * 20;
    if (world.heightAt(x, z) >= WATER_WALK_MIN + 1 && nav.isWalkable(x, z)) pts.push([x, z]);
  }
  check(pts.length >= 2, `found walkable land points near the town (${pts.length})`);
  if (pts.length >= 2) {
    const path = nav.findPath(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
    check(Array.isArray(path) && path.length > 0, "findPath succeeds between real walkable points");
  }
}

console.log(failures === 0 ? "\nnav: ALL OK" : `\nnav: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
