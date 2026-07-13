// Bodies left behind by dead players and zombies: pooled rigged characters
// frozen in death poses, scavengeable via the pickup prompt (NetSystem owns
// the prompt — no labels here). Corpses are static: each rig plays a
// 1-keyframe Death_*_Pose clip once on assignment and is never mixer-stepped
// again. The one exception is a FRESH kill — a corpse id the client first
// sees after being connected a few seconds plays the full death clip once
// (clampWhenFinished holds the final frame), stepping its mixer per frame
// only until the clip duration elapses.

import { useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_PLAYERS } from "@worldspring/shared/constants";
import { clientWorld } from "@/client/runtime";
import {
  createCharacterRig,
  useCharacterModel,
  type CharacterKind,
  type CharacterRig,
} from "./CharacterRig";

// Pool caps. Corpse counts are TTL-bounded (PLAYER_CORPSE_TTL_S = 300s,
// ZOMBIE_CORPSE_TTL_S = 120s) and interest-filtered server-side, so this much
// headroom is generous; overflow corpses simply skip rendering (their loot
// prompt still works) — never crash. The pools are lazy (grown on demand), so a
// larger ceiling costs nothing until that many corpses are actually in view.
// Player corpses scale with room size so a full-lobby massacre still renders.
const PLAYER_POOL_SIZE = MAX_PLAYERS;
const ZOMBIE_POOL_SIZE = 24;

const GROUND_OFFSET = 0.02; // lift over the terrain to dodge z-fighting
/** New corpse ids seen before this much connected time are the initial world
 * download, not witnessed kills — they skip straight to the frozen pose. */
const FRESH_KILL_MIN_CONNECTED_S = 3;
/** One mixer step pushes a 1-keyframe pose clip onto its (only) frame. */
const POSE_FREEZE_DT = 0.01;
const MAX_FRAME_DT = 5; // same throttled-tab guard as RemotePlayers/Zombies

// Death variants, indexed by corpse.id modulo so bodies vary. The pose clip
// at [v] is the 1-keyframe final frame of the full clip at [v] (verified
// against the GLB animation lists; the skeleton pack names its third death
// clip "Death_C_Skeletons" — there is no plain "Death_C").
const DEATH_VARIANTS: Record<CharacterKind, { poses: string[]; clips: string[] }> = {
  survivor: {
    poses: ["Death_A_Pose", "Death_B_Pose"],
    clips: ["Death_A", "Death_B"],
  },
  zombie: {
    poses: ["Death_A_Pose", "Death_B_Pose", "Death_C_Pose"],
    clips: ["Death_A", "Death_B", "Death_C_Skeletons"],
  },
};

// Lifeless casts over the authored palettes: ashen survivors, the live
// zombies' subtle green (see Zombies.tsx NORMAL_TINT) knocked down a step.
const CORPSE_TINT: Record<CharacterKind, THREE.Color> = {
  survivor: new THREE.Color("#b9b4ab"),
  zombie: new THREE.Color("#b6bfab"),
};

interface CorpseSlot {
  rig: CharacterRig;
  /** Seconds of fresh-kill death clip left; 0 = frozen, zero mixer cost. */
  animRemaining: number;
}

interface CorpsePool {
  kind: CharacterKind;
  slots: CorpseSlot[];
  byId: Map<number, number>;
  free: number[];
  /** Max rigs to allocate. Rigs grow lazily up to this cap; overflow corpses
   * past it skip rendering (their loot prompt still works) — the exact old
   * fixed-pool behavior, just allocated on demand instead of all at mount. */
  cap: number;
}

/** Allocate one corpse rig into the pool (lazy growth up to cap). The rig
 * starts DETACHED + pre-tinted like the old eager createPool; the caller
 * acquires (and attaches) it in the same frame. No-op at cap so overflow
 * corpses skip. */
function growPool(pool: CorpsePool): void {
  if (pool.slots.length >= pool.cap) return;
  const idx = pool.slots.length;
  const rig = createCharacterRig(pool.kind);
  rig.root.visible = false;
  // Pre-tint on allocation — assignSlot relies on the tint already being set
  // and never re-tints (createPool did this too).
  rig.setTint(CORPSE_TINT[pool.kind]);
  pool.slots.push({ rig, animRemaining: 0 });
  pool.free.push(idx);
}

