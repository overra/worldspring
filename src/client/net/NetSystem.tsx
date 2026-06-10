// Per-frame net driver mounted inside <Canvas>. Samples inputState into
// InputCmds, predicts locally, batches sends, interpolates remotes, and
// computes the pickup prompt. Renders nothing.

import { useFrame } from "@react-three/fiber";
import {
  INPUT_SEND_MS,
  MAX_CMDS_PER_FRAME,
  MAX_INPUT_DT,
  PICKUP_RANGE,
} from "@/shared/constants";
import { clamp, dist2D } from "@/shared/math";
import { ITEM_DEFS } from "@/shared/items";
import type { InputCmd } from "@/shared/protocol";
import { clientWorld, inputState } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import type { UIState } from "@/client/state/store";
import { sendMsg } from "./connection";
import { applyLocalCmd, drainOutbox, nextSeq } from "./prediction";
import { updateInterpolation } from "./interpolation";

let lastSendMs = 0;

export function NetSystem(): null {
  useFrame((_, delta) => {
    const world = clientWorld.world;
    if (!clientWorld.ready || world === null) return;

    const ui = useUIStore.getState();
    const phase = ui.phase;
    if (phase !== "playing" && phase !== "dead") return;

    const now = performance.now();
    updateInterpolation(now);

    if (phase === "dead") {
      // Death cam: remotes keep interpolating, but no input cmds and no
      // pickup prompt. Consume the jump edge so it can't fire on respawn.
      inputState.jump = false;
      clientWorld.promptLootId = null;
      ui.setPrompt(null);
      return;
    }

    // --- Build this frame's input cmds ---
    const jumpEdge = inputState.jump;
    inputState.jump = false;
    const blocked = !inputState.pointerLocked || ui.invOpen;
    let mx = 0;
    let mz = 0;
    let jump = false;
    if (!blocked) {
      mx = (inputState.right ? 1 : 0) - (inputState.left ? 1 : 0);
      mz = (inputState.back ? 1 : 0) - (inputState.forward ? 1 : 0);
      jump = jumpEdge;
    }
    // A long frame becomes several sub-cmds of at most MAX_INPUT_DT each, so
    // low-FPS clients keep full authoritative movement speed. Beyond the cap
    // the remainder is dropped (matches the server's input-budget burst).
    let remaining = clamp(delta, 0.001, MAX_INPUT_DT * MAX_CMDS_PER_FRAME);
    let first = true;
    while (remaining > 0) {
      const dt = Math.min(remaining, MAX_INPUT_DT);
      remaining -= dt;
      const cmd: InputCmd = {
        seq: nextSeq(),
        dt,
        mx,
        mz,
        yaw: inputState.yaw,
        pitch: inputState.pitch,
        sprint: inputState.sprint,
        jump: jump && first,
      };
      applyLocalCmd(cmd, world);
      first = false;
    }

    // --- Batched send ---
    if (now - lastSendMs >= INPUT_SEND_MS) {
      lastSendMs = now;
      const cmds = drainOutbox();
      if (cmds.length > 0) sendMsg({ t: "input", cmds });
    }

    updatePrompt(ui);
  });
  return null;
}

/**
 * Nearest loot item or scavengeable corpse within pickup range drives
 * promptLootId + the HUD prompt (loot and corpses share the id space).
 */
function updatePrompt(ui: UIState): void {
  const me = clientWorld.me;
  let bestId: number | null = null;
  let bestLabel = "";
  let bestDist = PICKUP_RANGE;
  for (const lootItem of clientWorld.loot) {
    const d = dist2D(me.x, me.z, lootItem.x, lootItem.z);
    if (d <= bestDist) {
      bestDist = d;
      bestId = lootItem.id;
      bestLabel = ITEM_DEFS[lootItem.type].name;
    }
  }
  for (const corpse of clientWorld.corpses) {
    if (corpse.items === 0) continue; // picked clean — body stays, prompt goes
    const d = dist2D(me.x, me.z, corpse.x, corpse.z);
    if (d <= bestDist) {
      bestDist = d;
      bestId = corpse.id;
      bestLabel = corpse.kind === "player" ? `Scavenge ${corpse.name ?? "body"}` : "Scavenge corpse";
    }
  }
  clientWorld.promptLootId = bestId;
  ui.setPrompt(bestId === null ? null : bestLabel);
}
