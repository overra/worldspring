// Day/night sky: sun + moon directional lights, ambient/hemisphere fill,
// scene background + fog colors lerped through dawn/dusk palettes, stars at
// night. Everything is mutated per frame from clientWorld.timeOfDay — no
// React state, no pops at hour boundaries.

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

const skyTmp = new THREE.Color();

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

  useEffect(() => {
    scene.background = background;
    scene.fog = fog;
    return () => {
      scene.background = null;
      scene.fog = null;
    };
  }, [scene, background, fog]);

  useFrame(() => {
    const hour = clientWorld.timeOfDay;
    const elev = sunElevation(hour);
    // 0 = full night, 1 = full day; ramps through dawn/dusk.
    const dayF = smoothstep01((elev + 0.12) / 0.47);

    const sun = sunRef.current;
    if (sun) {
      // East-to-west arc; exact azimuth at night is irrelevant (intensity 0).
      const dayT = (hour - NIGHT_END_HOUR) / DAY_LEN;
      sun.position.set(Math.cos(Math.PI * dayT) * 160, elev * 140, 60);
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

    const stars = starsRef.current;
    if (stars) stars.visible = elev < STARS_SHOW_ELEVATION;
  });

  return (
    <group>
      <directionalLight ref={sunRef} position={[160, 100, 60]} intensity={1.2} />
      <directionalLight ref={moonRef} position={[-120, 80, -80]} intensity={0} color="#93a7cc" />
      <ambientLight ref={ambientRef} intensity={0.4} />
      <hemisphereLight ref={hemiRef} intensity={0.5} />
      <group ref={starsRef} visible={false}>
        <Stars radius={280} depth={50} count={2500} factor={5} saturation={0} fade speed={0.5} />
      </group>
    </group>
  );
}
