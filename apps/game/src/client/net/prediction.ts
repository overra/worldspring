// Client-side prediction + server reconciliation. The local player is stepped
// immediately with the same shared movement code the server runs; on each
// snapshot we drop acked cmds, replay the rest from the authoritative state,
// and only overwrite the predicted position when it actually diverged.

import { stepPlayer } from "@worldspring/shared/movement";
import type { InputCmd, PlayerCore, YouState } from "@worldspring/shared/protocol";
import type { World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";

/** Corrections under 1cm are dropped to avoid micro-jitter from float drift. */
const RECONCILE_EPSILON_SQ = 0.01 * 0.01;

let seq = 0;
/** Cmds applied locally but not yet acked by the server (reconciliation replay set). */
let pending: InputCmd[] = [];
/** Cmds not yet sent to the server (drained on the INPUT_SEND_MS cadence). */
let outbox: InputCmd[] = [];

const scratch: PlayerCore = { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: false };

export function nextSeq(): number {
  seq += 1;
  return seq;
}

/** Predict locally and buffer the cmd for sending + reconciliation. */
export function applyLocalCmd(cmd: InputCmd, world: World): void {
  stepPlayer(clientWorld.me, cmd, world);
  pending.push(cmd);
  outbox.push(cmd);
}

/** Take all unsent cmds (returns the batch; internal buffer is emptied). */
export function drainOutbox(): InputCmd[] {
  if (outbox.length === 0) return outbox;
  const out = outbox;
  outbox = [];
  return out;
}

export function clearPending(): void {
  pending = [];
  outbox = [];
}

/** Fresh session (new welcome): restart sequence numbers and buffers. */
export function resetPrediction(): void {
  seq = 0;
  clearPending();
}

/**
 * Reconcile against an authoritative snapshot: drop acked cmds, replay the
 * remainder from `you` on a scratch body, and adopt the result only if it
 * differs from the current prediction by >= 1cm. Local yaw/pitch are kept.
 */
export function reconcile(ack: number, you: YouState): void {
  while (pending.length > 0 && pending[0].seq <= ack) pending.shift();
  const world = clientWorld.world;
  if (world === null) return;

  const me = clientWorld.me;
  scratch.x = you.x;
  scratch.y = you.y;
  scratch.z = you.z;
  scratch.vy = you.vy;
  scratch.grounded = you.grounded;
  scratch.yaw = me.yaw;
  scratch.pitch = me.pitch;
  for (const cmd of pending) stepPlayer(scratch, cmd, world);

  const dx = scratch.x - me.x;
  const dy = scratch.y - me.y;
  const dz = scratch.z - me.z;
  if (dx * dx + dy * dy + dz * dz < RECONCILE_EPSILON_SQ) return;

  me.x = scratch.x;
  me.y = scratch.y;
  me.z = scratch.z;
  me.vy = scratch.vy;
  me.grounded = scratch.grounded;
}
