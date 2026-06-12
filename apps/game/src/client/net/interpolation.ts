// Snapshot interpolation for remote entities. Snapshots are buffered with
// their arrival timestamps (performance.now() timeline); every frame we render
// the world as it was INTERP_DELAY_MS ago, lerping between the two snapshots
// that bracket that moment. Loot/fires snap to the newest state on arrival;
// time-of-day advances continuously from the latest snapshot's game time.

import { DAY_DURATION_S, INTERP_DELAY_MS, START_HOUR } from "@worldspring/shared/constants";
import { angleLerp, clamp, lerp } from "@worldspring/shared/math";
import { gameHours } from "@worldspring/shared/protocol";
import type { ServerMsg, WireAnimal, WirePlayer, WireZombie } from "@worldspring/shared/protocol";
import { clientWorld } from "@/client/runtime";
import type { AnimalView, RemotePlayerView, ZombieView } from "@/client/runtime";

export type SnapMsg = Extract<ServerMsg, { t: "snap" }>;

interface BufferedSnap {
  arrival: number; // performance.now() at receipt
  /** Server game-time of this snapshot (lag compensation aim timestamps). */
  time: number;
  players: WirePlayer[];
  zombies: WireZombie[];
  animals: WireAnimal[];
  playerById: Map<string, WirePlayer>;
  zombieById: Map<number, WireZombie>;
  animalById: Map<number, WireAnimal>;
  weather: number;
}

const MAX_BUFFERED_SNAPS = 12;
const buffer: BufferedSnap[] = [];
let latestGameTime = 0;
let latestGameTimeArrival = 0;

/** Seed the continuous clock (welcome and every snap). */
export function setTimeBase(gameTimeS: number, arrivalMs: number): void {
  latestGameTime = gameTimeS;
  latestGameTimeArrival = arrivalMs;
  clientWorld.timeOfDay = gameHours(gameTimeS, DAY_DURATION_S, START_HOUR);
}

/** Buffer a snapshot and apply its instant (non-interpolated) state. */
export function pushSnap(snap: SnapMsg, arrivalMs: number): void {
  const playerById = new Map<string, WirePlayer>();
  for (const p of snap.players) playerById.set(p.id, p);
  const zombieById = new Map<number, WireZombie>();
  for (const z of snap.zombies) zombieById.set(z.id, z);
  const animalById = new Map<number, WireAnimal>();
  for (const a of snap.animals) animalById.set(a.id, a);

  buffer.push({
    arrival: arrivalMs,
    time: snap.time,
    players: snap.players,
    zombies: snap.zombies,
    animals: snap.animals,
    playerById,
    zombieById,
    animalById,
    weather: snap.weather,
  });
  if (buffer.length > MAX_BUFFERED_SNAPS) buffer.shift();

  // Loot, corpses, fires and drops are discrete — always show the newest set.
  clientWorld.loot = snap.loot;
  clientWorld.corpses = snap.corpses;
  clientWorld.fires = snap.fires;
  clientWorld.drops = snap.drops;
  setTimeBase(snap.time, arrivalMs);
}

export function resetInterpolation(): void {
  buffer.length = 0;
  latestGameTime = 0;
  latestGameTimeArrival = 0;
}

/**
 * Per-frame: advance time-of-day and write interpolated remote players and
 * zombies into clientWorld (mutating existing view objects in place).
 */
