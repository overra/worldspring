// The join path, end to end: menu → WebSocket → Durable Object → a world on screen.
//
// This is the test that would have caught BOTH shipped 3D bugs at the door, because
// it asserts the one thing every weaker check skips: that triangles are actually
// being drawn. A live socket and a mounted canvas prove nothing — the night-join
// blackout had both.

import { expect, test } from "@playwright/test";
import { DEBUG_PATH, joinGame, probeScene } from "./helpers";

test("the menu renders before any world exists", async ({ page }) => {
  await page.goto(DEBUG_PATH);
  await expect(page.getByPlaceholder(/survivor name/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /join/i })).toBeVisible();
});

test("joining renders a world, with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await joinGame(page);
  const scene = await probeScene(page);

  expect(scene.meshCount, "the world must have meshes").toBeGreaterThan(10);
  expect(scene.drawCalls, "the renderer must be issuing draw calls").toBeGreaterThan(0);
  expect(scene.triangles, "the world must be drawing real geometry").toBeGreaterThan(50_000);

  // A console error on the happy path is a defect even when the pixels look right.
  // The chunk-load failures we log on purpose (mapBake) would surface here.
  expect(errors, "no console errors on the join path").toEqual([]);
});

test("the frame loop keeps running after join", async ({ page }) => {
  await joinGame(page);

  const first = await page.evaluate(
    () => (window as { __gl?: { info: { render: { frame: number } } } }).__gl?.info.render.frame ?? 0,
  );
  await page.waitForTimeout(1000);
  const second = await page.evaluate(
    () => (window as { __gl?: { info: { render: { frame: number } } } }).__gl?.info.render.frame ?? 0,
  );

  // A frozen rAF loop is the other way the screen goes black — and it is invisible
  // to a single screenshot, which happily captures the last good frame.
  expect(second, "the render loop must still be ticking a second after join").toBeGreaterThan(first);
});
