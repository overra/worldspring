// Day/night sky: sun + moon directional lights (the sun casts a
// camera-following shadow frustum), ambient/hemisphere fill, a gradient sky
// dome with sun/moon discs, scene background + fog colors lerped through
// dawn/dusk palettes, stars at night. Everything is mutated per frame from
// clientWorld.timeOfDay — no React state, no pops at hour boundaries.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import { NIGHT_END_HOUR, NIGHT_START_HOUR } from "@/shared/constants";
import { clamp, lerp } from "@/shared/math";
import { clientWorld } from "@/client/runtime";

const DAY_LEN = NIGHT_START_HOUR - NIGHT_END_HOUR; // 16h of daylight
const NIGHT_LEN = 24 - DAY_LEN;
const SOLAR_NOON = NIGHT_END_HOUR + DAY_LEN / 2; // 13h

// Sky palette.
const NIGHT_SKY = new THREE.Color("#0a0e1a");
const DAY_SKY = new THREE.Color("#9db8c9");
const DAWN_SKY = new THREE.Color("#c97b4a");
const DUSK_SKY = new THREE.Color("#b06a4a");

// Sky-dome zenith palette (the horizon reuses the fog/background color).
const ZENITH_DAY = new THREE.Color("#5f86a6");
const ZENITH_NIGHT = new THREE.Color("#050810");

// Light palette.
const SUN_HIGH = new THREE.Color("#fff3df");
const SUN_LOW = new THREE.Color("#ffb377");
const AMBIENT_DAY = new THREE.Color("#ccd5da");
const AMBIENT_NIGHT = new THREE.Color("#232c4a");
const HEMI_SKY_DAY = new THREE.Color("#9db8c9");
const HEMI_SKY_NIGHT = new THREE.Color("#111a30");
const HEMI_GROUND_DAY = new THREE.Color("#5f5b48");
const HEMI_GROUND_NIGHT = new THREE.Color("#0a0c12");

// Fog distances.
const FOG_NEAR_DAY = 40;
const FOG_FAR_DAY = 320;
const FOG_NEAR_NIGHT = 20;
const FOG_FAR_NIGHT = 140;

const SUN_MAX_INTENSITY = 1.6;
const MOON_INTENSITY = 0.12;
const STARS_SHOW_ELEVATION = -0.16; // sky is already near-black here — no pop

// Shadows: ortho box centered on the camera, sun pulled this far out along
// the sun direction. At night the sun intensity is 0 — no special casing.
const SUN_SHADOW_DIST = 120;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_ORTHO_HALF = 55;
const SHADOW_NEAR = 1;
const SHADOW_FAR = 240;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.04;

// Sky dome + celestial discs (camera-following, inside the 600 camera far).
const SKY_RADIUS = 500;
const DISC_DIST = 450;
const SUN_DISC_RADIUS = 22;
const MOON_DISC_RADIUS = 13;
const MOON_DISC_COLOR = "#c9d6ec";
const MOON_DISC_MAX_OPACITY = 0.75;

const skyTmp = new THREE.Color();
const sunDirTmp = new THREE.Vector3();
const moonDirTmp = new THREE.Vector3();

