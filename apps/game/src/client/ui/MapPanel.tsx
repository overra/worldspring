// doc 12 M4 — the full-screen island map (full reveal). Opened by the M key or
// by using the map item (InputController), only while the player holds one.
// Pure DOM/canvas, redrawn off the rAF frame on a calm timer — never React per
// frame. The fog-of-war mask is M6; this draws the whole island.

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { drawDynamicLayer, drawFog, getBakedMap } from "@/client/render/map/mapBake";
import "./map.css";

/** Panel drawing-buffer resolution (square); CSS scales it to the viewport. */
const PANEL_PX = 760;

export function MapPanel(): ReactElement | null {
  const mapOpen = useUIStore((s) => s.mapOpen);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!mapOpen) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const R = canvas.width;

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
      const explored = clientWorld.explored;
      if (clientWorld.config.map.reveal === "explored" && explored) drawFog(ctx, explored, toPx);
      drawDynamicLayer(ctx, toPx, 1.4);
    };

    draw();
    const id = window.setInterval(draw, 100); // 10 Hz — markers move slowly at map scale
    return () => window.clearInterval(id);
  }, [mapOpen]);

  if (!mapOpen) return null;
  return (
    <div
      className="map-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) useUIStore.getState().setMapOpen(false);
      }}
    >
      <div className="map-panel">
        <canvas ref={canvasRef} width={PANEL_PX} height={PANEL_PX} className="map-canvas" />
        <div className="map-hint">{clientWorld.config.map.reveal === "explored" ? "EXPLORED — fog of war" : "ISLAND MAP"} · M or click outside to close</div>
      </div>
    </div>
  );
}
