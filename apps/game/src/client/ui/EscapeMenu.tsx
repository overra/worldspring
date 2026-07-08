// Escape menu — resume/settings/leave overlay. The world does NOT pause
// (multiplayer); NetSystem already blocks gameplay input while menuOpen.
// InputController owns the opening side (pointer-lock Esc → setMenuOpen(true))
// and re-locks the pointer when the menu closes; this component only closes.

import { useEffect, useState } from "react";
import { QUALITY_CONFIGS, useSettingsStore, type QualityPreset } from "@/client/state/settings";
import { useUIStore } from "@/client/state/store";
import { disconnect, doRespawn } from "@/client/net/connection";
import "./menu.css";

// Lightest → heaviest. Must stay in sync with the QualityPreset union and
// QUALITY_CONFIGS table in settings.ts (the three edit sites).
const QUALITY_PRESETS: QualityPreset[] = ["mobile", "low", "medium", "high"];

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

export function EscapeMenu(): React.ReactElement | null {
  const menuOpen = useUIStore((s) => s.menuOpen);
  const setMenuOpen = useUIStore((s) => s.setMenuOpen);
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
      <div className="esc-panel">
        <h1 className="esc-title">PAUSED</h1>
        <p className="esc-subtitle">the world keeps moving</p>

        <button className="esc-btn esc-btn--resume" onClick={() => setMenuOpen(false)}>
          RESUME
        </button>

        <div className="esc-settings">
          <div className="esc-section-label">SETTINGS</div>

          <div className="esc-row">
            <span className="esc-label">MASTER VOLUME</span>
            <input
              className="esc-slider"
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
              type="range"
              min={0.3}
              max={2.5}
              step={0.05}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
            />
            <span className="esc-value">{sensitivity.toFixed(2)}×</span>
          </div>

          <div className="esc-row">
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
                type="checkbox"
                checked={showDebug}
                onChange={(e) => setShowDebug(e.target.checked)}
              />
              show fps / render stats
              <span className="esc-check-hint">F3</span>
            </label>
          </div>
        </div>

        {/* doc 06 griefing policy: respawn is ALWAYS available — the escape
            hatch for a walled-in player until structure damage ships. The
            server treats a living player's respawn request as a give-up
            (die in place, body + inventory stay). */}
        <button
          className="esc-btn esc-btn--leave"
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
          {confirmGiveUp ? "REALLY GIVE UP? (you die here)" : "GIVE UP (respawn)"}
        </button>

        <button className="esc-btn esc-btn--leave" onClick={leaveGame}>
          LEAVE GAME
        </button>
      </div>
    </div>
  );
}
