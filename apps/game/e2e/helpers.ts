// Shared fixtures for the e2e suite: joining the game, and reading facts back out
// of the live three.js scene.
//
// Everything here talks to the app through the SAME ?debug hooks a human uses from
// the browser console (window.__game / __scene / __gl, set in runtime.ts and
// DebugCollector.tsx). The suite adds no production seams of its own — if these
// hooks ever go away, that is a real signal, not a test-only breakage.

import { expect, type Page } from "@playwright/test";

/** How long a cold join may take under SwiftShader before we call it a failure. */
const JOIN_TIMEOUT_MS = 45_000;

/**
 * ?debug arms window.__scene / __gl / __game in a PRODUCTION build (runtime.ts
 * gates on `import.meta.env.DEV || location.search.includes("debug")`).
 *
 * It must be part of the PATH, not the baseURL: page.goto("/") resolves against
 * baseURL and drops its query, which silently disarms every hook this suite reads
 * and leaves the probes waiting on `undefined` until they time out.
 */
export const DEBUG_PATH = "/?debug=1";

// NOTE: do NOT `declare global { interface Window { __game … } }` here. runtime.ts
// already declares it, and a second augmentation with a different shape collides
// (TS2717) — reporting the error inside production source, not in this file. Each
// page.evaluate() below casts the handle it needs locally instead, which is also
// honest about the fact that these values cross a serialization boundary.

/** A directional light as seen from the test — enough to catch the night-join class. */
export interface LightProbe {
  name: string;
  type: string;
  intensity: number;
  castShadow: boolean;
  /** three allocates this lazily. null + castShadow + !autoUpdate = the night-join bug. */
  hasShadowMap: boolean;
  shadowAutoUpdate: boolean;
}

export interface SceneProbe {
  /** Objects in the graph — a world that failed to build is near-empty. */
  objectCount: number;
  meshCount: number;
  lights: LightProbe[];
  /** Triangles submitted on the last frame. 0 ⇒ nothing is being drawn. */
  triangles: number;
  drawCalls: number;
}

/**
 * Join the game and wait until the world is actually being rendered.
 *
 * "Rendered" deliberately means TRIANGLES ON SCREEN, not "the join request
 * resolved" and not "a canvas element exists". The night-join bug produced a live
 * socket, a mounted canvas and a correct player position while drawing nothing but
 * the sky — every weaker check passes straight through it.
 */
export async function joinGame(page: Page, name = "e2e"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(DEBUG_PATH, { waitUntil: "domcontentloaded" });

  // The design's whole identity is its type. If Barlow silently falls back to
  // system-ui the UI still "works" and every functional test passes — which is
  // precisely how a HUD with no webfonts shipped. Fail loudly instead.
  //
  // load() before check(), NOT fonts.ready: a face the page has not USED yet is not
  // "pending", so fonts.ready resolves without it and check() then reports false for
  // a font that is perfectly fine. load() forces the fetch, so what this actually
  // asserts is the thing we mean — the @font-face rules resolve to files that exist
  // and are served — rather than whatever the menu happened to render this run.
  const fontsLoaded = await page.evaluate(async () => {
    const faces = [
      '600 14px "Barlow Semi Condensed"',
      '400 14px "Barlow"',
      '500 13px "JetBrains Mono"',
    ];
    await Promise.all(faces.map((f) => document.fonts.load(f)));
    return faces.every((f) => document.fonts.check(f));
  });
  expect(fontsLoaded, "the Field Kit webfonts must load — a fallback to system-ui is the bug").toBe(true);

  await page.getByPlaceholder(/survivor name/i).fill(name);
  await page.getByRole("button", { name: /join/i }).click();

  await page.waitForFunction(
    () => {
      const gl = (window as { __gl?: { info?: { render?: { triangles?: number } } } }).__gl;
      return (gl?.info?.render?.triangles ?? 0) > 1000;
    },
    undefined,
    { timeout: JOIN_TIMEOUT_MS },
  );

  // Triangles prove the RENDERER is alive; they do not prove the app has reached
  // the "playing" phase with its key handlers mounted. A spec that pressed Tab on
  // the strength of the triangle check alone was intermittently sending it into a
  // window that had nothing listening yet — a flake, and flakes are how a suite
  // stops being believed. The hotbar renders only while playing, so waiting for it
  // is the honest readiness signal for anything that then drives input.
  await page.locator(".hud-hotbar").waitFor({ state: "visible", timeout: 15_000 });

  // A pageerror during join is never acceptable, even if pixels appeared anyway.
  expect(errors, "no uncaught exception during join").toEqual([]);
}

/** Read the live scene graph. Runs in the page against the app's real three instance. */
export async function probeScene(page: Page): Promise<SceneProbe> {
  return page.evaluate(() => {
    type Obj3D = {
      type: string;
      name: string;
      children: Obj3D[];
      isMesh?: boolean;
      isLight?: boolean;
      intensity?: number;
      castShadow?: boolean;
      shadow?: { map: unknown; autoUpdate: boolean };
    };
    const scene = (window as unknown as { __scene?: Obj3D }).__scene;
    const gl = (window as unknown as {
      __gl?: { info: { render: { triangles: number; calls: number } } };
    }).__gl;
    if (!scene || !gl) throw new Error("debug hooks absent — is ?debug=1 on the URL?");

    let objectCount = 0;
    let meshCount = 0;
    const lights: unknown[] = [];
    const walk = (o: Obj3D): void => {
      objectCount++;
      if (o.isMesh) meshCount++;
      if (o.isLight && o.shadow) {
        lights.push({
          name: o.name,
          type: o.type,
          intensity: o.intensity ?? 0,
          castShadow: o.castShadow ?? false,
          hasShadowMap: o.shadow.map !== null && o.shadow.map !== undefined,
          shadowAutoUpdate: o.shadow.autoUpdate,
        });
      }
      for (const c of o.children) walk(c);
    };
    walk(scene);

    return {
      objectCount,
      meshCount,
      lights,
      triangles: gl.info.render.triangles,
      drawCalls: gl.info.render.calls,
    };
  }) as Promise<SceneProbe>;
}

/**
 * Every rectangle the HUD paints, in viewport coordinates. The responsive spec
 * uses this to prove that (say) the vitals card never lands under the hotbar —
 * an overlap a screenshot shows but cannot ASSERT on.
 */
export async function visibleBoxes(
  page: Page,
  selectors: readonly string[],
): Promise<Record<string, { x: number; y: number; w: number; h: number } | null>> {
  return page.evaluate((sels) => {
    const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) {
        out[s] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const shown = style.display !== "none" && style.visibility !== "hidden" && r.width > 0;
      out[s] = shown ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    }
    return out;
  }, selectors);
}

/** Do two rects overlap? Touching edges do not count. */
export function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
