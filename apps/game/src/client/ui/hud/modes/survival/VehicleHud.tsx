import type { ReactElement } from "react";
import { VEHICLE_FUEL_MAX, VEHICLE_HP_MAX } from "@worldspring/shared/constants";
import { useUIStore } from "@/client/state/store";
import { Bar } from "../../parts/Bar";

/** doc 13 M4 — driving HUD: fuel / hull / speed. */
export function VehicleHud(): ReactElement | null {
  const seat = useUIStore((s) => s.vehicleSeat);
  if (!seat) return null;
  const fuelPct = Math.round(Math.max(0, Math.min(1, seat.fuel / VEHICLE_FUEL_MAX)) * 100);
  const hullPct = Math.round(Math.max(0, Math.min(1, seat.hp / VEHICLE_HP_MAX)) * 100);
  const kmh = Math.round(seat.speed * 3.6);
  const driver = seat.index === 0;
  const empty = fuelPct === 0;
  return (
    <div className="hud-vehicle ui-panel ui-panel--hud">
      <div className="hud-vehicle-head">
        <span className="ui-eyebrow">{driver ? "Driving" : "Passenger"}</span>
        <span className="ui-num ui-num--lg">
          {kmh}
          <span className="hud-vehicle-unit"> km/h</span>
        </span>
      </div>
      <Bar
        label="Fuel"
        value={fuelPct}
        max={100}
        fillClass={empty ? "bar-fill--danger" : "bar-fill--food"}
        valueText={`${fuelPct}%`}
      />
      <Bar
        label="Hull"
        value={hullPct}
        max={100}
        fillClass={hullPct < 30 ? "bar-fill--danger" : "bar-fill--accent"}
        valueText={`${hullPct}%`}
      />
      <div className="hud-vehicle-hint ui-hint">
        {driver ? "[W/S] drive · [A/D] steer · [Shift] brake · [E] exit" : "[E] exit"}
        {empty && driver ? " — OUT OF FUEL" : ""}
      </div>
    </div>
  );
}
