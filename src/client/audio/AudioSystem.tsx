// AudioSystem — three.js audio engine on top of the R3F scene.
//
// Owns a module-level engine singleton (survives remounts; the buffer cache
// and mute state persist). Mounted inside <Canvas>. All sound files may be
// missing on disk (generated in parallel) — every load failure is caught,
// warned once, and the sound is treated as silent. Nothing here ever throws
// at the call site and nothing runs through React state at frame rate.

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SFX_FILES, type SfxName } from "@/client/audio/manifest";
import { registerCueSink } from "@/client/audio/cues";
import { clientWorld, drainAudioEvents, type ZombieView } from "@/client/runtime";
import { useSettingsStore } from "@/client/state/settings";
import { useUIStore } from "@/client/state/store";
import { TEMP_SHIVER } from "@/shared/constants";
import type { GameEvent, WireFire, ZombieState } from "@/shared/protocol";

// --- Presentation tunables (audio polish, not gameplay) ---

const POSITIONAL_POOL_SIZE = 16;
const FLAT_POOL_SIZE = 8;
const DEFAULT_REF_DISTANCE = 8;
const ROLLOFF_FACTOR = 1.4;

const SHOT_FAR_DISTANCE = 120;
const SHOT_FAR_REF_DISTANCE = 30;
const HIT_FLESH_RADIUS = 1.5;

const STEP_STRIDE_M = 2.3;
const STEP_VOLUME = 0.35;
const STEP_MIN_FRAME_DIST = 1e-4;
const TELEPORT_DIST = 5;

const VOCAL_RANGE = 45;
const VOCAL_MIN_GAP_S = 2.5;
const VOCAL_JITTER_S = 2.5;
const ZOMBIE_ATTACK_SOUND_GAP_S = 1.2;

const FIRE_RANGE = 40;
const MAX_FIRE_LOOPS = 6;
const FIRE_REF_DISTANCE = 5;
const FIRE_VOLUME = 0.55;

const AMBIENT_FADE_S = 2;
const WIND_VOLUME = 0.22;
const WAVES_VOLUME = 0.45;
const WAVES_FULL_BELOW = 1.5;
const WAVES_SILENT_ABOVE = 6;
const CRICKETS_VOLUME = 0.3;
const HEARTBEAT_VOLUME = 0.5;
const HEARTBEAT_HP_BELOW = 25;

const CUE_VOLUMES: Partial<Record<SfxName, number>> = {
  eat: 0.6,
  drink: 0.6,
  bandage: 0.55,
  campfire_place: 0.7,
  pickup: 0.5,
};
const CUE_DEFAULT_VOLUME = 0.6;

// --- Engine singleton ---

interface PooledPositional {
  node: THREE.PositionalAudio;
  startedAt: number;
}

interface PooledFlat {
  node: THREE.Audio;
  startedAt: number;
}

interface AmbientLoop {
  node: THREE.Audio;
  volume: number;
}

interface Engine {
  listener: THREE.AudioListener;
  group: THREE.Group;
  loader: THREE.AudioLoader;
  buffers: Map<SfxName, AudioBuffer>;
  loading: Set<SfxName>;
  failed: Set<SfxName>;
  positional: PooledPositional[];
  flat: PooledFlat[];
  fireNodes: Map<number, THREE.PositionalAudio>;
  fireFree: THREE.PositionalAudio[];
  ambient: Map<SfxName, AmbientLoop>;
  unlocked: boolean;
  muted: boolean;
  stepAccum: number;
  prevX: number;
  prevZ: number;
  stepToggle: boolean;
  hurtToggle: boolean;
  vocalNextAt: number;
  zombiePrevState: Map<number, ZombieState>;
  zombieAttackLastAt: Map<number, number>;
  lcg: number;
}

let engineSingleton: Engine | null = null;

function getEngine(): Engine {
  if (engineSingleton) return engineSingleton;
  engineSingleton = createEngine();
  return engineSingleton;
}

