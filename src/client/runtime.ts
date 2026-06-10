// Mutable per-frame game state, deliberately OUTSIDE React. The net layer
// writes here at frame rate; R3F components read from useFrame. Never put
// this data in React state — it changes 60 times a second.
//
// Ownership:
//   - input fields are written by the input controller (pointer lock + keys)
//   - clientWorld is written by the net/prediction layer only
//   - render components READ both; they never write.

import type {
  GameEvent,
  PlayerCore,
  WireCorpse,
  WireFire,
  WireLoot,
  ZombieState,
} from "@/shared/protocol";
import type { ItemType } from "@/shared/items";
import type { World } from "@/shared/world";

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  /** Edge-triggered: set by input, consumed (cleared) by the net layer.
   * Attack/pickup/drop/equip have no flags — InputController calls the net
   * action helpers directly in its event handlers. */
  jump: boolean;
  /** Mouse-look, written by the pointer-lock controller. */
  yaw: number;
  pitch: number;
  pointerLocked: boolean;
  /** First-person vs third-person toggle (owned/read by the camera rig). */
  firstPerson: boolean;
}

export const inputState: InputState = {
  forward: false,
  back: false,
  left: false,
  right: false,
  sprint: false,
  jump: false,
  yaw: 0,
  pitch: 0,
  pointerLocked: false,
  firstPerson: false,
};

export interface RemotePlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  item: ItemType | null;
  anim: number; // ANIM_* bit flags from protocol
}

export interface ZombieView {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: ZombieState;
}

export interface ClientWorldState {
  /** True once the welcome message arrived and `world` is built. */
  ready: boolean;
  myId: string;
  /** Predicted local player state (position fed to the camera rig). */
  me: PlayerCore;
  /** Game-time hour of day [0, 24), interpolated between snapshots. */
  timeOfDay: number;
  /** Interpolated remote entities, keyed by id. Own player is NOT in here. */
  players: Map<string, RemotePlayerView>;
  zombies: Map<number, ZombieView>;
  loot: WireLoot[];
  corpses: WireCorpse[];
  fires: WireFire[];
  /** Loot/corpse id in scavenge range (shared id space; drives prompt + E key). */
  promptLootId: number | null;
  /** VFX queue: net layer pushes, render effects drain via drainEvents(). */
  events: GameEvent[];
  /** Same events, separate queue for the audio engine (drainAudioEvents). */
  audioEvents: GameEvent[];
  /** Deterministic world geometry, built from the seed in `welcome`. */
  world: World | null;
}

export const clientWorld: ClientWorldState = {
  ready: false,
  myId: "",
  me: { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: true },
  timeOfDay: 9,
  players: new Map(),
  zombies: new Map(),
  loot: [],
  corpses: [],
  fires: [],
  promptLootId: null,
  events: [],
  audioEvents: [],
  world: null,
};

// Dev-only debug handle: lets tooling (and curious humans) drive input and
// inspect the live world from the console without pointer lock.
declare global {
  interface Window {
    __game?: { inputState: InputState; clientWorld: ClientWorldState };
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__game = { inputState, clientWorld };
}

/** Drain pending VFX events (called once per frame by the effects renderer). */
export function drainEvents(): GameEvent[] {
  if (clientWorld.events.length === 0) return clientWorld.events;
  const out = clientWorld.events;
  clientWorld.events = [];
  return out;
}

/** Drain pending audio events (called once per frame by the audio engine). */
export function drainAudioEvents(): GameEvent[] {
  if (clientWorld.audioEvents.length === 0) return clientWorld.audioEvents;
  const out = clientWorld.audioEvents;
  clientWorld.audioEvents = [];
  return out;
}

/** Reset everything on disconnect/death-respawn-menu transitions. */
export function resetClientWorld(): void {
  clientWorld.ready = false;
  clientWorld.myId = "";
  clientWorld.players.clear();
  clientWorld.zombies.clear();
  clientWorld.loot = [];
  clientWorld.corpses = [];
  clientWorld.fires = [];
  clientWorld.promptLootId = null;
  clientWorld.events = [];
  clientWorld.audioEvents = [];
}
