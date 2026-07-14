import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";
import { RecapStats } from "./RecapStats";

/** Top-center recap toast: your character died while you were offline. The
 * stats it shows (days survived, zombie kills, distance) are survival's. */
export function LastLifeToast(): ReactElement | null {
  const phase = useUIStore((s) => s.phase);
  const recap = useUIStore((s) => s.recap);
  const setRecap = useUIStore((s) => s.setRecap);
  if (phase !== "playing" || recap === null) return null;
  return (
    <div className="hud-lastlife ui-panel">
      <div className="lastlife-head">
        <span className="lastlife-title ui-eyebrow">LAST LIFE</span>
        <button className="lastlife-close" aria-label="dismiss" onClick={() => setRecap(null)}>
          ×
        </button>
      </div>
      <p className="lastlife-msg ui-body">While you were away you died — killed by {recap.by}</p>
      <RecapStats recap={recap} />
    </div>
  );
}
