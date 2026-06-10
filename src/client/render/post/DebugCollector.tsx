// Frame-stats collector. Lives inside the Canvas, writes into the mutable
// debugStats object every frame (NO React state — see runtime.ts ownership
// notes). The DOM DebugOverlay samples debugStats at UI rate (250ms).
//
// The post-processing composer renders the scene in several passes at
// priority 2, and three's gl.info auto-resets after every render() call —
// reading it naively only ever shows the last pass. So: disable autoReset,
// reset manually at priority 1 (after the camera update, before the
// composer), and read the accumulated full-frame counts at priority 3.

import { useFrame } from "@react-three/fiber";
import { debugStats } from "@/client/runtime";

/** EMA weight for frame-time smoothing; ~0.1 ≈ averaging the last ~10 frames. */
const FRAME_MS_ALPHA = 0.1;

export function DebugCollector(): null {
  useFrame((state) => {
    state.gl.info.autoReset = false;
    state.gl.info.reset();
  }, 1);

  useFrame((state, delta) => {
    const ms = delta * 1000;
    debugStats.frameMs =
      debugStats.frameMs === 0
        ? ms
        : debugStats.frameMs + (ms - debugStats.frameMs) * FRAME_MS_ALPHA;
    debugStats.fps =
      debugStats.frameMs > 0 ? Math.round(1000 / debugStats.frameMs) : 0;

    const info = state.gl.info;
    debugStats.drawCalls = info.render.calls;
    debugStats.triangles = info.render.triangles;
    debugStats.geometries = info.memory.geometries;
    debugStats.textures = info.memory.textures;
  }, 3);
  return null;
}
