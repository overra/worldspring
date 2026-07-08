// doc 06 — player-built structures. Renders every piece's collision AABBs as
// instanced boxes: one InstancedMesh per (tier × door/structure) bucket, so
// a full 3000-piece world stays at ≤4 draw calls. Rebuilt wholesale when
// clientWorld.structuresVersion bumps — placements happen at human rate, and
// a rebuild is O(pieces) matrix writes (the Trees felledVersion pattern).
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
import { pieceAabbs, type StructurePiece } from "@worldspring/shared/structures";
import type { Aabb } from "@worldspring/shared/math";
import { clientWorld } from "@/client/runtime";

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

function buildMeshes(
  geometry: THREE.BoxGeometry,
  materials: Record<BucketKey, THREE.Material>,
): { group: THREE.Group; meshes: THREE.InstancedMesh[] } {
  const world = clientWorld.world;
  const group = new THREE.Group();
  const meshes: THREE.InstancedMesh[] = [];
  if (!world) return { group, meshes };

  const buckets: Record<BucketKey, Aabb[]> = { wood: [], scrap: [], woodDoor: [], scrapDoor: [] };
  for (const piece of world.structures.pieces.values()) {
    const key = bucketOf(piece);
    for (const box of pieceAabbs(piece)) buckets[key].push(box);
    if ((piece.kind === "door" || piece.kind === "gate") && piece.open === true) {
      const panel = openPanelBox(piece);
      if (panel) buckets[key].push(panel);
    }
  }

  for (const key of Object.keys(buckets) as BucketKey[]) {
    const boxes = buckets[key];
    if (boxes.length === 0) continue;
    const mesh = new THREE.InstancedMesh(geometry, materials[key], boxes.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    boxes.forEach((box, slot) => {
      dummy.position.set(
        (box.minX + box.maxX) / 2,
        (box.y0 + box.y1) / 2,
        (box.minZ + box.maxZ) / 2,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(box.maxX - box.minX, box.y1 - box.y0, box.maxZ - box.minZ);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    meshes.push(mesh);
  }
  return { group, meshes };
}

export function Structures(): ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const builtVersion = useRef(-1);
  const liveMeshes = useRef<THREE.InstancedMesh[]>([]);

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
      for (const mesh of liveMeshes.current) mesh.dispose();
      liveMeshes.current = [];
      shared.geometry.dispose();
      for (const m of Object.values(shared.materials)) m.dispose();
    };
  }, [shared]);

  useFrame(() => {
    const root = rootRef.current;
    if (!root || builtVersion.current === clientWorld.structuresVersion) return;
    builtVersion.current = clientWorld.structuresVersion;
    for (const mesh of liveMeshes.current) mesh.dispose();
    root.clear();
    const { group, meshes } = buildMeshes(shared.geometry, shared.materials);
    liveMeshes.current = meshes;
    root.add(group);
  });

  return <group ref={rootRef} />;
}
