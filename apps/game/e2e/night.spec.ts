// REGRESSION: joining a server while it is night must render the world.
//
// This is the bug that reached players. Symptom: "it loads and I hear sound but
// all I see is night sky." It only happened on a COLD JOIN AT NIGHT — get dark
// while already playing and everything was fine, which is why it survived review,
// typecheck, every existing test, and days of play.
//
// Root cause (three r184): the renderer skips a light whose shadow.autoUpdate is
// false BEFORE it lazily allocates shadow.map. At night the sun's intensity is 0,
// the old code switched autoUpdate off, and so on a cold start the shadow map was
// never allocated at all — while castShadow stayed true. Every shadow-RECEIVING
// material then failed, so the terrain, trees and buildings dropped out. The sky
// dome survived because it is a basic material that receives no shadow. Hence:
// sky, no world.
//
// The fix (SkyAndLighting.tsx):
//     sun.shadow.autoUpdate = sun.intensity > 0 || sun.shadow.map === null;
//
// These tests run against the `nightfall` preset (fixedHour 1 — "the sun never
// rises"), so the cold-start-at-night path is exercised on every run in seconds,
// rather than by waiting for dusk on prod.

import { expect, test } from "@playwright/test";
import { joinGame, probeScene } from "./helpers";

test.describe("cold join at night", () => {
  test("renders the world, not just the sky", async ({ page }) => {
    await joinGame(page, "night-e2e");
    const scene = await probeScene(page);

    // The precise failure: the sky dome alone still draws a couple of hundred
    // triangles and a handful of calls, so "something rendered" is not enough —
    // the terrain and its dressing are what vanished.
    expect(scene.meshCount, "world meshes must be in the scene").toBeGreaterThan(10);
    expect(
      scene.triangles,
      "a sky dome alone is a few hundred triangles — the WORLD must be drawn too",
    ).toBeGreaterThan(50_000);
  });

  test("no sun casts a shadow it never allocated a map for", async ({ page }) => {
    await joinGame(page, "night-e2e");
    const { lights } = await probeScene(page);

    expect(lights.length, "the scene must have at least one shadow-casting light").toBeGreaterThan(0);

    // The invariant, stated exactly. A light that says "I cast shadows" while
    // holding no shadow map breaks every shadow-receiving material in the scene.
    // Asserting the STATE, not the fix, means a future refactor that reintroduces
    // the bug by another route still trips this.
    for (const light of lights) {
      if (!light.castShadow) continue;
      expect(
        light.hasShadowMap,
        `light "${light.name || light.type}" has castShadow=true but shadow.map=null — ` +
          `this is the night-join blackout: three skips a light whose shadow.autoUpdate ` +
          `is false before it allocates the map, and every shadow-receiving material dies with it`,
      ).toBe(true);
    }
  });
});
