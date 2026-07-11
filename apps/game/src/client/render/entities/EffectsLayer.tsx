// Short-lived combat VFX. Drains the runtime event queue once per frame and
// drives fixed pools of meshes (round-robin slots, per-slot materials so each
// effect fades independently). Zero allocations per frame in steady state —
// spawn copies event floats into preallocated slot fields.
//
// Handled here: "shot" (tracer + muzzle flash), "hit" (expanding sphere),
// "zdie" (dark-red puff), "break" (pooled fracture debris — barrels AND axed
// trunks, routed by kind), "treeCut" (fell burst + leaf puff at the cut line).
// "swing" and "hurt" are owned elsewhere — ignored.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clientWorld, drainEvents } from "@/client/runtime";
import { QUALITY_CONFIGS, useSettingsStore } from "@/client/state/settings";
import { DebrisPool } from "./debrisPool";
import { BARREL_FRACTURE_SEEDS, buildBarrelFractureTemplate } from "./barrelFracture";
import { BARREL_INNER_MATERIAL, BARREL_MATERIAL } from "./physicsBodyAssets";
import {
  buildTreeCutTemplate,
  TREE_BARK_MATERIAL,
  TREE_FRACTURE_SEEDS,
  TREE_SPECIES,
  TREE_WOOD_MATERIAL,
} from "./treeFracture";

// 18 slots: a shotgun blast lands 6 shot events in one frame — round-robin
// must absorb a full blast (plus overlap from other shooters) without
// stomping live tracers.
const SHOT_POOL = 18;
const SHOT_DURATION_S = 0.12; // pistol + each shotgun pellet
const RIFLE_SHOT_DURATION_S = 0.2; // rifle tracers linger
const FLASH_DURATION_S = 0.06;
const TRACER_COLOR = "#ffd27a";
const RIFLE_TRACER_COLOR = "#fff3b8"; // brighter, near-white
const HIT_POOL = 12;
const HIT_DURATION_S = 0.15;
const ZDIE_POOL = 8;
const ZDIE_DURATION_S = 0.45;
// Leaf puffs on a tree fell — the cheap foliage counterpart to the trunk-cut
// fracture (leaves are billboards; Voronoi on them would be nonsense).
const LEAF_POOL = 6;
const LEAF_DURATION_S = 0.7;

const TRACER_GEO = new THREE.BoxGeometry(0.03, 0.03, 1); // scaled along z to span s->t
const FLASH_GEO = new THREE.BoxGeometry(0.14, 0.14, 0.14);
const HIT_GEO = new THREE.IcosahedronGeometry(0.12, 0);
const ZDIE_GEO = new THREE.IcosahedronGeometry(0.4, 0);
const LEAF_GEO = new THREE.IcosahedronGeometry(0.5, 0);
/** treeCut bursts tear out of a standing trunk — no body pose, identity quat. */
const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1];

const LOOK_TARGET = new THREE.Vector3(); // reused frame temp

interface ShotSlot {
  tracer: THREE.Mesh;
  tracerMat: THREE.MeshBasicMaterial;
  flash: THREE.Mesh;
  flashMat: THREE.MeshBasicMaterial;
  start: number; // seconds; -1 when inactive
  duration: number; // per-weapon tracer lifetime, seconds
}

interface PointFxSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  start: number;
}

interface FxPool {
  root: THREE.Group;
  shots: ShotSlot[];
  hits: PointFxSlot[];
  zdies: PointFxSlot[];
  leaves: PointFxSlot[];
  debris: DebrisPool;
  treeDebris: DebrisPool;
}

function fadeMaterial(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
}

