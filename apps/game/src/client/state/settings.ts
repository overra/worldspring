// Player-tunable settings, persisted to localStorage. Read by the systems
// they affect (audio engine, input controller, render quality consumers).
// Changing quality applies live where cheap (post, grass, dpr) and on next
// world load where not (shadow map size).

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type QualityPreset = "low" | "medium" | "high";

export interface QualityConfig {
  /** Device pixel ratio cap passed to the Canvas. */
  maxDpr: number;
  /** Post-processing chain (AO/bloom/grade) on or off. */
  postFx: boolean;
  /** Sun shadows on/off + map resolution. */
  shadows: boolean;
  shadowMapSize: number;
  /** Grass blade density multiplier (0..1). */
  grassDensity: number;
}

export const QUALITY_CONFIGS: Record<QualityPreset, QualityConfig> = {
  low: { maxDpr: 1, postFx: false, shadows: false, shadowMapSize: 1024, grassDensity: 0.35 },
  medium: { maxDpr: 1.5, postFx: true, shadows: true, shadowMapSize: 1024, grassDensity: 0.7 },
  high: { maxDpr: 2, postFx: true, shadows: true, shadowMapSize: 2048, grassDensity: 1 },
};

export interface SettingsState {
  /** 0..1, applied via the audio engine's master volume. */
  masterVolume: number;
  /** Mouse-look sensitivity multiplier, 0.3..2.5. */
  sensitivity: number;
  quality: QualityPreset;
  /** FPS/debug overlay visibility (also toggled with F3). */
  showDebug: boolean;

  setMasterVolume(v: number): void;
  setSensitivity(v: number): void;
  setQuality(q: QualityPreset): void;
  setShowDebug(v: boolean): void;
}

// One-time migration of the pre-Worldspring settings key (dc_settings → ws_settings):
// copy the legacy value forward if the new key is unset so existing players keep their
// settings. Harmless if storage is blocked (private browsing) — we just fall to defaults.
try {
  if (localStorage.getItem("ws_settings") === null) {
    const legacy = localStorage.getItem("dc_settings");
    if (legacy !== null) localStorage.setItem("ws_settings", legacy);
  }
} catch {
  // storage unavailable — ignore
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      masterVolume: 0.9,
      sensitivity: 1,
      quality: "high",
      showDebug: false,

      setMasterVolume: (masterVolume) => set({ masterVolume }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
      setQuality: (quality) => set({ quality }),
      setShowDebug: (showDebug) => set({ showDebug }),
    }),
    { name: "ws_settings" },
  ),
);

/** Resolved config for the current quality preset. */
export function qualityConfig(): QualityConfig {
  return QUALITY_CONFIGS[useSettingsStore.getState().quality];
}
