// Bounded client-only barrel debris. No Rapier/client prediction: the server
// already removed the gameplay body before the buffered break event reaches
// this pool. Motion is a short deterministic ballistic illusion over terrain.

import * as THREE from "three";
import type { GameEvent } from "@worldspring/shared/protocol";
import type { World } from "@worldspring/shared/world";
import {
  BARREL_FRACTURE_SEEDS,
  BARREL_FRAGMENT_COUNTS,
  buildBarrelFractureTemplate,
  type BarrelFragmentCount,
  type BarrelFragmentTemplate,
} from "./barrelFracture";
import { BARREL_INNER_MATERIAL, BARREL_MATERIAL } from "./physicsBodyAssets";

type BreakEvent = Extract<GameEvent, { e: "break" }>;

const MAX_BURSTS = 3;
const MAX_FRAGMENTS = 8;
const DURATION_S = 1.25;
const SHRINK_START_S = 0.9;
const GRAVITY = 9.81;

interface DebrisSlot {
  mesh: THREE.Mesh;
  materials: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  start: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  radius: number;
  bounced: boolean;
}

interface TemplateSet {
  6: BarrelFragmentTemplate[][];
  8: BarrelFragmentTemplate[][];
}

const tempCenter = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();

function hashUnit(id: number, fragment: number, salt: number): number {
  let h = Math.imul(id ^ salt, 0x45d9f3b) ^ Math.imul(fragment + 1, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

export class BarrelDebrisPool {
  readonly root = new THREE.Group();
  private readonly slots: DebrisSlot[] = [];
  private readonly templates: TemplateSet = { 6: [], 8: [] };
  private ready = false;
  private burstCursor = 0;

  constructor() {
    this.root.name = "barrel_debris";
    for (let i = 0; i < MAX_BURSTS * MAX_FRAGMENTS; i++) {
      const outer = BARREL_MATERIAL.clone();
      const inner = BARREL_INNER_MATERIAL.clone();
      outer.transparent = true;
      inner.transparent = true;
      const materials: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [outer, inner];
      const mesh = new THREE.Mesh(BARREL_GEOMETRY_PLACEHOLDER, materials);
      mesh.castShadow = true;
      mesh.visible = false;
      this.root.add(mesh);
      this.slots.push({
        mesh,
        materials,
        start: -1,
        vx: 0,
        vy: 0,
        vz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        radius: 0.1,
        bounced: false,
      });
    }
  }

  buildTemplates(): void {
    if (this.ready) return;
    for (const count of BARREL_FRAGMENT_COUNTS) {
      for (const seed of BARREL_FRACTURE_SEEDS) {
        this.templates[count].push(buildBarrelFractureTemplate(count, seed));
      }
    }
    this.ready = true;
  }

  spawn(event: BreakEvent, now: number, fragmentBudget: number): boolean {
    if (!this.ready || fragmentBudget === 0) return false;
    const count: BarrelFragmentCount = fragmentBudget <= 6 ? 6 : 8;
    const variants = this.templates[count];
    const template = variants[event.id % variants.length];
    if (!template) return false;

    const burst = this.burstCursor;
    this.burstCursor = (this.burstCursor + 1) % MAX_BURSTS;
    const base = burst * MAX_FRAGMENTS;
    tempQuat.set(event.q[0], event.q[1], event.q[2], event.q[3]).normalize();

    for (let i = 0; i < MAX_FRAGMENTS; i++) {
      const slot = this.slots[base + i];
      const fragment = template[i];
      if (!slot || !fragment) {
        if (slot) {
          slot.start = -1;
          slot.mesh.visible = false;
        }
        continue;
      }

      slot.mesh.geometry = fragment.geometry;
      tempCenter.copy(fragment.center).applyQuaternion(tempQuat);
      slot.mesh.position.set(event.x + tempCenter.x, event.y + tempCenter.y, event.z + tempCenter.z);
      slot.mesh.quaternion.copy(tempQuat);
      slot.mesh.scale.setScalar(1);
      slot.mesh.visible = true;
      slot.materials[0].opacity = 1;
      slot.materials[1].opacity = 1;
      slot.start = now;
      slot.radius = fragment.radius;
      slot.bounced = false;

      const angle = hashUnit(event.id, i, 0x51f15e) * Math.PI * 2;
      const speed = 1.4 + hashUnit(event.id, i, 0xa11ce) * 2.2;
      slot.vx = Math.cos(angle) * speed;
      slot.vz = Math.sin(angle) * speed;
      slot.vy = 1.8 + hashUnit(event.id, i, 0xb4a4e1) * 2.6;
      slot.rx = (hashUnit(event.id, i, 0x12345) - 0.5) * 8;
      slot.ry = (hashUnit(event.id, i, 0x6789a) - 0.5) * 8;
      slot.rz = (hashUnit(event.id, i, 0xbcdef) - 0.5) * 8;
    }
    return true;
  }

  update(now: number, delta: number, world: World | null): void {
    const dt = Math.min(delta, 0.05);
    for (const slot of this.slots) {
      if (slot.start < 0) continue;
      const age = now - slot.start;
      if (age >= DURATION_S) {
        slot.start = -1;
        slot.mesh.visible = false;
        continue;
      }

      slot.vy -= GRAVITY * dt;
      slot.mesh.position.x += slot.vx * dt;
      slot.mesh.position.y += slot.vy * dt;
      slot.mesh.position.z += slot.vz * dt;
      slot.mesh.rotation.x += slot.rx * dt;
      slot.mesh.rotation.y += slot.ry * dt;
      slot.mesh.rotation.z += slot.rz * dt;

      if (world) {
        const ground = world.groundHeight(slot.mesh.position.x, slot.mesh.position.z);
        const bottom = slot.mesh.position.y - slot.radius;
        if (bottom < ground) {
          slot.mesh.position.y = ground + slot.radius;
          if (!slot.bounced) {
            slot.vy = Math.abs(slot.vy) * 0.25;
            slot.vx *= 0.65;
            slot.vz *= 0.65;
            slot.bounced = true;
          } else {
            slot.vy = Math.max(0, slot.vy);
            slot.vx *= 0.9;
            slot.vz *= 0.9;
          }
        }
      }

      if (age > SHRINK_START_S) {
        const scale = 1 - (age - SHRINK_START_S) / (DURATION_S - SHRINK_START_S);
        const fade = Math.max(0, scale);
        slot.mesh.scale.setScalar(fade);
        slot.materials[0].opacity = fade;
        slot.materials[1].opacity = fade;
      }
    }
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    for (const variants of [this.templates[6], this.templates[8]]) {
      for (const template of variants) for (const fragment of template) geometries.add(fragment.geometry);
    }
    for (const geometry of geometries) geometry.dispose();
    for (const slot of this.slots) {
      for (const material of slot.materials) material.dispose();
      slot.mesh.removeFromParent();
    }
    this.root.removeFromParent();
  }
}

// Slots need a valid geometry before the idle-time templates exist. It is
// never rendered and stays app-lifetime.
const BARREL_GEOMETRY_PLACEHOLDER = new THREE.BufferGeometry();
