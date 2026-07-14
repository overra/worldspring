// Workspace interactions that a layout test cannot see.
//
// "Every visible control is clickable" (layout.spec) is blind to a control that is
// display:none — and that was exactly the bug here: the item popover's close button
// was `display: none` at base and only shown under (pointer: coarse), so on a
// desktop the item card could not be dismissed at all. Nothing failed; the control
// simply was not there. This spec drives the flow instead of measuring the layout.

import { expect, test } from "@playwright/test";
import { joinGame } from "./helpers";

test("the item card can be opened and dismissed", async ({ page }) => {
  await joinGame(page, "popover");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hud-inv")).toBeVisible();

  // The day server runs the TESTBED survival scenario, so slot 1 always holds an
  // item — the grid is not luck.
  const firstCell = page.locator(".inv-grid .ui-cell--filled").first();
  await expect(firstCell).toBeVisible();
  await firstCell.click();

  const card = page.locator(".inv-pop");
  await expect(card, "clicking a filled cell must open the item card").toBeVisible();

  // The close control is the ONLY thing wired to onClose. Clicking a cell again
  // re-selects it rather than toggling it off, and there is no Esc or click-outside
  // handler — so if this button is not here, the card is a trap on every pointer
  // that is not coarse.
  const close = card.getByRole("button", { name: /close item/i });
  await expect(close, "the item card needs a close control on EVERY pointer").toBeVisible();

  await close.click();
  await expect(card, "the close control must actually dismiss the card").toBeHidden();
});
