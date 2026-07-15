// HUD geometry, measured instead of computed.
//
// Six of the defects the Field Kit review found were the same shape: "element A
// overlaps element B at viewport X" — the chat input landing inside the vitals
// card, the LAST LIFE toast drawn through the compass, the touch menu button
// sitting on the minimap ring, the cast bar on top of the hotbar in landscape.
// Every one of them was found by a human (or an agent) doing CSS arithmetic in
// their head against a stack of `top: calc(50% + 110px)` rules. That is a terrible
// way to find these, it does not scale past a handful of viewports, and it is
// wrong often enough to matter.
//
// A browser already knows every one of these answers exactly. So: ask it.
//
// Two invariants, swept across a viewport matrix:
//
//   1. No two visible HUD panels overlap.
//   2. Every visible control is actually HIT-TESTABLE — elementFromPoint at its
//      centre returns the control itself, not something painted on top of it.
//
// (2) is the important one, and it is why this file exists rather than a pile of
// per-element rules. It catches occlusion REGARDLESS OF CAUSE — z-index, DOM
// order, a full-screen backdrop, a touch zone with pointer-events:auto — and it is
// the exact bug the review measured by hand as "the workspace close button is 89%
// covered by the joystick zone". A machine can prove that in a millisecond.

import { expect, test } from "@playwright/test";
import { joinGame } from "./helpers";

/**
 * The persistently-visible HUD surfaces. Transient ones (cast bar, build panel,
 * death toast) need game state to render and are not covered here — see the note
 * at the bottom of this file, which says so plainly rather than implying coverage
 * this suite does not have.
 */
const PANELS = [
  ".hud-vitals",
  ".hud-hotbar",
  ".hud-minimap",
  ".hud-compass",
  ".hud-status",
  ".hud-keyhints",
  ".hud-chat",
  ".tc-cluster",
  ".tc-btn--menu",
] as const;

/** Portrait phone → landscape phone → tablet → laptop → ultrawide. */
const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "phone-small", width: 360, height: 780 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "ultrawide", width: 2560, height: 1080 },
] as const;

// A VIEWPORTS sweep does ~7× the work of a single-viewport test — a slow mobile
// join, then per viewport a resize, a settle, and a full-DOM pass — and on the
// Pixel 7 project under a loaded CI runner that legitimately runs long: the
// overlap sweep clocked 58s and the hit-test sweep timed out at the 90s default.
// test.slow() triples the budget for exactly this "genuinely does more work" case,
// which is the honest lever — a blanket global timeout bump would also mask a real
// hang in the fast tests.

test("no two HUD panels overlap, at any viewport", async ({ page }) => {
  test.slow();
  await joinGame(page, "layout");

  const failures: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Let the media queries settle and the minimap re-lay-out.
    await page.waitForTimeout(400);

    const hits = await page.evaluate((sels) => {
      type Box = { x: number; y: number; w: number; h: number };
      const boxes: Record<string, Box> = {};
      for (const sel of sels) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        boxes[sel] = { x: r.x, y: r.y, w: r.width, h: r.height };
      }

      const over = (a: Box, b: Box): number => {
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return ox > 0 && oy > 0 ? Math.round(ox * oy) : 0;
      };

      const found: { a: string; b: string; area: number }[] = [];
      const keys = Object.keys(boxes);
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const area = over(boxes[keys[i]], boxes[keys[j]]);
          if (area > 0) found.push({ a: keys[i], b: keys[j], area });
        }
      }
      return found;
    }, PANELS);

    for (const h of hits) {
      failures.push(`${vp.name} (${vp.width}x${vp.height}): ${h.a} overlaps ${h.b} by ${h.area}px²`);
    }
  }

  expect(failures, `HUD panels overlap:\n${failures.join("\n")}`).toEqual([]);
});