export function updateInterpolation(nowMs: number): void {
  if (latestGameTimeArrival > 0) {
    clientWorld.timeOfDay = gameHours(
      latestGameTime + (nowMs - latestGameTimeArrival) / 1000,
      DAY_DURATION_S,
      START_HOUR,
    );
  }
  if (buffer.length === 0) return;

  // Render the world INTERP_DELAY_MS in the past, clamped to the buffer so a
  // late snapshot freezes entities at the newest known state instead of
  // extrapolating.
  const renderTime = nowMs - INTERP_DELAY_MS;
  let olderIdx = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].arrival <= renderTime) {
      olderIdx = i;
      break;
    }
  }
  let a: BufferedSnap;
  let b: BufferedSnap;
  if (olderIdx === -1) {
    a = buffer[0];
    b = buffer[0];
  } else if (olderIdx === buffer.length - 1) {
    a = buffer[olderIdx];
    b = buffer[olderIdx];
  } else {
    a = buffer[olderIdx];
    b = buffer[olderIdx + 1];
  }
  const span = b.arrival - a.arrival;
  const t = span > 0 ? clamp((renderTime - a.arrival) / span, 0, 1) : 1;

  interpolatePlayers(a, b, t);
  interpolateZombies(a, b, t);
  interpolateAnimals(a, b, t);
  clientWorld.weather = lerp(a.weather, b.weather, t);
  // Game-time of the world state currently on screen — attaches to attack
  // messages so the server can rewind targets to what the shooter SAW.
  clientWorld.renderGameTime = lerp(a.time, b.time, t);
}

function interpolateAnimals(a: BufferedSnap, b: BufferedSnap, t: number): void {
  const views = clientWorld.animals;
  for (const ab of b.animals) {
    const aa = a.animalById.get(ab.id) ?? ab;
    let view: AnimalView | undefined = views.get(ab.id);
    if (view === undefined) {
      view = { id: ab.id, x: ab.x, y: ab.y, z: ab.z, yaw: ab.yaw, state: ab.state };
      views.set(ab.id, view);
    }
    view.x = lerp(aa.x, ab.x, t);
    view.y = lerp(aa.y, ab.y, t);
    view.z = lerp(aa.z, ab.z, t);
    view.yaw = angleLerp(aa.yaw, ab.yaw, t);
    view.state = ab.state;
  }
  for (const id of views.keys()) {
    if (!b.animalById.has(id)) views.delete(id);
  }
}

function interpolatePlayers(a: BufferedSnap, b: BufferedSnap, t: number): void {
  const myId = clientWorld.myId;
  const views = clientWorld.players;
  for (const pb of b.players) {
    if (pb.id === myId) continue;
    const pa = a.playerById.get(pb.id) ?? pb;
    let view: RemotePlayerView | undefined = views.get(pb.id);
    if (view === undefined) {
      view = { id: pb.id, name: pb.name, x: pb.x, y: pb.y, z: pb.z, yaw: pb.yaw, hp: pb.hp, item: pb.item, anim: pb.anim };
      views.set(pb.id, view);
    }
    view.x = lerp(pa.x, pb.x, t);
    view.y = lerp(pa.y, pb.y, t);
    view.z = lerp(pa.z, pb.z, t);
    view.yaw = angleLerp(pa.yaw, pb.yaw, t);
    view.hp = pb.hp;
    view.item = pb.item;
    view.anim = pb.anim;
    view.name = pb.name;
  }
  for (const id of views.keys()) {
    if (!b.playerById.has(id)) views.delete(id);
  }
}

function interpolateZombies(a: BufferedSnap, b: BufferedSnap, t: number): void {
  const views = clientWorld.zombies;
  for (const zb of b.zombies) {
    const za = a.zombieById.get(zb.id) ?? zb;
    let view: ZombieView | undefined = views.get(zb.id);
    if (view === undefined) {
      view = { id: zb.id, x: zb.x, y: zb.y, z: zb.z, yaw: zb.yaw, state: zb.state, mil: zb.mil };
      views.set(zb.id, view);
    }
    view.x = lerp(za.x, zb.x, t);
    view.y = lerp(za.y, zb.y, t);
    view.z = lerp(za.z, zb.z, t);
    view.yaw = angleLerp(za.yaw, zb.yaw, t);
    view.state = zb.state;
    view.mil = zb.mil;
  }
  for (const id of views.keys()) {
    if (!b.zombieById.has(id)) views.delete(id);
  }
}
