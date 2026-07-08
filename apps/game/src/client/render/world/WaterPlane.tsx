// Ocean: a subdivided translucent plane at WATER_LEVEL. A patched
// MeshStandardMaterial adds three octaves of gentle sine displacement in the
// vertex stage (the flat-shaded derivative normals pick the waves up for
// lighting) and a fresnel deep/shallow mix in the fragment stage. Standard
// material keeps the stock fog/transparency/lighting chunks working.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { WATER_LEVEL, WORLD_SIZE } from "@worldspring/shared/constants";
import { clientWorld } from "@/client/runtime";

/** Ocean plane size/segments at the standard tier. Both scale with world.size
 * (doc 07 M2); segments cap at 192 (doc 07 §4) — cell size grows slightly at
 * huge, invisible on slow swells. */
const WATER_SCALE = 1.6;
const SEGMENTS = 64;
const SEGMENTS_CAP = 192;
const WAVE_AMPLITUDE = 0.07;
const DEEP_COLOR = new THREE.Color("#16313d");
const SHALLOW_COLOR = new THREE.Color("#5d8294");

// Injected after begin_vertex. Local xy is world xz (the mesh is rotated
// -PI/2 about X), local z is world up. Long, slow swells — the plane cells
// are ~20m, so wavelengths stay well above that.
const VERTEX_PATCH = /* glsl */ `
#include <begin_vertex>
{
  float waterWave =
    sin(transformed.x * 0.035 + uWaterTime * 0.6) * 0.5 +
    sin(transformed.x * 0.05 + transformed.y * 0.06 - uWaterTime * 0.9) * 0.3 +
    sin(transformed.y * 0.1 + uWaterTime * 1.4) * 0.2;
  transformed.z += waterWave * ${WAVE_AMPLITUDE.toFixed(3)};
}
`;

// Injected after normal_fragment_begin so the (flat-shaded, derivative-based)
// `normal` is in scope: grazing angles tint toward the sky-facing shallow
// color, look-down stays deep.
const FRAGMENT_PATCH = /* glsl */ `
#include <normal_fragment_begin>
{
  float waterFresnel = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
  diffuseColor.rgb = mix(uWaterDeep, uWaterShallow, waterFresnel);
}
`;

interface WaterAssets {
  material: THREE.MeshStandardMaterial;
  timeUniform: { value: number };
}

function createWaterMaterial(): WaterAssets {
  const timeUniform = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    color: DEEP_COLOR,
    transparent: true,
    opacity: 0.92,
    roughness: 0.35,
    emissive: "#16313f",
    emissiveIntensity: 0.25,
    flatShading: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = timeUniform;
    shader.uniforms.uWaterDeep = { value: DEEP_COLOR };
    shader.uniforms.uWaterShallow = { value: SHALLOW_COLOR };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uWaterTime;")
      .replace("#include <begin_vertex>", VERTEX_PATCH);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uWaterDeep;\nuniform vec3 uWaterShallow;",
      )
      .replace("#include <normal_fragment_begin>", FRAGMENT_PATCH);
  };
  return { material, timeUniform };
}

export function WaterPlane(): ReactElement | null {
  const water = useMemo(createWaterMaterial, []);
  // world.size drives the plane (doc 07 M2); the scene only mounts once the
  // welcome built the world, but fall back to the standard size defensively.
  const size = clientWorld.world?.size ?? WORLD_SIZE;
  const waterSize = size * WATER_SCALE;
  const segments = Math.min(Math.round(SEGMENTS * (size / WORLD_SIZE)), SEGMENTS_CAP);

  useEffect(() => () => water.material.dispose(), [water]);

  useFrame((state) => {
    water.timeUniform.value = state.clock.elapsedTime;
  });

  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[0, WATER_LEVEL, 0]}
      frustumCulled={false}
      material={water.material}
    >
      <planeGeometry args={[waterSize, waterSize, segments, segments]} />
    </mesh>
  );
}
