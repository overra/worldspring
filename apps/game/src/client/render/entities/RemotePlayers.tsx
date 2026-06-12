// Remote player rendering: a fixed pool of MAX_PLAYERS rigged GLTF characters
// created once and assigned to player ids per frame. No React re-render per
// snapshot — everything is imperative inside useFrame.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_PLAYERS } from "@worldspring/shared/constants";
import { ANIM_ATTACKING, ANIM_MOVING, ANIM_SPRINTING } from "@worldspring/shared/protocol";
import { clientWorld, type RemotePlayerView } from "@/client/runtime";
import {
  createCharacterRig,
  overlayForItem,
  useCharacterModel,
  type CharacterRig,
} from "./CharacterRig";

// Head top sits at PLAYER_HEIGHT (1.8) — float the name a bit above it.
const LABEL_Y = 2.0;
const LABEL_MAX_DIST_SQ = 60 * 60;
// Rigs beyond this only step their mixer every Nth frame (accumulated dt).
const FAR_DIST_SQ = 80 * 80;
const FAR_UPDATE_INTERVAL = 4;
const MAX_FRAME_DT = 5; // throttled tabs land on the correct anim phase per frame

// Remote flashlights: a tiny pool of real spotlights assigned each frame to
// the nearest holders — every extra live light is a forward-pass cost.
const FLASHLIGHT_POOL_SIZE = 4;
const FLASHLIGHT_MAX_DIST_SQ = 90 * 90;
const FLASHLIGHT_COLOR = "#ffe9b0";
const FLASHLIGHT_INTENSITY = 45; // a notch under the local beam
const FLASHLIGHT_DISTANCE = 38;
const FLASHLIGHT_ANGLE = 0.36;
const FLASHLIGHT_PENUMBRA = 0.45;
const FLASHLIGHT_DECAY = 1.6;
const FLASHLIGHT_CHEST_Y = 1.3;
const FLASHLIGHT_FORWARD = 0.35;
// Beam from yaw only (no remote pitch): 18m out, 2m down ≈ -0.12 rad.
const FLASHLIGHT_BEAM_DIST = 18;
const FLASHLIGHT_BEAM_DROP = 2;

// Subtle per-player tint: lerp white toward a hashed palette color so the
// model's authored palette still reads underneath.
const TINT_STRENGTH = 0.35;
const TINT_PALETTE = [
  "#7a6f5d",
  "#5d7a6f",
  "#6f5d7a",
  "#7a5d5d",
  "#5d6f7a",
  "#74837a",
  "#8a7a64",
  "#647a8a",
].map((hex) => new THREE.Color(1, 1, 1).lerp(new THREE.Color(hex), TINT_STRENGTH));

function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h;
}

// Name label canvas textures, cached per name (bounded by names seen).
const labelMaterialCache = new Map<string, THREE.SpriteMaterial>();
const emptyLabelMaterial = new THREE.SpriteMaterial({ transparent: true, opacity: 0 });

/** Each entry holds a canvas + GPU texture — evict oldest past this. No
 * dispose() on eviction: a visible sprite may still reference the material
 * (it self-heals on slot reassignment; JS side is reclaimed by GC). */
const LABEL_CACHE_MAX = 64;