test("every visible control is actually clickable, at any viewport", async ({ page }) => {
  test.slow();
  await joinGame(page, "hittest");

  const failures: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(400);

    const blocked = await page.evaluate(() => {
      const bad: { sel: string; by: string }[] = [];
      const controls = document.querySelectorAll<HTMLElement>("#root button, #root input, #root [data-tc]");

      for (const el of Array.from(controls)) {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.pointerEvents === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;

        // Ground truth: what would the browser actually deliver this tap to?
        const top = document.elementFromPoint(cx, cy);
        if (top === el || (top && el.contains(top))) continue;

        const name = (n: Element | null): string =>
          n ? `${n.tagName.toLowerCase()}${n.className && typeof n.className === "string" ? "." + n.className.split(/\s+/).filter(Boolean).join(".") : ""}` : "nothing";
        bad.push({ sel: name(el), by: name(top) });
      }
      return bad;
    });

    for (const b of blocked) {
      failures.push(`${vp.name} (${vp.width}x${vp.height}): ${b.sel} is covered by ${b.by}`);
    }
  }

  expect(
    failures,
    `controls exist but cannot be tapped — something is painted over them:\n${failures.join("\n")}`,
  ).toEqual([]);
});

test("nothing paints over the open workspace", async ({ page }) => {
  test.slow();
  await joinGame(page, "workspace");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hud-inv")).toBeVisible();

  const failures: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(400);

    // Sample a grid INSIDE the workspace and ask the browser what is on top at each
    // point. This is z-order ground truth, and it does not care WHY something is on
    // top — which matters, because the bug this caught could not be fixed with
    // z-index at all: .hud is a stacking context, so the workspace's z-index was
    // trapped inside it and a sibling <Minimap /> painted straight over the panel.
    // An assertion about z-index values would have happily passed.
    const intruders = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".hud-inv");
      if (!panel) return ["the workspace is not open"];
      const r = panel.getBoundingClientRect();
      const found = new Set<string>();

      for (let i = 1; i <= 6; i++) {
        for (let j = 1; j <= 6; j++) {
          const x = r.x + (r.width * i) / 7;
          const y = r.y + (r.height * j) / 7;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
          const top = document.elementFromPoint(x, y);
          if (!top || panel.contains(top) || top === panel) continue;
          found.add(
            `${top.tagName.toLowerCase()}${top.className && typeof top.className === "string" ? "." + top.className.split(/\s+/).filter(Boolean).join(".") : ""}`,
          );
        }
      }
      return [...found];
    });

    for (const i of intruders) {
      failures.push(`${vp.name} (${vp.width}x${vp.height}): "${i}" is painted over the workspace`);
    }
  }

  expect(failures, `something is covering the open workspace:\n${failures.join("\n")}`).toEqual([]);
});

test("the open map swallows every touch control", async ({ page, isMobile }) => {
  test.skip(!isMobile, "there are no touch controls on a fine pointer");

  await joinGame(page, "maplayer");
  await page.keyboard.press("KeyM");
  await expect(page.locator(".map-backdrop")).toBeVisible();

  // TouchControls' bag/chat/menu handlers cannot use gameplayBlocked() — it returns
  // true whenever a panel is open, and `bag` has to stay able to CLOSE the bag — so
  // they carry their own block-list. They now include mapOpen, but the map ALSO
  // covers them with its backdrop, and that redundancy is the point: this pins the
  // layering, so if the map panel ever goes pointer-events:none (as the minimap
  // already is) we find out here rather than by taps leaking through an open map.
  const reachable = await page.evaluate(() => {
    const leaks: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tc-btn"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top === el || el.contains(top)) leaks.push(String(el.className));
    }
    return leaks;
  });

  expect(
    reachable,
    `these touch controls are still tappable THROUGH an open map:\n${reachable.join("\n")}`,
  ).toEqual([]);
});

// NOT COVERED HERE, and deliberately said out loud rather than left to look like
// coverage: the TRANSIENT surfaces — the cast bar (.hud-channel), the build panel
// (.hud-build), the LAST LIFE toast (.hud-lastlife) and the notice stack
// (.hud-notices). Each needs game state to render, so a joined client does not show
// them. Three of the review's overlap defects lived in exactly those, which means
// this file guards the persistent HUD and NOT the surfaces with the worst track
// record. Closing that gap needs a way to force HUD state from a test — the natural
// seam is a testbed scenario that starts a channel and enters build mode.
