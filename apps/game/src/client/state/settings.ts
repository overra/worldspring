// Player-tunable settings, persisted to localStorage. Read by the systems
// they affect (audio engine, input controller, render quality consumers).
// Changing quality applies live (post, grass, dpr, shadows — SkyAndLighting
// reallocates the shadow map on preset change).
//
// Quality defaults to a device-detected tier (doc 08 M2): the first load
// probes the GPU/pointer/core-count once, persists the result as `tier`, and
// never re-probes. A manual Esc-menu pick sets `userOverrodeQuality` and is
// sacred — detection never runs over it. `?tier=<preset>` forces a preset for
// one session (QA) without touching the persisted choice.

import { create } from "zustand";
import { persist } from "zustand/middleware";

// "mobile" is the phone profile (doc 08 M3) — distinct from "low", which is
// the desktop fallback, so the two can diverge as knobs grow (doc 08 M5).
export type QualityPreset = "mobile" | "low" | "medium" | "high";

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

// Three edit sites must stay in sync when adding a preset: the union above,
// this table, and EscapeMenu's QUALITY_PRESETS list.
export const QUALITY_CONFIGS: Record<QualityPreset, QualityConfig> = {
  mobile: { maxDpr: 1, postFx: false, shadows: false, shadowMapSize: 1024, grassDensity: 0.25 },
  low: { maxDpr: 1, postFx: false, shadows: false, shadowMapSize: 1024, grassDensity: 0.35 },
  medium: { maxDpr: 1.5, postFx: true, shadows: true, shadowMapSize: 1024, grassDensity: 0.7 },
  high: { maxDpr: 2, postFx: true, shadows: true, shadowMapSize: 2048, grassDensity: 1 },
};

// GPU-class heuristics for detectTier(), matched against the (possibly
// masked) WEBGL_debug_renderer_info UNMASKED_RENDERER string. Deliberately
// coarse: strong = Apple silicon / discrete desktop parts; weak = mobile and
// software rasterizers (mostly already caught by the coarse-pointer check).
// Anything unrecognized — including privacy-masked strings — lands on medium.
const STRONG_GPU = /apple (m\d|gpu)|geforce|rtx\b|radeon rx|radeon pro|arc a\d/i;
const WEAK_GPU = /mali|adreno|powervr|videocore|swiftshader|llvmpipe|softpipe|software/i;

/**
 * Read the GPU renderer string from a throwaway WebGL context. Returns "" when
 * WebGL or the debug extension is unavailable (headless, privacy modes) — the
 * caller treats unknown as medium. Called at most once per profile (the result
 * feeds the persisted `tier`), so the context cost is a one-time boot expense.
 */
function probeGpuRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return renderer;
  } catch {
    return "";
  }
}

/**
 * Pick a quality tier for this device (doc 08 §1). Cheap signals only:
 * coarse pointer → mobile; weak/software GPU or tiny deviceMemory → low;
 * strong GPU with retina dpr or plenty of cores → high; everything else —
 * integrated, unknown, masked — → medium. Never throws; SSR-safe.
 */
export function detectTier(): QualityPreset {
  try {
    if (typeof window === "undefined") return "medium";
    if (window.matchMedia?.("(pointer: coarse)").matches) return "mobile";
    // deviceMemory is Chrome-only (capped at 8) — only trust the low end.
    const nav = navigator as Navigator & { deviceMemory?: number };
    if (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) return "low";
    const renderer = probeGpuRenderer();
    if (WEAK_GPU.test(renderer)) return "low";
    const dpr = window.devicePixelRatio || 1;
    const cores = nav.hardwareConcurrency ?? 0;
    if (STRONG_GPU.test(renderer) && (dpr >= 2 || cores >= 8)) return "high";
    return "medium";
  } catch {
    return "medium";
  }
}

export interface SettingsState {
  /** 0..1, applied via the audio engine's master volume. */
  masterVolume: number;
  /** Mouse-look sensitivity multiplier, 0.3..2.5. */
  sensitivity: number;
  quality: QualityPreset;
  /** Auto-detected tier, persisted after the first probe; null = never probed. */
  tier: QualityPreset | null;
  /** True once the player ever picked a quality manually — never re-detect over it. */
  userOverrodeQuality: boolean;
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

/** Parsed once at boot: `?tier=<preset>` QA override, null when absent/invalid. */
const urlTier: QualityPreset | null = (() => {
  try {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("tier");
    return raw !== null && Object.hasOwn(QUALITY_CONFIGS, raw) ? (raw as QualityPreset) : null;
  } catch {
    return null;
  }
})();

// While the URL override is active, partialize keeps persisting this
// pre-override quality so a QA session never clobbers the stored choice.
// Cleared by setQuality: a manual pick mid-session is a real choice.
let persistShadowQuality: QualityPreset | null = null;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      masterVolume: 0.9,
      sensitivity: 1,
      // Placeholder until applyTierDefaults() below resolves the real tier —
      // never seen by consumers (module eval finishes before any render).
      quality: "high",
      tier: null,
      userOverrodeQuality: false,
      showDebug: false,

      setMasterVolume: (masterVolume) => set({ masterVolume }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
      setQuality: (quality) => {
        persistShadowQuality = null;
        set({ quality, userOverrodeQuality: true });
      },
      setShowDebug: (showDebug) => set({ showDebug }),
    }),
    {
      name: "ws_settings",
      partialize: (s) => ({
        masterVolume: s.masterVolume,
        sensitivity: s.sensitivity,
        quality: persistShadowQuality ?? s.quality,
        tier: s.tier,
        userOverrodeQuality: s.userOverrodeQuality,
        showDebug: s.showDebug,
      }),
    },
  ),
);

/**
 * Resolve the boot quality (doc 08 M2). Runs once at module eval, right after
 * the store rehydrates (localStorage persist is synchronous). Precedence:
 * `?tier=` QA override (session-only) > a persisted manual choice (sacred) >
 * the persisted detected tier > a fresh probe (first load only, then persisted).
 */
function applyTierDefaults(): void {
  const s = useSettingsStore.getState();
  if (urlTier !== null) {
    persistShadowQuality = s.quality;
    useSettingsStore.setState({ quality: urlTier });
    return;
  }
  if (s.userOverrodeQuality) return;
  const tier = s.tier ?? detectTier();
  useSettingsStore.setState({ tier, quality: tier });
}
applyTierDefaults();

/** How the active quality was chosen — shown in the debug overlay. */
export function qualitySource(): "url" | "manual" | "auto" {
  if (urlTier !== null) return "url";
  return useSettingsStore.getState().userOverrodeQuality ? "manual" : "auto";
}

/** Resolved config for the current quality preset. */
export function qualityConfig(): QualityConfig {
  return QUALITY_CONFIGS[useSettingsStore.getState().quality];
}
