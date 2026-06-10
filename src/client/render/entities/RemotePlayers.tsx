// Remote player rendering: a fixed pool of MAX_PLAYERS humanoid rigs created
// once and assigned to player ids per frame. No React re-render per snapshot —
// everything is imperative inside useFrame.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_PLAYERS } from "@/shared/constants";
import { ANIM_ATTACKING, ANIM_MOVING, ANIM_SPRINTING } from "@/shared/protocol";
import { clientWorld } from "@/client/runtime";
import { createHumanoid, type HumanoidRig } from "./Humanoid";

const LABEL_Y = 2.1;
const LABEL_MAX_DIST_SQ = 60 * 60;
const SPRINT_ANIM_FACTOR = 1.35;
const PANTS_COLOR = "#4a4e57";
const SKIN_COLOR = "#d9b08c";

// Small muted shirt palette; stable per id via hash.
const SHIRT_PALETTE = [
  "#7a6f5d",
  "#5d7a6f",
  "#6f5d7a",
  "#7a5d5d",
  "#5d6f7a",
  "#74837a",
  "#8a7a64",
  "#647a8a",
];

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
  rig: HumanoidRig;
  label: THREE.Sprite;
  appliedName: string;
}

interface PlayerPool {
  root: THREE.Group;
  slots: PlayerSlot[];
  byId: Map<string, number>;
  free: number[];
}

function createPool(): PlayerPool {
  const root = new THREE.Group();
  const slots: PlayerSlot[] = [];
  const free: number[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const rig = createHumanoid({ shirt: SHIRT_PALETTE[0], pants: PANTS_COLOR, skin: SKIN_COLOR });
    rig.group.visible = false;
    const label = new THREE.Sprite(emptyLabelMaterial);
    label.position.y = LABEL_Y;
    label.scale.set(1.6, 0.4, 1);
    rig.group.add(label);
    root.add(rig.group);
    slots.push({ rig, label, appliedName: "" });
    free.push(MAX_PLAYERS - 1 - i); // pop() hands out slot 0 first
  }
  return { root, slots, byId: new Map(), free };
}

export function RemotePlayers(): ReactElement {
  const pool = useMemo(createPool, []);

  useFrame((state) => {
    const players = clientWorld.players;

    // Release slots whose player left (Map tolerates delete-while-iterating).
    for (const [id, idx] of pool.byId) {
      if (players.has(id)) continue;
      pool.byId.delete(id);
      pool.free.push(idx);
      pool.slots[idx].rig.group.visible = false;
    }

    const t = state.clock.elapsedTime;
    const camPos = state.camera.position;

    for (const view of players.values()) {
      if (view.id === clientWorld.myId) continue; // belt and suspenders
      let idx = pool.byId.get(view.id);
      if (idx === undefined) {
        idx = pool.free.pop();
        if (idx === undefined) continue; // pool exhausted (shouldn't happen)
        pool.byId.set(view.id, idx);
        const fresh = pool.slots[idx];
        fresh.rig.group.visible = true;
        fresh.rig.shirtMaterial.color.set(
          SHIRT_PALETTE[hashId(view.id) % SHIRT_PALETTE.length],
        );
      }
      const slot = pool.slots[idx];
      const g = slot.rig.group;
      g.position.set(view.x, view.y, view.z);
      g.rotation.y = view.yaw;

      const moving = (view.anim & ANIM_MOVING) !== 0;
      const sprinting = (view.anim & ANIM_SPRINTING) !== 0;
      const attacking = (view.anim & ANIM_ATTACKING) !== 0;
      const speedFactor = sprinting ? SPRINT_ANIM_FACTOR : moving ? 1 : 0;
      // Per-slot phase offset so the pool doesn't march in lockstep.
      slot.rig.update(t + idx * 1.7, speedFactor, attacking);
      slot.rig.setHeldItem(view.item);

      if (slot.appliedName !== view.name) {
        slot.appliedName = view.name;
        slot.label.material = labelMaterial(view.name);
      }
      const dx = view.x - camPos.x;
      const dy = view.y - camPos.y;
      const dz = view.z - camPos.z;
      slot.label.visible = dx * dx + dy * dy + dz * dz <= LABEL_MAX_DIST_SQ;
    }
  });

  return <primitive object={pool.root} />;
}