function labelMaterial(name: string): THREE.SpriteMaterial {
  const cached = labelMaterialCache.get(name);
  if (cached) return cached;
  if (labelMaterialCache.size >= LABEL_CACHE_MAX) {
    // Maps iterate in insertion order — drop the oldest half.
    let toDrop = LABEL_CACHE_MAX / 2;
    for (const key of labelMaterialCache.keys()) {
      if (toDrop-- <= 0) break;
      labelMaterialCache.delete(key);
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(name, 128, 34);
    ctx.fillStyle = "#f2efe6";
    ctx.fillText(name, 128, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  labelMaterialCache.set(name, mat);
  return mat;
}

interface PlayerSlot {
  rig: CharacterRig;
  label: THREE.Sprite;
  appliedName: string;
  lastAttacking: boolean;
  accumDt: number;
}

interface PlayerPool {
  root: THREE.Group;
  slots: PlayerSlot[];
  byId: Map<string, number>;
  free: number[];
  frame: number;
  flashlights: THREE.SpotLight[];
}

function createPool(): PlayerPool {
  const root = new THREE.Group();
  const slots: PlayerSlot[] = [];
  const free: number[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const rig = createCharacterRig("survivor");
    rig.root.visible = false;
    const label = new THREE.Sprite(emptyLabelMaterial);
    label.position.y = LABEL_Y;
    label.scale.set(1.6, 0.4, 1);
    rig.root.add(label);
    root.add(rig.root);
    slots.push({ rig, label, appliedName: "", lastAttacking: false, accumDt: 0 });
    free.push(MAX_PLAYERS - 1 - i); // pop() hands out slot 0 first
  }
  const flashlights: THREE.SpotLight[] = [];
  for (let i = 0; i < FLASHLIGHT_POOL_SIZE; i++) {
    const light = new THREE.SpotLight(
      FLASHLIGHT_COLOR,
      FLASHLIGHT_INTENSITY,
      FLASHLIGHT_DISTANCE,
      FLASHLIGHT_ANGLE,
      FLASHLIGHT_PENUMBRA,
      FLASHLIGHT_DECAY,
    );
    light.castShadow = false; // perf: no shadow-map pass per beam
    light.visible = false;
    // Both the light and its target need a scene-graph parent for
    // matrixWorld updates.
    root.add(light);
    root.add(light.target);
    flashlights.push(light);
  }
  return { root, slots, byId: new Map(), free, frame: 0, flashlights };
}

// Reused per-frame scratch for flashlight assignment (cleared each frame).
const flashCandidates: Array<{ view: RemotePlayerView; d2: number }> = [];

export function RemotePlayers(): ReactElement {
  useCharacterModel("survivor");
  const pool = useMemo(createPool, []);

  useFrame((state, delta) => {
    const players = clientWorld.players;
    pool.frame++;

    // Release slots whose player left (Map tolerates delete-while-iterating).
    for (const [id, idx] of pool.byId) {
      if (players.has(id)) continue;
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.slots[idx].rig.root.visible = false;
    }

    const dt = Math.min(delta, MAX_FRAME_DT);
    const camPos = state.camera.position;

    for (const view of players.values()) {
      if (view.id === clientWorld.myId) continue; // belt and suspenders
      let idx = pool.byId.get(view.id);
      if (idx === undefined) {
        idx = pool.free.pop();
        if (idx === undefined) continue; // pool exhausted (shouldn't happen)
        pool.byId.set(view.id, idx);
        const fresh = pool.slots[idx];
        fresh.rig.root.visible = true;
        fresh.rig.setTint(TINT_PALETTE[hashId(view.id) % TINT_PALETTE.length]);
        fresh.rig.setLocomotion("idle");
        fresh.lastAttacking = false;
        fresh.accumDt = 0;
      }
      const slot = pool.slots[idx];
      const root = slot.rig.root;
      root.position.set(view.x, view.y, view.z);
      root.rotation.y = view.yaw;

      const moving = (view.anim & ANIM_MOVING) !== 0;
      const sprinting = (view.anim & ANIM_SPRINTING) !== 0;
      const attacking = (view.anim & ANIM_ATTACKING) !== 0;
      slot.rig.setLocomotion(sprinting ? "run" : moving ? "walk" : "idle");
      // Fire the overlay on the rising edge of the attack flag only.
      if (attacking && !slot.lastAttacking) slot.rig.playOverlay(overlayForItem(view.item));
      slot.lastAttacking = attacking;
      slot.rig.setHeldItem(view.item);

      if (slot.appliedName !== view.name) {
        slot.appliedName = view.name;
        slot.label.material = labelMaterial(view.name);
      }
      const dx = view.x - camPos.x;
      const dy = view.y - camPos.y;
      const dz = view.z - camPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      slot.label.visible = distSq <= LABEL_MAX_DIST_SQ;

      if (view.item === "flashlight" && distSq <= FLASHLIGHT_MAX_DIST_SQ) {
        flashCandidates.push({ view, d2: distSq });
      }

      // Mixer step — far rigs only every Nth frame, staggered by slot.
      slot.accumDt += dt;
      if (distSq > FAR_DIST_SQ && (pool.frame + idx) % FAR_UPDATE_INTERVAL !== 0) continue;
      slot.rig.update(slot.accumDt);
      slot.accumDt = 0;
    }

    // Hand the spotlight pool to the nearest flashlight holders.
    flashCandidates.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < pool.flashlights.length; i++) {
      const light = pool.flashlights[i];
      const candidate = i < flashCandidates.length ? flashCandidates[i] : null;
      if (!candidate) {
        light.visible = false;
        continue;
      }
      const view = candidate.view;
      const fx = -Math.sin(view.yaw); // forward: yaw 0 faces -Z
      const fz = -Math.cos(view.yaw);
      light.visible = true;
      light.position.set(
        view.x + fx * FLASHLIGHT_FORWARD,
        view.y + FLASHLIGHT_CHEST_Y,
        view.z + fz * FLASHLIGHT_FORWARD,
      );
      light.target.position.set(
        light.position.x + fx * FLASHLIGHT_BEAM_DIST,
        light.position.y - FLASHLIGHT_BEAM_DROP,
        light.position.z + fz * FLASHLIGHT_BEAM_DIST,
      );
    }
    flashCandidates.length = 0;
  });

  return <primitive object={pool.root} />;
}
