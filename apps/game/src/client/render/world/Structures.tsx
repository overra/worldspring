// doc 06 — player-built structures. Renders every piece's collision AABBs as
// instanced boxes: one InstancedMesh per (world cell × tier × door/structure)
// bucket via chunkedDressing.ts, so a full 3000-piece world frustum-culls per
// chunk instead of vertex-processing every base on the island each frame.
// Rebuilt wholesale when clientWorld.structuresVersion bumps — placements
// happen at human rate, and a rebuild is O(pieces) matrix writes (the Trees
// felledVersion pattern).
//
// The rendered boxes ARE the collision boxes (pieceAabbs — the one shared
// geometry source), so what you see is exactly what blocks you. Open doors/
// gates derive zero collision boxes; a render-only swung-panel box is
// synthesized so the door stays visible.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { BUILD_CELL, BUILD_WALL_THICKNESS } from "@worldspring/shared/constants";
import { PIECE_DEFS, crateAabb, pieceAabbs, type StructurePiece } from "@worldspring/shared/structures";
import type { Aabb } from "@worldspring/shared/math";
import { clientWorld } from "@/client/runtime";
import {
  buildChunkedDressing,
  type ChunkedDressing,
  type DressingEntry,
} from "./chunkedDressing";

type BucketKey = "wood" | "scrap" | "woodDoor" | "scrapDoor";

const BUCKET_COLORS: Record<BucketKey, string> = {
  wood: "#8a6a3f",
  scrap: "#8d949c",
  woodDoor: "#6f4f28",
  scrapDoor: "#5c6670",
};

/** Door/gate panel height for the open-state visual (matches DOOR geometry
 * in structures.ts — render-only, never collision). */
const OPEN_DOOR_HEIGHT = 2.2;
const OPEN_GATE_HEIGHT = 2.6;


/** Damage tint multiplier from remaining hp (doc 06 M7): cracks at ≥50%
 * damage, heavy at ≥80% — instanced per-box via setColorAt. */
function damageTint(piece: StructurePiece): number {
  const maxHp = PIECE_DEFS[piece.kind].hp[piece.tier];
  if (maxHp <= 0) return 1;
  const dmg = 1 - piece.hp / maxHp;
  if (dmg >= 0.8) return 0.45;
  if (dmg >= 0.5) return 0.7;
  return 1;
}

/** Render-only panel for an OPEN door/gate: swung 90° to hug the hinge-side
 * jamb, sticking into the +Z/+X neighbor cell. Zero collision by design. */
function openPanelBox(piece: StructurePiece): Aabb | null {
  if (piece.edge === undefined) return null;
  const c = BUILD_CELL;
  const x0 = piece.gx * c;
  const z0 = piece.gz * c;
  const t = BUILD_WALL_THICKNESS;
  const len = piece.kind === "gate" ? c : 1.6;
  const h = piece.kind === "gate" ? OPEN_GATE_HEIGHT : OPEN_DOOR_HEIGHT;
  const y0 = piece.floorY;
  if (piece.edge === 0) {
    // Edge along X at z = z0 + c; hinge at the left jamb, panel swings +Z.
    const hinge = x0 + (piece.kind === "gate" ? 0 : (c - 1.6) / 2);
    return { minX: hinge, maxX: hinge + t, minZ: z0 + c, maxZ: z0 + c + len, y0, y1: y0 + h };
  }
  const hinge = z0 + (piece.kind === "gate" ? 0 : (c - 1.6) / 2);
  return { minX: x0 + c, maxX: x0 + c + len, minZ: hinge, maxZ: hinge + t, y0, y1: y0 + h };
}

function bucketOf(piece: StructurePiece): BucketKey {
  const door = piece.kind === "door" || piece.kind === "gate";
  if (piece.tier === 1) return door ? "scrapDoor" : "scrap";
  return door ? "woodDoor" : "wood";
}

const dummy = new THREE.Object3D();

const BUCKET_KEYS: readonly BucketKey[] = ["wood", "scrap", "woodDoor", "scrapDoor"];

function buildDressing(
  geometry: THREE.BoxGeometry,
  materials: Record<BucketKey, THREE.Material>,
): ChunkedDressing | null {
  const world = clientWorld.world;
  if (!world) return null;

  const entries: DressingEntry[] = [];
  const pushBox = (bucket: number, box: Aabb, tint: number): void => {
    dummy.position.set(
      (box.minX + box.maxX) / 2,
      (box.y0 + box.y1) / 2,
      (box.minZ + box.maxZ) / 2,
    );
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(box.maxX - box.minX, box.y1 - box.y0, box.maxZ - box.minZ);
    dummy.updateMatrix();
    // Damage tiers (doc 06 M7): per-instance darkening multiplies the
    // bucket material color (white = untouched).
    entries.push({
      bucket,
      matrix: dummy.matrix.clone(),
      color: new THREE.Color().setScalar(tint),
    });
  };
  for (const piece of world.structures.pieces.values()) {
    const bucket = BUCKET_KEYS.indexOf(bucketOf(piece));
    const tint = damageTint(piece);
    for (const box of pieceAabbs(piece)) pushBox(bucket, box, tint);
    // Crates derive zero collision boxes; render the shared crateAabb — the
    // raycast-only attribution box, so what you see is what an axe hits.
    if (piece.kind === "crate") pushBox(bucket, crateAabb(piece), tint);
    if ((piece.kind === "door" || piece.kind === "gate") && piece.open === true) {
      const panel = openPanelBox(piece);
      if (panel) pushBox(bucket, panel, tint);
    }
  }
  return buildChunkedDressing(
    BUCKET_KEYS.map((key) => ({
      geometry,
      material: materials[key],
      castShadow: true,
      receiveShadow: true,
    })),
    entries,
  );
}

export function Structures(): ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const builtVersion = useRef(-1);
  const dressingRef = useRef<ChunkedDressing | null>(null);

  const shared = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mat = (key: BucketKey): THREE.Material =>
      new THREE.MeshStandardMaterial({ color: BUCKET_COLORS[key], roughness: 0.9 });
    const materials: Record<BucketKey, THREE.Material> = {
      wood: mat("wood"),
      scrap: mat("scrap"),
      woodDoor: mat("woodDoor"),
      scrapDoor: mat("scrapDoor"),
    };
    return { geometry, materials };
  }, []);

  useEffect(() => {
    return () => {
      dressingRef.current?.dispose();
      dressingRef.current = null;
      // Same remount hardening as Stumps/PlantedTrees: Fast Refresh re-runs
      // effects but preserves refs — a matching version would skip the
      // rebuild and leave every base invisible until the next placement.
      builtVersion.current = -1;
      shared.geometry.dispose();
      for (const m of Object.values(shared.materials)) m.dispose();
    };
  }, [shared]);

  useFrame((state) => {
    const root = rootRef.current;
    if (!root) return;
    dressingRef.current?.updateVisibility(state.camera.position.x, state.camera.position.z);
    if (builtVersion.current === clientWorld.structuresVersion) return;
    builtVersion.current = clientWorld.structuresVersion;
    dressingRef.current?.dispose();
    dressingRef.current = null;
    root.clear();
    const dressing = buildDressing(shared.geometry, shared.materials);
    if (!dressing) return;
    dressingRef.current = dressing;
    root.add(dressing.group);
  });

  return <group ref={rootRef} />;
}
