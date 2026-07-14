// Survival's slot in the shared pause menu. The clock it sits under is chrome —
// the world clock runs in every mode — but a thermometer is this mode's rule.
//
// .esc-meta-row lives in menu.css, with the rest of the shell it renders into.

import type { ReactElement } from "react";
import { TEMP_SHIVER } from "@worldspring/shared/constants";
import { useUIStore } from "@/client/state/store";

/** Core temp beside the pause menu's clock. A component, not a row inlined into
 * EscapeMenu, so the vitals subscription exists only while the menu is open. */
export function EscTemp(): ReactElement {
  const temp = useUIStore((s) => s.vitals.temp);
  const shivering = temp < TEMP_SHIVER;
  return (
    <span className={shivering ? "esc-meta-row esc-meta-row--cold" : "esc-meta-row"}>
      {temp.toFixed(1)}°C{shivering ? " · SHIVERING" : ""}
    </span>
  );
}
