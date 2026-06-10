// Static island terrain: one displaced, vertex-colored plane built once from
// the deterministic world heightfield. Low-poly flat-shaded, no textures.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import { WORLD_SIZE } from "@/shared/constants";
import { clamp } from "@/shared/math";
import { clientWorld } from "@/client/runtime";

const SEGMENTS = 200;

// Palette (THREE.Color converts hex from sRGB to working space automatically).
const SAND = new THREE.Color("#c2b280");
const GRASS_LOW = new THREE.Color("#5a7247");
const GRASS_HIGH = new THREE.Color("#49593b");
const ROCK = new THREE.Color("#7d7f78");

const SAND_MAX_H = 1.5; // sand below here, blending out just above
const ROCK_HEIGHT = 14; // high altitude turns to bare rock
const ROCK_SLOPE_START = 0.32; // gradient (m/m) where rock starts blending in
const ROCK_SLOPE_FULL = 0.52;

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
    <mesh geometry={geometry} frustumCulled={false}>
      <meshStandardMaterial vertexColors flatShading />
    </mesh>
  );
}
