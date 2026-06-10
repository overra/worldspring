// Title screen: name entry + join. Pure DOM over a CSS-only backdrop —
// the 3D canvas is not mounted while this is visible.

import { useState } from "react";
import type { ReactElement } from "react";
import { MAX_NAME_LENGTH } from "@/shared/constants";
import { connect } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import "./ui.css";

const NAME_STORAGE_KEY = "dc_name";

const CONTROLS_LEGEND =
  "WASD move · Shift sprint · Mouse look · LMB attack · E pick up · " +
  "1-8 hotbar · Tab inventory · G drop · V camera · Space jump";

function loadSavedName(): string {
  const saved = localStorage.getItem(NAME_STORAGE_KEY);
  return saved === null ? "" : saved.slice(0, MAX_NAME_LENGTH);
}

export function MainMenu(): ReactElement {
  const phase = useUIStore((s) => s.phase);
  const error = useUIStore((s) => s.error);
  const setPlayerName = useUIStore((s) => s.setPlayerName);
  const [name, setName] = useState(loadSavedName);

  const connecting = phase === "connecting";

  function join(): void {
    if (connecting) return;
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed.length === 0) return;
    localStorage.setItem(NAME_STORAGE_KEY, trimmed);
    setPlayerName(trimmed);
    connect(trimmed);
  }

  return (
    <div className="menu-root">
      <div className="menu-panel">
        <h1 className="menu-title">DEADCOAST</h1>
        <p className="menu-subtitle">a web survival experiment</p>
        <div className="menu-form">
          <input
            className="menu-input"
            type="text"
            placeholder="survivor name"
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            value={name}
            disabled={connecting}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") join();
            }}
          />
          <button
            className="menu-join"
            disabled={connecting || name.trim().length === 0}
            onClick={join}
          >
            {connecting ? "CONNECTING…" : "JOIN"}
          </button>
        </div>
        {error !== null && <p className="menu-error">{error}</p>}
      </div>
      <div className="menu-controls">{CONTROLS_LEGEND}</div>
    </div>
  );
}
