// Responsive + mobile invariants.
//
// These are deliberately SELECTOR-FREE. They assert the rules in
// docs/design/field-kit.md against whatever the HUD actually renders, so they keep
// working when components are renamed or restyled — and so a new mode's HUD, or a
// modder's, is held to the same rules for free. A test that names .hud-crate only
// guards .hud-crate; a test that says "nothing may overflow the viewport" guards
// everything anyone ever adds.

import { expect, test } from "@playwright/test";
import { joinGame } from "./helpers";

/** WCAG 2.5.5 / Apple HIG floor. Field Kit says >= 44px on coarse pointers. */
const MIN_TOUCH_TARGET = 44;

test("the page never scrolls horizontally", async ({ page }) => {
  await joinGame(page);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  // A HUD is fixed-position over a canvas: if the document can scroll sideways,
  // something is sized in fixed px and has escaped the viewport.
  expect(
    overflow.scrollWidth,
    `the document scrolls horizontally (${overflow.scrollWidth}px wide in a ${overflow.innerWidth}px viewport) — a HUD element is overflowing`,
  ).toBeLessThanOrEqual(overflow.innerWidth);
});

test("no HUD element hangs off the edge of the viewport", async ({ page }) => {
  await joinGame(page);

  const escapees = await page.evaluate(() => {
    const bad: { sel: string; right: number; left: number }[] = [];
    const vw = window.innerWidth;

    // An element inside an overflow-hidden ancestor is CLIPPED, not escaping: the
    // compass is a 900%-wide strip scrolled inside a narrow window, so most of its
    // ticks legitimately sit far outside the viewport and are never painted. Only
    // the clipping ancestor's own box can escape, and it is checked on its own turn.
    const isClipped = (el: HTMLElement): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflowX !== "visible" || o.overflowY !== "visible") return true;
      }
      return false;
    };

    for (const el of Array.from(document.querySelectorAll<HTMLElement>("#root *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (isClipped(el)) continue;
      // 1px of tolerance for subpixel layout rounding.
      if (r.right > vw + 1 || r.left < -1) {
        const sel = el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.split(/\s+/).filter(Boolean).join(".")}`
          : el.tagName.toLowerCase();
        bad.push({ sel, right: Math.round(r.right), left: Math.round(r.left) });
      }
    }
    return bad;
  });

  expect(
    escapees,
    `these elements extend past the viewport edge:\n${escapees.map((e) => `  ${e.sel}  left=${e.left} right=${e.right}`).join("\n")}`,
  ).toEqual([]);
});

test.describe("coarse pointer (touch)", () => {
  // Only the mobile project emulates a real touch device, so (pointer: coarse)
  // actually matches and TouchControls mounts. On desktop these rules are moot.
  test.skip(({ isMobile }) => !isMobile, "touch-only rules");

  test("backdrop blur is off — it is a per-frame GPU tax over a live 3D canvas", async ({ page }) => {
    await joinGame(page);

    const blurred = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("#root *"))
        .filter((el) => {
          const f = getComputedStyle(el).backdropFilter;
          return f && f !== "none";
        })
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className)} → ${getComputedStyle(el).backdropFilter}`),
    );

    // This one has regressed before: a new rule re-enabled blur and silently
    // out-specified the (pointer: coarse) opt-out, which no screenshot would show.
    expect(
      blurred,
      `backdrop-filter is still active on a coarse pointer:\n${blurred.join("\n")}\n` +
        `Blurring a full-screen 3D canvas every frame is a real mobile GPU cost — keep the opt-out.`,
    ).toEqual([]);
  });

  test("every control is at least 44px", async ({ page }) => {
    await joinGame(page);

    const small = await page.evaluate((min) => {
      const bad: { sel: string; w: number; h: number }[] = [];
      const controls = document.querySelectorAll<HTMLElement>(
        '#root button, #root [role="button"], #root input, #root a, #root [data-touch]',
      );
      for (const el of Array.from(controls)) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width < min || r.height < min) {
          bad.push({
            sel: `${el.tagName.toLowerCase()}.${String(el.className)}`,
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
      }
      return bad;
    }, MIN_TOUCH_TARGET);

    expect(
      small,
      `controls below the ${MIN_TOUCH_TARGET}px touch floor:\n${small.map((s) => `  ${s.sel}  ${s.w}x${s.h}`).join("\n")}`,
    ).toEqual([]);
  });
});
