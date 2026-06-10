// Rigged GLTF character system — replaces the procedural box humanoids.
// One GLB per kind (KayKit Knight = survivor, Skeleton Minion = zombie) is
// loaded once through drei's useGLTF cache; every pooled rig is a
// SkeletonUtils.clone of that scene with per-rig cloned materials (shared
// geometry), an AnimationMixer, a locomotion crossfade state machine, and
// one-shot attack/hit overlays. Held weapons attach to the `handslot.r`
// bone ("handslotr" after three.js name sanitization strips the dot).

import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { PLAYER_HEIGHT } from "@/shared/constants";
import { ITEM_DEFS, type ItemType } from "@/shared/items";

export type CharacterKind = "survivor" | "zombie";
export type LocomotionState = "idle" | "walk" | "run" | "shamble";
export type OverlayKind =
  | "attack_melee"
  | "attack_punch"
  | "attack_shoot1h"
  | "attack_shoot2h"
  | "hit";

export interface CharacterRig {
  /** Root group — caller sets position + rotation.y. Feet at local y=0,
   * head top at PLAYER_HEIGHT (before any caller scale). */
  root: THREE.Group;
  /** Crossfades to the given looping state. No-op when already there. */
  setLocomotion(state: LocomotionState): void;
  /** One-shot full-body action (LoopOnce). Locomotion weight fades down for
   * the duration and back up when the mixer fires "finished". */
  playOverlay(kind: OverlayKind): void;
  /** Low-level: parents an arbitrary object to the right-hand slot bone
   * (replacing whatever is there). Prefer setHeldItem for inventory items. */
  attachHeldItem(mesh: THREE.Object3D | null): void;
  /** Builds the weapon/prop mesh + grip transform for an item type.
   * No-op when the type is unchanged. */
  setHeldItem(item: ItemType | null): void;
  /** Multiplies every material color by `color`; null restores the
   * authored palette. Materials are per-rig clones — tints never leak. */
  setTint(color: THREE.Color | null): void;
  /** Steps the mixer. Callers may accumulate dt across skipped frames to
   * throttle far-away rigs — animation speed stays correct. */
  update(dt: number): void;
  dispose(): void;
}

// --- Animation tuning ---

const LOCO_FADE_S = 0.2;
const OVERLAY_FADE_IN_S = 0.08;
const OVERLAY_FADE_OUT_S = 0.15;

// --- Clip mapping (verified against the GLB animation lists) ---

interface ClipTable {
  locomotion: Record<LocomotionState, string>;
  overlay: Record<OverlayKind, string>;
}

const CLIP_TABLE: Record<CharacterKind, ClipTable> = {
  survivor: {
    locomotion: {
      idle: "Idle",
      walk: "Walking_A",
      run: "Running_A",
      shamble: "Walking_A", // survivors never shamble; safe fallback
    },
    overlay: {
      attack_melee: "1H_Melee_Attack_Chop",
      attack_punch: "Unarmed_Melee_Attack_Punch_A",
      attack_shoot1h: "1H_Ranged_Shoot",
      attack_shoot2h: "2H_Ranged_Shoot",
      hit: "Hit_A",
    },
  },
  zombie: {
    locomotion: {
      idle: "Idle",
      walk: "Walking_D_Skeletons",
      run: "Running_A",
      shamble: "Walking_D_Skeletons", // the signature shamble
    },
    overlay: {
      attack_melee: "Unarmed_Melee_Attack_Punch_A",
      attack_punch: "Unarmed_Melee_Attack_Punch_A",
      attack_shoot1h: "Unarmed_Melee_Attack_Punch_A",
      attack_shoot2h: "Unarmed_Melee_Attack_Punch_A",
      hit: "Hit_A",
    },
  },
};

/** Which one-shot overlay a swing should play for a given equipped item. */
export function overlayForItem(item: ItemType | null): OverlayKind {
  if (item === null) return "attack_punch";
  const def = ITEM_DEFS[item];
  if (def.kind === "ranged") return item === "pistol" ? "attack_shoot1h" : "attack_shoot2h";
  if (def.kind === "melee") return "attack_melee";
  return "attack_punch";
}

// --- Held-item grip transforms (ONE tunable place) ---
// Weapon meshes are authored barrel/business-end toward -Z with the grip at
// the origin (handle up +Y for the axe). The KayKit hand slot basis (measured
// in-game during the 1H_Ranged_Shoot aim pose): +X = aim/strike direction,
// +Y = blade-up, +Z = lateral. So guns and the axe rotate Y-90° to map their
// -Z onto slot +X. Positions are in meters at world scale (the wrapper
// cancels the rig scale).

