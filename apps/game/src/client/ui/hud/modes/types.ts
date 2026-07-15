// The per-mode HUD seam (docs/plans/00): survival's vitals are one mode's skin,
// not engine core. The shared chrome (crosshair, hotbar, chat, clock, online,
// ping, notices, cast bar, pickup prompt, damage flash) renders for every mode,
// as do the mode-agnostic overlays it sits under — the pause menu, the death
// screen and the inventory panel. A ModeHud fills the mode-owned surfaces of
// each; a mode with no ModeHud renders all of them bare, and every slot below is
// optional so a mode only names the surfaces it actually skins.

import type { ReactElement } from "react";
import type { ChannelKind, DeathRecap } from "@worldspring/shared/protocol";

/** The sections a mode adds to the shared inventory panel's side column
 * (survival: the condition readout + the crafting list). The shell — carry grid,
 * equipment rows, detail card — is engine-level: every mode has an inventory. */
export interface ModeInvSlot {
  /** Copy for the narrow-screen tab that reveals the sections. The panel renders
   * no tab bar for a mode without a slot — there is nothing to switch to. */
  readonly tabLabel: string;
  readonly Section: () => ReactElement | null;
}

export interface ModeHud {
  /** Mode-owned panels, rendered inside .hud alongside the shared chrome. */
  readonly Hud: () => ReactElement | null;
  /** Extra readout in the shared top-right status corner (round timer, score). */
  readonly StatusSlot?: () => ReactElement | null;
  /** Extra readout beside the pause menu's world clock (survival's core temp). */
  readonly EscSlot?: () => ReactElement | null;
  /** Body of the shared death screen (survival recap / arena scoreline). */
  readonly DeathBody?: (props: { recap: DeathRecap }) => ReactElement | null;
  /** Mode-owned sections of the shared inventory panel. */
  readonly InvSlot?: ModeInvSlot;
  /** Cast-bar copy for the ChannelKinds this mode uses. */
  readonly channelLabels?: Partial<Record<ChannelKind, string>>;
}
