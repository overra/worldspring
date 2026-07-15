// Visual baselines for the DOM UI — and ONLY the DOM UI.
//
// The 3D canvas is masked out of every comparison. What is left is plain HTML/CSS:
// deterministic, diffable, and exactly where the Field Kit regressions live (a
// radius that went flat, a font that fell back to system-ui, a panel that lost its
// shadow). The world behind it is asserted semantically in smoke/night specs.
//
// Determinism comes from the server, not from luck: the day worker runs the
// TESTBED survival scenario (a fixed loadout and fixed vitals) with the clock
// pinned to noon, so the hotbar, the inventory grid and the day/time readout are
// the same on every run. See playwright.config.ts.
//
// Baselines are LINUX-CANONICAL — regenerate them in CI's container, never on a
// Mac. Font rasterization differs across platforms and a Mac-made baseline will
// false-fail forever in CI.

import { expect, test } from "@playwright/test";
import { joinGame } from "./helpers";

// DISARMED until the baselines exist, and deliberately not faked green.
//
// A visual baseline is only valid on the platform that made it — font rasterization
// differs macOS↔Linux — so these have to be BORN IN CI's container. They cannot be
// generated on a laptop, and running CI with `--update-snapshots=missing` would just
// re-mint them every run and compare each run against itself: a test that can never
// fail, which is worse than no test because it reads as coverage.
//
// To arm it, once, on Linux:
//   1. CI: run this job with VISUAL=1 and `test:e2e:update` (a dispatchable job, or
//      temporarily flip the env in ci.yml).
//   2. Download the e2e artifacts and commit e2e/__screenshots__/linux/.
//   3. Set VISUAL=1 in the ci.yml e2e step for good.
// From then on a HUD that changes shape fails the build with an image diff.
//
// The functional specs (smoke / night / layout / responsive) are armed and need no
// baselines — they are the ones that caught every real bug in this pass anyway.
test.skip(
  process.env.VISUAL !== "1",
  "visual baselines must be generated on Linux (see the note at the top of this file)",
);

/** Everything that is not stable DOM gets painted over before the diff. */
const maskOf = (page: import("@playwright/test").Page) => [
  // The live 3D world.
  page.locator("canvas"),
  // Ping/fps and anything else that samples the wall clock or the socket.
  page.locator("[data-volatile]"),
];

test("HUD", async ({ page }) => {
  await joinGame(page, "hud");
  await expect(page).toHaveScreenshot("hud.png", { mask: maskOf(page) });
});

test("inventory", async ({ page }) => {
  await joinGame(page, "inv");
  await page.keyboard.press("Tab");
  // The workspace animates in; the stylesheet freezes the animation, but the
  // component still has to mount before there is anything to shoot.
  await expect(page.getByText(/carry|storage|field kit/i).first()).toBeVisible();
  await expect(page).toHaveScreenshot("inventory.png", { mask: maskOf(page) });
});

test("map", async ({ page }) => {
  await joinGame(page, "map");
  await page.keyboard.press("KeyM");
  // The map canvas is baked lazily behind a dynamic import — give the chunk a beat,
  // then mask it: it renders the world, so it is no more deterministic than the 3D view.
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot("map.png", {
    mask: [...maskOf(page), page.locator(".map-canvas")],
  });
});