const DOME_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
varying vec3 vDir;
void main() {
  float up = clamp(normalize(vDir).y, 0.0, 1.0);
  gl_FragColor = vec4(mix(uHorizon, uZenith, pow(up, 0.6)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface SkyAssets {
  dome: THREE.Mesh;
  /** Dome shader uniform values — mutate in place each frame. */
  horizonColor: THREE.Color;
  zenithColor: THREE.Color;
  sunDisc: THREE.Mesh;
  sunDiscMaterial: THREE.MeshBasicMaterial;
  moonDisc: THREE.Mesh;
  moonDiscMaterial: THREE.MeshBasicMaterial;
  dispose(): void;
}

function createSkyAssets(): SkyAssets {
  const horizonColor = DAY_SKY.clone();
  const zenithColor = ZENITH_DAY.clone();
  const domeGeometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const domeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: horizonColor },
      uZenith: { value: zenithColor },
    },
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(domeGeometry, domeMaterial);
  dome.frustumCulled = false;
  dome.renderOrder = -1000; // paint first; everything else draws over it

  const sunDiscGeometry = new THREE.CircleGeometry(SUN_DISC_RADIUS, 24);
  const sunDiscMaterial = new THREE.MeshBasicMaterial({
    color: SUN_HIGH,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const sunDisc = new THREE.Mesh(sunDiscGeometry, sunDiscMaterial);
  sunDisc.frustumCulled = false;
  sunDisc.renderOrder = -999;

  const moonDiscGeometry = new THREE.CircleGeometry(MOON_DISC_RADIUS, 24);
  const moonDiscMaterial = new THREE.MeshBasicMaterial({
    color: MOON_DISC_COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const moonDisc = new THREE.Mesh(moonDiscGeometry, moonDiscMaterial);
  moonDisc.frustumCulled = false;
  moonDisc.renderOrder = -998;

  return {
    dome,
    horizonColor,
    zenithColor,
    sunDisc,
    sunDiscMaterial,
    moonDisc,
    moonDiscMaterial,
    dispose() {
      domeGeometry.dispose();
      domeMaterial.dispose();
      sunDiscGeometry.dispose();
      sunDiscMaterial.dispose();
      moonDiscGeometry.dispose();
      moonDiscMaterial.dispose();
    },
  };
}

/**
 * Sun elevation as sin(altitude) in [-1, 1]: a sine arc peaking at 13h,
 * below the horizon through the night window. Continuous everywhere
 * (both branches hit 0 exactly at NIGHT_START_HOUR / NIGHT_END_HOUR).
 */
function sunElevation(hour: number): number {
  if (hour >= NIGHT_END_HOUR && hour < NIGHT_START_HOUR) {
    return Math.sin((Math.PI * (hour - NIGHT_END_HOUR)) / DAY_LEN);
  }
  const sinceNight = (hour - NIGHT_START_HOUR + 24) % 24; // continuous across midnight
  return -Math.sin((Math.PI * sinceNight) / NIGHT_LEN);
}

function smoothstep01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export function SkyAndLighting(): ReactElement | null {
  const scene = useThree((s) => s.scene);

  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const starsRef = useRef<THREE.Group>(null);

  const background = useMemo(() => DAY_SKY.clone(), []);
  const fog = useMemo(() => new THREE.Fog(DAY_SKY.clone(), FOG_NEAR_DAY, FOG_FAR_DAY), []);
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const sky = useMemo(createSkyAssets, []);

  useEffect(() => {
    scene.background = background;
    scene.fog = fog;
    return () => {
      scene.background = null;
      scene.fog = null;
    };
  }, [scene, background, fog]);

  useEffect(() => () => sky.dispose(), [sky]);

  // Shadow camera setup is imperative: changing ortho extents needs an
  // explicit updateProjectionMatrix, which pierced JSX props don't guarantee.
  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    if (sun.shadow.map) {
      // A frame may have rendered before this effect — drop the stale target.
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_ORTHO_HALF;
    cam.right = SHADOW_ORTHO_HALF;
    cam.top = SHADOW_ORTHO_HALF;
    cam.bottom = -SHADOW_ORTHO_HALF;
    cam.near = SHADOW_NEAR;
    cam.far = SHADOW_FAR;
    cam.updateProjectionMatrix();
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
  }, []);

  useFrame((state) => {
    const camPos = state.camera.position;
    const hour = clientWorld.timeOfDay;
    const elev = sunElevation(hour);
    // 0 = full night, 1 = full day; ramps through dawn/dusk.
    const dayF = smoothstep01((elev + 0.12) / 0.47);

    // East-to-west arc; exact azimuth at night is irrelevant (intensity 0).
    const dayT = (hour - NIGHT_END_HOUR) / DAY_LEN;
    sunDirTmp.set(Math.cos(Math.PI * dayT) * 160, elev * 140, 60).normalize();

    const sun = sunRef.current;
    if (sun) {
      // Camera-following shadow frustum: sun sits out along the sun
      // direction, aimed back at the camera position.
      sun.position.copy(camPos).addScaledVector(sunDirTmp, SUN_SHADOW_DIST);
      sunTarget.position.copy(camPos);
      sunTarget.updateMatrixWorld();
      sun.intensity = SUN_MAX_INTENSITY * Math.pow(clamp(elev, 0, 1), 0.85);
      const warm = 1 - clamp(elev / 0.45, 0, 1);
      sun.color.copy(SUN_HIGH).lerp(SUN_LOW, warm);
    }

    const moon = moonRef.current;
    if (moon) {
      // Night progress 0..1 from dusk to dawn, continuous across midnight.
      const sinceNight = (hour - NIGHT_START_HOUR + 24) % 24;
      const nightP = clamp(sinceNight / NIGHT_LEN, 0, 1);
      moon.position.set(Math.cos(Math.PI * (1 - nightP)) * 120, 30 + 90 * Math.sin(Math.PI * nightP), -80);
      moon.intensity = MOON_INTENSITY * clamp(-elev / 0.3, 0, 1);
    }

    const ambient = ambientRef.current;
    if (ambient) {
      ambient.intensity = lerp(0.06, 0.45, dayF);
      ambient.color.copy(AMBIENT_NIGHT).lerp(AMBIENT_DAY, dayF);
    }

    const hemi = hemiRef.current;
    if (hemi) {
      hemi.intensity = lerp(0.06, 0.55, dayF);
      hemi.color.copy(HEMI_SKY_NIGHT).lerp(HEMI_SKY_DAY, dayF);
      hemi.groundColor.copy(HEMI_GROUND_NIGHT).lerp(HEMI_GROUND_DAY, dayF);
    }

    // Sky/fog color: night<->day base, tinted toward dawn/dusk near the
    // horizon. The dawn/dusk switch happens at solar noon where the tint
    // weight is 0, and the tint is 0 by the time stars toggle — no pops.
    skyTmp.copy(NIGHT_SKY).lerp(DAY_SKY, dayF);
    const twilight = Math.max(0, 1 - Math.abs(elev) / 0.2);
    skyTmp.lerp(hour < SOLAR_NOON ? DAWN_SKY : DUSK_SKY, twilight * 0.8);
    background.copy(skyTmp);
    fog.color.copy(skyTmp);
    fog.near = lerp(FOG_NEAR_NIGHT, FOG_NEAR_DAY, dayF);
    fog.far = lerp(FOG_FAR_NIGHT, FOG_FAR_DAY, dayF);

    // Sky dome: follows the camera; horizon matches the fog color so the
    // terrain fades seamlessly into it, zenith goes deeper with a faint
    // dawn/dusk tint.
    sky.dome.position.copy(camPos);
    sky.horizonColor.copy(skyTmp);
    sky.zenithColor.copy(ZENITH_NIGHT).lerp(ZENITH_DAY, dayF);
    sky.zenithColor.lerp(hour < SOLAR_NOON ? DAWN_SKY : DUSK_SKY, twilight * 0.25);

    // Celestial discs ride the light directions, fading on the same curves
    // as the light intensities.
    sky.sunDisc.position.copy(camPos).addScaledVector(sunDirTmp, DISC_DIST);
    sky.sunDisc.lookAt(camPos);
    sky.sunDiscMaterial.opacity = smoothstep01((elev + 0.04) / 0.12);
    if (sun) sky.sunDiscMaterial.color.copy(sun.color);

    if (moon) {
      moonDirTmp.copy(moon.position).normalize();
      sky.moonDisc.position.copy(camPos).addScaledVector(moonDirTmp, DISC_DIST);
      sky.moonDisc.lookAt(camPos);
      sky.moonDiscMaterial.opacity = MOON_DISC_MAX_OPACITY * clamp(-elev / 0.3, 0, 1);
    }

    const stars = starsRef.current;
    if (stars) stars.visible = elev < STARS_SHOW_ELEVATION;
  });

  return (
    <group>
      <directionalLight
        ref={sunRef}
        position={[160, 100, 60]}
        intensity={1.2}
        castShadow
        target={sunTarget}
      />
      <primitive object={sunTarget} />
      <directionalLight ref={moonRef} position={[-120, 80, -80]} intensity={0} color="#93a7cc" />
      <ambientLight ref={ambientRef} intensity={0.4} />
      <hemisphereLight ref={hemiRef} intensity={0.5} />
      <primitive object={sky.dome} />
      <primitive object={sky.sunDisc} />
      <primitive object={sky.moonDisc} />
      <group ref={starsRef} visible={false}>
        <Stars radius={280} depth={50} count={2500} factor={5} saturation={0} fade speed={0.5} />
      </group>
    </group>
  );
}
