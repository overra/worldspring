// Preview-only testbed QA panel (doc 10 M4). Shows the active scenario set's
// checklist plus RESET (rejoin the same set) and a SET-SWITCHER (rejoin a chosen
// set) — both via connection.reprovision (a fresh-token rejoin carrying the
// gated join.scenario field). Mounts ONLY on a per-PR preview origin and never
// in prod, and the server ignores the scenario field unless env.TESTBED is on,
// so this adds no production surface. The set list + checklists come from a
// build-time glob of the on-disk sets — no server round-trip, no welcome field.

import { useState } from "react";
import { reprovision } from "@/client/net/connection";

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

/** Per-PR preview origin only (worldspring-pr-<N>.*); never prod. `?qa=0` hides it. */
function isPreviewOrigin(): boolean {
  return /^worldspring-pr-\d+(\.|$)/.test(location.hostname) && !location.search.includes("qa=0");
}

const wrapStyle: React.CSSProperties = {
  position: "fixed",
  top: 8,
  right: 8,
  zIndex: 9999,
  width: 280,
  maxHeight: "70vh",
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

export function QaPanel(): React.ReactElement | null {
  const [active, setActive] = useState(DEFAULT_SET);
  // Gate AFTER the hook so hook order is stable (the origin never changes mid-
  // session). Off-preview / ?qa=0 / no sets → never renders.
  if (!isPreviewOrigin() || SETS.length === 0) return null;

  const checklist = SETS.find((s) => s.name === active)?.checklist ?? [];

  return (
    <div style={wrapStyle}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>🧪 Testbed QA</div>
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
          title="Rejoin a fresh life with the current set (re-seeds loadout/vitals/position/fire)"
          style={{
            background: "#2a3340",
            color: "#e8e4d8",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          Reset
        </button>
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
        {checklist.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
