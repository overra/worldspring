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
      ctx.clearRect(0, 0, MM, MM);
      ctx.save();
      // Circular viewport — hides the rotated-window corners (CSS rounds the
      // element to match).
      ctx.beginPath();
      ctx.arc(MM / 2, MM / 2, MM / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#1d3a52"; // deep-water bg shows through off-island edges
      ctx.fillRect(0, 0, MM, MM);
      const baked = getBakedMap();
      if (baked) {
        const me = clientWorld.me;
        // Rotate-to-heading: spin the whole view so the player's facing points UP.
        // The baked base is a true overhead projection (projection.ts: +Z up, +X
        // left), so heading-up is a PLAIN rotation of it — by (yaw − π), which
        // sends the forward dir (−sin,−cos) to screen-up. Terrain, fog, entities,
        // and the you-arrow all ride this one rotation (the arrow derives its own
        // heading from toPx, so it nets to straight up). No mirroring and no
        // per-marker counter-rotation — that asymmetry was the old left/right flip.
        ctx.translate(MM / 2, MM / 2);
        ctx.rotate(me.yaw - Math.PI);
        ctx.translate(-MM / 2, -MM / 2);
        // Window corners in image space: +Z up & +X left ⇒ top-left = (me.x+R, me.z+R).
        const tl = baked.proj.worldToImage(me.x + R, me.z + R);
        const br = baked.proj.worldToImage(me.x - R, me.z - R);
        blitWindow(ctx, baked.base, tl.ix, tl.iy, br.ix - tl.ix, br.iy - tl.iy, MM, baked.px);
        const toPx = (x: number, z: number): { x: number; y: number } => ({
          x: (((me.x + R) - x) / (2 * R)) * MM,
          y: (((me.z + R) - z) / (2 * R)) * MM,
        });
        const explored = clientWorld.explored;
        if (clientWorld.config.map.reveal === "explored" && explored) drawFog(ctx, explored, toPx);
        drawDynamicLayer(ctx, toPx, 1);
      }
      ctx.restore();
    };

    draw();
    const id = window.setInterval(draw, 66); // ~15 Hz, snapshot cadence
    return () => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} width={188} height={188} className="hud-minimap" />;
}
