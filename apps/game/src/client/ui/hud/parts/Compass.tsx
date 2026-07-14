import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { clientWorld } from "@/client/runtime";

/** Degrees of arc visible across the strip. */
const VISIBLE_DEG = 120;

/** One mark every 5°, a label every 45°. Must divide 45 or the intercardinals
 * would have no tick to sit on. */
const MARK_STEP = 5;

/** Three copies of the rose (−360 / 0 / +360) — see COPIES. */
const SPAN_DEG = 1080;

/** How many strip-widths the track spans. MUST match `.hud-compass-track`'s
 * width in chrome.css (900%) — the two halves of one layout. */
const WINDOWS = SPAN_DEG / VISIBLE_DEG;

/** Translate that centres the window on the track, as a % of the track. */
const CENTRE_PCT = 100 / (2 * WINDOWS);

/** Compass points, clockwise from north, at 45° each. */
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Compass bearing (degrees clockwise from true north) for a player yaw.
 *
 * The map projection is +Z north and +X *west* (render/map/projection.ts; the
 * long comment in Minimap.tsx is the same fact from the other end), and a player
 * at yaw ψ faces (−sin ψ, −cos ψ) in world XZ. So the north component of facing
 * is −cos ψ and the east component is +sin ψ, and
 *
 *   bearing = atan2(east, north) = atan2(sin ψ, −cos ψ) = π − ψ.
 *
 * Sanity: yaw 0 faces −Z ⇒ 180° ⇒ S, which is exactly where the minimap's rose
 * puts the S letter at yaw 0. The two readouts are the same claim about the
 * world and must never disagree — change one, re-derive the other.
 */
function bearingOf(yaw: number): number {
  return ((180 - (yaw * 180) / Math.PI) % 360 + 360) % 360;
}

interface Mark {
  deg: number;
  /** "" for the minor ticks — most marks are unlabelled. */
  label: string;
  cls: string;
}

/** Four tick heights, so the eye can count without reading: N/E/S/W tallest,
 * then the intercardinals, then a 15° beat, then the 5° fill. */
function markClass(deg: number): string {
  if (deg % 90 === 0) return "hud-compass-mark hud-compass-mark--major";
  if (deg % 45 === 0) return "hud-compass-mark hud-compass-mark--mid";
  if (deg % 15 === 0) return "hud-compass-mark hud-compass-mark--minor";
  return "hud-compass-mark";
}

const MARKS: readonly Mark[] = Array.from(
  { length: 360 / MARK_STEP },
  (_, i): Mark => {
    const deg = i * MARK_STEP;
    return {
      deg,
      label: deg % 45 === 0 ? CARDINALS[deg / 45] : "",
      cls: markClass(deg),
    };
  },
);

/** The rose is laid out three times so that crossing north is a plain translate
 * rather than a wrap: the middle copy always covers the visible window. */
const COPIES = [0, 360, 720] as const;

/**
 * The heading strip (top-centre). Yaw is per-frame runtime state — it is
 * deliberately NOT in the zustand store — so this drives itself from rAF and
 * writes the DOM directly. Re-rendering React 60× a second to move a compass
 * would be the most expensive thing on the HUD; instead the whole rose is one
 * static element and each frame writes one transform.
 */
export function Compass(): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null);
  const degRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastDeg = -1;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const deg = bearingOf(clientWorld.me.yaw);

      // Slide the rose so the current bearing lands under the pointer. Both
      // terms are percentages of the TRACK's width (= SPAN_DEG), so the strip's
      // clamp()ed CSS width never enters the math and there is nothing to
      // recompute on resize.
      const track = trackRef.current;
      if (track !== null) {
        const x = CENTRE_PCT - ((deg + 360) / SPAN_DEG) * 100;
        track.style.transform = `translateX(${x}%)`;
      }

      // The text only changes on a whole degree — gate it, or this is two DOM
      // writes per frame to say the same thing.
      const whole = Math.round(deg) % 360;
      if (whole === lastDeg) return;
      lastDeg = whole;
      if (degRef.current !== null) {
        degRef.current.textContent = `${String(whole).padStart(3, "0")}°`;
      }
      if (cardRef.current !== null) {
        cardRef.current.textContent = CARDINALS[Math.round(deg / 45) % 8];
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="hud-compass">
      <div className="hud-compass-heading">
        <span ref={degRef}>000°</span> <span className="hud-compass-card" ref={cardRef}>N</span>
      </div>
      <div className="hud-compass-strip">
        <div className="hud-compass-track" ref={trackRef}>
          {COPIES.map((offset) =>
            MARKS.map((m) => (
              <span
                key={`${offset}:${m.deg}`}
                className={m.cls}
                style={{ left: `${((m.deg + offset) / SPAN_DEG) * 100}%` }}
              >
                {m.label !== "" && <span className="hud-compass-label">{m.label}</span>}
                <span className="hud-compass-tick" />
              </span>
            )),
          )}
        </div>
      </div>
      <div className="hud-compass-pointer" />
    </div>
  );
}
