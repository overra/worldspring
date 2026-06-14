// Red portals: a pooled set of standing ARCHWAYS — two pillars capped by a
// rounded arch, with a swirling, pulsing portal surface filling the opening and
// a point light. One per portal in clientWorld.portals (already realm- and
// interest-filtered server-side). Built from primitives (no GLB). Each arch is
// billboarded around Y so its opening always faces the camera, and tinted by
// where it leads — hot red toward the red realm, cool teal back to the
// overworld. Imperative per-frame updates from clientWorld, like Campfires.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Realm } from "@worldspring/shared/protocol";
import { clientWorld } from "@/client/runtime";

const POOL_SIZE = 16;

// Archway dimensions: a ~2.9m doorway you walk through. OW = opening half-width
// and the arch radius; PH = straight pillar height before the arch springs.
const OW = 0.95;
const PH = 2.0;
const FRAME_T = 0.18; // pillar thickness
const ARCH_TUBE = 0.1; // arch bar radius

// Shared geometry (module-level, reused across mounts — never disposed, like
// the campfire fallback primitives).
const PILLAR_GEO = new THREE.BoxGeometry(FRAME_T, PH, FRAME_T);
const BASE_GEO = new THREE.BoxGeometry(OW * 2 + FRAME_T, FRAME_T, FRAME_T);
const ARCH_GEO = new THREE.TorusGeometry(OW, ARCH_TUBE, 8, 28, Math.PI);

// The portal SURFACE silhouette: a rectangle PH tall, OW half-wide, capped by a
// semicircle of radius OW — the classic rounded-arch opening.
const SURFACE_GEO = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(-OW, 0);
  shape.lineTo(-OW, PH);
  shape.absarc(0, PH, OW, Math.PI, 0, true); // left → over the top → right
  shape.lineTo(OW, 0);
  shape.lineTo(-OW, 0);
  return new THREE.ShapeGeometry(shape);
})();

const LIGHT_DISTANCE = 12;
const LIGHT_DECAY = 2;
const SURFACE_CENTER_Y = 1.3; // swirl origin, roughly the opening's middle

interface PortalPalette {
  frame: THREE.Color;
  emissive: THREE.Color;
  surface: THREE.Color;
}

// Keyed by the portal's destination realm (`to`).
const PALETTES: Record<Realm, PortalPalette> = {
  red: {
    frame: new THREE.Color("#1a0c14"),
    emissive: new THREE.Color("#ff1f5a"),
    surface: new THREE.Color("#ff2d6a"),
  },
  overworld: {
    frame: new THREE.Color("#0a1416"),
    emissive: new THREE.Color("#1fe0d6"),
    surface: new THREE.Color("#33e8e8"),
  },
};

// Swirling, edge-feathered portal surface (additive, unlit). The swirl is a
// spiral of the destination color around the opening's center.
const SURFACE_VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SURFACE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uCenterY;
varying vec2 vPos;
void main() {
  vec2 p = vec2(vPos.x, vPos.y - uCenterY);
  float r = length(p);
  float a = atan(p.y, p.x);
  float swirl = 0.5 + 0.5 * sin(a * 5.0 + r * 5.0 - uTime * 3.0);
  float fade = smoothstep(1.7, 0.1, r); // dim toward the frame edges
  vec3 col = uColor * (0.35 + 0.75 * swirl);
  gl_FragColor = vec4(col, fade * (0.5 + 0.25 * swirl));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface PortalSlot {
  group: THREE.Group;
  frameMat: THREE.MeshStandardMaterial;
  surfaceMat: THREE.ShaderMaterial;
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

    const frameMat = new THREE.MeshStandardMaterial({
      color: PALETTES.red.frame,
      emissive: PALETTES.red.emissive,
      emissiveIntensity: 0.9,
      roughness: 0.5,
      metalness: 0.2,
    });

    const pillarL = new THREE.Mesh(PILLAR_GEO, frameMat);
    pillarL.position.set(-OW, PH / 2, 0);
    const pillarR = new THREE.Mesh(PILLAR_GEO, frameMat);
    pillarR.position.set(OW, PH / 2, 0);
    const base = new THREE.Mesh(BASE_GEO, frameMat);
    base.position.set(0, FRAME_T / 2, 0);
    const arch = new THREE.Mesh(ARCH_GEO, frameMat);
    arch.position.set(0, PH, 0);
    group.add(pillarL, pillarR, base, arch);

    const surfaceMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: PALETTES.red.surface.clone() },
        uCenterY: { value: SURFACE_CENTER_Y },
      },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const surface = new THREE.Mesh(SURFACE_GEO, surfaceMat);
    surface.position.z = 0;
    group.add(surface);

    const light = new THREE.PointLight(PALETTES.red.surface, 2.4, LIGHT_DISTANCE, LIGHT_DECAY);
    light.position.set(0, SURFACE_CENTER_Y, 0);
    group.add(light);

    root.add(group);
    slots.push({ group, frameMat, surfaceMat, light });
  }
  return { root, slots };
}

export function Portals(): ReactElement {
  const pool = useMemo(createPool, []);

  useEffect(
    () => () => {
      for (const slot of pool.slots) {
        slot.frameMat.dispose();
        slot.surfaceMat.dispose();
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
      // Billboard around Y so the opening always faces the camera.
      slot.group.rotation.y = Math.atan2(cam.x - p.x, cam.z - p.z);

      const palette = PALETTES[p.to] ?? PALETTES.red;
      slot.frameMat.color.copy(palette.frame);
      slot.frameMat.emissive.copy(palette.emissive);
      (slot.surfaceMat.uniforms.uColor.value as THREE.Color).copy(palette.surface);
      slot.surfaceMat.uniforms.uTime.value = t;
      slot.light.color.copy(palette.surface);
      slot.light.intensity = 2.1 + 0.8 * Math.sin(t * 4 + i);
    }
    for (let i = n; i < POOL_SIZE; i++) pool.slots[i].group.visible = false;
  });

  return <primitive object={pool.root} />;
}
