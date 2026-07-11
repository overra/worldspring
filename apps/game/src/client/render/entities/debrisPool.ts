// Bounded client-only fracture debris, generalized from the doc 13 M3 barrel
// pool: one instance per debris FAMILY (barrels, tree cuts), each with its own
// template groups. No Rapier/client prediction: the server already removed the
// gameplay entity before the buffered event reaches a pool. Motion is a short
// deterministic ballistic illusion over terrain.

import * as THREE from "three";
import type { World } from "@worldspring/shared/world";
import type { FragmentTemplate } from "./fracture";

const MAX_BURSTS = 3;
const MAX_FRAGMENTS = 8;
const DURATION_S = 1.25;
const SHRINK_START_S = 0.9;
const GRAVITY = 9.81;

/** The two budget-selected fragment counts (settings.destructionFragments). */
export type FragmentCount = 6 | 8;
const FRAGMENT_COUNTS: readonly FragmentCount[] = [6, 8];

/** What a burst needs: an id (deterministic variant/velocity hash), a world
 * pose, and an orientation. break events fit directly; treeCut spawns pass an
 * identity quaternion (the burst tears out of a standing trunk). */
export interface BurstPose {
  id: number;
  x: number;
  y: number;
  z: number;
  q: [number, number, number, number];
}

/** A named template family inside one pool — e.g. tree cuts register one group
 * per species so a burst matches the felled tree's trunk. */
export interface DebrisGroupSpec {
  group: string;
  build: (count: FragmentCount, seed: number) => FragmentTemplate[];
}

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

const tempCenter = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();

function hashUnit(id: number, fragment: number, salt: number): number {
  let h = Math.imul(id ^ salt, 0x45d9f3b) ^ Math.imul(fragment + 1, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

// Slots need a valid geometry before the idle-time templates exist. It is
// never rendered and stays app-lifetime.
const EMPTY_GEOMETRY = new THREE.BufferGeometry();

export class DebrisPool {
  readonly root = new THREE.Group();
  private readonly slots: DebrisSlot[] = [];
  /** `${group}:${count}` → seed variants → fragment templates. */
  private readonly templates = new Map<string, FragmentTemplate[][]>();
  private readonly specs: readonly DebrisGroupSpec[];
  private readonly seeds: readonly number[];
  private ready = false;
  private burstCursor = 0;

  constructor(
    name: string,
    outerMaterial: THREE.MeshStandardMaterial,
    innerMaterial: THREE.MeshStandardMaterial,
    specs: readonly DebrisGroupSpec[],
    seeds: readonly number[],
  ) {
    this.root.name = name;
    this.specs = specs;
    this.seeds = seeds;
    for (let i = 0; i < MAX_BURSTS * MAX_FRAGMENTS; i++) {
      const outer = outerMaterial.clone();
      const inner = innerMaterial.clone();
      outer.transparent = true;
      inner.transparent = true;
      const materials: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [outer, inner];
      const mesh = new THREE.Mesh(EMPTY_GEOMETRY, materials);
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
    for (const spec of this.specs) {
      for (const count of FRAGMENT_COUNTS) {
        const variants: FragmentTemplate[][] = [];
        for (const seed of this.seeds) variants.push(spec.build(count, seed));
        this.templates.set(`${spec.group}:${count}`, variants);
      }
    }
    this.ready = true;
  }

  /** Spawn a burst at `pose`. `group` defaults to the first registered spec
   * (single-family pools like barrels never pass it). False = not ready or
   * zero budget — the caller falls back to a cheap puff. */
  spawn(pose: BurstPose, now: number, fragmentBudget: number, group?: string): boolean {
    if (!this.ready || fragmentBudget === 0) return false;
    const count: FragmentCount = fragmentBudget <= 6 ? 6 : 8;
    const variants = this.templates.get(`${group ?? this.specs[0].group}:${count}`);
    const template = variants?.[pose.id % (variants?.length || 1)];
    if (!template) return false;

    const burst = this.burstCursor;
    this.burstCursor = (this.burstCursor + 1) % MAX_BURSTS;
    const base = burst * MAX_FRAGMENTS;
    tempQuat.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]).normalize();

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
      slot.mesh.position.set(pose.x + tempCenter.x, pose.y + tempCenter.y, pose.z + tempCenter.z);
      slot.mesh.quaternion.copy(tempQuat);
      slot.mesh.scale.setScalar(1);
      slot.mesh.visible = true;
      slot.materials[0].opacity = 1;
      slot.materials[1].opacity = 1;
      slot.start = now;
      slot.radius = fragment.radius;
      slot.bounced = false;

      const angle = hashUnit(pose.id, i, 0x51f15e) * Math.PI * 2;
      const speed = 1.4 + hashUnit(pose.id, i, 0xa11ce) * 2.2;
      slot.vx = Math.cos(angle) * speed;
      slot.vz = Math.sin(angle) * speed;
      slot.vy = 1.8 + hashUnit(pose.id, i, 0xb4a4e1) * 2.6;
      slot.rx = (hashUnit(pose.id, i, 0x12345) - 0.5) * 8;
      slot.ry = (hashUnit(pose.id, i, 0x6789a) - 0.5) * 8;
      slot.rz = (hashUnit(pose.id, i, 0xbcdef) - 0.5) * 8;
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
    for (const variants of this.templates.values()) {
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
