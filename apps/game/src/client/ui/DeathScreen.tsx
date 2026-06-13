// Fullscreen death overlay. Mounted by App when phase === "dead";
// the socket stays open underneath so RESPAWN reuses it.

import type { ReactElement } from "react";
import { DAY_DURATION_S } from "@worldspring/shared/constants";
import type { DeathRecap } from "@worldspring/shared/protocol";
import { doRespawn } from "@/client/net/connection";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import "./ui.css";

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

/** Stat rows for a finished life — shared by the death screen and the HUD
 * "LAST LIFE" toast. When connected, uses the server's day length so the
 * display matches the actual day cycle experienced. */
export function RecapStats({ recap }: RecapStatsProps): ReactElement {
  const dayDurationS = clientWorld.config.time.dayLengthMin * 60;
  return (
    <div className="recap-stats">
      <div className="recap-row">
        <span className="recap-label">SURVIVED</span>
        <span className="recap-value">{formatSurvived(recap.survivedS, dayDurationS)}</span>
      </div>
      <div className="recap-row">
        <span className="recap-label">KILLS</span>
        <span className="recap-value">{recap.kills}</span>
      </div>
      <div className="recap-row">
        <span className="recap-label">ZOMBIE KILLS</span>
        <span className="recap-value">{recap.zombieKills}</span>
      </div>
      <div className="recap-row">
        <span className="recap-label">DISTANCE</span>
        <span className="recap-value">{(recap.distanceM / 1000).toFixed(1)} km</span>
      </div>
    </div>
  );
}

export function DeathScreen(): ReactElement {
  const deathCause = useUIStore((s) => s.deathCause);
  const recap = useUIStore((s) => s.recap);
  return (
    <div className="death-root">
      <h1 className="death-title">YOU DIED</h1>
      <p className="death-cause">killed by {deathCause ?? "the wasteland"}</p>
      {recap !== null && <RecapStats recap={recap} />}
      <button
        className="death-respawn"
        onClick={() => doRespawn()}
      >
        RESPAWN
      </button>
    </div>
  );
}
