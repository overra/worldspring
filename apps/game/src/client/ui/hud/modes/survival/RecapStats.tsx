// Survival's ledger for a finished life. It reaches the death screen through the
// seam (SURVIVAL_HUD.DeathBody) and the LAST LIFE toast mounts it directly — the
// death-screen shell (title, cause, RESPAWN) is engine-level, these rows are not:
// a mode with no days and no zombies has nothing to put here.
//
// .recap-* lives in survival.css, with the rest of this mode's skin.

import type { ReactElement } from "react";
import { DAY_DURATION_S } from "@worldspring/shared/constants";
import type { DeathRecap } from "@worldspring/shared/protocol";
import { clientWorld } from "@/client/runtime";

/** Game-seconds survived -> "2.3 days" / "5.1 hours" (in-game time).
 * When connected (config truthy), uses the server's dayLengthMin so the
 * display matches the actual day cycle the player experienced. Falls back to
 * the compiled constant for pre-join contexts (e.g. leaderboard on MainMenu). */
export function formatSurvived(survivedS: number, dayDurationS?: number): string {
  const duration = dayDurationS ?? DAY_DURATION_S;
  const days = survivedS / duration;
  if (days >= 1) return `${days.toFixed(1)} days`;
  return `${(days * 24).toFixed(1)} hours`;
}

interface RecapStatsProps {
  recap: DeathRecap;
}

/** Stat rows for a finished life. When connected, uses the server's day length
 * so the display matches the actual day cycle experienced. */
export function RecapStats({ recap }: RecapStatsProps): ReactElement {
  const dayDurationS = clientWorld.config.time.dayLengthMin * 60;
  return (
    <div className="recap-stats">
      <div className="recap-row">
        <span className="ui-label">Survived</span>
        <span className="ui-num">{formatSurvived(recap.survivedS, dayDurationS)}</span>
      </div>
      <div className="recap-row">
        <span className="ui-label">Kills</span>
        <span className="ui-num">{recap.kills}</span>
      </div>
      <div className="recap-row">
        <span className="ui-label">Zombie kills</span>
        <span className="ui-num">{recap.zombieKills}</span>
      </div>
      <div className="recap-row">
        <span className="ui-label">Distance</span>
        <span className="ui-num">{(recap.distanceM / 1000).toFixed(1)} km</span>
      </div>
    </div>
  );
}
