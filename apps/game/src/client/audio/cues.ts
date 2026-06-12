// Non-positional one-shot cue entry point for UI/self sounds (eat, drink,
// bandage, campfire_place, pickup). Safe to call from anywhere (net layer,
// UI handlers) at any time — including before <AudioSystem/> mounts. Until
// the engine registers itself, cues are queued briefly; stale queued cues
// are dropped so a late-mounting engine never replays old sounds.

import type { SfxName } from "@/client/audio/manifest";

export type CueSink = (name: SfxName) => void;

const PENDING_MAX = 8;
const PENDING_TTL_MS = 500;

let sink: CueSink | null = null;
const pending: Array<{ name: SfxName; at: number }> = [];

/** Play a non-positional one-shot UI/self sound. No-ops gracefully if the
 * audio engine is not ready (queues for a short window instead). */
export function cueSound(name: SfxName): void {
  if (sink) {
    sink(name);
    return;
  }
  if (pending.length >= PENDING_MAX) pending.shift();
  pending.push({ name, at: performance.now() });
}

/** Called by the audio engine on mount/unmount. Passing a sink drains any
 * fresh queued cues into it; passing null detaches (cues queue again). */
export function registerCueSink(next: CueSink | null): void {
  sink = next;
  if (!sink) return;
  const now = performance.now();
  for (const cue of pending) {
    if (now - cue.at <= PENDING_TTL_MS) sink(cue.name);
  }
  pending.length = 0;
}
