// doc 07 M5 — fresh-water surfaces (rivers + ponds). ONE static BufferGeometry
// for the whole island (river ribbons + pond discs) sharing a single instance of
// the ocean's patched water material (calmer swell), so all fresh water is ONE
// extra draw call. Present only on a water world (world.water set); dry worlds
// render nothing. Surfaces sit 0.05m below their surfY so they never z-fight the
// carved banks, and the material is translucent + fog-aware like the ocean.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RIVER_R_MULT } from "@worldspring/shared/world";
import type { River, Pond, World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";
import { createWaterMaterial, FRESH_WAVE_AMPLITUDE } from "./WaterPlane";

/** Sit the visible surface just under surfY so waves never poke through banks. */
const SURFACE_DROP = 0.05;
/** Pond disc tessellation. */
const POND_SEGMENTS = 24;

/** Append a river as a two-sided ribbon strip: paired verts offset ± the carve
 * influence half-width (halfW·RIVER_R_MULT — the full width the terrain is
 * carved over) perpendicular to the polyline, each at its own surfY (the surface
 * slopes downhill with the channel). Drawing to the carve radius (not the
 * narrower channel) lets the opaque terrain, which the C0-continuous carve
 * raises back to natural height by that radius, occlude the water exactly at its
 * shoreline — so the visible edge follows the real bank on any terrain instead
 * of leaving a submerged-but-undrawn band. */
function addRiver(river: River, pos: number[], idx: number[]): void {
  const v = river.verts;
  if (v.length < 2) return;
  const base = pos.length / 3;
  for (let i = 0; i < v.length; i++) {
    const cur = v[i];
    // Tangent from neighbours (forward/back at the ends).
    const a = v[Math.max(0, i - 1)];
    const b = v[Math.min(v.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Perpendicular in XZ.
    const px = -tz;
    const pz = tx;
    const w = cur.halfW * RIVER_R_MULT;
    const y = cur.surfY - SURFACE_DROP;
    pos.push(cur.x + px * w, y, cur.z + pz * w); // left
    pos.push(cur.x - px * w, y, cur.z - pz * w); // right
  }
  for (let i = 0; i < v.length - 1; i++) {
    const l0 = base + i * 2;
    const r0 = l0 + 1;
    const l1 = l0 + 2;
    const r1 = l0 + 3;
    idx.push(l0, r0, r1, l0, r1, l1);
  }
}

/** Append a pond as a flat 24-gon disc at its surfY. */
function addPond(pond: Pond, pos: number[], idx: number[]): void {
  const center = pos.length / 3;
  const y = pond.surfY - SURFACE_DROP;
  pos.push(pond.cx, y, pond.cz);
  for (let k = 0; k < POND_SEGMENTS; k++) {
    const ang = (k / POND_SEGMENTS) * Math.PI * 2;
    pos.push(pond.cx + Math.cos(ang) * pond.radius, y, pond.cz + Math.sin(ang) * pond.radius);
  }
  for (let k = 0; k < POND_SEGMENTS; k++) {
    idx.push(center, center + 1 + k, center + 1 + ((k + 1) % POND_SEGMENTS));
  }
}

function buildGeometry(world: World): THREE.BufferGeometry | null {
  const water = world.water;
  if (!water || (water.rivers.length === 0 && water.ponds.length === 0)) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const river of water.rivers) addRiver(river, pos, idx);
  for (const pond of water.ponds) addPond(pond, pos, idx);
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function FreshWater(): ReactElement | null {
  const world = clientWorld.world;

  const built = useMemo(() => {
    if (!world) return null;
    const geometry = buildGeometry(world);
    if (!geometry) return null;
    // Own instance of the ocean material (calmer swell). DoubleSide so the thin
    // ribbons/discs are visible from any camera angle without winding fuss.
    const assets = createWaterMaterial(FRESH_WAVE_AMPLITUDE);
    assets.material.side = THREE.DoubleSide;
    return { geometry, ...assets };
  }, [world]);

  useEffect(() => {
    if (!built) return;
    return () => {
      built.geometry.dispose();
      built.material.dispose();
    };
  }, [built]);

  useFrame((state) => {
    if (built) built.timeUniform.value = state.clock.elapsedTime;
  });

  if (!built) return null;
  return (
    <mesh geometry={built.geometry} material={built.material} frustumCulled={false} renderOrder={-1} />
  );
}
