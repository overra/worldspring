// doc 12 M4 — the always-on corner minimap. Mounted only when the server enables
// it (cfg.map.minimap). A player-centered window blitted from the baked base,
// redrawn at snapshot rate. pointer-events:none — never steals input or the
// pointer lock. Full reveal; fog mask is M6.

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import "./map.css";

/** Half-extent of the world window shown, meters (so a 220 m square). */
const MINIMAP_WORLD_RADIUS = 110;

/** Half-angle of the facing wedge, radians. A readability cue, not the frustum. */
const CONE_HALF = (38 * Math.PI) / 180;

/** Gap between the ring and the compass letters, CSS px. */
const CARDINAL_GAP = 11;

/**
 * The facing wedge. Drawn in SCREEN space (outside the heading rotation), so it
 * always points up — which is where the player is looking on a heading-up map.
 */
function drawFacingCone(ctx: CanvasRenderingContext2D, mm: number): void {
  const r = mm / 2;
  ctx.save();
  ctx.translate(r, r);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, "rgba(125,160,107,0.26)"); // --ui-accent
  grad.addColorStop(1, "rgba(125,160,107,0)");
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, r, -Math.PI / 2 - CONE_HALF, -Math.PI / 2 + CONE_HALF);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(125,160,107,0.32)";
  ctx.stroke();
  ctx.restore();
}

export function Minimap(): ReactElement | null {
  // Config is set on welcome (before the playing render) and stable per session.
  const enabled = clientWorld.config.map.minimap;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const MM = canvas.width;
    const R = MINIMAP_WORLD_RADIUS;
    const rose = roseRef.current;
    const cards = rose ? Array.from(rose.querySelectorAll<HTMLElement>(".hud-minimap-card")) : [];

    // mapBake MUST stay behind a dynamic import (runtime.ts loads it the same
    // way): App.tsx mounts this component from the menu-shell chunk, so a static
    // import would pull the baker and its raster deps onto the join path.
    let id = 0;
    let live = true;
    void import("@/client/render/map/mapBake").then(
      ({ blitWindow, drawDynamicLayer, drawFog, getBakedMap }) => {
        if (!live) return; // unmounted before the chunk landed

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
          const me = clientWorld.me;
          if (baked) {
            // Rotate-to-heading: spin the whole view so the player's facing points UP.
            // The baked base is a true overhead projection (projection.ts: +Z up, +X
            // left), so heading-up is a PLAIN rotation of it — by (yaw − π), which
            // sends the forward dir (−sin,−cos) to screen-up. Terrain, fog, entities,
            // and the you-arrow all ride this one rotation (the arrow derives its own
            // heading from toPx, so it nets to straight up). No mirroring and no
            // per-marker counter-rotation — that asymmetry was the old left/right flip.
            ctx.save();
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
            if (clientWorld.config.map.reveal === "explored" && explored)
              drawFog(ctx, explored, toPx);
            drawDynamicLayer(ctx, toPx, 1);
            ctx.restore();
            drawFacingCone(ctx, MM);
          }
          ctx.restore();

          // Compass rose. The map spins under a fixed frame, so the letters have to
          // orbit with it or they would name the heading, not the bearing: north is
          // image-up (+Z), which the (yaw − π) rotation sends to (−sin yaw, cos yaw)
          // in screen space; E/S/W follow at 90° steps clockwise (screen y is down).
          if (cards.length === 4) {
            const rPx = canvas.clientWidth / 2 + CARDINAL_GAP;
            const nx = -Math.sin(me.yaw);
            const ny = Math.cos(me.yaw);
            const dirs = [
              [nx, ny],
              [-ny, nx],
              [-nx, -ny],
              [ny, -nx],
            ];
            for (let i = 0; i < 4; i++) {
              const [dx, dy] = dirs[i];
              cards[i].style.transform = `translate(-50%, -50%) translate(${dx * rPx}px, ${dy * rPx}px)`;
            }
          }
        };

        draw();
        id = window.setInterval(draw, 66); // ~15 Hz, snapshot cadence
      },
      (err: unknown) => {
        // A stale deploy or a network blip fails the chunk fetch. Say so — a
        // silently blank minimap reads as a rendering bug, not a load failure.
        console.error("minimap: mapBake chunk failed to load", err);
      },
    );

    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className="hud-minimap" ref={roseRef}>
      <canvas ref={canvasRef} width={188} height={188} className="hud-minimap-canvas" />
      <span className="hud-minimap-card hud-minimap-card--n">N</span>
      <span className="hud-minimap-card">E</span>
      <span className="hud-minimap-card">S</span>
      <span className="hud-minimap-card">W</span>
    </div>
  );
}
