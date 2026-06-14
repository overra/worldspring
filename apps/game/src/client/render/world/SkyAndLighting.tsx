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
import { NIGHT_END_HOUR, NIGHT_START_HOUR } from "@worldspring/shared/constants";
import { clamp, lerp } from "@worldspring/shared/math";
import { clientWorld } from "@/client/runtime";
import { QUALITY_CONFIGS, useSettingsStore } from "@/client/state/settings";
import { useUIStore } from "@/client/state/store";

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

// Weather (rain) modulation — applied as a post-step over the clear-sky
// values so the palette math above stays untouched. clientWorld.weather is
// the server's ramped 0..1 rain intensity.
const OVERCAST_DAY = new THREE.Color("#7a8087"); // desaturated rain grey
const OVERCAST_NIGHT = new THREE.Color("#0c0f15"); // night stays dark, just flatter
const RAIN_GREY_MAX = 0.85; // how far sky/fog shift toward overcast at weather 1
const RAIN_FOG_NEAR_MULT = 0.5; // fog tightens toward (near*0.5, far*0.45)
const RAIN_FOG_FAR_MULT = 0.45;
const RAIN_SUN_CUT = 0.65; // sun/moon intensity scale = 1 - weather * this
const RAIN_AMBIENT_LIFT = 0.3; // ambient up so rain reads overcast, not dark
const RAIN_STARS_CUTOFF = 0.35; // cloud cover hides stars past this
const overcastTmp = new THREE.Color();

const SUN_MAX_INTENSITY = 1.6;
const MOON_INTENSITY = 0.12;
const STARS_SHOW_ELEVATION = -0.16; // sky is already near-black here — no pop

// Shadows: ortho box centered on the camera, sun pulled this far out along
// the sun direction. At night the sun intensity is 0 — no special casing.
// On/off + map size come from the quality preset (settings store).
const SUN_SHADOW_DIST = 120;
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

// --- Red realm: a wild, timeless sky. These override the day/night palette
// entirely while the local player is in the red realm (set last in useFrame).
const RED_HORIZON = new THREE.Color("#d23a18"); // fiery red-orange skirt
const RED_ZENITH = new THREE.Color("#2a0618"); // deep maroon/purple overhead
const RED_FOG = new THREE.Color("#7a1408"); // dark red haze
const RED_FOG_NEAR = 40;
const RED_FOG_FAR = 380;
const RED_SUN_COLOR = new THREE.Color("#ff5a2a");
const RED_SUN_INTENSITY = 0.7;
const RED_AMBIENT = new THREE.Color("#b04428");
const RED_AMBIENT_INTENSITY = 0.5;
const RED_HEMI_SKY = new THREE.Color("#c83a1a");
const RED_HEMI_GROUND = new THREE.Color("#280608");
const RED_HEMI_INTENSITY = 0.45;

// Rainbow arc — a translucent half-annulus standing in the sky ahead of the
// camera, billboarded so it always spans the view. Sized + distanced so the
// whole arch fits a forward look (well inside the sky dome at 500 / far 600).
const RAINBOW_INNER = 120;
const RAINBOW_OUTER = 150;
const RAINBOW_DIST = 200; // meters ahead of the camera
const RAINBOW_DROP = 30; // lower the center so the arch springs from the horizon

const RAINBOW_VERTEX = /* glsl */ `
uniform float uInner;
uniform float uOuter;
varying float vT;
void main() {
  float r = length(position.xy);
  vT = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RAINBOW_FRAGMENT = /* glsl */ `
varying float vT;
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  // Outer edge red (hue 0), inner edge violet (hue 0.75) — a real rainbow's order.
  float hue = (1.0 - vT) * 0.75;
  vec3 col = hsv2rgb(vec3(hue, 0.85, 1.0));
  // Soft feathered edges across the band.
  float edge = smoothstep(0.0, 0.16, vT) * smoothstep(1.0, 0.84, vT);
  gl_FragColor = vec4(col, edge * 0.55);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const skyTmp = new THREE.Color();
