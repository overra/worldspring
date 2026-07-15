// doc 12 M4 — the full-screen island map (full reveal). Opened by the M key or
// by using the map item (InputController), only while the player holds one.
// Pure DOM/canvas, redrawn off the rAF frame on a calm timer — never React per
// frame. The fog-of-war mask is M6; this draws the whole island.
//
// The canvas is split out as <MapCanvas> because the tabbed workspace hosts the
// same map in its MAP tab (inventory/InventoryPanel.tsx). Both sites mount the
// SAME component — the projection inside mapBake is hard-won and must have
// exactly one caller.

import { useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { useBakedMap } from "./useBakedMap";
import "./map.css";

/** Redraw cadence, ms. 10 Hz — markers move at walking pace at map scale. */
const MAP_REDRAW_MS = 100;

/** Panel drawing-buffer resolution (square); CSS scales it to the viewport. */
const PANEL_PX = 760;

/** The four markers drawDynamicLayer paints — and the only ones the map has. */
const LEGEND = [
  { mark: "you", label: "You" },
  { mark: "player", label: "Player" },
  { mark: "zombie", label: "Zombie" },
  { mark: "drop", label: "Airdrop" },
] as const;

interface MapCanvasProps {
  /** The canvas's box class — each host sizes the square itself. */
  className?: string;
}

/**
 * The island canvas and its 10 Hz redraw. Mount it only while the map is
 * actually on screen: the effect owns a setInterval and a dynamic chunk fetch,
 * and unmounting is what stops both.
 */
export function MapCanvas({ className = "map-canvas" }: MapCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // useBakedMap owns the chunk load, the timer and the teardown — including the
  // rule that mapBake must never be imported statically (see useBakedMap.ts). All
  // that lives here is the drawing. Always active: this component is mounted only
  // while the map is on screen, and unmounting is what stops the redraw.
  useBakedMap(true, MAP_REDRAW_MS, ({ drawDynamicLayer, drawFog, drawLabels, getBakedMap }) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    const R = canvas.width;

    return (): void => {
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
  });

  return <canvas ref={canvasRef} width={PANEL_PX} height={PANEL_PX} className={className} />;
}

/** The marker key. Exported so the workspace's MAP tab shows the same one —
 * a legend that drifts from drawDynamicLayer is worse than none. */
export function MapLegend(): ReactElement {
  return (
    <ul className="map-legend">
      {LEGEND.map((l) => (
        <li key={l.label} className="ui-label">
          <span className={`map-swatch map-swatch--${l.mark}`} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

/** True while the map's reveal is fogged — the FOG OF WAR chip's gate. */
export function mapIsFogged(): boolean {
  return clientWorld.config.map.reveal === "explored";
}

/**
 * The standalone M-key map. The workspace has a MAP tab that shows the same
 * canvas, but M keeps this panel: InputController owns the M binding and gates
 * movement/pointer-lock on `mapOpen`, and rerouting it to `invOpen` + a tab
 * would mean editing that controller.
 *
 * `mapOpen` and `invOpen` are NOT mutually exclusive (Tab is live while the map
 * is up), and this panel outranks the workspace (map.css z-index 8 vs the HUD's
 * 5) — so the workspace's MAP tab stands its canvas down while `mapOpen` is
 * true, and only one MapCanvas (one interval, one chunk) is ever mounted.
 */
export function MapPanel(): ReactElement | null {
  const mapOpen = useUIStore((s) => s.mapOpen);
  if (!mapOpen) return null;
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
          {mapIsFogged() && <span className="ui-chip">Fog of war</span>}
        </div>
        <div className="map-body">
          <MapCanvas />
        </div>
        <div className="map-foot">
          <MapLegend />
          <div className="map-hint ui-label">
            <span className="ui-key">M</span>
            or click outside to close
          </div>
        </div>
      </div>
    </div>
  );
}
