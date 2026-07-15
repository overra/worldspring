import type { ReactElement } from "react";

/** Four ticks + a centre dot, centred on the actual camera centre. The ticks are
 * real elements rather than a background-image so they can carry a rounded cap —
 * at 2px wide a hard tick reads as a dead pixel against foliage. */
export function Crosshair(): ReactElement {
  return (
    <div className="hud-crosshair">
      <span className="hud-crosshair-tick hud-crosshair-tick--n" />
      <span className="hud-crosshair-tick hud-crosshair-tick--e" />
      <span className="hud-crosshair-tick hud-crosshair-tick--s" />
      <span className="hud-crosshair-tick hud-crosshair-tick--w" />
    </div>
  );
}