function createEngine(): Engine {
  const listener = new THREE.AudioListener();
  listener.setMasterVolume(useSettingsStore.getState().masterVolume);

  const group = new THREE.Group();
  group.name = "audio-positional-pool";

  const positional: PooledPositional[] = [];
  for (let i = 0; i < POSITIONAL_POOL_SIZE; i++) {
    const node = new THREE.PositionalAudio(listener);
    node.setRefDistance(DEFAULT_REF_DISTANCE);
    node.setRolloffFactor(ROLLOFF_FACTOR);
    group.add(node);
    positional.push({ node, startedAt: 0 });
  }

  const flat: PooledFlat[] = [];
  for (let i = 0; i < FLAT_POOL_SIZE; i++) {
    flat.push({ node: new THREE.Audio(listener), startedAt: 0 });
  }

  return {
    listener,
    group,
    loader: new THREE.AudioLoader(),
    buffers: new Map(),
    loading: new Set(),
    failed: new Set(),
    positional,
    flat,
    fireNodes: new Map(),
    fireFree: [],
    ambient: new Map(),
    unlocked: false,
    muted: false,
    stepAccum: 0,
    prevX: Number.NaN,
    prevZ: Number.NaN,
    stepToggle: false,
    hurtToggle: false,
    vocalNextAt: 0,
    zombiePrevState: new Map(),
    zombieAttackLastAt: new Map(),
    lcg: 0x2f6e2b1,
  };
}

function nowSec(): number {
  return performance.now() / 1000;
}

function lcg01(engine: Engine): number {
  engine.lcg = (engine.lcg * 1664525 + 1013904223) >>> 0;
  return engine.lcg / 4294967296;
}

// --- Buffer cache (lazy, missing files tolerated) ---

function requestBuffer(engine: Engine, name: SfxName): AudioBuffer | null {
  const cached = engine.buffers.get(name);
  if (cached) return cached;
  if (engine.failed.has(name) || engine.loading.has(name)) return null;

  engine.loading.add(name);
  const url = SFX_FILES[name];
  const fail = (err?: unknown): void => {
    engine.loading.delete(name);
    if (engine.failed.has(name)) return;
    engine.failed.add(name);
    console.warn(`[audio] could not load "${url}" — "${name}" will be silent`, err ?? "");
  };
  try {
    engine.loader.load(
      url,
      (buffer) => {
        engine.loading.delete(name);
        engine.buffers.set(name, buffer);
      },
      undefined,
      fail,
    );
  } catch (err) {
    fail(err);
  }
  return null;
}

function warmup(engine: Engine): void {
  for (const name of Object.keys(SFX_FILES) as SfxName[]) {
    requestBuffer(engine, name);
  }
}

function markUnlocked(engine: Engine): void {
  if (engine.unlocked) return;
  engine.unlocked = true;
  warmup(engine);
}

// --- Playback primitives ---

function playFlat(engine: Engine, name: SfxName, volume: number): void {
  const buffer = requestBuffer(engine, name);
  if (!buffer || !engine.unlocked) return;

  let slot = engine.flat.find((s) => !s.node.isPlaying);
  if (!slot) {
    slot = engine.flat[0];
    for (const s of engine.flat) if (s.startedAt < slot.startedAt) slot = s;
    if (slot.node.isPlaying) slot.node.stop();
  }
  slot.node.setBuffer(buffer);
  slot.node.setLoop(false);
  slot.node.setVolume(volume);
  slot.node.play();
  slot.startedAt = nowSec();
}

function playPositional(
  engine: Engine,
  name: SfxName,
  x: number,
  y: number,
  z: number,
  volume: number,
  refDistance: number = DEFAULT_REF_DISTANCE,
): void {
  const buffer = requestBuffer(engine, name);
  if (!buffer || !engine.unlocked) return;

  let slot = engine.positional.find((s) => !s.node.isPlaying);
  if (!slot) {
    slot = engine.positional[0];
    for (const s of engine.positional) if (s.startedAt < slot.startedAt) slot = s;
    if (slot.node.isPlaying) slot.node.stop();
  }
  const node = slot.node;
  node.position.set(x, y, z);
  node.setRefDistance(refDistance);
  node.setBuffer(buffer);
  node.setLoop(false);
  node.setVolume(volume);
  node.play();
  slot.startedAt = nowSec();
}

// --- Game events ---

function fleshNear(x: number, y: number, z: number): boolean {
  const r2 = HIT_FLESH_RADIUS * HIT_FLESH_RADIUS;
  for (const zb of clientWorld.zombies.values()) {
    const dx = zb.x - x;
    const dz = zb.z - z;
    if (dx * dx + dz * dz <= r2 && Math.abs(zb.y - y) <= 2.5) return true;
  }
  for (const p of clientWorld.players.values()) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz <= r2 && Math.abs(p.y - y) <= 2.5) return true;
  }
  return false;
}

