// CPU/JS/submit frame-time splitter — the live, committed form of
// apps/game/scripts/perf-probes.md §1, promoted to a permanent tool by doc 08 M1
// so every gameplay milestone can read its own frame cost behind ?debug=1.
//
// The three numbers (frame / JS / submit) the console kit used to log:
//   - frame ms : rAF-to-rAF gap — already in debugStats.frameMs (DebugCollector).
//   - JS ms    : main-thread time spent inside the rAF tick (now − rAF timestamp).
//                Measured by a standalone rAF registered AFTER R3F's render loop,
//                so it observes the whole frame's JS — sim, prediction, camera,
//                and the composer — not just the render-phase useFrames.
//   - submit ms: CPU time inside gl.render. @react-three/postprocessing's composer
//                passes each call gl.render(scene, camera) on the renderer INSTANCE,
//                so wrapping it once captures the full submit cost of the frame.
//
// frameMs − jsMs ≈ GPU/vsync wait; submit ms is the slice of JS spent issuing draw
// calls. Per-pass GPU time over-counts on Apple's tile GPU (see the doc), so the
// overlay reports CPU/submit, not a GPU row — use perf-probes.md §3
// (__fx.n8ao.lastTime) for the one GPU pass that actually matters.
//
// Cost is a couple of subtractions + one rAF per frame, and the splitter is only
// started under ?debug=1 / DEV (the same gate as the window.__scene/__gl hooks),
// so production pays ≈0.

import type { Camera, Object3D, WebGLRenderer } from "three";
import { debugStats } from "@/client/runtime";

/** EMA weight — matches DebugCollector's frameMs smoothing (~10-frame settle). */
const ALPHA = 0.1;

let started = false;
/** CPU ms accumulated inside gl.render across the current frame's passes. */
let submitAccum = 0;

type WrappedRenderer = WebGLRenderer & { __origRender?: WebGLRenderer["render"] };

function ema(prev: number, sample: number): number {
  return prev === 0 ? sample : prev + (sample - prev) * ALPHA;
}

/**
 * Install the gl.render wrap + standalone measurement loop. Idempotent: safe to
 * call every frame from DebugCollector — only the first call takes effect.
 */
export function startPerfSplitter(gl: WebGLRenderer): void {
  if (started) return;
  started = true;

  // Wrap the renderer INSTANCE (not the prototype): the composer's passes all
  // call this gl.render, so the wrap sees the whole submit cost of the frame.
  const r = gl as WrappedRenderer;
  if (!r.__origRender) {
    r.__origRender = r.render;
    r.render = function patched(this: WebGLRenderer, scene: Object3D, camera: Camera) {
      const t0 = performance.now();
      (r.__origRender as WebGLRenderer["render"]).call(this, scene, camera);
      submitAccum += performance.now() - t0;
    };
  }

  // Standalone rAF, registered after R3F's render loop (which was set up at Canvas
  // init), so for each frame R3F runs first and `now − ts` spans its entire JS.
  const tick = (ts: number): void => {
    const now = performance.now();
    debugStats.jsMs = ema(debugStats.jsMs, Math.max(0, now - ts));
    debugStats.submitMs = ema(debugStats.submitMs, submitAccum);
    submitAccum = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Console hook for perf-probes.md §1 — it reads these live getters instead of
  // installing a second gl.render wrap (only one wrap can own the instance).
  (window as unknown as { __perfSplit?: unknown }).__perfSplit = {
    get frameMs(): number {
      return debugStats.frameMs;
    },
    get jsMs(): number {
      return debugStats.jsMs;
    },
    get submitMs(): number {
      return debugStats.submitMs;
    },
  };
}
