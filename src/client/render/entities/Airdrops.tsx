// Airdrop crates from clientWorld.drops (never interest-filtered): the
// props.glb supply_crate (1m, base-origin) descending under the props.glb
// parachute while drop.falling (client-side cosmetic fall — the server only
// flips the flag), and a 40m billboarded smoke column while drop.smoke so
// the landing reads from across the island. Smoke materials are fog: false
// on purpose — scene fog must never swallow the column at distance (visible
// out to the 600m camera far plane). Same imperative pooling pattern as
// Zombies; GLB clones share geometry + materials like LootItems, with the
// old primitive crate/cone as fallback if a node goes missing.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { AIRDROP_FALL_DELAY_S } from "@/shared/constants";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 6;
const MAX_FRAME_DT = 0.1;

const PROPS_MODEL_URL = "/models/props.glb";
useGLTF.preload(PROPS_MODEL_URL);

// The parachute node's origin is the riser-line convergence point (canopy
// apex ~3.4m above it). Attach just above the 1m crate top so the canopy
// floats where the old cone chute used to.
const CHUTE_ATTACH_Y = 1.05;

// Cosmetic descent: spawn the crate this far above its landing spot and let
// it sink at the rate that covers the height in the announce->land window.
const FALL_FROM_HEIGHT = 60;
const FALL_SPEED = FALL_FROM_HEIGHT / AIRDROP_FALL_DELAY_S; // m/s

const CRATE_COLOR = "#5c6134"; // olive drab
const STRAP_COLOR = "#373b20";
const CHUTE_COLOR = "#c7cad0";
const CHUTE_SPIN_RATE = 0.4; // rad/s lazy spin on the way down

const SMOKE_QUADS = 9;
const SMOKE_HEIGHT = 40; // m column above the crate
const SMOKE_BASE_Y = 1.2;
const SMOKE_CYCLE_S = 14; // bottom-to-top travel time per quad
const SMOKE_SCALE_BOTTOM = 2.6;
const SMOKE_SCALE_TOP = 10;
const SMOKE_OPACITY = 0.42;
const SMOKE_COLOR = "#b35a1f"; // dark orange signal smoke
const LIGHT_COLOR = "#d9742a";
const LIGHT_INTENSITY = 1.5;
const LIGHT_DISTANCE = 14;
const LIGHT_DECAY = 2;
// Night beacon: smoke is invisible in the dark, so the crate also raises a
// pulsing flare column — additive, fog-exempt, readable across the island.
const FLARE_COLOR = "#ff4f24";
const FLARE_HEIGHT = 55;
const FLARE_WIDTH = 1.1;
const FLARE_OPACITY = 0.38;
const FLARE_PULSE_HZ = 0.9;

// Shared geometry/materials — module-level singletons like Campfires.
const CRATE_GEO = new THREE.BoxGeometry(1, 1, 1);
// Straps read as darker bands: thin in one axis, proud of the crate in the
// other two, crossing at the crate's center.
const STRAP_A_GEO = new THREE.BoxGeometry(1.06, 1.06, 0.18);
const STRAP_B_GEO = new THREE.BoxGeometry(0.18, 1.06, 1.06);
const CHUTE_GEO = new THREE.ConeGeometry(2.3, 1.5, 8, 1, true);
const SMOKE_GEO = new THREE.PlaneGeometry(1, 1);
const FLARE_GEO = new THREE.PlaneGeometry(FLARE_WIDTH, FLARE_HEIGHT);
const CRATE_MAT = new THREE.MeshLambertMaterial({ color: CRATE_COLOR });
const STRAP_MAT = new THREE.MeshLambertMaterial({ color: STRAP_COLOR });
const CHUTE_MAT = new THREE.MeshLambertMaterial({
  color: CHUTE_COLOR,
  side: THREE.DoubleSide,
});

