// End-to-end + visual tests for the game client, driven through a REAL headless
// Chromium (SwiftShader WebGL, real WebSockets, a real rAF loop).
//
//   pnpm --filter @worldspring/game test:e2e          # run
//   pnpm --filter @worldspring/game test:e2e:update   # re-baseline (Linux only!)
//
// WHAT THIS SUITE TESTS — AND WHAT IT DELIBERATELY DOES NOT
//
// It does NOT pixel-diff the 3D world. A WebGL canvas is not deterministic across
// machines (SwiftShader vs a real GPU), across time-of-day, or across animation
// phase; a suite that diffs it goes red for reasons that are not bugs, and a suite
// people learn to ignore is worse than no suite. So:
//
//   - the DOM (HUD, menus, inventory) IS pixel-diffed — it is plain HTML/CSS and
//     fully deterministic once the canvas is masked out.
//   - the 3D world is asserted SEMANTICALLY, by querying the live scene graph
//     through the ?debug hooks (window.__scene / __gl / __game). Both 3D bugs that
//     actually shipped were structural facts, not pixel deltas: a null shadow map
//     (night-join) and wrong authored dimensions (the trim). Neither needed an image.
//
// TWO SERVERS, because determinism comes from server config, not from waiting:
//
//   :8788 "day"   — TESTBED=1 + the survival scenario, so every run joins with the
//                   SAME inventory and vitals. Without it the HUD shows random loot
//                   and the visual baselines are noise.
//   :8789 "night" — GAME_CONFIG=nightfall (fixedHour 1 — "the sun never rises").
//                   This is what makes the night-join regression reproducible in
//                   seconds instead of waiting for dusk in prod, which is how that
//                   bug reached players in the first place.
//
// Both run the BUILT worker under `wrangler dev` (not vite), so the artifact under
// test is the one that deploys — assets binding, Durable Object and all. Run
// `vite build` first; the test:e2e script does.
//
// BASELINES ARE LINUX-CANONICAL. Font rasterization differs macOS↔Linux, so a
// baseline generated on a Mac false-fails in CI — the same trap the worldgen
// fingerprint already taught us. Snapshots live under __screenshots__/<platform>/,
// and CI only ever compares the linux set. Update them in CI's container, or with
// `docker compose run e2e-update`, never from your laptop.

import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/** apps/game. webServer spawns from the CONFIG's directory (e2e/) by default, and
 *  wrangler.jsonc lives one level up — so every server command runs from here. */
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Same-origin worker (assets + Durable Object) with a fixed noon clock. */
const DAY_PORT = 8788;
/** Same worker, `nightfall` preset — the sun never rises. */
const NIGHT_PORT = 8789;

/** Pin the clock so the HUD's day/time readout is stable across runs. */
const DAY_CONFIG = JSON.stringify({
  preset: "deadcoast",
  overrides: { time: { fixedHour: 12 } },
});

/**
 * `wrangler dev` for the built worker. Each instance needs its OWN state and
 * inspector port — two workerd processes sharing .wrangler/state would share a
 * Durable Object, and the night server would inherit the day server's world.
 *
 * The config is dist/worldspring/wrangler.json — the one the VITE PLUGIN GENERATES
 * at build time (the checked-in wrangler.jsonc has no assets.directory; the plugin
 * fills it in). It is also byte-for-byte the config CI deploys
 * (`deploy -c dist/worldspring/wrangler.json`), so the suite drives the exact
 * artifact that ships, not an approximation of it. Requires a build first.
 */
const server = (port: number, persist: string, vars: string[]): string =>
  [
    "npx wrangler dev",
    "--config dist/worldspring/wrangler.json",
    `--port ${port}`,
    "--inspector-port 0",
    `--persist-to .wrangler/e2e-${persist}`,
    ...vars.map((v) => `--var ${v}`),
  ].join(" ");

export default defineConfig({
  testDir: ".",
  // The 3D client is heavy; a cold join can take a few seconds under SwiftShader.
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // The world behind the HUD is live: sun angle, waves, the player's idle
      // animation. None of it is the DOM under test — the specs mask the canvas,
      // and this sheet freezes anything still moving in the HUD itself.
      stylePath: "./screenshot.css",
      animations: "disabled",
      // Text antialiasing still differs by a hair between runs on the same box.
      maxDiffPixelRatio: 0.01,
    },
  },
  // A visual diff that only fails on CI is a baseline problem, not a flake —
  // never paper over it with retries.
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  snapshotPathTemplate: "__screenshots__/{platform}/{testFilePath}/{arg}{ext}",

  use: {
    // ?debug exposes window.__scene / __gl / __game in a production build. It is
    // the same hook a human uses from the console; the suite needs no new seams.
    // Origin ONLY — no query. page.goto("/") resolves against baseURL and would
    // drop a query string here, silently un-arming the ?debug hooks the whole suite
    // reads. The specs navigate to DEBUG_PATH instead (see helpers.ts).
    baseURL: `http://localhost:${DAY_PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: [
        // Headless Chromium has no GPU. SwiftShader gives it a real, if slow,
        // WebGL2 implementation — without these the canvas never paints and every
        // 3D assertion is vacuously wrong.
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    },
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: /night\.spec\.ts/,
    },
    {
      name: "mobile",
      // A real touch device: (pointer: coarse) matches, so this is the ONLY project
      // that exercises TouchControls and the blur opt-out.
      //
      // Pixel 7, NOT an iPhone: Playwright's iPhone descriptors default to WebKit,
      // and CI installs chromium only (the suite asserts on OUR layout, not on
      // cross-browser parity). An iPhone device here is permanently red in CI while
      // passing on any laptop that happens to have WebKit — the worst kind of green.
      use: { ...devices["Pixel 7"] },
      testMatch: /(responsive|hud|layout)\.spec\.ts/,
    },
    {
      name: "night",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${NIGHT_PORT}`,
      },
      testMatch: /night\.spec\.ts/,
    },
  ],

  webServer: [
    {
      command: server(DAY_PORT, "day", [
        "TESTBED:1",
        "SCENARIO:survival",
        `GAME_CONFIG:'${DAY_CONFIG}'`,
      ]),
      url: `http://localhost:${DAY_PORT}/api/server-info`,
      cwd: APP_DIR,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: server(NIGHT_PORT, "night", ["GAME_CONFIG:nightfall"]),
      url: `http://localhost:${NIGHT_PORT}/api/server-info`,
      cwd: APP_DIR,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
