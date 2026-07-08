// Chunked island terrain (doc 07 §4): 128m chunks on a fixed grid, displaced
// and vertex-colored from the deterministic analytic heightfield. Two LOD
// rings by chunk-center distance (LOD0 4m verts ≤336m — full density under
// every entity the interest filter can send; LOD1 8m ≤448m) with ±16m
// hysteresis, 3m skirts hiding LOD cracks, ≤2 geometry builds per frame, and
// an LRU geometry cache. All of that lives in terrainChunks.ts (React-free,
// tested headlessly by scripts/terrain-chunks.mjs); this file is only the
// React/R3F shell. Low-poly flat-shaded, no textures — the mesh is cosmetic,
// the sim only ever reads the analytic heightAt.

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clientWorld } from "@/client/runtime";
import { useUIStore } from "@/client/state/store";
import {
  createChunkRenderer,
  disposeChunkRenderer,
  updateChunks,
} from "./terrainChunks";

export function Terrain(): ReactElement | null {
  const world = clientWorld.world;
  // Red realm: a single multiply tint reddens the whole island while
  // preserving the baked height/slope shading, plus a faint emissive so the
  // barren ground glows under the wild sky. Overworld keeps white (vertex
  // colors as-is). One shared material tints every chunk at once.
  const realm = useUIStore((s) => s.realm);
  const isRed = realm === "red";

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.color.set(isRed ? "#d04a2c" : "#ffffff");
    material.emissive.set(isRed ? "#3a0c06" : "#000000");
  }, [material, isRed]);

  const renderer = useMemo(
    () => (world ? createChunkRenderer(world.size, world.heightAt, material) : null),
    [world, material],
  );

  useEffect(() => {
    if (!renderer) return;
    return () => disposeChunkRenderer(renderer);
  }, [renderer]);

  useFrame((state) => {
    if (!renderer) return;
    updateChunks(renderer, state.camera.position.x, state.camera.position.z);
  });

  if (!renderer) return null;
  return <primitive object={renderer.group} />;
}
