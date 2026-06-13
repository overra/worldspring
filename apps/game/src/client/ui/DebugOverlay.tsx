// F3 debug overlay: perf stats (from the mutable debugStats object filled by
// DebugCollector inside the Canvas), net ping, player position, time of day
// and entity counts. Pure DOM, pointer-events none.
//
// debugStats/clientWorld change at frame rate, so they are NOT subscribed to —
// a 250ms interval copies a snapshot into local React state, which is cheap
// at UI rate. The F3 listener is registered whenever this component is
// mounted (App mounts it for the playing/dead phases).

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { clientWorld, debugStats } from "@/client/runtime";
import { useSettingsStore } from "@/client/state/settings";
import { useUIStore } from "@/client/state/store";
import "./debug.css";

const REFRESH_MS = 250;

interface DebugSnapshot {
  fps: number;
  frameMs: number;
  jsMs: number;
  submitMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  audio: string;
  x: number;
  z: number;
  yaw: number;
  timeOfDay: number;
  players: number;
  zombies: number;
  loot: number;
  corpses: number;
  fires: number;
}

function takeSnapshot(): DebugSnapshot {
  return {
    fps: debugStats.fps,
    frameMs: debugStats.frameMs,
    jsMs: debugStats.jsMs,
    submitMs: debugStats.submitMs,
    drawCalls: debugStats.drawCalls,
    triangles: debugStats.triangles,
    geometries: debugStats.geometries,
    textures: debugStats.textures,
    audio: debugStats.audio,
    x: clientWorld.me.x,
    z: clientWorld.me.z,
    yaw: clientWorld.me.yaw,
    timeOfDay: clientWorld.timeOfDay,
    players: clientWorld.players.size,
    zombies: clientWorld.zombies.size,
    loot: clientWorld.loot.length,
    corpses: clientWorld.corpses.length,
    fires: clientWorld.fires.length,
  };
}

function formatClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps): ReactElement {
  return (
    <div className="debug-row">
      <span className="debug-label">{label}</span>
      <span className="debug-value">{value}</span>
    </div>
  );
}

export function DebugOverlay(): ReactElement | null {
  const showDebug = useSettingsStore((s) => s.showDebug);
  const pingMs = useUIStore((s) => s.pingMs);
  const [snap, setSnap] = useState<DebugSnapshot>(takeSnapshot);

  // F3 toggle — always registered while mounted (playing/dead phases), even
  // when the panel itself is hidden. preventDefault stops the browser
  // search-bar focus some setups bind to F3.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "F3") return;
      e.preventDefault();
      const settings = useSettingsStore.getState();
      settings.setShowDebug(!settings.showDebug);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sample the mutable runtime objects at UI rate while visible.
  useEffect(() => {
    if (!showDebug) return;
    setSnap(takeSnapshot());
    const id = window.setInterval(() => setSnap(takeSnapshot()), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [showDebug]);

  if (!showDebug) return null;

  return (
    <div className="debug-overlay">
      <Row label="fps" value={`${snap.fps} (${snap.frameMs.toFixed(1)} ms)`} />
      {snap.jsMs > 0 && (
        <Row
          label="js/submit"
          value={`${snap.jsMs.toFixed(1)} / ${snap.submitMs.toFixed(1)} ms`}
        />
      )}
      <Row label="draws" value={String(snap.drawCalls)} />
      <Row label="tris" value={`${(snap.triangles / 1000).toFixed(1)}k`} />
      <Row label="geo/tex" value={`${snap.geometries}/${snap.textures}`} />
      <Row label="ping" value={`${pingMs} ms`} />
      <Row label="audio" value={snap.audio} />
      <Row
        label="pos"
        value={`${snap.x.toFixed(1)}, ${snap.z.toFixed(1)} @ ${snap.yaw.toFixed(1)}`}
      />
      <Row label="time" value={formatClock(snap.timeOfDay)} />
      <Row
        label="ents"
        value={`p${snap.players} z${snap.zombies} l${snap.loot} c${snap.corpses} f${snap.fires}`}
      />
    </div>
  );
}
