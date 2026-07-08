// doc 13 M4 — the drivable buggy. A small pool of low-poly hull groups (chassis
// box + cabin + four cosmetic wheels) assigned to the interpolated "vehicle"
// bodies each frame, same imperative pooling as PhysicsBodies/Portals. The
// client NEVER steps physics — pose comes from the server-authoritative body,
// pos lerped + quat slerped in interpolation.ts (the hull is upright server-side,
// so the quaternion is a pure yaw). A wrecked hull renders charred.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_VEHICLES, VEHICLE_HALF_X, VEHICLE_HALF_Y, VEHICLE_HALF_Z } from "@worldspring/shared/constants";
import { clientWorld } from "@/client/runtime";

/** Pool a touch larger than the spawn cap — interest filtering can never send
 * more vehicles than exist, and vehicles are cap-exempt at MAX_VEHICLES. */
const POOL_SIZE = MAX_VEHICLES + 3;

// Shared, app-lifetime geometry/materials (the Portals precedent — never
// disposed here; only the pool detaches on unmount).
const hullGeom = new THREE.BoxGeometry(VEHICLE_HALF_X * 2, VEHICLE_HALF_Y * 2, VEHICLE_HALF_Z * 2);
const cabinGeom = new THREE.BoxGeometry(VEHICLE_HALF_X * 1.7, VEHICLE_HALF_Y * 1.1, VEHICLE_HALF_Z * 0.9);
const wheelGeom = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
const hullMat = new THREE.MeshStandardMaterial({ color: "#6b6f43", roughness: 0.85, metalness: 0.25 });
const cabinMat = new THREE.MeshStandardMaterial({ color: "#4a4d36", roughness: 0.7, metalness: 0.2 });
const wheelMat = new THREE.MeshStandardMaterial({ color: "#1c1c1e", roughness: 0.95 });
const wreckedMat = new THREE.MeshStandardMaterial({ color: "#2b2622", roughness: 1, metalness: 0.1 });

interface VehicleSlot {
  group: THREE.Group;
  hull: THREE.Mesh;
  cabin: THREE.Mesh;
}

function buildSlot(): VehicleSlot {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(hullGeom, hullMat);
  hull.castShadow = true;
  group.add(hull);
  // Cabin sits on top of the chassis, set back a touch toward the rear (+Z is
  // back; local forward is -Z).
  const cabin = new THREE.Mesh(cabinGeom, cabinMat);
  cabin.position.set(0, VEHICLE_HALF_Y * 1.05, VEHICLE_HALF_Z * 0.15);
  cabin.castShadow = true;
  group.add(cabin);
  // Four wheels at the chassis corners, axis along X (rotate the Y-axis cylinder
  // 90° about Z). Cosmetic in v1 — they don't spin.
  const wx = VEHICLE_HALF_X;
  const wy = -VEHICLE_HALF_Y * 0.7;
  const wz = VEHICLE_HALF_Z * 0.62;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx * sx, wy, wz * sz);
    group.add(wheel);
  }
  group.visible = false;
  return { group, hull, cabin };
}

interface Pool {
  root: THREE.Group;
  slots: VehicleSlot[];
}

function createPool(): Pool {
  const root = new THREE.Group();
  const slots: VehicleSlot[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = buildSlot();
    root.add(slot.group);
    slots.push(slot);
  }
  return { root, slots };
}

export function Vehicles(): ReactElement {
  const pool = useMemo(createPool, []);

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
      if (view.kind !== "vehicle") continue;
      if (i >= slots.length) break;
      const slot = slots[i++];
      slot.group.visible = true;
      slot.group.position.set(view.x, view.y, view.z);
      slot.group.quaternion.set(view.q[0], view.q[1], view.q[2], view.q[3]);
      const mat = view.wrecked ? wreckedMat : hullMat;
      slot.hull.material = mat;
      slot.cabin.material = view.wrecked ? wreckedMat : cabinMat;
    }
    for (; i < slots.length; i++) slots[i].group.visible = false;
  });

  return <primitive object={pool.root} />;
}
