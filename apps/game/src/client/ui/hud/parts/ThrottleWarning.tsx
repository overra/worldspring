import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { debugStats } from "@/client/runtime";

/**
 * Visible-but-starved detector: macOS/Chrome display-throttle occluded or
 * embedded windows down to ~2Hz rAF (0Hz fully hidden) — the game looks
 * frozen/T-posed while the code is healthy. DOM timers keep firing in that
 * state, so an interval can catch it and say so. Only shown while the
 * document is visible: a fully hidden window has nobody to warn.
 */
export function ThrottleWarning(): ReactElement | null {
  const [starved, setStarved] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      const stale =
        document.visibilityState === "visible" &&
        debugStats.lastFrameAt > 0 &&
        performance.now() - debugStats.lastFrameAt > 1500;
      setStarved(stale);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!starved) return null;
  return (
    <div className="hud-throttle-warning">
      window is being throttled by the OS — click the game window or unblock it
      to restore smooth play
    </div>
  );
}
