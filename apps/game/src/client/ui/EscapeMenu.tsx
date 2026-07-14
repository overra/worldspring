// Escape menu — resume/settings/leave overlay. The world does NOT pause
// (multiplayer); NetSystem already blocks gameplay input while menuOpen.
// InputController owns the opening side (pointer-lock Esc → setMenuOpen(true))
// and re-locks the pointer when the menu closes; this component only closes.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { QUALITY_CONFIGS, useSettingsStore, type QualityPreset } from "@/client/state/settings";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { disconnect, doRespawn } from "@/client/net/connection";
import { modeHud } from "./hud/modes/registry";
import "./ui.css";
import "./menu.css";

// Lightest → heaviest. Must stay in sync with the QualityPreset union and
// QUALITY_CONFIGS table in settings.ts (the three edit sites).
const QUALITY_PRESETS: QualityPreset[] = ["mobile", "low", "medium", "high"];

const SENSITIVITY_MIN = 0.3;
const SENSITIVITY_MAX = 2.5;

/** WebKit has no ::-moz-range-progress — it paints the whole runnable track —
 * so the olive filled part of a slider is a hard gradient stop that menu.css
 * reads off this custom property. Firefox ignores it and uses the pseudo. */
function sliderFill(fraction: number): CSSProperties {
  const pct = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  // React types custom properties as unknown keys; the cast is the narrowest
  // way to pass one (see QaPanel's style objects for the same idiom).
  return { "--esc-fill": `${pct}%` } as CSSProperties;
}

/** One-line summary of what a preset does, derived from QUALITY_CONFIGS. */
function qualityHint(preset: QualityPreset): string {
  const c = QUALITY_CONFIGS[preset];
  const shadows = c.shadows ? "shadows" : "no shadows";
  const post = c.postFx ? "effects" : "no effects";
  const grass =
    c.grassDensity >= 1
      ? "dense grass"
      : c.grassDensity >= 0.5
        ? "medium grass"
        : c.grassDensity >= 0.35
          ? "sparse grass"
          : "minimal grass";
  return `${preset}: ${shadows}, ${post}, ${grass}, ${c.maxDpr}x res cap`;
}

function formatClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function CloseGlyph(): ReactElement {
  return (
    <svg className="esc-close-glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

interface EscMetaProps {
  /** The mode's own readout (survival's core temp) — rendered under the clock. */
  Slot?: () => ReactElement | null;
}

/** Clock + the mode's slot, right of the title. The world clock is engine-level
 * (config.time runs in every mode); anything a mode measures goes through Slot.
 * Its own component so the world-state subscriptions only exist while the menu is
 * mounted-open — EscapeMenu itself must not re-render on every snapshot to draw
 * nothing. */
function EscMeta({ Slot }: EscMetaProps): ReactElement {
  const clockHours = useUIStore((s) => s.clockHours);
  return (
    <div className="esc-meta">
      <span className="esc-meta-row">{formatClock(clockHours)}</span>
      {Slot !== undefined && <Slot />}
    </div>
  );
}

export function EscapeMenu(): ReactElement | null {
  const menuOpen = useUIStore((s) => s.menuOpen);
  const setMenuOpen = useUIStore((s) => s.setMenuOpen);
  // Module read of the session's mode, same as HUD's — the menu itself stays
  // mode-agnostic: settings, give-up and leave belong to every mode.
  const mode = modeHud(clientWorld.config.mode);
  // Two-tap confirm for GIVE UP — it kills the character and leaves the body.
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);

  // Never carry a half-armed confirm across menu opens.
  useEffect(() => {
    if (!menuOpen) setConfirmGiveUp(false);
  }, [menuOpen]);

  const masterVolume = useSettingsStore((s) => s.masterVolume);
  const sensitivity = useSettingsStore((s) => s.sensitivity);
  const quality = useSettingsStore((s) => s.quality);
  const showDebug = useSettingsStore((s) => s.showDebug);
  const setMasterVolume = useSettingsStore((s) => s.setMasterVolume);
  const setSensitivity = useSettingsStore((s) => s.setSensitivity);
  const setQuality = useSettingsStore((s) => s.setQuality);
  const setShowDebug = useSettingsStore((s) => s.setShowDebug);

  // Esc closes while open. Registered only while open, so it never races the
  // pointer-lock Esc that opens the menu (InputController's side).
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Escape" || e.repeat) return;
      e.preventDefault();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, setMenuOpen]);

  if (!menuOpen) return null;

  const leaveGame = (): void => {
    // Clear the flag first: the App unmounts this component on phase change,
    // so a stale menuOpen would otherwise pop the menu open on the next join.
    setMenuOpen(false);
    disconnect();
  };

  return (
    <div
      className="esc-root"
      onClick={(e) => {
        // Backdrop only — clicks inside the panel land on a child.
        if (e.target === e.currentTarget) setMenuOpen(false);
      }}
    >
      {/* Window-CONTAINED (design frame 03): glass over the still-visible world,
          not a full-bleed takeover. .esc-root above is the scrim that dims it. */}
      <div className="ui-panel ui-panel--xl esc-panel">
        <div className="ui-panel-head">
          <span className="ui-eyebrow">SYSTEM</span>
          <button className="esc-close" onClick={() => setMenuOpen(false)} aria-label="Resume">
            ESC
            <CloseGlyph />
          </button>
        </div>

        <div className="esc-body">
          <div className="esc-headline">
            <div className="esc-headline-text">
              <h1 className="esc-title">PAUSED</h1>
              <p className="esc-subtitle">the world keeps moving</p>
            </div>
            <EscMeta Slot={mode?.EscSlot} />
          </div>

          {/* The one hero CTA on the surface — everything else here is a hairline. */}
          <button
            className="ui-btn ui-btn--primary ui-btn--lg esc-resume"
            onClick={() => setMenuOpen(false)}
          >
            RESUME
          </button>

          <div className="esc-settings">
            <span className="ui-eyebrow esc-section-label">SETTINGS</span>

            <div className="esc-row">
              <span className="esc-label">MASTER VOLUME</span>
              <input
                className="esc-slider"
                style={sliderFill(masterVolume)}
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(masterVolume * 100)}
                onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
              />
              <span className="esc-value">{Math.round(masterVolume * 100)}%</span>
            </div>

            <div className="esc-row">
              <span className="esc-label">SENSITIVITY</span>
              <input
                className="esc-slider"
                style={sliderFill(
                  (sensitivity - SENSITIVITY_MIN) / (SENSITIVITY_MAX - SENSITIVITY_MIN),
                )}
                type="range"
                min={SENSITIVITY_MIN}
                max={SENSITIVITY_MAX}
                step={0.05}
                value={sensitivity}
                onChange={(e) => setSensitivity(Number(e.target.value))}
              />
              <span className="esc-value">{sensitivity.toFixed(2)}×</span>
            </div>

            <div className="esc-row esc-row--stack">
              <span className="esc-label">QUALITY</span>
              <div className="esc-seg">
                {QUALITY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={
                      preset === quality ? "esc-seg-btn esc-seg-btn--active" : "esc-seg-btn"
                    }
                    onClick={() => setQuality(preset)}
                  >
                    {preset.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="esc-hint">{qualityHint(quality)}</div>

            <div className="esc-row">
              <span className="esc-label">DEBUG OVERLAY</span>
              <label className="esc-check">
                <input
                  className="esc-toggle"
                  type="checkbox"
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                />
                show fps / render stats
                <span className="menu-key">F3</span>
              </label>
            </div>
          </div>

          <div className="esc-footer">
            {/* doc 06 griefing policy: respawn is ALWAYS available — the escape
                hatch for a walled-in player until structure damage ships. The
                server treats a living player's respawn request as a give-up
                (die in place, body + inventory stay). */}
            <button
              className={
                confirmGiveUp
                  ? "ui-btn ui-btn--warn esc-footer-btn esc-footer-btn--armed"
                  : "ui-btn ui-btn--warn esc-footer-btn"
              }
              onClick={() => {
                if (!confirmGiveUp) {
                  setConfirmGiveUp(true);
                  return;
                }
                setConfirmGiveUp(false);
                setMenuOpen(false);
                doRespawn();
              }}
            >
              {confirmGiveUp ? "REALLY GIVE UP?" : "GIVE UP"}
              <span className="esc-btn-note">
                {confirmGiveUp ? "(you die here)" : "(respawn)"}
              </span>
            </button>

            <button className="ui-btn ui-btn--danger esc-footer-btn" onClick={leaveGame}>
              LEAVE GAME
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