export interface GripTransform {
  pos: readonly [number, number, number];
  /** Euler XYZ, degrees. */
  rotDeg: readonly [number, number, number];
  scale: number;
}

const DEFAULT_GRIP: GripTransform = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };

export const GRIP_TRANSFORMS: Partial<Record<ItemType, GripTransform>> = {
  pistol: { pos: [0, 0.03, 0], rotDeg: [0, -90, 0], scale: 1 },
  rifle: { pos: [0, 0.05, 0], rotDeg: [0, -90, 0], scale: 1 },
  shotgun: { pos: [0, 0.04, 0], rotDeg: [0, -90, 0], scale: 1 },
  axe: { pos: [0, 0, 0], rotDeg: [0, -90, 0], scale: 1 },
};

// --- Held-item mesh builders (carried over from the old box Humanoid) ---

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const AXE_HANDLE_COLOR = "#6b4a2f";
const GUN_METAL_COLOR = "#2e2e32";

// Held-item materials are identical across rigs — cache by color.
const heldMaterialCache = new Map<string, THREE.MeshLambertMaterial>();

function heldMaterial(color: string): THREE.MeshLambertMaterial {
  const cached = heldMaterialCache.get(color);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({ color });
  heldMaterialCache.set(color, mat);
  return mat;
}

function heldBox(color: string): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT_BOX, heldMaterial(color));
  mesh.castShadow = true;
  return mesh;
}

function buildHeldItem(type: ItemType): THREE.Object3D {
  const def = ITEM_DEFS[type];
  if (type === "pistol") {
    // Dark two-box "L": slide pointing -Z plus a grip.
    const g = new THREE.Group();
    const slide = heldBox(def.color);
    slide.scale.set(0.05, 0.07, 0.26);
    slide.position.set(0, 0.02, -0.1);
    const grip = heldBox(def.color);
    grip.scale.set(0.045, 0.14, 0.06);
    grip.position.set(0, -0.06, 0.02);
    g.add(slide, grip);
    return g;
  }
  if (type === "rifle") {
    // Long thin bolt-action silhouette (~0.9m): metal barrel forward, wooden
    // stock (item color) at the shoulder end.
    const g = new THREE.Group();
    const barrel = heldBox(GUN_METAL_COLOR);
    barrel.scale.set(0.05, 0.06, 0.56);
    barrel.position.set(0, 0.03, -0.4);
    const stock = heldBox(def.color);
    stock.scale.set(0.06, 0.09, 0.34);
    stock.position.set(0, 0, 0.05);
    g.add(barrel, stock);
    return g;
  }
  if (type === "shotgun") {
    // Slightly shorter (~0.7m), twin-tone: stubby metal barrels + wooden
    // stock/forend in the item color.
    const g = new THREE.Group();
    const barrels = heldBox(GUN_METAL_COLOR);
    barrels.scale.set(0.08, 0.05, 0.42);
    barrels.position.set(0, 0.03, -0.27);
    const stock = heldBox(def.color);
    stock.scale.set(0.07, 0.1, 0.28);
    stock.position.set(0, 0, 0.08);
    g.add(barrels, stock);
    return g;
  }
  if (type === "axe") {
    // Wooden stick + red head box near the top.
    const g = new THREE.Group();
    const handle = heldBox(AXE_HANDLE_COLOR);
    handle.scale.set(0.05, 0.55, 0.05);
    handle.position.y = 0.18;
    const head = heldBox(def.color);
    head.scale.set(0.22, 0.12, 0.06);
    head.position.set(0, 0.42, -0.06);
    g.add(handle, head);
    return g;
  }
  // Generic prop: small tinted box.
  const m = heldBox(def.color);
  m.scale.set(0.16, 0.16, 0.16);
  return m;
}

// --- GLB loading + per-kind source registry ---

const MODEL_URLS: Record<CharacterKind, string> = {
  survivor: "/models/survivor.glb",
  zombie: "/models/zombie.glb",
};