function createPool(): FxPool {
  const root = new THREE.Group();
  const debris = new DebrisPool(
    "barrel_debris",
    BARREL_MATERIAL,
    BARREL_INNER_MATERIAL,
    [{ group: "barrel", build: (count, seed) => buildBarrelFractureTemplate(count, seed) }],
    BARREL_FRACTURE_SEEDS,
  );
  const treeDebris = new DebrisPool(
    "tree_debris",
    TREE_BARK_MATERIAL,
    TREE_WOOD_MATERIAL,
    TREE_SPECIES.map((species) => ({
      group: species,
      build: (count: 6 | 8, seed: number) => buildTreeCutTemplate(species, count, seed),
    })),
    TREE_FRACTURE_SEEDS,
  );
  root.add(debris.root, treeDebris.root);

  const shots: ShotSlot[] = [];
  for (let i = 0; i < SHOT_POOL; i++) {
    const tracerMat = fadeMaterial(TRACER_COLOR);
    const tracer = new THREE.Mesh(TRACER_GEO, tracerMat);
    tracer.visible = false;
    const flashMat = fadeMaterial("#ffe9b0");
    const flash = new THREE.Mesh(FLASH_GEO, flashMat);
    flash.visible = false;
    root.add(tracer, flash);
    shots.push({ tracer, tracerMat, flash, flashMat, start: -1, duration: SHOT_DURATION_S });
  }

  const hits: PointFxSlot[] = [];
  for (let i = 0; i < HIT_POOL; i++) {
    const mat = fadeMaterial("#ffd9a0");
    const mesh = new THREE.Mesh(HIT_GEO, mat);
    mesh.visible = false;
    root.add(mesh);
    hits.push({ mesh, mat, start: -1 });
  }

  const zdies: PointFxSlot[] = [];
  for (let i = 0; i < ZDIE_POOL; i++) {
    const mat = fadeMaterial("#5a1414");
    const mesh = new THREE.Mesh(ZDIE_GEO, mat);
    mesh.visible = false;
    root.add(mesh);
    zdies.push({ mesh, mat, start: -1 });
  }

  const leaves: PointFxSlot[] = [];
  for (let i = 0; i < LEAF_POOL; i++) {
    const mat = fadeMaterial("#4d713b");
    const mesh = new THREE.Mesh(LEAF_GEO, mat);
    mesh.visible = false;
    root.add(mesh);
    leaves.push({ mesh, mat, start: -1 });
  }

  return { root, shots, hits, zdies, leaves, debris, treeDebris };
}

function spawnHit(pool: FxPool, cursors: { hit: number }, x: number, y: number, z: number, now: number): void {
  const slot = pool.hits[cursors.hit];
  cursors.hit = (cursors.hit + 1) % HIT_POOL;
  slot.start = now;
  slot.mesh.position.set(x, y, z);
  slot.mesh.scale.set(1, 1, 1);
  slot.mesh.visible = true;
  slot.mat.opacity = 0.9;
}

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