function processEvents(engine: Engine, events: GameEvent[], cam: THREE.Vector3): void {
  for (const ev of events) {
    switch (ev.e) {
      case "shot": {
        const dist = Math.hypot(ev.sx - cam.x, ev.sy - cam.y, ev.sz - cam.z);
        if (dist > SHOT_FAR_DISTANCE) {
          playPositional(engine, "shot_far", ev.sx, ev.sy, ev.sz, 0.85, SHOT_FAR_REF_DISTANCE);
        } else {
          playPositional(engine, "shot", ev.sx, ev.sy, ev.sz, 0.9);
        }
        break;
      }
      case "hit": {
        const name: SfxName = fleshNear(ev.x, ev.y, ev.z) ? "hit_flesh" : "hit_thud";
        playPositional(engine, name, ev.x, ev.y, ev.z, 0.7);
        break;
      }
      case "swing": {
        if (ev.id === clientWorld.myId) {
          playFlat(engine, "swing", 0.5);
          break;
        }
        const p = clientWorld.players.get(ev.id);
        if (p) playPositional(engine, "swing", p.x, p.y + 1.3, p.z, 0.6);
        break;
      }
      case "zdie": {
        playPositional(engine, "zombie_die", ev.x, ev.y + 1, ev.z, 0.8);
        break;
      }
      case "hurt": {
        playFlat(engine, engine.hurtToggle ? "hurt2" : "hurt1", 0.65);
        engine.hurtToggle = !engine.hurtToggle;
        break;
      }
    }
  }
}

// --- Footsteps ---

function updateFootsteps(engine: Engine): void {
  const me = clientWorld.me;
  const dx = me.x - engine.prevX;
  const dz = me.z - engine.prevZ;
  engine.prevX = me.x;
  engine.prevZ = me.z;

  const dist = Math.hypot(dx, dz);
  if (!Number.isFinite(dist) || dist > TELEPORT_DIST) {
    engine.stepAccum = 0;
    return;
  }
  if (!me.grounded || dist < STEP_MIN_FRAME_DIST) {
    engine.stepAccum = 0;
    return;
  }
  engine.stepAccum += dist;
  if (engine.stepAccum < STEP_STRIDE_M) return;
  engine.stepAccum -= STEP_STRIDE_M;
  playFlat(engine, engine.stepToggle ? "step_grass2" : "step_grass1", STEP_VOLUME);
  engine.stepToggle = !engine.stepToggle;
}

// --- Zombies: state transitions + ambient vocalizations ---

function updateZombieStates(engine: Engine, now: number): void {
  const zombies = clientWorld.zombies;
  for (const [id, zb] of zombies) {
    const prev = engine.zombiePrevState.get(id);
    if ((prev === "idle" || prev === "wander") && zb.state === "chase") {
      playPositional(engine, "zombie_aggro", zb.x, zb.y + 1.4, zb.z, 0.85);
    }
    if (zb.state === "attack") {
      const last = engine.zombieAttackLastAt.get(id) ?? Number.NEGATIVE_INFINITY;
      if (now - last >= ZOMBIE_ATTACK_SOUND_GAP_S) {
        engine.zombieAttackLastAt.set(id, now);
        playPositional(engine, "zombie_attack", zb.x, zb.y + 1.4, zb.z, 0.8);
      }
    }
    engine.zombiePrevState.set(id, zb.state);
  }
  if (engine.zombiePrevState.size > zombies.size) {
    for (const id of engine.zombiePrevState.keys()) {
      if (zombies.has(id)) continue;
      engine.zombiePrevState.delete(id);
      engine.zombieAttackLastAt.delete(id);
    }
  }
}

function updateVocalizations(engine: Engine, now: number, cam: THREE.Vector3): void {
  if (engine.vocalNextAt === 0) {
    engine.vocalNextAt = now + VOCAL_MIN_GAP_S + lcg01(engine) * VOCAL_JITTER_S;
    return;
  }
  if (now < engine.vocalNextAt) return;
  engine.vocalNextAt = now + VOCAL_MIN_GAP_S + lcg01(engine) * VOCAL_JITTER_S;

  const r2 = VOCAL_RANGE * VOCAL_RANGE;
  const candidates: ZombieView[] = [];
  for (const zb of clientWorld.zombies.values()) {
    const dx = zb.x - cam.x;
    const dy = zb.y - cam.y;
    const dz = zb.z - cam.z;
    if (dx * dx + dy * dy + dz * dz <= r2) candidates.push(zb);
  }
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(lcg01(engine) * candidates.length) % candidates.length];
  const name: SfxName = lcg01(engine) < 0.5 ? "zombie_idle1" : "zombie_idle2";
  playPositional(engine, name, pick.x, pick.y + 1.2, pick.z, 0.7);
}

