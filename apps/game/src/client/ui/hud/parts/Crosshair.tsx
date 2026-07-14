import type { ReactElement } from "react";

/** Four ticks + a centre dot, drawn entirely in CSS from this one empty div,
 * centred on the actual camera centre. */
export function Crosshair(): ReactElement {
  return <div className="hud-crosshair" />;
}
