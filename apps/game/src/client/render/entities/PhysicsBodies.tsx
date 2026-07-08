// doc 13 M1 — dynamic physics bodies: the same imperative pooling pattern as
// Portals/Zombies, driven by the interpolated clientWorld.bodies views (pos
// lerped, quat slerped in interpolation.ts — the client NEVER steps physics).
// doc 13 M2 adds the "trunk" variant (felled tree: elongated bark-brown box
// scaled by WireBody.dims). Unknown kinds still fall back to the crate look —
// wire-enum growth is additive-safe (protocol.ts).

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clientWorld } from "@/client/runtime";

/** Matches config.physics.bodyCap's default; the server interest-filters, so
 * >64 in view means several rooms' caps stacked — clamp to the pool. */
const POOL_SIZE = 64;
/** Matches the server's CRATE_HALF (PhysicsSystem.ts) — 0.8 m cube. */
const CRATE_SIZE = 0.8;
/** Fallback trunk half-extents when dims is absent (a server older than the
 * dims field): worldgen trunk radius 0.35 at a mid-range 8 m height. */
const TRUNK_FALLBACK_DIMS: [number, number, number] = [0.35, 4, 0.35];

// One shared UNIT cube; per-slot scale turns it into a crate or a trunk.
const unitGeometry = new THREE.BoxGeometry(1, 1, 1);
const crateMaterial = new THREE.MeshStandardMaterial({ color: "#8a6b42", roughness: 0.85 });
const trunkMaterial = new THREE.MeshStandardMaterial({ color: "#5e4426", roughness: 0.95 });

interface Pool {
  root: THREE.Group;
  slots: THREE.Mesh[];
}

function createPool(): Pool {
  const root = new THREE.Group();
  const slots: THREE.Mesh[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(unitGeometry, crateMaterial);
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
    let i = 0;
    for (const view of clientWorld.bodies.values()) {
      if (i >= POOL_SIZE) break;
      const mesh = pool.slots[i++];
      mesh.visible = true;
      if (view.kind === "trunk") {
        const d = view.dims ?? TRUNK_FALLBACK_DIMS;
        mesh.material = trunkMaterial;
        mesh.scale.set(d[0] * 2, d[1] * 2, d[2] * 2);
      } else {
        // "crate" and any future kind this build doesn't know (fallback).
        mesh.material = crateMaterial;
        mesh.scale.setScalar(CRATE_SIZE);
      }
      // WireBody y is the body CENTER (rapier translation), not a base origin.
      mesh.position.set(view.x, view.y, view.z);
      mesh.quaternion.set(view.q[0], view.q[1], view.q[2], view.q[3]);
    }
    for (; i < POOL_SIZE; i++) pool.slots[i].visible = false;
  });

  return <primitive object={pool.root} />;
}