interface GltfLike {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

interface CharacterSource {
  scene: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  /** Uniform scale putting head top at PLAYER_HEIGHT. */
  scale: number;
  /** Post-scale y offset putting the feet at local y=0. */
  yOffset: number;
}

const SOURCES = new Map<CharacterKind, CharacterSource>();

// The animation-excursion margin applied to the bind-pose bounding sphere so
// frustum culling stays correct through lunges/swings (the meshopt-quantized
// raw geometry bounds are useless for skinned meshes).
const CULL_SPHERE_MARGIN = 1.6;

function buildSource(gltf: GltfLike): CharacterSource {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  // Measure the bind-pose bounds. Skinned meshes need the bone-aware path:
  // their raw geometry is quantized to [-1,1] (KHR_mesh_quantization) and only
  // takes real-world shape after skinning.
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  box.makeEmpty();
  scene.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) {
      obj.skeleton.update();
      obj.computeBoundingBox();
      const skinnedBox = obj.boundingBox;
      if (!skinnedBox) return;
      // Replace the bogus quantized geometry bounds so frustum culling works
      // for every clone (geometry is shared — do this once per source).
      const sphere = new THREE.Sphere();
      skinnedBox.getBoundingSphere(sphere);
      sphere.radius *= CULL_SPHERE_MARGIN;
      obj.geometry.boundingSphere = sphere;
      obj.geometry.boundingBox = skinnedBox.clone();
      meshBox.copy(skinnedBox).applyMatrix4(obj.matrixWorld);
      box.union(meshBox);
      return;
    }
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry;
      if (geo.boundingBox === null) geo.computeBoundingBox();
      if (geo.boundingBox === null) return;
      meshBox.copy(geo.boundingBox).applyMatrix4(obj.matrixWorld);
      box.union(meshBox);
    }
  });

  const rawHeight = Math.max(box.max.y - box.min.y, 1e-3);
  const scale = PLAYER_HEIGHT / rawHeight;
  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) clips.set(clip.name, clip);
  return { scene, clips, scale, yOffset: -box.min.y * scale };
}

useGLTF.preload(MODEL_URLS.survivor);
useGLTF.preload(MODEL_URLS.zombie);

/**
 * Suspends until the GLB for `kind` is loaded (drei cache, meshopt decoder
 * enabled by default) and registers it for createCharacterRig. Call at the
 * top of any component whose pool creates rigs of that kind.
 */
export function useCharacterModel(kind: CharacterKind): void {
  const gltf = useGLTF(MODEL_URLS[kind]);
  if (!SOURCES.has(kind)) SOURCES.set(kind, buildSource(gltf));
}

// --- Rig factory ---

type MaterialWithColor = THREE.Material & { color: THREE.Color };

function hasColor(mat: THREE.Material): mat is MaterialWithColor {
  return (mat as Partial<MaterialWithColor>).color instanceof THREE.Color;
}

