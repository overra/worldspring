// Shared low-poly humanoid rig: a THREE.Group of flat-colored boxes (torso,
// head, arms, legs) with a right-hand item slot and a procedural animation
// update(). Used by PlayerCamera (local body), RemotePlayers, and Zombies.
// No skeletons, no assets — limb swing is plain sin math driven from useFrame.

import * as THREE from "three";
import { ITEM_DEFS, type ItemType } from "@/shared/items";

export interface HumanoidColors {
  shirt: string;
  pants: string;
  skin: string;
}

export interface HumanoidRig {
  /** Root — caller sets position + rotation.y. */
  group: THREE.Group;
  /** Torso + head + arms, pivoted at the hip. Bobbed by update(); tilt
   * rotation.x for the zombie hunch AFTER calling update(). */
  upper: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  shirtMaterial: THREE.MeshLambertMaterial;
  pantsMaterial: THREE.MeshLambertMaterial;
  skinMaterial: THREE.MeshLambertMaterial;
  /** Swap the right-hand prop. No-op when the type is unchanged. */
  setHeldItem(item: ItemType | null): void;
  /**
   * Procedural animation. timeSec is any monotonic seconds clock,
   * speedFactor 0 = idle, 1 = walk, ~1.35 = sprint. While `attacking`,
   * the right arm swings forward in ~0.3s cycles.
   */
  update(timeSec: number, speedFactor: number, attacking: boolean): void;
}

/** Local-player FX bridge: InputController stamps attacks, PlayerCamera reads.
 * Both files live in this build area; uses performance.now() milliseconds. */
export const localPlayerAnim = { attackUntil: 0 };

export const ATTACK_ANIM_S = 0.3;

// --- Proportions (PLAYER_HEIGHT 1.8: feet 0, hip 0.85, head top 1.8) ---
const HIP_Y = 0.85;
const TORSO_LOCAL_Y = 0.325; // torso center above hip pivot
const HEAD_LOCAL_Y = 0.8; // world ~1.65
const SHOULDER_LOCAL_Y = 0.55;
const SHOULDER_X = 0.32;
const ARM_MESH_Y = -0.25;
const HAND_Y = -0.55;
const LEG_X = 0.13;
const LEG_MESH_Y = -0.425;

const WALK_FREQ = 9; // rad/s of the sin walk cycle
const LEG_SWING = 0.65;
const ARM_SWING = 0.5;
const BOB_AMPLITUDE = 0.05;

// Shared geometries — every rig reuses these.
const TORSO_GEO = new THREE.BoxGeometry(0.5, 0.65, 0.3);
const HEAD_GEO = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const ARM_GEO = new THREE.BoxGeometry(0.14, 0.6, 0.14);
const LEG_GEO = new THREE.BoxGeometry(0.16, 0.85, 0.16);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const AXE_HANDLE_COLOR = "#6b4a2f";

// Held-item materials are identical across rigs — cache by color.
const heldMaterialCache = new Map<string, THREE.MeshLambertMaterial>();

function heldMaterial(color: string): THREE.MeshLambertMaterial {
  const cached = heldMaterialCache.get(color);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({ color });
  heldMaterialCache.set(color, mat);
  return mat;
}

