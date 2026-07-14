// Fullscreen death overlay. Mounted by App when phase === "dead";
// the socket stays open underneath so RESPAWN reuses it.
//
// The shell is engine-level — you died, something killed you, you can go again.
// What a life is worth counting in is the mode's: the body comes from its HUD
// module, and a mode with none (arena) gets the shell alone (docs/plans/00).

import type { ReactElement } from "react";
import { doRespawn } from "@/client/net/connection";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import { modeHud } from "./hud/modes/registry";
import "./ui.css";

export function DeathScreen(): ReactElement {
  const deathCause = useUIStore((s) => s.deathCause);
  const recap = useUIStore((s) => s.recap);
  // Module read, not a subscription: welcome.config lands (clamped) before App
  // can reach the dead phase and never changes mid-session — same rationale as
  // HUD's. A mode with no DeathBody, or a death with no recap, renders nothing
  // between the cause line and RESPAWN.
  const DeathBody = modeHud(clientWorld.config.mode)?.DeathBody;
  return (
    <div className="death-root">
      <h1 className="death-title">YOU DIED</h1>
      <p className="death-cause">killed by {deathCause ?? "the wasteland"}</p>
      {DeathBody !== undefined && recap !== null && <DeathBody recap={recap} />}
      <button
        className="death-respawn"
        onClick={() => doRespawn()}
      >
        RESPAWN
      </button>
    </div>
  );
}
