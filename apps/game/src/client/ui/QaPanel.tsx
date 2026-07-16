// Preview-only testbed QA panel (doc 10 M4). Shows the active scenario set's
// checklist plus RESET (rejoin the same set) and a SET-SWITCHER (rejoin a chosen
// set) — both via connection.reprovision (a fresh-token rejoin carrying the
// gated join.scenario field). Mounts ONLY on a per-PR preview origin and never
// in prod, and the server ignores the scenario field unless env.TESTBED is on,
// so this adds no production surface. The set list + checklists come from a
// build-time glob of the on-disk sets — no server round-trip, no welcome field.

import { Fragment, useState } from "react";
import { currentScenario, reprovision } from "@/client/net/connection";

interface SetInfo {
  name: string;
  checklist: string[];
}

// Build-time manifest of apps/game/scenarios/*.json (the same files the server
// registry loads): each set's name + its human checklist.
const SETS: SetInfo[] = Object.values(
  import.meta.glob("../../../scenarios/*.json", { eager: true, import: "default" }) as Record<
    string,
    { name: string; checklist?: string[] }
  >,
)
  .map((j) => ({ name: j.name, checklist: j.checklist ?? [] }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The server defaults a fresh join to "survival" (DEFAULT_SCENARIO_NAME); mirror
// that so the panel opens showing the set the player actually landed in.
const DEFAULT_SET = SETS.find((s) => s.name === "survival")?.name ?? SETS[0]?.name ?? "survival";

/** Per-PR preview origin only (worldspring-pr-<N>.*); never prod. An explicit
 * `?qa=0` hides it — parsed exactly, so unrelated params can't false-match. */
function isPreviewOrigin(): boolean {
  return (
    /^worldspring-pr-\d+(\.|$)/.test(location.hostname) &&
    new URLSearchParams(location.search).get("qa") !== "0"
  );
}

// Parked top-LEFT, not top-right: the minimap + clock/ping stack own the whole
// top-right corner (map.css), and a 280px panel there sat squarely on top of the
// ring. The left corner is clear during play, and the panel is collapsible so it
// never blocks the view either.
const wrapStyle: React.CSSProperties = {
  position: "fixed",
  top: 8,
  left: 8,
  zIndex: 9999,
  width: 280,
  maxHeight: "calc(100vh - 16px)",
  overflowY: "auto",
  padding: "8px 10px",
  background: "rgba(12, 14, 18, 0.88)",
  color: "#e8e4d8",
  font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.15)",
  pointerEvents: "auto",
  userSelect: "none",
};

const btnStyle: React.CSSProperties = {
  background: "#2a3340",
  color: "#e8e4d8",
  border: "1px solid #555",
  borderRadius: 4,
  padding: "2px 8px",
  cursor: "pointer",
  font: "inherit",
};

// The load-bearing keys a tester needs to work any checklist. Pulled straight
// from InputController (WASD/Shift/Space movement; Tab/F/R/G/E/1-8 actions).
const CONTROLS: [string, string][] = [
  ["Move / sprint / jump", "WASD · Shift · Space"],
  ["Look (click to lock) / release", "Mouse · Esc"],
  ["Inventory", "Tab"],
  ["Use / cook / fill selected item", "F"],
  ["Attack / fire", "Left-click"],
  ["Reload · refuel a vehicle", "R"],
  ["Interact · pick up · board", "E"],
  ["Equip hotbar slot", "1–8"],
  ["Drop selected", "G"],
  ["Map (needs a map item) · chat", "M · Enter"],
];

export function QaPanel(): React.ReactElement | null {
  // Seed from the session's ACTUAL last-joined scenario, not a fixed default —
  // a reprovision does a fresh-token rejoin that remounts this panel, so a plain
  // useState(DEFAULT_SET) would snap the dropdown + checklist back to "survival"
  // even though the chosen scenario is what actually spawned (doc 10).
  const [active, setActive] = useState(() => currentScenario() ?? DEFAULT_SET);
  const [open, setOpen] = useState(true);
  // Gate AFTER the hooks so hook order is stable (the origin never changes mid-
  // session). Off-preview / ?qa=0 / no sets → never renders.
  if (!isPreviewOrigin() || SETS.length === 0) return null;

  const checklist = SETS.find((s) => s.name === active)?.checklist ?? [];

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: open ? 6 : 0 }}>
        <span style={{ fontWeight: 700, flex: 1 }}>🧪 Testbed QA</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse testbed panel" : "Expand testbed panel"}
          title={open ? "Collapse (frees the view)" : "Expand"}
          style={{ ...btnStyle, padding: "0 8px", lineHeight: "18px" }}
        >
          {open ? "–" : "+"}
        </button>
      </div>

      {open && (
        <>
          <p style={{ margin: "0 0 8px", color: "#b8b3a4" }}>
            Preview-only test harness. Pick a scenario below to respawn a fresh
            character seeded for that area, then work its checklist. Reset re-seeds
            the same scenario.
          </p>

          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            <select
              value={active}
              aria-label="Testbed scenario set"
              onChange={(e) => {
                const name = e.target.value;
                setActive(name);
                reprovision(name); // fresh-token rejoin → server re-provisions this set
              }}
              style={{
                flex: 1,
                background: "#1b1f27",
                color: "#e8e4d8",
                border: "1px solid #444",
                borderRadius: 4,
                padding: "2px 4px",
                font: "inherit",
              }}
            >
              {SETS.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => reprovision(active)}
              title="Rejoin a fresh life with the current scenario (re-seeds loadout/vitals/position/fire)"
              style={btnStyle}
            >
              Reset
            </button>
          </div>

          <ol
            style={{ margin: "0 0 8px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}
          >
            {checklist.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <details style={{ marginTop: 2 }}>
            <summary style={{ cursor: "pointer", color: "#b8b3a4" }}>Controls</summary>
            <dl
              style={{
                margin: "6px 0 0",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                columnGap: 8,
                rowGap: 2,
              }}
            >
              {CONTROLS.map(([label, keys]) => (
                <Fragment key={label}>
                  <dt style={{ color: "#b8b3a4" }}>{label}</dt>
                  <dd style={{ margin: 0, textAlign: "right", whiteSpace: "nowrap" }}>{keys}</dd>
                </Fragment>
              ))}
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