interface DropSlot {
  root: THREE.Group;
  chute: THREE.Object3D;
  smoke: THREE.Mesh[];
  /** Per-quad materials — opacity is animated individually. */
  smokeMats: THREE.MeshBasicMaterial[];
  /** Two crossed flare planes + their shared material (pulsed per frame). */
  flare: THREE.Mesh[];
  flareMat: THREE.MeshBasicMaterial;
  light: THREE.PointLight;
  /** Remaining cosmetic height above drop.y while falling. */
  fallOffset: number;
}

interface DropPool {
  root: THREE.Group;
  slots: DropSlot[];
  byId: Map<number, number>;
  free: number[];
}

/** Grabs a template node from the cached GLB scene, flagging its meshes for
 * shadows once so every clone inherits the flag (LootItems pattern). */
function propTemplate(scene: THREE.Group, name: string, castShadow: boolean): THREE.Object3D | null {
  const node = scene.getObjectByName(name);
  if (!node) return null;
  if (castShadow) {
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
  }
  return node;
}

function createSlot(crateSource: THREE.Object3D | null, chuteSource: THREE.Object3D | null): DropSlot {
  const root = new THREE.Group();
  root.visible = false;

  if (crateSource) {
    root.add(crateSource.clone());
  } else {
    // Fallback: olive box with darker strapping (props.glb node missing).
    const crate = new THREE.Mesh(CRATE_GEO, CRATE_MAT);
    crate.position.y = 0.5;
    crate.castShadow = true;
    root.add(crate);
    const strapA = new THREE.Mesh(STRAP_A_GEO, STRAP_MAT);
    strapA.position.y = 0.5;
    root.add(strapA);
    const strapB = new THREE.Mesh(STRAP_B_GEO, STRAP_MAT);
    strapB.position.y = 0.5;
    root.add(strapB);
  }

  let chute: THREE.Object3D;
  if (chuteSource) {
    chute = chuteSource.clone();
    chute.position.y = CHUTE_ATTACH_Y;
  } else {
    chute = new THREE.Mesh(CHUTE_GEO, CHUTE_MAT);
    chute.position.y = 3.2;
  }
  chute.visible = false;
  root.add(chute);

  const smoke: THREE.Mesh[] = [];
  const smokeMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < SMOKE_QUADS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: SMOKE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false, // island-wide visibility — never fog-culled
    });
    const quad = new THREE.Mesh(SMOKE_GEO, mat);
    quad.visible = false;
    quad.frustumCulled = false; // billboarded/scaled per frame
    root.add(quad);
    smoke.push(quad);
    smokeMats.push(mat);
  }

  const light = new THREE.PointLight(LIGHT_COLOR, LIGHT_INTENSITY, LIGHT_DISTANCE, LIGHT_DECAY);
  light.position.y = 1.4;
  light.visible = false;
  root.add(light);

  const flareMat = new THREE.MeshBasicMaterial({
    color: FLARE_COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false, // the whole point: visible across the island at night
  });
  const flare: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const plane = new THREE.Mesh(FLARE_GEO, flareMat);
    plane.position.y = FLARE_HEIGHT / 2;
    plane.rotation.y = i * Math.PI * 0.5; // crossed planes read from any angle
    plane.visible = false;
    plane.frustumCulled = false;
    root.add(plane);
    flare.push(plane);
  }

  return { root, chute, smoke, smokeMats, flare, flareMat, light, fallOffset: 0 };
}

function createPool(scene: THREE.Group): DropPool {
  // Old cone chute never cast a shadow; keep the parachute shadowless too.
  const crateSource = propTemplate(scene, "supply_crate", true);
  const chuteSource = propTemplate(scene, "parachute", false);
  const root = new THREE.Group();
  const slots: DropSlot[] = [];
  const free: number[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = createSlot(crateSource, chuteSource);
    root.add(slot.root);
    slots.push(slot);
    free.push(POOL_SIZE - 1 - i);
  }
  return { root, slots, byId: new Map(), free };
}

