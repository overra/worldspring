// Rain: ~1200 instanced streak quads falling inside a 30m cylinder around
// the camera. ALL motion runs in the vertex shader from a time uniform plus
// a per-instance seed (InstancedBufferGeometry + ShaderMaterial) — zero
// per-frame CPU work per streak. Each streak wraps back to the top of the
// band when it falls below the camera's feet (mod in the shader), with a
// short fade at both band edges so the wrap never pops. Layer opacity
// tracks clientWorld.weather per frame; fully hidden when nearly dry.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp } from "@/shared/math";
import { clientWorld } from "@/client/runtime";

const STREAK_COUNT = 1200;
const CYLINDER_RADIUS = 30; // m around the camera
const BAND_HEIGHT = 32; // local y range the streaks fall through
const BAND_BOTTOM_BELOW_EYE = 2.5; // band bottom sits below the camera's feet
const FALL_SPEED = 18; // m/s
const WIND_X = 1.7; // slight wind shear (m/s of horizontal drift)
const WIND_Z = 0.9;
const STREAK_WIDTH = 0.02;
const STREAK_LENGTH = 0.55;
const RAIN_COLOR = "#aab4bd";
const BASE_ALPHA = 0.34; // streak alpha at weather = 1
const MIN_WEATHER_VISIBLE = 0.02;

const RAIN_VERTEX = /* glsl */ `
uniform float uTime;
attribute vec3 aSeed;
varying float vFade;

const float RADIUS = ${CYLINDER_RADIUS.toFixed(2)};
const float BAND = ${BAND_HEIGHT.toFixed(2)};
const float FALL_SPEED = ${FALL_SPEED.toFixed(2)};
const vec2 WIND = vec2(${WIND_X.toFixed(2)}, ${WIND_Z.toFixed(2)});

void main() {
  // Per-instance placement from the seed: angle + sqrt-radius gives a
  // uniform disc; the third component staggers the fall phase.
  float angle = aSeed.x * 6.2831853;
  float radius = sqrt(aSeed.y) * RADIUS;
  float fall = mod(aSeed.z * BAND + uTime * FALL_SPEED, BAND);
  float y = BAND - fall; // BAND at respawn, 0 below the camera's feet
  vec2 drift = WIND * (fall / FALL_SPEED); // wind shear while falling
  vec3 center = vec3(cos(angle) * radius + drift.x, y, sin(angle) * radius + drift.y);

  // Cylindrical billboard in view space: the quad's long axis follows the
  // fall velocity, its width always faces the eye.
  vec3 axis = normalize(vec3(-WIND.x, FALL_SPEED, -WIND.y));
  vec4 mv = modelViewMatrix * vec4(center, 1.0);
  vec3 axisView = normalize((modelViewMatrix * vec4(axis, 0.0)).xyz);
  vec3 rightView = cross(axisView, normalize(mv.xyz));
  float rl = length(rightView);
  rightView = rl > 1e-4 ? rightView / rl : vec3(1.0, 0.0, 0.0);
  mv.xyz += rightView * position.x + axisView * position.y;
  gl_Position = projectionMatrix * mv;

  // Fade near both band edges so the wrap respawn is invisible.
  vFade = smoothstep(0.0, 2.0, y) * (1.0 - smoothstep(BAND - 4.0, BAND, y));
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;

void main() {
  gl_FragColor = vec4(uColor, uOpacity * vFade * ${BASE_ALPHA.toFixed(2)});
  #include <colorspace_fragment>
}
`;

interface RainUniforms {
  uTime: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  // ShaderMaterial's uniforms parameter wants an index signature.
  [name: string]: THREE.IUniform<unknown>;
}

interface RainAssets {
  mesh: THREE.Mesh;
  uniforms: RainUniforms;
  dispose(): void;
}

function createRainAssets(): RainAssets {
  // Base quad shared into an InstancedBufferGeometry; the instance count and
  // a per-instance seed are all the CPU ever uploads.
  const base = new THREE.PlaneGeometry(STREAK_WIDTH, STREAK_LENGTH);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute("position", base.getAttribute("position"));
  geometry.instanceCount = STREAK_COUNT;

  const seeds = new Float32Array(STREAK_COUNT * 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 3));

  // Positions are generated in the shader — the base quad's bounds are
  // meaningless. The mesh is also frustumCulled=false below; this just keeps
  // any bounds math sane.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, BAND_HEIGHT / 2, 0),
    CYLINDER_RADIUS + BAND_HEIGHT,
  );

  const uniforms: RainUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(RAIN_COLOR) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    mesh,
    uniforms,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function RainLayer(): ReactElement | null {
  const assets = useMemo(createRainAssets, []);
  useEffect(() => () => assets.dispose(), [assets]);

  useFrame((state) => {
    const weather = clientWorld.weather;
    const mesh = assets.mesh;
    if (weather < MIN_WEATHER_VISIBLE) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    assets.uniforms.uTime.value = state.clock.elapsedTime;
    assets.uniforms.uOpacity.value = clamp(weather, 0, 1);
    // Snap the layer to the camera: x/z follow exactly, y holds a fixed band
    // from just below the feet up to ~30m overhead.
    const cam = state.camera.position;
    mesh.position.set(cam.x, cam.y - BAND_BOTTOM_BELOW_EYE, cam.z);
  });

  return <primitive object={assets.mesh} />;
}