export function EffectsLayer(): ReactElement {
  const pool = useMemo(createPool, []);
  const cursors = useMemo(() => ({ shot: 0, hit: 0, zdie: 0, leaf: 0 }), []);
  const fragmentBudget = QUALITY_CONFIGS[useSettingsStore((s) => s.quality)].destructionFragments;

  useEffect(() => {
    if (fragmentBudget === 0) return;
    const idleWindow = window as unknown as IdleWindow;
    let cancelled = false;
    const build = () => {
      if (cancelled) return;
      pool.debris.buildTemplates();
      pool.treeDebris.buildTemplates();
    };
    const idleHandle = idleWindow.requestIdleCallback?.(build, { timeout: 2_000 });
    const timeoutHandle = idleHandle === undefined ? window.setTimeout(build, 250) : undefined;
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  }, [fragmentBudget, pool]);

  useEffect(
    () => () => {
      pool.debris.dispose();
      pool.treeDebris.dispose();
    },
    [pool],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    // --- Spawn from this frame's events ---
    const events = drainEvents();
    for (const ev of events) {
      if (ev.e === "shot") {
        const slot = pool.shots[cursors.shot];
        cursors.shot = (cursors.shot + 1) % SHOT_POOL;
        slot.start = t;
        // Rifle: longer-lived, brighter tracer. Pistol and shotgun pellets
        // (6 events per blast) use the standard short flash.
        const rifle = ev.w === "rifle";
        slot.duration = rifle ? RIFLE_SHOT_DURATION_S : SHOT_DURATION_S;
        slot.tracerMat.color.set(rifle ? RIFLE_TRACER_COLOR : TRACER_COLOR);
        const dx = ev.tx - ev.sx;
        const dy = ev.ty - ev.sy;
        const dz = ev.tz - ev.sz;
        const len = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.01);
        slot.tracer.position.set(ev.sx + dx / 2, ev.sy + dy / 2, ev.sz + dz / 2);
        LOOK_TARGET.set(ev.tx, ev.ty, ev.tz);
        slot.tracer.lookAt(LOOK_TARGET);
        slot.tracer.scale.set(1, 1, len);
        slot.tracer.visible = true;
        slot.tracerMat.opacity = 1;
        slot.flash.position.set(ev.sx, ev.sy, ev.sz);
        slot.flash.visible = true;
        slot.flashMat.opacity = 1;
      } else if (ev.e === "hit") {
        spawnHit(pool, cursors, ev.x, ev.y, ev.z, t);
      } else if (ev.e === "zdie") {
        const slot = pool.zdies[cursors.zdie];
        cursors.zdie = (cursors.zdie + 1) % ZDIE_POOL;
        slot.start = t;
        slot.mesh.position.set(ev.x, ev.y + 0.7, ev.z);
        slot.mesh.scale.set(0.6, 0.6, 0.6);
        slot.mesh.visible = true;
        slot.mat.opacity = 0.85;
      } else if (ev.e === "break") {
        // Route by body kind: barrels burst from the barrel templates; an axed
        // trunk log-bursts from the tree-cut templates (species untracked on
        // bodies — id parity picks one; the bark/wood look is shared anyway).
        const spawned =
          ev.kind === "trunk"
            ? pool.treeDebris.spawn(ev, t, fragmentBudget, ev.id % 2 === 0 ? "conifer" : "oak")
            : pool.debris.spawn(ev, t, fragmentBudget);
        if (!spawned) {
          // Mobile / idle templates not ready: preserve immediate feedback
          // without blocking a frame on Voronoi generation.
          spawnHit(pool, cursors, ev.x, ev.y, ev.z, t);
        }
      } else if (ev.e === "treeCut") {
        // Fell burst at the cut line (released on the delayed timeline, in
        // lock-step with the standing tree vanishing) + a leaf puff up at the
        // canopy. The authoritative trunk topples intact via PhysicsBodies.
        const cutPose = { id: ev.id, x: ev.x, y: ev.y + 0.7, z: ev.z, q: IDENTITY_Q };
        if (!pool.treeDebris.spawn(cutPose, t, fragmentBudget, ev.species)) {
          spawnHit(pool, cursors, ev.x, ev.y + 0.7, ev.z, t);
        }
        const leaf = pool.leaves[cursors.leaf];
        cursors.leaf = (cursors.leaf + 1) % LEAF_POOL;
        leaf.start = t;
        leaf.mesh.position.set(ev.x, ev.y + (ev.species === "conifer" ? 5.4 : 4.6), ev.z);
        leaf.mesh.scale.set(1, 1, 1);
        leaf.mesh.visible = true;
        leaf.mat.color.set(ev.species === "conifer" ? "#315b36" : "#4d713b");
        leaf.mat.opacity = 0.7;
      }
      // "swing" / "hurt": handled elsewhere (HUD vignette etc.) — ignore.
    }

    // --- Advance active effects ---
    for (const slot of pool.shots) {
      if (slot.start < 0) continue;
      const age = t - slot.start;
      if (age >= slot.duration) {
        slot.start = -1;
        slot.tracer.visible = false;
        slot.flash.visible = false;
        continue;
      }
      slot.tracerMat.opacity = 1 - age / slot.duration;
      if (age >= FLASH_DURATION_S) {
        slot.flash.visible = false;
      } else {
        slot.flashMat.opacity = 1 - age / FLASH_DURATION_S;
      }
    }

    for (const slot of pool.hits) {
      if (slot.start < 0) continue;
      const age = t - slot.start;
      if (age >= HIT_DURATION_S) {
        slot.start = -1;
        slot.mesh.visible = false;
        continue;
      }
      const p = age / HIT_DURATION_S;
      const s = 1 + p * 2.2;
      slot.mesh.scale.set(s, s, s);
      slot.mat.opacity = 0.9 * (1 - p);
    }

    for (const slot of pool.zdies) {
      if (slot.start < 0) continue;
      const age = t - slot.start;
      if (age >= ZDIE_DURATION_S) {
        slot.start = -1;
        slot.mesh.visible = false;
        continue;
      }
      const p = age / ZDIE_DURATION_S;
      const s = 0.6 + p * 1.8;
      slot.mesh.scale.set(s, s, s);
      slot.mat.opacity = 0.85 * (1 - p);
    }

    for (const slot of pool.leaves) {
      if (slot.start < 0) continue;
      const age = t - slot.start;
      if (age >= LEAF_DURATION_S) {
        slot.start = -1;
        slot.mesh.visible = false;
        continue;
      }
      // Swell + drift down slightly, like a canopy shaking itself apart.
      const p = age / LEAF_DURATION_S;
      const s = 1 + p * 2.6;
      slot.mesh.scale.set(s, s * 0.8, s);
      slot.mesh.position.y -= delta * 1.2;
      slot.mat.opacity = 0.7 * (1 - p);
    }

    pool.debris.update(t, delta, clientWorld.world);
    pool.treeDebris.update(t, delta, clientWorld.world);
  });

  return <primitive object={pool.root} />;
}
