import type { ReactElement } from "react";
import { useUIStore } from "@/client/state/store";

const PIECE_LABELS: Record<string, string> = {
  foundation: "Foundation",
  wall: "Wall",
  doorway: "Doorway",
  window: "Window Wall",
  door: "Door",
  gate: "Gate",
  crate: "Storage Crate",
};

/** Build mode (doc 06): selected piece/tier + why the ghost is red. */
export function BuildPanel(): ReactElement | null {
  const info = useUIStore((s) => s.buildInfo);
  if (info === null) return null;
  return (
    <div className="hud-build">
      <div className="hud-build-row">
        <span className="hud-build-piece">
          {PIECE_LABELS[info.kind] ?? info.kind} · {info.tier === 1 ? "scrap" : "wood"}
        </span>
        {info.status !== null && <span className="hud-build-status">{info.status}</span>}
      </div>
      <div className="hud-build-hints">
        <span className="hud-prompt-key">[Q]</span> piece
        <span className="hud-prompt-key">[T]</span> tier
        <span className="hud-prompt-key">[LMB]</span> place
        <span className="hud-prompt-key">[hold X]</span> demolish
      </div>
    </div>
  );
}
