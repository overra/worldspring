// Per-frame net driver mounted inside <Canvas>. Samples inputState into
// InputCmds, predicts locally, batches sends, interpolates remotes, and
// computes the pickup prompt. Renders nothing.

import { useFrame } from "@react-three/fiber";
import {
  BUILD_CELL,
  INPUT_SEND_MS,
  MAX_CMDS_PER_FRAME,
  MAX_INPUT_DT,
  PICKUP_RANGE,
} from "@worldspring/shared/constants";
import { clamp, dist2D } from "@worldspring/shared/math";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import { pieceCenter } from "@worldspring/shared/structures";
import type { InputCmd, WirePiece } from "@worldspring/shared/protocol";
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
      clientWorld.promptDoorId = null;
      clientWorld.promptCrateId = null;
      ui.setPrompt(null);
      ui.setDoorPromptId(null);
      return;
    }

    // --- Build this frame's input cmds ---
    const jumpEdge = inputState.jump;
    inputState.jump = false;
    // chatOpen must be here explicitly: on desktop the pointer unlock already
    // blocks, but in touchMode there is no pointer lock to lose. codePad is a
    // modal like inventory; the crate panel deliberately is NOT — walking
    // away is its close gesture (checked below).
    const blocked =
      ui.invOpen ||
      ui.menuOpen ||
      ui.chatOpen ||
      ui.codePad !== null ||
      (!inputState.pointerLocked && !inputState.touchMode);
    let mx = 0;
    let mz = 0;
    let jump = false;
    if (!blocked) {
      // Keyboard direction + virtual joystick, clamped; stepPlayer normalizes
      // anything above unit length but preserves analog magnitudes below it.
      mx = clamp(
        (inputState.right ? 1 : 0) - (inputState.left ? 1 : 0) + inputState.analogX,
        -1,
        1,
      );
      mz = clamp(
        (inputState.back ? 1 : 0) - (inputState.forward ? 1 : 0) + inputState.analogZ,
        -1,
        1,
      );
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
    closeOutOfRangePanels(ui);
  });
  return null;
}

/**
 * doc 06 — the crate panel closes on walk-away (client-side; the server just
 * rejects out-of-range moves) and the code pad drops when its door leaves
 * interact range or vanishes. Small slack over the open range so standing at
 * the boundary doesn't flicker the panel.
 */
function closeOutOfRangePanels(ui: UIState): void {
  const world = clientWorld.world;
  if (!world) return;
  const me = clientWorld.me;
  if (ui.container !== null) {
    const piece = world.structures.pieces.get(ui.container.id);
    if (!piece) {
      ui.setContainer(null);
    } else {
      const [cx, cz] = pieceCenter(piece);
      if (dist2D(me.x, me.z, cx, cz) > PICKUP_RANGE + 0.6) ui.setContainer(null);
    }
  }
  if (ui.codePad !== null) {
    const piece = world.structures.pieces.get(ui.codePad.id);
    if (!piece) {
      ui.setCodePad(null);
    } else {
      const [cx, cz] = pieceCenter(piece);
      if (dist2D(me.x, me.z, cx, cz) > PICKUP_RANGE + 1.2) ui.setCodePad(null);
    }
  }
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
      bestLabel = (ITEM_DEFS[lootItem.type] ?? UNKNOWN_DEF).name;
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
  for (const drop of clientWorld.drops) {
    if (drop.falling) continue; // not lootable until it lands
    const d = dist2D(me.x, me.z, drop.x, drop.z);
    if (d <= bestDist) {
      bestDist = d;
      bestId = drop.id;
      bestLabel = "Supply Crate";
    }
  }
  // doc 06 — door/gate/crate prompt, only when no pickup prompt won (E
  // prioritizes loot). Realm-gated like BuildPreview: structures render (and
  // the server handlers accept) in the overworld only, so a red-realm scan
  // would prompt for something invisible whose interaction the server
  // rejects. O(pieces) scan of the shared index at frame rate is fine at the
  // 3000-piece world cap — the kind check plus the integer-grid distance
  // precheck below skip non-candidates without allocating.
  let doorId: number | null = null;
  let crateId: number | null = null;
  const world = clientWorld.world;
  if (bestId === null && world !== null && ui.realm === "overworld") {
    let pieceDist = PICKUP_RANGE + 0.6; // gates are 3m wide — a little slack
    for (const piece of world.structures.pieces.values()) {
      const isDoor = piece.kind === "door" || piece.kind === "gate";
      if (!isDoor && piece.kind !== "crate") continue;
      // pieceCenter lies within [g*BUILD_CELL, g*BUILD_CELL + BUILD_CELL] on
      // each axis — a cheap reject before the tuple-allocating center call.
      const reach = pieceDist + BUILD_CELL;
      if (
        Math.abs(piece.gx * BUILD_CELL - me.x) > reach ||
        Math.abs(piece.gz * BUILD_CELL - me.z) > reach
      ) {
        continue;
      }
      const [cx, cz] = pieceCenter(piece);
      const d = dist2D(me.x, me.z, cx, cz);
      if (d > pieceDist) continue;
      pieceDist = d;
      if (isDoor) {
        doorId = piece.id;
        crateId = null;
        // `locked` rides the wire record (M5); a door this session already
        // unlocked prompts as a plain toggle.
        const locked =
          (piece as WirePiece).locked === true && !clientWorld.unlockedDoors.has(piece.id);
        bestLabel = locked
          ? `Unlock ${piece.kind}`
          : `${piece.open === true ? "Close" : "Open"} ${piece.kind} · [L] code`;
      } else {
        crateId = piece.id;
        doorId = null;
        bestLabel = "Open storage crate";
      }
    }
  }
  clientWorld.promptLootId = bestId;
  clientWorld.promptDoorId = doorId;
  clientWorld.promptCrateId = crateId;
  ui.setDoorPromptId(doorId);
  ui.setPrompt(bestId === null && doorId === null && crateId === null ? null : bestLabel);
}
