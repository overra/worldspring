// The one place that loads the map baker, for every surface that draws the map
// (the corner minimap and the full island panel).
//
// It exists to hold ONE constraint in ONE place:
//
//   mapBake MUST stay behind a dynamic import. runtime.ts loads it the same way.
//   The components that draw the map sit on the menu-shell / HUD chunks, so a
//   STATIC import here would drag the baker and its raster deps onto the JOIN
//   PATH — undoing code-splitting that was paid for deliberately.
//
// That rule used to be written out in a comment in Minimap.tsx and again in
// MapPanel.tsx, next to two hand-rolled copies of the same import → draw →
// setInterval → cleanup dance. A rule stated twice is a rule that gets broken in
// one of the two places, and a static import is exactly the kind of edit an
// autocomplete makes for you. Now there is one copy of both.

import { useEffect, useRef } from "react";

/** The baker module, typed off the real thing so a rename here fails the build. */
type MapBake = typeof import("@/client/render/map/mapBake");

/**
 * Load the baker (lazily, once) and run a redraw on a timer while `active`.
 *
 * `makeDraw` is called with the module AFTER it lands, and returns the draw
 * function — or null if its canvas isn't there. Each caller keeps its own drawing
 * code (the projection math in these two differs and is load-bearing); all this
 * owns is the lifecycle.
 *
 * NOT rAF: the map redraws at snapshot cadence, not frame cadence. Driving it off
 * rAF would burn a canvas blit per frame to show markers that move at walking pace.
 */
export function useBakedMap(
  active: boolean,
  intervalMs: number,
  makeDraw: (bake: MapBake) => (() => void) | null,
): void {
  // Held in a ref so a caller can close over fresh props without re-importing the
  // chunk and restarting the timer every render.
  const makeDrawRef = useRef(makeDraw);
  makeDrawRef.current = makeDraw;

  useEffect(() => {
    if (!active) return;

    let id = 0;
    let live = true;

    void import("@/client/render/map/mapBake").then(
      (bake) => {
        if (!live) return; // unmounted before the chunk landed
        const draw = makeDrawRef.current(bake);
        if (!draw) return;
        draw();
        id = window.setInterval(draw, intervalMs);
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
  }, [active, intervalMs]);
}