// --- Campfire loops ---

function createFireNode(engine: Engine): THREE.PositionalAudio {
  const node = new THREE.PositionalAudio(engine.listener);
  node.setRefDistance(FIRE_REF_DISTANCE);
  node.setRolloffFactor(ROLLOFF_FACTOR);
  node.setLoop(true);
  engine.group.add(node);
  return node;
}

function updateFires(engine: Engine, cam: THREE.Vector3): void {
  const nearby: Array<{ fire: WireFire; d2: number }> = [];
  const r2 = FIRE_RANGE * FIRE_RANGE;
  for (const fire of clientWorld.fires) {
    const dx = fire.x - cam.x;
    const dy = fire.y - cam.y;
    const dz = fire.z - cam.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= r2) nearby.push({ fire, d2 });
  }
  nearby.sort((a, b) => a.d2 - b.d2);
  const active = nearby.slice(0, MAX_FIRE_LOOPS);

  for (const [id, node] of engine.fireNodes) {
    if (active.some((entry) => entry.fire.id === id)) continue;
    if (node.isPlaying) node.stop();
    engine.fireNodes.delete(id);
    engine.fireFree.push(node);
  }

  for (const { fire } of active) {
    const existing = engine.fireNodes.get(fire.id);
    if (existing) {
      existing.position.set(fire.x, fire.y + 0.4, fire.z);
      continue;
    }
    if (!engine.unlocked) continue;
    const buffer = requestBuffer(engine, "fire_loop");
    if (!buffer) continue;
    const node = engine.fireFree.pop() ?? createFireNode(engine);
    node.position.set(fire.x, fire.y + 0.4, fire.z);
    if (node.buffer !== buffer) node.setBuffer(buffer);
    node.setVolume(FIRE_VOLUME);
    node.play();
    engine.fireNodes.set(fire.id, node);
  }
}

// --- Ambience (non-positional gain-faded loops) ---

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 1 deep in the night window (21–5), 0 in the day, linear ramps near the edges. */
function nightFactor(tod: number): number {
  if (tod >= 21 || tod < 4.5) return 1;
  if (tod >= 20.5) return (tod - 20.5) / 0.5;
  if (tod < 5) return (5 - tod) / 0.5;
  return 0;
}

function setAmbientTarget(engine: Engine, name: SfxName, target: number, dt: number): void {
  let loop = engine.ambient.get(name);
  if (!loop) {
    const node = new THREE.Audio(engine.listener);
    node.setLoop(true);
    loop = { node, volume: 0 };
    engine.ambient.set(name, loop);
  }
  const step = dt / AMBIENT_FADE_S;
  const diff = target - loop.volume;
  loop.volume += Math.max(-step, Math.min(step, diff));

  if (!loop.node.isPlaying) {
    if (target <= 0.001 || !engine.unlocked) return;
    const buffer = requestBuffer(engine, name);
    if (!buffer) return;
    if (loop.node.buffer !== buffer) loop.node.setBuffer(buffer);
    loop.node.setVolume(loop.volume);
    loop.node.play();
    return;
  }
  loop.node.setVolume(loop.volume);
}

function updateAmbience(engine: Engine, dt: number): void {
  const ui = useUIStore.getState();
  const me = clientWorld.me;
  const world = clientWorld.world;

  let waves = 0;
  if (world) {
    const h = world.heightAt(me.x, me.z);
    waves =
      WAVES_VOLUME *
      clamp01((WAVES_SILENT_ABOVE - h) / (WAVES_SILENT_ABOVE - WAVES_FULL_BELOW));
  }
  const crickets = CRICKETS_VOLUME * nightFactor(clientWorld.timeOfDay);
  const lowVitals = ui.vitals.hp < HEARTBEAT_HP_BELOW || ui.vitals.temp < TEMP_SHIVER;
  const heartbeat = lowVitals && ui.phase === "playing" ? HEARTBEAT_VOLUME : 0;

  setAmbientTarget(engine, "wind_loop", WIND_VOLUME, dt);
  setAmbientTarget(engine, "waves_loop", waves, dt);
  setAmbientTarget(engine, "crickets_loop", crickets, dt);
  setAmbientTarget(engine, "heartbeat", heartbeat, dt);
}

