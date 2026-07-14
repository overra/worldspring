// doc 12 M4 — the full-screen island map (full reveal). Opened by the M key or
// by using the map item (InputController), only while the player holds one.
// Pure DOM/canvas, redrawn off the rAF frame on a calm timer — never React per
// frame. The fog-of-war mask is M6; this draws the whole island.

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import "./map.css";

/** Panel drawing-buffer resolution (square); CSS scales it to the viewport. */
const PANEL_PX = 760;

/** The four markers drawDynamicLayer paints — and the only ones the map has. */
const LEGEND = [
  { mark: "you", label: "You" },
  { mark: "player", label: "Player" },
  { mark: "zombie", label: "Zombie" },
  { mark: "drop", label: "Airdrop" },
] as const;

export function MapPanel(): ReactElement | null {
  const mapOpen = useUIStore((s) => s.mapOpen);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!mapOpen) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const R = canvas.width;

    // mapBake MUST stay behind a dynamic import (runtime.ts loads it the same
    // way): App.tsx mounts this component from the menu-shell chunk, so a static
    // import would pull the baker and its raster deps onto the join path.
    let id = 0;
    let live = true;
    void import("@/client/render/map/mapBake").then(
      ({ drawDynamicLayer, drawFog, drawLabels, getBakedMap }) => {
        if (!live) return; // panel closed before the chunk landed

        const draw = (): void => {
          ctx.clearRect(0, 0, R, R);
          const baked = getBakedMap();
          if (!baked) return;
          ctx.drawImage(baked.base, 0, 0, baked.px, baked.px, 0, 0, R, R);
          const k = R / baked.px;
          const toPx = (x: number, z: number): { x: number; y: number } => {
            const c = baked.proj.worldToImage(x, z);
            return { x: c.ix * k, y: c.iy * k };
          };
          // Labels go BEFORE fog so unexplored town names stay hidden (matching the
          // old baked layering); the full map is unrotated, so they read upright.
          if (clientWorld.world) drawLabels(ctx, clientWorld.world, toPx, R / 55);
          const explored = clientWorld.explored;
          if (clientWorld.config.map.reveal === "explored" && explored) drawFog(ctx, explored, toPx);
          drawDynamicLayer(ctx, toPx, 1.4);
        };

        draw();
        id = window.setInterval(draw, 100); // 10 Hz — markers move slowly at map scale
      },
      (err: unknown) => {
        // A stale deploy or a network blip fails the chunk fetch. Say so — a
        // silently blank map reads as a rendering bug, not a load failure.
        console.error("map: mapBake chunk failed to load", err);
      },
    );

    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [mapOpen]);

  if (!mapOpen) return null;
  const fogged = clientWorld.config.map.reveal === "explored";
  return (
    <div
      className="map-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) useUIStore.getState().setMapOpen(false);
      }}
    >
      <div className="map-panel ui-panel">
        <div className="ui-panel-head">
          <span className="ui-eyebrow">Island map</span>
          {fogged && <span className="ui-chip">Fog of war</span>}
        </div>
        <div className="map-body">
          <canvas ref={canvasRef} width={PANEL_PX} height={PANEL_PX} className="map-canvas" />
        </div>
        <div className="map-foot">
          <ul className="map-legend">
            {LEGEND.map((l) => (
              <li key={l.label} className="ui-label">
                <span className={`map-swatch map-swatch--${l.mark}`} />
                {l.label}
              </li>
            ))}
          </ul>
          <div className="map-hint ui-label">
            <span className="ui-key">M</span>
            or click outside to close
          </div>
        </div>
      </div>
    </div>
  );
}
