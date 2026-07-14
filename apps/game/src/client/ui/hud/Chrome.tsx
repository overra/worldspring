import type { ReactElement } from "react";
import { ChatPanel } from "../ChatPanel";
import type { ModeHud } from "./modes/types";
import { ChannelBar } from "./parts/ChannelBar";
import { Compass } from "./parts/Compass";
import { Crosshair } from "./parts/Crosshair";
import { DamageFlash } from "./parts/DamageFlash";
import { Hotbar } from "./parts/Hotbar";
import { KeyHints } from "./parts/KeyHints";
import { Notices } from "./parts/Notices";
import { PickupPrompt } from "./parts/PickupPrompt";
import { StatusCorner } from "./parts/StatusCorner";
import { ThrottleWarning } from "./parts/ThrottleWarning";
import "./chrome.css";

interface ChromeProps {
  /** null when the mode ships no HUD module — the chrome still renders whole. */
  mode: ModeHud | null;
}

/** Every mode gets this: aim, heading, items, chat, world clock, ping, notices,
 * the generic cast bar and the generic [E] prompt. */
export function Chrome({ mode }: ChromeProps): ReactElement {
  return (
    <>
      <DamageFlash />
      <ThrottleWarning />
      <Compass />
      <Notices />
      <StatusCorner Slot={mode?.StatusSlot} />
      <Crosshair />
      <ChannelBar labels={mode?.channelLabels} />
      <PickupPrompt />
      <ChatPanel />
      <Hotbar />
      <KeyHints />
    </>
  );
}
