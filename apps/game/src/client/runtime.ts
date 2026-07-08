// Mutable per-frame game state, deliberately OUTSIDE React. The net layer
// writes here at frame rate; R3F components read from useFrame. Never put
// this data in React state — it changes 60 times a second.
//
// Ownership:
//   - input fields are written by the input controller (pointer lock + keys)
//   - clientWorld is written by the net/prediction layer only
//   - render components READ both; they never write.

import { DEFAULT_CONFIG } from "@worldspring/shared/config";
import type { ServerConfig } from "@worldspring/shared/config";
import type {
  AnimalState,
  BodyKind,
  GameEvent,
  PlayerCore,
  WireCorpse,
  WireDrop,
  WireFire,
  WireLoot,
  WirePortal,
  ZombieState,
} from "@worldspring/shared/protocol";
import type { ExploredGrid } from "@worldspring/shared/fog";
import type { ItemType } from "@worldspring/shared/items";
import type { PieceTier, PlaceRejection, PlaceTarget } from "@worldspring/shared/structures";
import type { World } from "@worldspring/shared/world";

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
  /** Mouse-look, written by the pointer-lock controller (and touch look). */
  yaw: number;
  pitch: number;
  pointerLocked: boolean;
  /** First-person vs third-person toggle (owned/read by the camera rig). */
  firstPerson: boolean;
  /** Touch device input is active: gameplay input flows without pointer lock. */
  touchMode: boolean;
  /** Analog move vector from the virtual joystick, each -1..1 (0 = none).
   * Summed with the keyboard direction in NetSystem, then clamped. */
  analogX: number;
  analogZ: number;
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
  touchMode: false,
  analogX: 0,
  analogZ: 0,
};

/**
 * Local player attack-swing animation bridge: any input surface (mouse,
 * touch button) triggers it; the camera-owned local rig reads it. Lives here
 * because both writers and the reader span ownership areas.
 */
export const localPlayerAnim = { attackUntil: 0 };

const LOCAL_ATTACK_ANIM_MS = 300;

export function triggerLocalAttackAnim(): void {
  localPlayerAnim.attackUntil = performance.now() + LOCAL_ATTACK_ANIM_MS;
}

/**
 * Render/perf stats, written by the debug collector inside the Canvas and
 * read by the DOM debug overlay. Mutable for the same reason as clientWorld.
 */
export interface DebugStats {
  fps: number;
  frameMs: number;
  /** Main-thread JS time spent inside the rAF tick (sim + camera + composer),
   * EMA-smoothed. Written by the perf splitter (perfSplitter.ts) only under
   * ?debug=1 / DEV; stays 0 otherwise. frameMs − jsMs ≈ GPU/vsync wait. */
  jsMs: number;
  /** CPU time inside gl.render across one frame's composer passes, EMA-smoothed.
   * Same ?debug-only gating as jsMs. submit dominant ⇒ submit/matrix-bound. */
  submitMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** AudioContext state + mute, e.g. "running" / "suspended" / "running/muted". */
  audio: string;
  /** performance.now() of the last R3F frame — lets DOM code (which keeps
   * running when rAF is display-throttled) detect a starved frame loop. */
  lastFrameAt: number;
}

export const debugStats: DebugStats = {
  fps: 0,
  frameMs: 0,
  jsMs: 0,
  submitMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  audio: "-",
  lastFrameAt: 0,
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
  /** Military variant (WireZombie.mil) — renders darker/wider. */
  mil: boolean;
}

export interface AnimalView {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: AnimalState;
}

