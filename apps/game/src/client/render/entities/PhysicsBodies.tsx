// doc 13 M1 — dynamic physics bodies: the same imperative pooling pattern as
// Portals/Zombies, driven by the interpolated clientWorld.bodies views (pos
// lerped, quat slerped in interpolation.ts — the client NEVER steps physics).
// doc 13 M2 adds the "trunk" variant (felled tree: elongated bark-brown box
// scaled by WireBody.dims). doc 13 M3 adds the "barrel" variant (a shovable
// loot prop: a fixed-size rusty drum, rendered as a cylinder). Unknown kinds
// still fall back to the crate look — wire-enum growth is additive-safe
// (protocol.ts).

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clientWorld } from "@/client/runtime";
import {
  BARREL_GEOMETRY,
  BARREL_MATERIAL,
  BODY_BOX_GEOMETRY,
  CRATE_MATERIAL,
  TRUNK_MATERIAL,
} from "./physicsBodyAssets";

/** Matches the server's CRATE_HALF (PhysicsSystem.ts) — 0.8 m cube. */
const CRATE_SIZE = 0.8;
/** Fallback trunk half-extents when dims is absent (a server older than the
 * dims field): worldgen trunk radius 0.35 at a mid-range 8 m height. */
const TRUNK_FALLBACK_DIMS: [number, number, number] = [0.35, 4, 0.35];

// Shared UNIT geometries; per-slot scale turns them into a crate/trunk (box) or
// a barrel (cylinder). Kept module-level (app-lifetime, like Portals' shared
// resources) — the branch swaps a slot's geometry reference per frame.
interface Pool {
  root: THREE.Group;
  slots: THREE.Mesh[];
}

function createPool(): Pool {
  // Sized to the server's clamped physics.bodyCap (config.ts RANGES caps it at
  // 256): the server can never have — let alone interest-send — more bodies
  // than its cap, so a matching pool can't drop any. clientWorld.config is
  // written by onWelcome before the canvas mounts and is stable for the mount
  // (see GameCanvas.tsx), so a one-shot read here is safe.
  const size = clientWorld.config.physics.bodyCap;
  const root = new THREE.Group();
  const slots: THREE.Mesh[] = [];
  for (let i = 0; i < size; i++) {
    const mesh = new THREE.Mesh(BODY_BOX_GEOMETRY, CRATE_MATERIAL);
    mesh.castShadow = true;
    mesh.visible = false;
    root.add(mesh);
    slots.push(mesh);
  }
  return { root, slots };
}

export function PhysicsBodies(): ReactElement {
  const pool = useMemo(createPool, []);

  // Shared module-level geometry/materials are NOT disposed here (they live
  // for the app's life, like Portals' shared resources); only the pool detaches.
  useEffect(
    () => () => {
      pool.root.removeFromParent();
    },
    [pool],
  );

  useFrame(() => {
    const slots = pool.slots;
    let i = 0;
    for (const view of clientWorld.bodies.values()) {
      // doc 13 M4 — the buggy is a multi-part mesh rendered by <Vehicles/>; skip
      // it here so it never consumes a crate/trunk/barrel slot.
      if (view.kind === "vehicle") continue;
      if (i >= slots.length) break;
      const mesh = slots[i++];
      mesh.visible = true;
      if (view.kind === "trunk") {
        const d = view.dims ?? TRUNK_FALLBACK_DIMS;
        mesh.geometry = BODY_BOX_GEOMETRY;
        mesh.material = TRUNK_MATERIAL;
        mesh.scale.set(d[0] * 2, d[1] * 2, d[2] * 2);
      } else if (view.kind === "barrel") {
        // doc 13 M3 — a fixed-size rusty drum (cylinder, not the shared box).
        mesh.geometry = BARREL_GEOMETRY;
        mesh.material = BARREL_MATERIAL;
        mesh.scale.setScalar(1);
      } else {
        // "crate" and any future kind this build doesn't know (fallback).
        mesh.geometry = BODY_BOX_GEOMETRY;
        mesh.material = CRATE_MATERIAL;
        mesh.scale.setScalar(CRATE_SIZE);
      }
      // WireBody y is the body CENTER (rapier translation), not a base origin.
      mesh.position.set(view.x, view.y, view.z);
      mesh.quaternion.set(view.q[0], view.q[1], view.q[2], view.q[3]);
    }
    for (; i < slots.length; i++) slots[i].visible = false;
  });

  return <primitive object={pool.root} />;
}
