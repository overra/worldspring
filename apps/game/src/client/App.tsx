import { lazy, Suspense, useEffect } from "react";
import { useUIStore } from "./state/store";
import { MainMenu } from "./ui/MainMenu";
import { HUD } from "./ui/HUD";
import { DeathScreen } from "./ui/DeathScreen";
import { EscapeMenu } from "./ui/EscapeMenu";
import { DebugOverlay } from "./ui/DebugOverlay";
import { QaPanel } from "./ui/QaPanel";
import { TouchControls } from "./ui/TouchControls";
// doc 12 — DOM/2D-canvas map overlays (no three.js), so they mount HERE, not in
// GameCanvas. Each self-gates: Minimap on cfg.map.minimap, MapPanel on mapOpen.
import { MapPanel } from "./ui/MapPanel";
import { Minimap } from "./ui/Minimap";

// Lazy boundary: GameCanvas.tsx owns the <Canvas> subtree and every three.js /
// R3F / postprocessing import, so the menu shell chunk stays tiny. The canvas
// mount list lives in src/client/GameCanvas.tsx — add new scene mounts THERE,
// not here (a static three-touching import in this file defeats the split).
const GameCanvas = lazy(() =>
  import("./GameCanvas").then((m) => ({ default: m.GameCanvas })),
);

export function App(): React.ReactElement {
  const phase = useUIStore((s) => s.phase);

  // Warm the heavy chunk in the background while the player is on the menu so
  // joining doesn't stall on a network fetch after `welcome`.
  useEffect(() => {
    void import("./GameCanvas");
  }, []);

  if (phase === "menu" || phase === "connecting") {
    return <MainMenu />;
  }
  return (
    <div className="game-root">
      <Suspense fallback={null}>
        <GameCanvas />
      </Suspense>
      <HUD />
      <Minimap />
      <MapPanel />
      <TouchControls />
      <DebugOverlay />
      <QaPanel />
      <EscapeMenu />
      {phase === "dead" && <DeathScreen />}
    </div>
  );
}
