// Title screen: name entry + join. Pure DOM over a CSS-only backdrop —
// the 3D canvas is not mounted while this is visible.

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { DAY_DURATION_S, MAX_NAME_LENGTH } from "@worldspring/shared/constants";
import type { LeaderboardEntry } from "@worldspring/shared/protocol";
import { connect } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import "./ui.css";
import "./menu.css";

const NAME_STORAGE_KEY = "ws_name";
// Pre-Worldspring key; read as a fallback so a saved name survives the rename.
const LEGACY_NAME_KEY = "dc_name";
const LEADERBOARD_SHOWN = 5;

const CONTROLS_LEGEND: readonly (readonly [key: string, action: string])[] = [
  ["WASD", "move"],
  ["SHIFT", "sprint"],
  ["MOUSE", "look"],
  ["LMB", "attack"],
  ["R", "reload"],
  ["E", "pick up"],
  ["1-8", "hotbar"],
  ["TAB", "inventory"],
  ["G", "drop"],
  ["V", "camera"],
  ["SPACE", "jump"],
];

function loadSavedName(): string {
  // localStorage can throw in private browsing / blocked-storage contexts.
  try {
    const saved =
      localStorage.getItem(NAME_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_NAME_KEY);
    return saved === null ? "" : saved.slice(0, MAX_NAME_LENGTH);
  } catch {
    return "";
  }
}

/** Directory join flow (doc 02 §9 M6): the interstitial's opt-in
 * `?name=<urlencoded>` prefills the name input. The URL param wins over the
 * saved name (an explicit per-join choice beats stale storage); the server
 * re-runs sanitizeName at join regardless — this is convenience, not trust. */
function initialName(): string {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("name");
    if (fromQuery !== null) {
      const trimmed = fromQuery.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Malformed URL/blocked API — fall through to storage.
  }
  return loadSavedName();
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Non-fatal: the name just won't survive a reload.
  }
}

function isLeaderboardEntry(row: unknown): row is LeaderboardEntry {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.survivedS === "number" &&
    typeof r.kills === "number"
  );
}

/** Top lives fetched from /api/leaderboard. Any failure renders nothing —
 * the leaderboard is decoration, never a join blocker. */
function Leaderboard(): ReactElement | null {
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/leaderboard", { signal: ctrl.signal });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (!Array.isArray(data)) return;
        setRows(data.filter(isLeaderboardEntry).slice(0, LEADERBOARD_SHOWN));
      } catch {
        // Network error or unmount abort: keep the menu clean.
      }
    })();
    return () => ctrl.abort();
  }, []);

  if (rows.length === 0) return null;
  return (
    <div className="menu-leaderboard">
      <div className="ui-eyebrow lb-title">LONGEST LIVES</div>
      {rows.map((row, i) => (
        <div key={`${i}-${row.name}`} className="lb-row">
          <span className="lb-rank">{i + 1}</span>
          <span className="lb-name">{row.name}</span>
          <span className="lb-days">{(row.survivedS / DAY_DURATION_S).toFixed(1)}d</span>
          <span className="lb-kills">
            {row.kills} {row.kills === 1 ? "kill" : "kills"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MainMenu(): ReactElement {
  const phase = useUIStore((s) => s.phase);
  const error = useUIStore((s) => s.error);
  const setPlayerName = useUIStore((s) => s.setPlayerName);
  const [name, setName] = useState(initialName);

  const connecting = phase === "connecting";

  function join(): void {
    if (connecting) return;
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed.length === 0) return;
    saveName(trimmed);
    setPlayerName(trimmed);
    connect(trimmed);
  }

  return (
    <div className="menu-root">
      {/* The glass of the in-game HUD, before there is a world behind it: the
          title screen is the first thing anyone sees, and it has to read as the
          same material as everything after it. */}
      <div className="ui-panel ui-panel--xl menu-panel">
        <div className="menu-mark" />
        <h1 className="menu-title">Worldspring</h1>
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
            className="ui-btn ui-btn--primary ui-btn--lg menu-join"
            disabled={connecting || name.trim().length === 0}
            onClick={join}
          >
            {connecting ? "CONNECTING…" : "JOIN"}
          </button>
        </div>
        {error !== null && <p className="menu-error">{error}</p>}
        <Leaderboard />
      </div>
      <div className="menu-controls">
        <div className="menu-keys">
          {CONTROLS_LEGEND.map(([key, action]) => (
            <span key={key} className="menu-control">
              <kbd className="menu-key">{key}</kbd>
              {action}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