export function createCharacterRig(kind: CharacterKind): CharacterRig {
  const source = SOURCES.get(kind);
  if (!source) {
    throw new Error(
      `createCharacterRig("${kind}"): model not registered — render after useCharacterModel("${kind}")`,
    );
  }

  const root = new THREE.Group();
  const model = cloneSkeleton(source.scene);
  model.scale.setScalar(source.scale);
  model.position.y = source.yOffset;
  // KayKit models are authored facing +Z; the game's yaw-0 convention faces
  // -Z (see @/shared/math) — flip the model inside the root.
  model.rotation.y = Math.PI;
  root.add(model);

  // Clone materials per rig (geometries stay shared) so setTint never leaks
  // across the pool. Meshes sharing a source material share the clone.
  const matEntries: { material: MaterialWithColor; base: THREE.Color }[] = [];
  const matMap = new Map<THREE.Material, THREE.Material>();
  const remap = (mat: THREE.Material): THREE.Material => {
    const existing = matMap.get(mat);
    if (existing) return existing;
    const cloned = mat.clone();
    matMap.set(mat, cloned);
    if (hasColor(cloned)) matEntries.push({ material: cloned, base: cloned.color.clone() });
    return cloned;
  };
  model.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.material = Array.isArray(obj.material) ? obj.material.map(remap) : remap(obj.material);
  });

  // --- Animation state machine ---

  const mixer = new THREE.AnimationMixer(model);
  const table = CLIP_TABLE[kind];
  const actionCache = new Map<string, THREE.AnimationAction>();
  const actionFor = (clipName: string): THREE.AnimationAction | null => {
    const cached = actionCache.get(clipName);
    if (cached) return cached;
    const clip = source.clips.get(clipName);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    actionCache.set(clipName, action);
    return action;
  };

  const idleAction = actionFor(table.locomotion.idle);
  if (!idleAction) throw new Error(`CharacterRig("${kind}"): missing idle clip`);
  const locoActions: Record<LocomotionState, THREE.AnimationAction> = {
    idle: idleAction,
    walk: actionFor(table.locomotion.walk) ?? idleAction,
    run: actionFor(table.locomotion.run) ?? idleAction,
    shamble: actionFor(table.locomotion.shamble) ?? idleAction,
  };

  // Random per-rig phase so pooled rigs don't animate in lockstep.
  const phaseSeed = Math.random();

  let locoState: LocomotionState = "idle";
  let locoAction = locoActions.idle;
  let overlayAction: THREE.AnimationAction | null = null;

  locoAction.play();
  locoAction.time = phaseSeed * locoAction.getClip().duration;

  const setLocomotion = (next: LocomotionState): void => {
    if (next === locoState) return;
    locoState = next;
    const nextAction = locoActions[next];
    if (nextAction === locoAction) return; // two states sharing one clip
    const prev = locoAction;
    locoAction = nextAction;
    nextAction.reset();
    nextAction.time = phaseSeed * nextAction.getClip().duration;
    if (overlayAction) {
      // Hidden under the overlay: swap silently at weight 0; the "finished"
      // handler fades the (new) locomotion action back in.
      prev.stop();
      nextAction.play();
      nextAction.setEffectiveWeight(0);
      return;
    }
    prev.fadeOut(LOCO_FADE_S);
    nextAction.fadeIn(LOCO_FADE_S).play();
  };

  const playOverlay = (overlayKind: OverlayKind): void => {
    const action = actionFor(table.overlay[overlayKind]) ?? actionFor(table.overlay.attack_punch);
    if (!action) return;
    if (overlayAction === action) {
      // Rapid retrigger of the same swing: snap-restart at full weight.
      action.reset();
      action.setEffectiveWeight(1);
      action.play();
    } else {
      if (overlayAction) overlayAction.fadeOut(OVERLAY_FADE_IN_S);
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      // NOTE: clamp instead of letting three disable the action at the clip
      // end — disabling drops its weight instantly and the pose pops toward
      // the bind pose for the fade-back duration. Clamping holds the last
      // frame while we fade locomotion back in, then the action just sits
      // paused at weight 0 (skipped by the mixer) until reused.
      action.clampWhenFinished = true;
      action.fadeIn(OVERLAY_FADE_IN_S).play();
      overlayAction = action;
    }
    locoAction.fadeOut(OVERLAY_FADE_IN_S);
  };

  const onFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== overlayAction) return; // a superseded overlay ended
    event.action.fadeOut(OVERLAY_FADE_OUT_S);
    overlayAction = null;
    locoAction.fadeIn(OVERLAY_FADE_OUT_S);
  };
  mixer.addEventListener("finished", onFinished);

  // --- Held item ---

  const handSlot = model.getObjectByName("handslotr") ?? null;
  // Weapon meshes are authored at world scale; the wrapper cancels the rig
  // scale so they keep their intended size under the scaled skeleton.
  const heldWrapper = new THREE.Group();
  heldWrapper.scale.setScalar(1 / source.scale);
  if (handSlot) handSlot.add(heldWrapper);

  let attached: THREE.Object3D | null = null;
  let heldType: ItemType | null = null;
  let heldTypeValid = true; // false after a raw attachHeldItem()

  const attachHeldItem = (mesh: THREE.Object3D | null): void => {
    if (attached) heldWrapper.remove(attached);
    attached = mesh;
    heldType = null;
    heldTypeValid = mesh === null;
    if (mesh) heldWrapper.add(mesh);
  };

  const setHeldItem = (item: ItemType | null): void => {
    if (heldTypeValid && item === heldType) return;
    if (attached) heldWrapper.remove(attached);
    attached = null;
    heldType = item;
    heldTypeValid = true;
    if (item === null) return;
    const mesh = buildHeldItem(item);
    const grip = GRIP_TRANSFORMS[item] ?? DEFAULT_GRIP;
    mesh.position.set(grip.pos[0], grip.pos[1], grip.pos[2]);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(grip.rotDeg[0]),
      THREE.MathUtils.degToRad(grip.rotDeg[1]),
      THREE.MathUtils.degToRad(grip.rotDeg[2]),
    );
    mesh.scale.multiplyScalar(grip.scale);
    attached = mesh;
    heldWrapper.add(mesh);
  };

  // --- Tint ---

  const setTint = (color: THREE.Color | null): void => {
    for (const entry of matEntries) {
      entry.material.color.copy(entry.base);
      if (color) entry.material.color.multiply(color);
    }
  };

  const update = (dt: number): void => {
    if (dt <= 0) return;
    mixer.update(dt);
  };

  const dispose = (): void => {
    mixer.removeEventListener("finished", onFinished);
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    for (const mat of matMap.values()) mat.dispose();
    root.removeFromParent();
  };

  return {
    root,
    setLocomotion,
    playOverlay,
    attachHeldItem,
    setHeldItem,
    setTint,
    update,
    dispose,
  };
}
