// doc 06 — build-mode driver + ghost preview. Runs a per-frame loop while
// the hammer is equipped: snaps the crosshair to the global 3m grid (cell for
// foundations, nearest canonical edge for wall-class pieces), validates with
// the SAME shared canPlace the server runs, and renders the candidate's
// collision boxes as a translucent green/red ghost. The chosen target lives
// in runtime.buildState, where InputController's click reads it.
//
// The occupants view here is an approximation (doc 06:196): interpolated
// remotes lag ~one RTT, so a racing sprinter can turn a green ghost into a
// server rejection — the server's notice covers that carve-out.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { BUILD_CELL, BUILD_RANGE, PLAYER_EYE_HEIGHT } from "@worldspring/shared/constants";
import { distSq2D, lookDir } from "@worldspring/shared/math";
import type { Aabb } from "@worldspring/shared/math";
import {
  PIECE_DEFS,
  PLACEABLE_KINDS,
  PLACE_REJECTION_TEXT,
  canPlace,
  pieceAabbs,
  pieceCenter,
  quantizeFloorY,
  targetFloorY,
  type PlaceTarget,
  type StructurePiece,
} from "@worldspring/shared/structures";
import { buildState, clientWorld, inputState } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";

/** Aim distances: how far ahead the ghost snaps when looking level/down. */
const AIM_MIN = 1.6;
const AIM_MAX = 5.2;
const AIM_LEVEL = 4;

const GREEN = new THREE.Color("#3fae5a");
const RED = new THREE.Color("#c0392b");

function countOfType(inv: ReadonlyArray<{ type: string; count: number } | null>, type: string): number {
  let n = 0;
  for (const s of inv) if (s && s.type === type) n += s.count;
  return n;
}

/** Snap the aim point to a PlaceTarget: cell address for foundations, the
 * nearest canonical edge of the aimed cell for edge pieces. */
function snapTarget(kind: (typeof PLACEABLE_KINDS)[number], tier: 0 | 1, ax: number, az: number): PlaceTarget {
  const gx = Math.floor(ax / BUILD_CELL);
  const gz = Math.floor(az / BUILD_CELL);
  if (kind === "foundation") return { kind, tier, gx, gz };
  // Fractional position inside the cell picks the nearest of the 4 edges,
  // canonicalized: -Z → edge 0 of (gx, gz-1); -X → edge 2 of (gx-1, gz).
  const u = ax / BUILD_CELL - gx;
  const v = az / BUILD_CELL - gz;
  const dists: Array<[number, number, number, 0 | 2]> = [
    [1 - v, gx, gz, 0], // +Z
    [v, gx, gz - 1, 0], // -Z
    [1 - u, gx, gz, 2], // +X
    [u, gx - 1, gz, 2], // -X
  ];
  dists.sort((a, b) => a[0] - b[0]);
  const [, egx, egz, edge] = dists[0];
  return { kind, tier, gx: egx, gz: egz, edge };
}

