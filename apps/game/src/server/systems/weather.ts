// Two-state weather machine on game time: clear <-> raining, with
// state.weather ramping smoothly toward the target intensity (the client
// renders rain density/fog straight from the ramped value, so fronts fade in
// rather than popping). Transitions are announced exactly once via a notice.

import {
  WEATHER_CLEAR_MAX_S,
  WEATHER_CLEAR_MIN_S,
  WEATHER_RAIN_MAX_S,
  WEATHER_RAIN_MIN_S,
  WEATHER_RAMP_S,
} from "@worldspring/shared/constants";
import { broadcast, type GameState } from "./state";

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Game-time of the next flip, from the phase we just entered. */
function nextFlipAt(state: GameState): number {
  return (
    state.time +
    (state.weatherRaining
      ? randBetween(WEATHER_RAIN_MIN_S, WEATHER_RAIN_MAX_S)
      : randBetween(WEATHER_CLEAR_MIN_S, WEATHER_CLEAR_MAX_S))
  );
}

export function tickWeather(state: GameState, dt: number): void {
  // First tick ever (or pre-weather persisted worlds): schedule the first
  // front from a clear sky. weatherNextAt === 0 is the uninitialized marker.
  if (state.weatherNextAt === 0) {
    state.weatherRaining = false;
    state.weatherNextAt = nextFlipAt(state);
  }

  if (state.time >= state.weatherNextAt) {
    state.weatherRaining = !state.weatherRaining;
    state.weatherNextAt = nextFlipAt(state);
    broadcast(state, {
      t: "notice",
      msg: state.weatherRaining ? "rain rolling in" : "the rain is clearing",
    });
  }

  // Ramp intensity toward the phase target at 1/WEATHER_RAMP_S per second.
  const target = state.weatherRaining ? 1 : 0;
  const step = dt / WEATHER_RAMP_S;
  if (state.weather < target) {
    state.weather = Math.min(target, state.weather + step);
  } else if (state.weather > target) {
    state.weather = Math.max(target, state.weather - step);
  }
}
