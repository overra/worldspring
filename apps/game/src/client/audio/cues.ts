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

// An empty-mag pull opens the server's auto-reload, but the reload only shows
// up in the snapshot-mirrored channelAction after RTT + a 15 Hz snap
// (~100–150 ms) — so the call sites' "suppress while reloading" check can't
// see it yet, and rapid pulls in that window would each click on top of the
// imminent reload_start. One latch shared by desktop + touch (they never fire
// together); repeat pulls inside it stay silent.
const DRY_FIRE_LATCH_MS = 250;
let dryFireLastAt = Number.NEGATIVE_INFINITY;

/** Play the dry-fire click, at most once per latch window. */
export function cueDryFire(): void {
  const now = performance.now();
  if (now - dryFireLastAt < DRY_FIRE_LATCH_MS) return;
  dryFireLastAt = now;
  cueSound("dry_fire");
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
