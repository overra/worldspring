import type { ReactElement } from "react";
import { MAX_FOOD, MAX_HP, MAX_WATER, TEMP_SHIVER } from "@worldspring/shared/constants";
import { useUIStore } from "@/client/state/store";
import { Bar } from "../../parts/Bar";

type VitalKind = "hp" | "food" | "water" | "temp";

// 16px stroked glyphs, currentColor — survival.css gives each one its vital hue.
const ICON_PATHS: Record<VitalKind, string> = {
  hp: "M8 13.6 3.1 8.7a3.1 3.1 0 0 1 4.4-4.4l.5.5.5-.5a3.1 3.1 0 0 1 4.4 4.4Z",
  food: "M4.5 4.4v7.2c0 1 1.6 1.8 3.5 1.8s3.5-.8 3.5-1.8V4.4M4.5 4.4c0-1 1.6-1.8 3.5-1.8s3.5.8 3.5 1.8-1.6 1.8-3.5 1.8-3.5-.8-3.5-1.8Z",
  water: "M8 2.6c0 0 4 4.4 4 6.9a4 4 0 0 1-8 0c0-2.5 4-6.9 4-6.9Z",
  temp: "M9.5 9.5V3.6a1.5 1.5 0 0 0-3 0v5.9a3 3 0 1 0 3 0Z",
};

function VitalIcon({ kind }: { kind: VitalKind }): ReactElement {
  return (
    <svg
      className={`bar-icon bar-icon--${kind}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[kind]} />
    </svg>
  );
}

/** Survival's vitals: health, food, hydration, core temperature. Health is the
 * only one an arena would keep — the panel as composed is this mode's skin.
 *
 * The card is .ui-panel--hud, not the full-blur .ui-panel: it sits over live
 * gameplay and the world behind it has to stay readable. */
export function VitalsPanel(): ReactElement {
  const vitals = useUIStore((s) => s.vitals);
  const shivering = vitals.temp < TEMP_SHIVER;
  return (
    <div className="hud-vitals ui-panel ui-panel--hud">
      <Bar
        icon={<VitalIcon kind="hp" />}
        label="Health"
        value={vitals.hp}
        max={MAX_HP}
        fillClass="bar-fill--hp"
        ticks
      />
      <Bar
        icon={<VitalIcon kind="food" />}
        label="Food"
        value={vitals.food}
        max={MAX_FOOD}
        fillClass="bar-fill--food"
        ticks
      />
      <Bar
        icon={<VitalIcon kind="water" />}
        label="Hydration"
        value={vitals.water}
        max={MAX_WATER}
        fillClass="bar-fill--water"
        ticks
      />
      <div className={shivering ? "hud-temp hud-temp--cold" : "hud-temp"}>
        <VitalIcon kind="temp" />
        <span className="hud-temp-label">Core temp</span>
        <span className="hud-temp-value ui-num">{vitals.temp.toFixed(1)}°C</span>
        {shivering && <span className="hud-shiver ui-chip ui-chip--solid">Shivering</span>}
      </div>
    </div>
  );
}
