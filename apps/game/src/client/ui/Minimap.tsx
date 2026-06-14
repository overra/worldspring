// doc 12 M4 — the always-on corner minimap. Mounted only when the server enables
// it (cfg.map.minimap). A player-centered window blitted from the baked base,
// redrawn at snapshot rate. pointer-events:none — never steals input or the
// pointer lock. Full reveal; fog mask is M6.

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import { blitWindow, drawDynamicLayer, drawFog, getBakedMap } from "@/client/render/map/mapBake";
import "./map.css";

/** Half-extent of the world window shown, meters (so a 220 m square). */
const MINIMAP_WORLD_RADIUS = 110;

export function Minimap(): ReactElement | null {
  // Config is set on welcome (before the playing render) and stable per session.
  const enabled = clientWorld.config.map.minimap;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const MM = canvas.width;
    const R = MINIMAP_WORLD_RADIUS;

    const draw = (): void => {
      ctx.fillStyle = "#1d3a52"; // deep-water bg shows through off-island edges
      ctx.fillRect(0, 0, MM, MM);
      const baked = getBakedMap();
      if (!baked) return;
      const me = clientWorld.me;
      // +Z up: window top-left = (me.x - R, me.z + R), bottom-right = (me.x + R, me.z - R).
      const tl = baked.proj.worldToImage(me.x - R, me.z + R);
      const br = baked.proj.worldToImage(me.x + R, me.z - R);
      blitWindow(ctx, baked.base, tl.ix, tl.iy, br.ix - tl.ix, br.iy - tl.iy, MM, baked.px);
      const toPx = (x: number, z: number): { x: number; y: number } => ({
        x: ((x - (me.x - R)) / (2 * R)) * MM,
        y: (((me.z + R) - z) / (2 * R)) * MM,
      });
      const explored = clientWorld.explored;
      if (clientWorld.config.map.reveal === "explored" && explored) drawFog(ctx, explored, toPx);
      drawDynamicLayer(ctx, toPx, 1);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeRect(0, 0, MM, MM);
    };

    draw();
    const id = window.setInterval(draw, 66); // ~15 Hz, snapshot cadence
    return () => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} width={188} height={188} className="hud-minimap" />;
}
