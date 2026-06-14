// Static island terrain: one displaced, vertex-colored plane built once from
// the deterministic world heightfield. Low-poly flat-shaded, no textures.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import { WORLD_SIZE } from "@worldspring/shared/constants";
import { clamp } from "@worldspring/shared/math";
import { MAP_BIOME, MAP_PALETTE } from "@worldspring/shared/map/palette";
import { clientWorld } from "@/client/runtime";

const SEGMENTS = 200;

// Palette literals + thresholds are the SHARED source (packages/shared/src/map/
// palette.ts) so the 3D terrain and the top-down map never drift (doc 12 M1).
// THREE.Color converts the same hex from sRGB to working space automatically.
const SAND = new THREE.Color(MAP_PALETTE.sand);
const GRASS_LOW = new THREE.Color(MAP_PALETTE.grassLow);
const GRASS_HIGH = new THREE.Color(MAP_PALETTE.grassHigh);
const ROCK = new THREE.Color(MAP_PALETTE.rock);

const SAND_MAX_H = MAP_BIOME.sandMaxH; // sand below here, blending out just above
const ROCK_HEIGHT = MAP_BIOME.rockHeight; // high altitude turns to bare rock
const ROCK_SLOPE_START = MAP_BIOME.rockSlopeStart; // gradient (m/m) where rock starts blending in
const ROCK_SLOPE_FULL = MAP_BIOME.rockSlopeFull;

function buildTerrainGeometry(heightAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2); // lie flat: plane XY -> world XZ

  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);

    // Local slope: central-difference gradient magnitude (m per m).
    const dhdx = (heightAt(x + 2, z) - heightAt(x - 2, z)) / 4;
    const dhdz = (heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
    const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);

    // Grass darkens subtly with altitude.
    tmp.copy(GRASS_LOW).lerp(GRASS_HIGH, clamp((h - 2) / 14, 0, 1));
    // Beach sand below the waterline fringe.
    tmp.lerp(SAND, clamp((SAND_MAX_H + 0.3 - h) / 0.6, 0, 1));
    // Bare rock on steep faces and high ground.
    const rockT = Math.max(
      clamp((slope - ROCK_SLOPE_START) / (ROCK_SLOPE_FULL - ROCK_SLOPE_START), 0, 1),
      clamp((h - ROCK_HEIGHT) / 2.5, 0, 1),
    );
    tmp.lerp(ROCK, rockT);

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  pos.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function Terrain(): ReactElement | null {
  const world = clientWorld.world;
  const geometry = useMemo(
    () => (world ? buildTerrainGeometry(world.heightAt) : null),
    [world],
  );

  useEffect(() => {
    if (!geometry) return;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) return null;
  return (
    <mesh geometry={geometry} frustumCulled={false} receiveShadow>
      <meshStandardMaterial vertexColors flatShading />
    </mesh>
  );
}