/** Interpolated dynamic physics body (doc 13) — pos lerped, quat slerped. */
export interface BodyView {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  z: number;
  q: [number, number, number, number];
  /** Collider half-extents (trunks — doc 13 M2); absent for fixed-size kinds. */
  dims?: [number, number, number];
  asleep: boolean;
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
  /** Red portals in the local player's realm, within interest range. */
  portals: WirePortal[];
  /** Airdrop crates — island-wide, never interest-filtered. */
  drops: WireDrop[];
  /** Interpolated wildlife, keyed by id. */
  animals: Map<number, AnimalView>;
  /** Interpolated dynamic physics bodies (doc 13), keyed by id. */
  bodies: Map<number, BodyView>;
  /** Rain intensity 0..1, lerped between snapshots. */
  weather: number;
  /** Game-time of the interpolated state being rendered (lag comp aim time). */
  renderGameTime: number;
  /** Loot/corpse/crate id in pickup range (shared id space; prompt + E key). */
  promptLootId: number | null;
  /** doc 06 — door/gate piece id in interact range (E toggles). Only set
   * while no loot prompt wins; null otherwise. */
  promptDoorId: number | null;
  /** VFX queue: net layer pushes, render effects drain via drainEvents(). */
  events: GameEvent[];
  /** Same events, separate queue for the audio engine (drainAudioEvents). */
  audioEvents: GameEvent[];
  /** Deterministic world geometry, built from the seed in `welcome`. */
  world: World | null;
  /** Server rules, clamped from `welcome.config`. Initialized to DEFAULT_CONFIG
   * so every read path is total against an old/absent-config server. The net
   * layer ALWAYS writes clampConfig(msg.config) — never the raw object. */
  config: ServerConfig;
  /** doc 12 — fog-of-war explored set, mirrored from welcome/snap. null unless
   * the server runs map.reveal === "explored". Read-only to the map renderer. */
  explored: ExploredGrid | null;
  /** doc 13 M2 — felled tree indices (welcome.felled + per-snap deltas). The
   * Trees renderer zero-scales these instances out of the static forest. */
  felledTrees: Set<number>;
  /** Bumped whenever felledTrees changes (and on reset) so the per-frame
   * Trees check is one integer compare, not a Set diff. */
  felledVersion: number;
  /** doc 06 — bumped on every structure mutation (sFull/sAdd/sRemove/sState
   * and world rebuild) so renderers re-stamp on an integer compare. */
  structuresVersion: number;
}

export const clientWorld: ClientWorldState = {
  ready: false,
  myId: "",
  me: { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: true },
  timeOfDay: 9,
  players: new Map(),
  zombies: new Map(),
  bodies: new Map(),
  loot: [],
  corpses: [],
  fires: [],
  portals: [],
  drops: [],
  animals: new Map(),
  weather: 0,
  renderGameTime: 0,
  promptLootId: null,
  promptDoorId: null,
  events: [],
  audioEvents: [],
  world: null,
  config: DEFAULT_CONFIG,
  explored: null,
  felledTrees: new Set(),
  felledVersion: 0,
  structuresVersion: 0,
};

// --- Build mode (doc 06) ---
// Written by the BuildPreview frame loop (target/validity) and by
// InputController (kind/tier cycling, place clicks read `target`). Kept out
// of React state — the target changes at look rate.

export interface BuildRuntimeState {
  /** True while the hammer is equipped in live play (BuildPreview maintains it). */
  active: boolean;
  /** Index into PLACEABLE_KINDS — the selected piece kind. */
  kindIndex: number;
  tier: PieceTier;
  /** The snapped grid address under the crosshair, or null. */
  target: PlaceTarget | null;
  /** canPlace === null AND local resources suffice — the ghost is green. */
  valid: boolean;
  rejection: PlaceRejection | null;
}

export const buildState: BuildRuntimeState = {
  active: false,
  kindIndex: 0,
  tier: 0,
  target: null,
  valid: false,
  rejection: null,
};

// Dev-only debug handle: lets tooling (and curious humans) drive input and
// inspect the live world from the console without pointer lock.
declare global {
  interface Window {
    __game?: { inputState: InputState; clientWorld: ClientWorldState };
  }
}
const debugHooks =
  typeof window !== "undefined" &&
  (import.meta.env.DEV || window.location.search.includes("debug"));
if (debugHooks) {
  window.__game = { inputState, clientWorld };
}

// Dev-only: expose three for console profiling (tree-shaken out of prod).
if (debugHooks) {
  void import("three").then((m) => {
    (window as unknown as { __THREE?: unknown }).__THREE = m;
  });
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
  // Free the baked map canvas (doc 12); a re-join rebuilds it from the new world.
  // Dynamic import avoids a static runtime<->mapBake import cycle (mapBake reads
  // clientWorld); by reset time the module is already loaded.
  void import("./render/map/mapBake").then((m) => m.disposeBakedMap());
  clientWorld.ready = false;
  clientWorld.myId = "";
  clientWorld.players.clear();
  clientWorld.zombies.clear();
  clientWorld.bodies.clear();
  clientWorld.loot = [];
  clientWorld.corpses = [];
  clientWorld.fires = [];
  clientWorld.portals = [];
  clientWorld.drops = [];
  clientWorld.animals.clear();
  clientWorld.weather = 0;
  clientWorld.renderGameTime = 0;
  clientWorld.promptLootId = null;
  clientWorld.events = [];
  clientWorld.audioEvents = [];
  clientWorld.explored = null;
  clientWorld.felledTrees.clear();
  clientWorld.felledVersion++;
  clientWorld.promptDoorId = null;
  clientWorld.structuresVersion++;
  buildState.active = false;
  buildState.target = null;
  buildState.valid = false;
  buildState.rejection = null;
}