function createPool(kind: CharacterKind, size: number): CorpsePool {
  // Empty pool: corpse rigs (skinned — the join-hitch cost) are cloned lazily
  // on first sighting via growPool up to `size`. Pre-cloning 24+24 rigs at
  // mount is exactly what this avoids; overflow behavior past the cap is
  // unchanged. Pooled rigs are DETACHED + hidden until acquire (three r184's
  // updateMatrixWorld recurses into ALL children).
  return { kind, slots: [], byId: new Map(), free: [], cap: size };
}

function releaseMissing(pool: CorpsePool, presentIds: Set<number>): void {
  for (const [id, idx] of pool.byId) {
    if (presentIds.has(id)) continue;
    pool.byId.delete(id); // Map tolerates delete-while-iterating
    pool.free.push(idx);
    const slot = pool.slots[idx];
    slot.rig.root.visible = false;
    // Detach the idle rig (createPool). CorpsePool holds no root reference,
    // so detach via the rig itself — same API dispose uses.
    slot.rig.root.removeFromParent();
    slot.animRemaining = 0;
  }
}

/** Rig setup on (re)assignment: playPose resets whatever clamped pose the
 * slot's previous corpse left behind, so reuse needs no extra cleanup. */
function assignSlot(slot: CorpseSlot, pool: CorpsePool, corpseId: number, fresh: boolean): void {
  const variants = DEATH_VARIANTS[pool.kind];
  const variant = corpseId % variants.poses.length;
  slot.rig.root.visible = true;
  slot.animRemaining = 0;
  if (fresh) {
    const duration = slot.rig.playPose(variants.clips[variant]);
    if (duration !== null) {
      slot.animRemaining = duration;
      return; // per-frame updates animate the fall, then clamp on the pose
    }
    // Missing clip (shouldn't happen — names verified): frozen-pose fallback.
  }
  if (slot.rig.playPose(variants.poses[variant]) !== null) slot.rig.update(POSE_FREEZE_DT);
}

// Reused per-frame scratch (cleared each frame).
const presentIds = new Set<number>();

export function Corpses(): ReactElement {
  useCharacterModel("survivor");
  useCharacterModel("zombie");

  const pools = useMemo(() => {
    const root = new THREE.Group();
    return {
      root,
      player: createPool("survivor", PLAYER_POOL_SIZE),
      zombie: createPool("zombie", ZOMBIE_POOL_SIZE),
    };
  }, []);

  /** Seconds since mount (mounts at phase `playing`, i.e. on welcome). */
  const connectedFor = useRef(0);
  /** Highest corpse id ever seen. Entity ids are monotonic (shared
   * nextEntityId space with loot), so id > watermark ⇔ the corpse was
   * created after everything we've already seen — an old body re-entering
   * interest range can never replay its death animation. */
  const idWatermark = useRef(-1);

  useFrame((_, delta) => {
    const corpses = clientWorld.corpses;
    connectedFor.current += delta;
    const dt = Math.min(delta, MAX_FRAME_DT);

    presentIds.clear();
    for (const corpse of corpses) presentIds.add(corpse.id);
    releaseMissing(pools.player, presentIds);
    releaseMissing(pools.zombie, presentIds);

    const watermark = idWatermark.current;
    const liveClient = connectedFor.current > FRESH_KILL_MIN_CONNECTED_S;
    let maxId = watermark;

    for (const corpse of corpses) {
      if (corpse.id > maxId) maxId = corpse.id;
      const pool = corpse.kind === "zombie" ? pools.zombie : pools.player;
      let idx = pool.byId.get(corpse.id);
      if (idx === undefined) {
        if (pool.free.length === 0) growPool(pool); // lazy grow up to pool.cap
        idx = pool.free.pop();
        if (idx === undefined) continue; // at cap: skip the excess (loot prompt still works)
        pool.byId.set(corpse.id, idx);
        // Re-attach before the pose/position writes (see createPool); this
        // priority-0 useFrame runs before the priority-2 composer render.
        pools.root.add(pool.slots[idx].rig.root);
        // Fresh kill = first sighting of an id newer than everything seen,
        // on a client past the initial world download.
        assignSlot(pool.slots[idx], pool, corpse.id, liveClient && corpse.id > watermark);
      }
      const slot = pool.slots[idx];
      slot.rig.root.position.set(corpse.x, corpse.y + GROUND_OFFSET, corpse.z);
      slot.rig.root.rotation.y = corpse.yaw;
      if (slot.animRemaining > 0) {
        // Step past the end once (clampWhenFinished holds the last frame),
        // then never touch the mixer again for this body.
        slot.rig.update(dt);
        slot.animRemaining -= dt;
      }
    }
    idWatermark.current = maxId;
  });

  return <primitive object={pools.root} />;
}
