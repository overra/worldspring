// Fullscreen death overlay. Mounted by App when phase === "dead";
// the socket stays open underneath so RESPAWN reuses it.

import type { ReactElement } from "react";
import { doRespawn } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import "./ui.css";

export function DeathScreen(): ReactElement {
  const deathCause = useUIStore((s) => s.deathCause);
  return (
    <div className="death-root">
      <h1 className="death-title">YOU DIED</h1>
      <p className="death-cause">killed by {deathCause ?? "the wasteland"}</p>
      <button className="death-respawn" onClick={() => doRespawn()}>
        RESPAWN
      </button>
    </div>
  );
}
