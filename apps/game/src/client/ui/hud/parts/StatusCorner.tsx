import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";

export function formatClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface StatusCornerProps {
  /** The mode's own readout (round timer, score) — rendered under the clock. */
  Slot?: () => ReactElement | null;
}

/** Top-right meta stack: world clock, players online, ping. World time is
 * engine-level (config.time), so the clock is chrome; anything mode-specific
 * goes through Slot. */
export function StatusCorner({ Slot }: StatusCornerProps): ReactElement {
  const clockHours = useUIStore((s) => s.clockHours);
  const playerCount = useUIStore((s) => s.playerCount);
  const pingMs = useUIStore((s) => s.pingMs);
  // doc 12: the corner minimap sits in this same top-right slot, so drop below it
  // when it's active (config is stable per session; map.css owns the offset).
  const cls = clientWorld.config.map.minimap ? "hud-status has-minimap" : "hud-status";
  return (
    <div className={cls}>
      <div className="hud-clock">{formatClock(clockHours)}</div>
      {Slot !== undefined && <Slot />}
      <div>{playerCount} online</div>
      <div>{Math.round(pingMs)}ms</div>
    </div>
  );
}