export function BuildPreview(): ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const builtKey = useRef("");

  const shared = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: GREEN,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    return { geometry, material };
  }, []);

  useEffect(() => {
    return () => {
      shared.geometry.dispose();
      shared.material.dispose();
      // Unmount (realm switch / canvas teardown) must not strand build mode:
      // clear the runtime state and the HUD mirror.
      buildState.active = false;
      buildState.target = null;
      buildState.valid = false;
      buildState.rejection = null;
      useUIStore.getState().setBuildInfo(null);
    };
  }, [shared]);

  useFrame(() => {
    const root = rootRef.current;
    if (!root) return;
    const ui = useUIStore.getState();
    const world = clientWorld.world;
    const held = ui.inventory[ui.selectedSlot];
    const active =
      ui.phase === "playing" &&
      !ui.invOpen &&
      !ui.mapOpen &&
      !ui.menuOpen &&
      world !== null &&
      held?.type === "hammer" &&
      ui.realm === "overworld";

    buildState.active = active;
    if (!active || world === null) {
      buildState.target = null;
      buildState.valid = false;
      buildState.rejection = null;
      if (builtKey.current !== "") {
        builtKey.current = "";
        root.clear();
      }
      if (ui.buildInfo !== null) ui.setBuildInfo(null);
      return;
    }

    const kind = PLACEABLE_KINDS[buildState.kindIndex % PLACEABLE_KINDS.length];
    const tier = buildState.tier;

    // Aim: intersect the look ray with the feet plane; clamp to a sane band.
    const me = clientWorld.me;
    const dir = lookDir(inputState.yaw, inputState.pitch);
    let dist = AIM_LEVEL;
    if (dir.y < -0.05) dist = Math.min(AIM_MAX, Math.max(AIM_MIN, -PLAYER_EYE_HEIGHT / dir.y));
    const horiz = Math.max(0.2, Math.hypot(dir.x, dir.z));
    const ax = me.x + (dir.x / horiz) * dist;
    const az = me.z + (dir.z / horiz) * dist;

    const target = snapTarget(kind, tier, ax, az);
    buildState.target = target;

    // Occupants: predicted self + interpolated remotes (approximate).
    const occupants: Array<{ x: number; y: number; z: number }> = [
      { x: me.x, y: me.y, z: me.z },
    ];
    for (const p of clientWorld.players.values()) occupants.push({ x: p.x, y: p.y, z: p.z });

    const rejection = canPlace(world, target, occupants);
    const material = tier === 1 ? "scrap" : "wood";
    const cost = PIECE_DEFS[kind].cost;
    const haveResources = countOfType(ui.inventory, material) >= cost;
    // Mirror the server's BUILD_RANGE gate (handlePlace checks the piece
    // CENTER, not the aim point): the aim band reaches 5.2m and grid snapping
    // can push a cell center ~2.1m further — without this a green ghost at
    // max reach turns into a server "Too far away" rejection.
    const [pcx, pcz] = pieceCenter(target);
    const inRange = distSq2D(me.x, me.z, pcx, pcz) <= BUILD_RANGE * BUILD_RANGE;
    buildState.rejection = rejection;
    buildState.valid = rejection === null && haveResources && inRange;

    // HUD mirror — only on change (store writes are React renders).
    // Range first: it's the server's first geometric check (handlePlace).
    const status = !inRange
      ? "too far away"
      : rejection !== null
        ? PLACE_REJECTION_TEXT[rejection]
        : haveResources
          ? null
          : `needs ${cost} ${material}`;
    const info = ui.buildInfo;
    if (info === null || info.kind !== kind || info.tier !== tier || info.status !== status) {
      ui.setBuildInfo({ kind, tier, status });
    }

    // Ghost boxes: the candidate's collision geometry (closed state), at the
    // anchored floorY when one exists, else resting on the ground (invalid
    // targets still show WHERE you are aiming).
    const floorY =
      targetFloorY(world, target) ?? quantizeFloorY(world.groundHeight(ax, az) + 0.18);
    const candidate: StructurePiece = {
      id: -1,
      kind: target.kind,
      tier,
      gx: target.gx,
      gz: target.gz,
      ...(target.edge !== undefined ? { edge: target.edge } : {}),
      floorY,
      hp: 0,
      ...(kind === "door" || kind === "gate" ? { open: false } : {}),
    };
    const boxes = pieceAabbs(candidate);

    const key = `${kind}|${tier}|${target.gx}|${target.gz}|${target.edge ?? "-"}|${floorY}`;
    if (builtKey.current !== key) {
      builtKey.current = key;
      root.clear();
      for (const box of boxes as Aabb[]) {
        const mesh = new THREE.Mesh(shared.geometry, shared.material);
        mesh.position.set(
          (box.minX + box.maxX) / 2,
          (box.y0 + box.y1) / 2,
          (box.minZ + box.maxZ) / 2,
        );
        mesh.scale.set(box.maxX - box.minX, box.y1 - box.y0, box.maxZ - box.minZ);
        root.add(mesh);
      }
    }
    shared.material.color.copy(buildState.valid ? GREEN : RED);
  });

  return <group ref={rootRef} />;
}
