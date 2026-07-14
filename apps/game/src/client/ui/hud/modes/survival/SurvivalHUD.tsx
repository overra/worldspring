import type { ReactElement } from "react";
import type { ChannelKind } from "@worldspring/shared/protocol";
import type { ModeHud } from "../types";
import { BuildPanel } from "./BuildPanel";
import { EscTemp } from "./EscTemp";
import { SurvivalInvSections } from "./InvSections";
import { LastLifeToast } from "./LastLifeToast";
import { RecapStats } from "./RecapStats";
import { VehicleHud } from "./VehicleHud";
import { VitalsPanel } from "./VitalsPanel";
import "./survival.css";

// Kind-level copy — the wire carries only the ChannelKind, so there is no
// per-item label to show. craft/fish never reach the bar (both are instant),
// they exist here for exhaustiveness.
const CHANNEL_LABELS: Record<ChannelKind, string> = {
  cook: "Cooking",
  reload: "Reloading",
  use: "Using",
  craft: "Crafting",
  fish: "Casting",
};

function SurvivalPanels(): ReactElement {
  return (
    <>
      <BuildPanel />
      <VehicleHud />
      <VitalsPanel />
      <LastLifeToast />
    </>
  );
}

export const SURVIVAL_HUD: ModeHud = {
  Hud: SurvivalPanels,
  EscSlot: EscTemp,
  DeathBody: RecapStats,
  InvSlot: { tabLabel: "Craft", Section: SurvivalInvSections },
  channelLabels: CHANNEL_LABELS,
};