const sunDirTmp = new THREE.Vector3();
const moonDirTmp = new THREE.Vector3();
const rainbowDirTmp = new THREE.Vector3();

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
  /** Red-realm rainbow arc; hidden in the overworld. */
  rainbow: THREE.Mesh;
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

  // Rainbow: an upper half-annulus (theta 0..π) whose radial band runs the
  // spectrum. Additive + depthWrite off so it glows in the sky and the terrain
  // (drawn after, at renderOrder 0) cleanly occludes it.
  const rainbowGeometry = new THREE.RingGeometry(RAINBOW_INNER, RAINBOW_OUTER, 96, 1, 0, Math.PI);
  const rainbowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uInner: { value: RAINBOW_INNER },
      uOuter: { value: RAINBOW_OUTER },
    },
    vertexShader: RAINBOW_VERTEX,
    fragmentShader: RAINBOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const rainbow = new THREE.Mesh(rainbowGeometry, rainbowMaterial);
  rainbow.frustumCulled = false;
  rainbow.renderOrder = -997;
  rainbow.visible = false;

  return {
    dome,
    horizonColor,
    zenithColor,
    sunDisc,
    sunDiscMaterial,
    moonDisc,
    moonDiscMaterial,
    rainbow,
    dispose() {
      domeGeometry.dispose();
      domeMaterial.dispose();
      sunDiscGeometry.dispose();
      sunDiscMaterial.dispose();
      moonDiscGeometry.dispose();
      moonDiscMaterial.dispose();
      rainbowGeometry.dispose();
      rainbowMaterial.dispose();
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
  const quality = useSettingsStore((s) => s.quality);

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
  // Re-runs on quality change: castShadow + map size follow the preset.
  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    const config = QUALITY_CONFIGS[quality];
    sun.castShadow = config.shadows;
    sun.shadow.mapSize.set(config.shadowMapSize, config.shadowMapSize);
    if (sun.shadow.map) {
      // A frame may have rendered before this effect (or the size just
      // changed) — drop the stale target so three reallocates it.
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
  }, [quality]);

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

    // Weather post-step: rain greys and tightens everything computed above.
    // Runs last on purpose — the clear-sky values are the baseline it lerps
    // away from, so the existing time-of-day curves keep working untouched.
    const weather = clamp(clientWorld.weather, 0, 1);
    if (weather > 0.001) {
      overcastTmp.copy(OVERCAST_NIGHT).lerp(OVERCAST_DAY, dayF);
      const grey = weather * RAIN_GREY_MAX;
      background.lerp(overcastTmp, grey);
      fog.color.lerp(overcastTmp, grey);
      sky.horizonColor.lerp(overcastTmp, grey);
      sky.zenithColor.lerp(overcastTmp, grey * 0.85);
      fog.near = lerp(fog.near, fog.near * RAIN_FOG_NEAR_MULT, weather);
      fog.far = lerp(fog.far, fog.far * RAIN_FOG_FAR_MULT, weather);
      if (sun) sun.intensity *= 1 - weather * RAIN_SUN_CUT;
      if (moon) moon.intensity *= 1 - weather * RAIN_SUN_CUT;
      if (ambient) ambient.intensity *= 1 + weather * RAIN_AMBIENT_LIFT;
      // Cloud cover swallows the celestial discs and the stars.
      sky.sunDiscMaterial.opacity *= 1 - weather;
      sky.moonDiscMaterial.opacity *= 1 - weather;
      if (stars) stars.visible = stars.visible && weather < RAIN_STARS_CUTOFF;
    }

    // Red realm override: runs LAST so it fully replaces the day/night/weather
    // palette with a wild, timeless red sky + a rainbow streaking overhead. The
    // sun keeps its computed arc direction (for terrain shading) but turns dim
    // and red; the celestial discs hide and the rainbow takes over.
    const isRed = useUIStore.getState().realm === "red";
    sky.rainbow.visible = isRed;
    if (isRed) {
      background.copy(RED_HORIZON);
      fog.color.copy(RED_FOG);
      fog.near = RED_FOG_NEAR;
      fog.far = RED_FOG_FAR;
      sky.horizonColor.copy(RED_HORIZON);
      sky.zenithColor.copy(RED_ZENITH);
      if (sun) {
        sun.intensity = RED_SUN_INTENSITY;
        sun.color.copy(RED_SUN_COLOR);
      }
      if (moon) moon.intensity = 0;
      if (ambient) {
        ambient.intensity = RED_AMBIENT_INTENSITY;
        ambient.color.copy(RED_AMBIENT);
      }
      if (hemi) {
        hemi.intensity = RED_HEMI_INTENSITY;
        hemi.color.copy(RED_HEMI_SKY);
        hemi.groundColor.copy(RED_HEMI_GROUND);
      }
      sky.sunDiscMaterial.opacity = 0;
      sky.moonDiscMaterial.opacity = 0;
      if (stars) stars.visible = true; // a wild starfield, day or night
      // Stand the arch RAINBOW_DIST ahead of the camera along the horizontal
      // look direction, dropped so it springs from the horizon, and turn it to
      // face back at the camera so the whole arch always spans the view.
      state.camera.getWorldDirection(rainbowDirTmp);
      rainbowDirTmp.y = 0;
      if (rainbowDirTmp.lengthSq() < 1e-6) rainbowDirTmp.set(0, 0, -1);
      rainbowDirTmp.normalize();
      sky.rainbow.position.set(
        camPos.x + rainbowDirTmp.x * RAINBOW_DIST,
        camPos.y - RAINBOW_DROP,
        camPos.z + rainbowDirTmp.z * RAINBOW_DIST,
      );
      sky.rainbow.rotation.set(0, Math.atan2(-rainbowDirTmp.x, -rainbowDirTmp.z), 0);
    }
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
      <primitive object={sky.rainbow} />
      <group ref={starsRef} visible={false}>
        <Stars radius={280} depth={50} count={2500} factor={5} saturation={0} fade speed={0.5} />
      </group>
    </group>
  );
}