function buildHeldItem(type: ItemType): THREE.Object3D {
  const def = ITEM_DEFS[type];
  if (type === "pistol") {
    // Dark two-box "L": slide pointing -Z plus a grip.
    const g = new THREE.Group();
    const slide = new THREE.Mesh(UNIT_BOX, heldMaterial(def.color));
    slide.scale.set(0.05, 0.07, 0.26);
    slide.position.set(0, 0.02, -0.1);
    const grip = new THREE.Mesh(UNIT_BOX, heldMaterial(def.color));
    grip.scale.set(0.045, 0.14, 0.06);
    grip.position.set(0, -0.06, 0.02);
    g.add(slide, grip);
    return g;
  }
  if (type === "axe") {
    // Wooden stick + red head box near the top.
    const g = new THREE.Group();
    const handle = new THREE.Mesh(UNIT_BOX, heldMaterial(AXE_HANDLE_COLOR));
    handle.scale.set(0.05, 0.55, 0.05);
    handle.position.y = 0.18;
    const head = new THREE.Mesh(UNIT_BOX, heldMaterial(def.color));
    head.scale.set(0.22, 0.12, 0.06);
    head.position.set(0, 0.42, -0.06);
    g.add(handle, head);
    return g;
  }
  // Generic prop: small tinted box.
  const m = new THREE.Mesh(UNIT_BOX, heldMaterial(def.color));
  m.scale.set(0.16, 0.16, 0.16);
  return m;
}

export function createHumanoid(colors: HumanoidColors): HumanoidRig {
  const shirtMaterial = new THREE.MeshLambertMaterial({ color: colors.shirt });
  const pantsMaterial = new THREE.MeshLambertMaterial({ color: colors.pants });
  const skinMaterial = new THREE.MeshLambertMaterial({ color: colors.skin });

  const group = new THREE.Group();

  // Upper body pivots at the hip so a zombie hunch tilts naturally.
  const upper = new THREE.Group();
  upper.position.y = HIP_Y;
  group.add(upper);

  const torso = new THREE.Mesh(TORSO_GEO, shirtMaterial);
  torso.position.y = TORSO_LOCAL_Y;
  upper.add(torso);

  const head = new THREE.Mesh(HEAD_GEO, skinMaterial);
  head.position.y = HEAD_LOCAL_Y;
  upper.add(head);

  const makeArm = (side: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(side * SHOULDER_X, SHOULDER_LOCAL_Y, 0);
    const mesh = new THREE.Mesh(ARM_GEO, skinMaterial);
    mesh.position.y = ARM_MESH_Y;
    pivot.add(mesh);
    upper.add(pivot);
    return pivot;
  };
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);

  const handSlot = new THREE.Group();
  handSlot.position.y = HAND_Y;
  rightArm.add(handSlot);

  const makeLeg = (side: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(side * LEG_X, HIP_Y, 0);
    const mesh = new THREE.Mesh(LEG_GEO, pantsMaterial);
    mesh.position.y = LEG_MESH_Y;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  };
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);

  let heldType: ItemType | null = null;
  let lastTime = 0;
  let attackRemaining = 0;

  const setHeldItem = (item: ItemType | null): void => {
    if (item === heldType) return;
    heldType = item;
    handSlot.clear();
    if (item !== null) handSlot.add(buildHeldItem(item));
  };

  const update = (timeSec: number, speedFactor: number, attacking: boolean): void => {
    const dt = Math.min(Math.max(timeSec - lastTime, 0), 0.1);
    lastTime = timeSec;

    const phase = timeSec * WALK_FREQ;
    const swing = Math.sin(phase) * speedFactor;
    leftLeg.rotation.x = swing * LEG_SWING;
    rightLeg.rotation.x = -swing * LEG_SWING;
    leftArm.rotation.x = -swing * ARM_SWING;
    upper.position.y = HIP_Y + Math.abs(Math.sin(phase)) * BOB_AMPLITUDE * speedFactor;

    if (attacking && attackRemaining <= 0) attackRemaining = ATTACK_ANIM_S;
    if (attackRemaining > 0) {
      attackRemaining -= dt;
      const p = 1 - Math.max(attackRemaining, 0) / ATTACK_ANIM_S;
      // Forward punch/swing: positive rotation.x moves the arm toward -Z.
      rightArm.rotation.x = Math.sin(p * Math.PI) * 2.1;
      return;
    }
    rightArm.rotation.x = swing * ARM_SWING;
  };

  return {
    group,
    upper,
    torso,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    shirtMaterial,
    pantsMaterial,
    skinMaterial,
    setHeldItem,
    update,
  };
}
