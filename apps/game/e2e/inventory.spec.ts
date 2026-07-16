// Workspace interactions that a layout test cannot see.
//
// "Every visible control is clickable" (layout.spec) is blind to a control that is
// display:none — and that was exactly the bug here: the item popover's close button
// was `display: none` at base and only shown under (pointer: coarse), so on a
// desktop the item card could not be dismissed at all. Nothing failed; the control
// simply was not there. This spec drives the flow instead of measuring the layout.

import { expect, test } from "@playwright/test";
import { joinGame } from "./helpers";

// The desktop project is a fine, hovering pointer at 1440px — the anchored hover-card
// layout, which is what these assert. (Touch's tapped bottom sheet + its X are a
// different layout; the mobile project does not run this spec.)

test("the detail card opens on hover and its action buttons stay reachable", async ({ page }) => {
  await joinGame(page, "hover");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hud-inv")).toBeVisible();

  // The day server runs the TESTBED survival scenario, so slot 1 always holds an
  // item — the grid is not luck.
  const firstCell = page.locator(".inv-grid .ui-cell--filled").first();
  await expect(firstCell).toBeVisible();

  const card = page.locator(".inv-pop");
  await expect(card, "the card must not be up before hovering").toBeHidden();
  await firstCell.hover();
  await expect(card, "hovering a filled cell must open the detail card").toBeVisible();

  // A hover card should not carry an X — it closes itself. On desktop the close
  // button is display:none, so it is not a reachable control.
  await expect(
    card.getByRole("button", { name: /close item/i }),
    "the desktop hover card must not show an X",
  ).toBeHidden();

  // The whole point of the delayed close: the card survives the pointer travelling
  // from the cell onto the card, so its buttons are clickable. A bare cell-mouseleave
  // close would snap it shut in the gap.
  await card.getByRole("button").first().hover();
  await expect(card, "the card must persist while the pointer is over it").toBeVisible();
});

test("the hover card closes in-window — no need to leave, no X", async ({ page }) => {
  await joinGame(page, "dismiss");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hud-inv")).toBeVisible();

  const card = page.locator(".inv-pop");
  await page.locator(".inv-grid .ui-cell--filled").first().hover();
  await expect(card).toBeVisible();

  // The reported bug: the card covered other items and could only be dismissed via
  // the X or by leaving the whole window. Move the pointer to the workspace's own
  // header — in-window, not a cell, not the card — and it must close on its own.
  // (Coordinates, not a locator: the card overlaps the grid/equipment, so hovering
  //  an element there fails Playwright's actionability check — which is precisely
  //  the overlap this fix is about.)
  const box = await page.locator(".inv-panel").boundingBox();
  if (box === null) throw new Error("inventory panel has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + 18);
  await expect(card, "resting on neither a cell nor the card must dismiss it, in-window").toBeHidden();
});