// --- Teardown ---

function silenceEngine(engine: Engine): void {
  for (const slot of engine.positional) {
    if (slot.node.isPlaying) slot.node.stop();
  }
  for (const slot of engine.flat) {
    if (slot.node.isPlaying) slot.node.stop();
  }
  for (const [id, node] of engine.fireNodes) {
    if (node.isPlaying) node.stop();
    engine.fireNodes.delete(id);
    engine.fireFree.push(node);
  }
  for (const loop of engine.ambient.values()) {
    if (loop.node.isPlaying) loop.node.stop();
    loop.volume = 0;
  }
  engine.stepAccum = 0;
  engine.prevX = Number.NaN;
  engine.prevZ = Number.NaN;
  engine.stepToggle = false;
  engine.vocalNextAt = 0;
  engine.zombiePrevState.clear();
  engine.zombieAttackLastAt.clear();
}

// --- Component ---

const tmpCamPos = new THREE.Vector3();

export function AudioSystem(): null {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const engine = getEngine();
    camera.add(engine.listener);
    scene.add(engine.group);

    // Autoplay policy: resume the context on the first user gesture.
    if (engine.listener.context.state === "running") markUnlocked(engine);
    const tryUnlock = (): void => {
      const ctx = engine.listener.context;
      ctx
        .resume()
        .then(() => {
          if (ctx.state !== "running") return;
          markUnlocked(engine);
          document.removeEventListener("pointerdown", tryUnlock);
          document.removeEventListener("keydown", tryUnlock);
        })
        .catch((err: unknown) => {
          // Keep the listeners; the next gesture retries.
          console.warn("[audio] AudioContext resume failed; will retry on next gesture", err);
        });
    };
    document.addEventListener("pointerdown", tryUnlock);
    document.addEventListener("keydown", tryUnlock);

    // M toggles master mute (mute overrides; unmute restores the store value).
    const onMuteKey = (e: KeyboardEvent): void => {
      if (e.code !== "KeyM" || e.repeat) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      engine.muted = !engine.muted;
      engine.listener.setMasterVolume(engine.muted ? 0 : useSettingsStore.getState().masterVolume);
    };
    document.addEventListener("keydown", onMuteKey);

    // Settings → master volume (live; the persisted value seeded createEngine).
    engine.listener.setMasterVolume(engine.muted ? 0 : useSettingsStore.getState().masterVolume);
    const unsubVolume = useSettingsStore.subscribe((state, prev) => {
      if (state.masterVolume === prev.masterVolume) return;
      engine.listener.setMasterVolume(engine.muted ? 0 : state.masterVolume);
    });

    // UI/self one-shot cues (eat/drink/bandage/campfire_place/pickup).
    registerCueSink((name) => {
      playFlat(engine, name, CUE_VOLUMES[name] ?? CUE_DEFAULT_VOLUME);
    });

    // Death sting on playing -> dead.
    const unsubPhase = useUIStore.subscribe((state, prev) => {
      if (prev.phase === "playing" && state.phase === "dead") {
        playFlat(engine, "death", 0.8);
      }
    });

    return () => {
      unsubPhase();
      unsubVolume();
      registerCueSink(null);
      document.removeEventListener("pointerdown", tryUnlock);
      document.removeEventListener("keydown", tryUnlock);
      document.removeEventListener("keydown", onMuteKey);
      silenceEngine(engine);
      camera.remove(engine.listener);
      scene.remove(engine.group);
    };
  }, [camera, scene]);

  useFrame((state, delta) => {
    const engine = getEngine();
    const dt = Math.min(delta, 0.1);
    const now = nowSec();
    state.camera.getWorldPosition(tmpCamPos);

    // Always drain (even while the context is locked) so the queue never grows;
    // playback primitives no-op until unlocked.
    processEvents(engine, drainAudioEvents(), tmpCamPos);
    updateFootsteps(engine);
    updateZombieStates(engine, now);
    updateVocalizations(engine, now, tmpCamPos);
    updateFires(engine, tmpCamPos);
    updateAmbience(engine, dt);
  });

  return null;
}