export function Airdrops(): ReactElement {
  // Suspends until the GLB loads; the Canvas mounts post-welcome so the
  // suspension is invisible. Same drei cache entry the other props use.
  const gltf = useGLTF(PROPS_MODEL_URL);
  const pool = useMemo(() => createPool(gltf.scene), [gltf.scene]);

  // Smoke materials are per-slot (animated opacity) — dispose with the pool.
  useEffect(
    () => () => {
      for (const slot of pool.slots) for (const mat of slot.smokeMats) mat.dispose();
    },
    [pool],
  );

  useFrame((state, delta) => {
    const drops = clientWorld.drops;
    const t = state.clock.elapsedTime;
    const dt = Math.min(delta, MAX_FRAME_DT);

    // Release slots whose drop despawned (looted empty or TTL).
    outer: for (const [id, idx] of pool.byId) {
      for (let i = 0; i < drops.length; i++) {
        if (drops[i].id === id) continue outer;
      }
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.slots[idx].root.visible = false;
    }

    for (const drop of drops) {
      let idx = pool.byId.get(drop.id);
      if (idx === undefined) {
        idx = pool.free.pop();
        if (idx === undefined) continue;
        pool.byId.set(drop.id, idx);
        const fresh = pool.slots[idx];
        fresh.root.visible = true;
        fresh.fallOffset = drop.falling ? FALL_FROM_HEIGHT : 0;
      }
      const slot = pool.slots[idx];

      // Cosmetic descent: sink toward drop.y while falling, hard-settle the
      // moment the server says it landed (authority wins over the animation).
      if (drop.falling) {
        slot.fallOffset = Math.max(0, slot.fallOffset - FALL_SPEED * dt);
      } else {
        slot.fallOffset = 0;
      }
      slot.root.position.set(drop.x, drop.y + slot.fallOffset, drop.z);

      slot.chute.visible = drop.falling;
      if (drop.falling) slot.chute.rotation.y = t * CHUTE_SPIN_RATE;

      const smokeOn = drop.smoke && !drop.falling;
      slot.light.visible = smokeOn;
      for (const plane of slot.flare) plane.visible = smokeOn;
      if (smokeOn) {
        // Slow pulse so it reads as a signal flare, not a glitch.
        slot.flareMat.opacity =
          FLARE_OPACITY * (0.7 + 0.3 * Math.sin(t * FLARE_PULSE_HZ * Math.PI * 2));
        // Constant on-screen width: a 1.1m plane is subpixel at 500m. Scale
        // with camera distance so the beacon reads across the island.
        const dx = drop.x - state.camera.position.x;
        const dz = drop.z - state.camera.position.z;
        const widthScale = Math.min(Math.max(Math.hypot(dx, dz) * 0.012, 1), 9);
        for (const plane of slot.flare) plane.scale.x = widthScale;
      }
      if (!smokeOn) {
        for (let i = 0; i < SMOKE_QUADS; i++) slot.smoke[i].visible = false;
        continue;
      }

      slot.light.intensity = LIGHT_INTENSITY + Math.sin(t * 7 + drop.id) * 0.4;
      for (let i = 0; i < SMOKE_QUADS; i++) {
        const quad = slot.smoke[i];
        quad.visible = true;
        // Each quad loops bottom->top, staggered along the column; it grows
        // as it rises and thins toward the top.
        const cycle = (t / SMOKE_CYCLE_S + i / SMOKE_QUADS + drop.id * 0.13) % 1;
        quad.position.y = SMOKE_BASE_Y + cycle * SMOKE_HEIGHT;
        const scale = SMOKE_SCALE_BOTTOM + (SMOKE_SCALE_TOP - SMOKE_SCALE_BOTTOM) * cycle;
        quad.scale.set(scale, scale, 1);
        // Billboard toward the camera, then roll slowly around the view axis.
        quad.quaternion.copy(state.camera.quaternion);
        quad.rotateZ(i * 1.9 + t * (0.15 + (i % 3) * 0.07));
        const fade = Math.min(1, cycle * 6) * (1 - cycle * 0.85);
        slot.smokeMats[i].opacity = SMOKE_OPACITY * fade;
      }
    }
  });

  return <primitive object={pool.root} />;
}
