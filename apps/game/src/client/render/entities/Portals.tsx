// Red portals: a pooled set of glowing hoops with a swirling, pulsing core and
// a point light, one per portal in clientWorld.portals (already realm- and
// interest-filtered server-side). Built from primitives (no GLB). Each hoop is
// billboarded around Y so it always reads as a full ring, and tinted by where
// it leads — hot red toward the red realm, cool teal back to the overworld.
// Imperative per-frame updates from clientWorld, like Campfires.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Realm } from "@worldspring/shared/protocol";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 16;
const RING_RADIUS = 1.1;

// Shared geometry (module-level, reused across mounts — never disposed, like
// the campfire fallback primitives).
const RING_GEO = new THREE.TorusGeometry(RING_RADIUS, 0.16, 10, 30);
const DISC_GEO = new THREE.CircleGeometry(RING_RADIUS * 0.94, 30);

const LIGHT_DISTANCE = 12;
const LIGHT_DECAY = 2;

interface PortalPalette {
  ring: THREE.Color;
  emissive: THREE.Color;
  glow: THREE.Color;
}

// Keyed by the portal's destination realm (`to`).
const PALETTES: Record<Realm, PortalPalette> = {
  red: {
    ring: new THREE.Color("#7a0a24"),
    emissive: new THREE.Color("#ff1f5a"),
    glow: new THREE.Color("#ff2d6a"),
  },
  overworld: {
    ring: new THREE.Color("#063a3a"),
    emissive: new THREE.Color("#1fe0d6"),
    glow: new THREE.Color("#33e8e8"),
  },
};

interface PortalSlot {
  group: THREE.Group;
  ringMat: THREE.MeshStandardMaterial;
  discMat: THREE.MeshBasicMaterial;
  disc: THREE.Mesh;
  light: THREE.PointLight;
}

interface PortalPool {
  root: THREE.Group;
  slots: PortalSlot[];
}

function createPool(): PortalPool {
  const root = new THREE.Group();
  const slots: PortalSlot[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const group = new THREE.Group();
    group.visible = false;

    const ringMat = new THREE.MeshStandardMaterial({
      color: PALETTES.red.ring,
      emissive: PALETTES.red.emissive,
      emissiveIntensity: 1.4,
      roughness: 0.4,
      metalness: 0.1,
    });
    const ring = new THREE.Mesh(RING_GEO, ringMat);
    ring.position.y = RING_RADIUS;
    group.add(ring);

    const discMat = new THREE.MeshBasicMaterial({
      color: PALETTES.red.glow,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const disc = new THREE.Mesh(DISC_GEO, discMat);
    disc.position.y = RING_RADIUS;
    group.add(disc);

    const light = new THREE.PointLight(PALETTES.red.glow, 2.4, LIGHT_DISTANCE, LIGHT_DECAY);
    light.position.y = RING_RADIUS;
    group.add(light);

    root.add(group);
    slots.push({ group, ringMat, discMat, disc, light });
  }
  return { root, slots };
}

export function Portals(): ReactElement {
  const pool = useMemo(createPool, []);

  useEffect(
    () => () => {
      for (const slot of pool.slots) {
        slot.ringMat.dispose();
        slot.discMat.dispose();
      }
    },
    [pool],
  );

  useFrame((state) => {
    const portals = clientWorld.portals;
    const t = state.clock.elapsedTime;
    const cam = state.camera.position;
    const n = Math.min(portals.length, POOL_SIZE);

    for (let i = 0; i < n; i++) {
      const p = portals[i];
      const slot = pool.slots[i];
      slot.group.visible = true;
      slot.group.position.set(p.x, p.y, p.z);
      // Billboard around Y so the hoop always faces the camera.
      slot.group.rotation.y = Math.atan2(cam.x - p.x, cam.z - p.z);

      const palette = PALETTES[p.to] ?? PALETTES.red;
      slot.ringMat.color.copy(palette.ring);
      slot.ringMat.emissive.copy(palette.emissive);
      slot.discMat.color.copy(palette.glow);
      slot.light.color.copy(palette.glow);

      // Swirl the core and pulse the glow.
      slot.disc.rotation.z = t * 1.6 + i;
      slot.discMat.opacity = 0.5 + 0.18 * Math.sin(t * 3 + i * 1.3);
      slot.light.intensity = 2.1 + 0.8 * Math.sin(t * 4 + i);
    }
    for (let i = n; i < POOL_SIZE; i++) pool.slots[i].group.visible = false;
  });

  return <primitive object={pool.root} />;
}
