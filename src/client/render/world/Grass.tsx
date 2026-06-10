// Wind-swaying instanced grass around the player. Chunk-based: the world is
// divided into 16m cells; each built chunk is one InstancedMesh of up to ~700
// tapered-quad blades placed deterministically (seeded per cell) on terrain.
// CPU builds matrices/colors once per chunk; the GPU does the wind sway via a
// MeshLambertMaterial onBeforeCompile patch that bends blade tops in world
// space (so scene fog and lighting keep working). A 5x5 chunk window follows
// the player; out-of-range chunks are kept in an LRU (recycled meshes) to
// avoid rebuild churn, and at most 2 chunks are built per frame.

import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { clientWorld } from "@/client/runtime";
import { createRng, hashString } from "@/shared/rng";
import { clamp } from "@/shared/math";
import type { World } from "@/shared/world";

const CHUNK_SIZE = 16; // meters
const BLADES_PER_CHUNK = 700;
const VIEW_CHUNK_RADIUS = 2; // 5x5 grid around the player's chunk
const MAX_BUILT_CHUNKS = 40; // LRU cap (recycle beyond this)
const MAX_BUILDS_PER_FRAME = 2;

const MIN_GRASS_HEIGHT = 1.4; // below this = beach/water, no grass
const SLOPE_SAMPLE = 0.5; // heightAt sampled +/- this around the blade
const MAX_SLOPE_DELTA = 0.8; // height delta over 2*SLOPE_SAMPLE that kills grass
const BUILDING_MARGIN = 0.5; // extra clearance around building footprints

const BLADE_BASE_HALF_WIDTH = 0.045; // ~0.09m wide at the base
const BLADE_TOP_HALF_WIDTH = 0.016; // tapered, not a needle
const BLADE_HEIGHT = 0.7; // base height; per-instance scale 0.7-1.3
const HEIGHT_SCALE_MIN = 0.7;
const HEIGHT_SCALE_MAX = 1.3;

const BASE_COLOR = "#55703f";
const LIGHTNESS_JITTER = 0.08; // +/-8% lightness per blade
// Low ground (just above the beach line) shifts toward yellow.
const YELLOW_FADE_TOP = 3.2; // fully green at/above this height
const YELLOW_HUE_SHIFT = 0.035;
const YELLOW_SAT_BOOST = 0.04;

// Wind: bend blade TOP vertices only (aBend = 0 at base, 1 at tip) in world
// space, after the instance transform, so the phase varies across the field.
const WIND_PROJECT_VERTEX = /* glsl */ `
vec4 grassWorld = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	grassWorld = instanceMatrix * grassWorld;
#endif
grassWorld = modelMatrix * grassWorld;
float grassPhase = uTime * 1.6 + grassWorld.x * 0.35 + grassWorld.z * 0.27;
grassWorld.x += sin( grassPhase ) * 0.06 * aBend;
grassWorld.z += sin( grassPhase * 0.83 + 1.7 ) * 0.04 * aBend;
vec4 mvPosition = viewMatrix * grassWorld;
gl_Position = projectionMatrix * mvPosition;
`;

interface ChunkEntry {
  key: string;
  mesh: THREE.InstancedMesh;
}

interface PendingBuild {
  key: string;
  cx: number;
  cz: number;
}

interface GrassRuntime {
  /** Built chunks; Map iteration order doubles as LRU (re-insert on touch). */
  built: Map<string, ChunkEntry>;
  /** Recycled meshes from evicted chunks, ready to be rebuilt. */
  pool: THREE.InstancedMesh[];
  /** Chunks waiting to be built, nearest-first. */
  queue: PendingBuild[];
  queued: Set<string>;
  desired: Set<string>;
  lastCx: number;
  lastCz: number;
}

interface SharedAssets {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshLambertMaterial;
  timeUniform: THREE.IUniform<number>;
}

const dummy = new THREE.Object3D();
const colorScratch = new THREE.Color();
const baseHsl = { h: 0, s: 0, l: 0 };
new THREE.Color(BASE_COLOR).getHSL(baseHsl);

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** Single tapered quad (2 triangles), origin at the base, facing +Z. */
function createBladeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -BLADE_BASE_HALF_WIDTH, 0, 0,
    BLADE_BASE_HALF_WIDTH, 0, 0,
    BLADE_TOP_HALF_WIDTH, BLADE_HEIGHT, 0,
    -BLADE_TOP_HALF_WIDTH, BLADE_HEIGHT, 0,
  ]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  // Bend weight (== uv.y): 0 at the base verts, 1 at the tip verts. Kept as
  // its own attribute so the shader patch never depends on USE_UV defines.
  const bend = new Float32Array([0, 0, 1, 1]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("aBend", new THREE.BufferAttribute(bend, 1));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function createWindMaterial(timeUniform: THREE.IUniform<number>): THREE.MeshLambertMaterial {
  // White base — the real color comes entirely from instanceColor, which the
  // shader multiplies into diffuse. Lambert keeps fog + lights via chunks.
  const material = new THREE.MeshLambertMaterial({
    color: "#ffffff",
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uTime;\nattribute float aBend;",
      )
      .replace("#include <project_vertex>", WIND_PROJECT_VERTEX);
  };
  material.customProgramCacheKey = () => "deadcoast-grass-wind";
  return material;
}

function createChunkMesh(assets: SharedAssets): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(assets.geometry, assets.material, BLADES_PER_CHUNK);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Pre-allocate so the very first compiled program includes instance colors.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(BLADES_PER_CHUNK * 3),
    3,
  );
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false; // thousands of blades in the shadow pass = no
  mesh.receiveShadow = false;
  mesh.frustumCulled = true; // per-chunk bounding sphere set in buildChunk
  return mesh;
}

/**
 * Fill a (new or recycled) InstancedMesh with this chunk's blades. Placement
 * is deterministic per cell (seeded by cell coords + world seed) so rebuilds
 * after eviction reproduce the exact same field. Returns blades placed.
 */
function buildChunk(world: World, cx: number, cz: number, mesh: THREE.InstancedMesh): number {
  const rng = createRng(hashString(`grass|${world.seed}|${cx}|${cz}`));
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;

  // Only test buildings whose (padded) footprint overlaps this chunk.
  const pad = BUILDING_MARGIN;
  const nearbyBuildings = world.buildings.filter(
    (b) =>
      x0 < b.cx + b.halfW + pad &&
      x0 + CHUNK_SIZE > b.cx - b.halfW - pad &&
      z0 < b.cz + b.halfD + pad &&
      z0 + CHUNK_SIZE > b.cz - b.halfD - pad,
  );

  let placed = 0;
  for (let i = 0; i < BLADES_PER_CHUNK; i++) {
    const x = x0 + rng.next() * CHUNK_SIZE;
    const z = z0 + rng.next() * CHUNK_SIZE;
    const yaw = rng.range(0, Math.PI * 2);
    const heightScale = rng.range(HEIGHT_SCALE_MIN, HEIGHT_SCALE_MAX);
    const lightJitter = rng.range(-LIGHTNESS_JITTER, LIGHTNESS_JITTER);

    const y = world.heightAt(x, z);
    if (y < MIN_GRASS_HEIGHT) continue; // beach / underwater

    // Steep local slope — bare rock, no grass.
    const dx =
      world.heightAt(x + SLOPE_SAMPLE, z) - world.heightAt(x - SLOPE_SAMPLE, z);
    if (Math.abs(dx) > MAX_SLOPE_DELTA) continue;
    const dz =
      world.heightAt(x, z + SLOPE_SAMPLE) - world.heightAt(x, z - SLOPE_SAMPLE);
    if (Math.abs(dz) > MAX_SLOPE_DELTA) continue;

    // Inside a building footprint (+margin). Towns otherwise keep grass.
    let blocked = false;
    for (const b of nearbyBuildings) {
      if (
        x > b.cx - b.halfW - pad &&
        x < b.cx + b.halfW + pad &&
        z > b.cz - b.halfD - pad &&
        z < b.cz + b.halfD + pad
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, heightScale, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);

    // Base green, +/-8% lightness, drifting yellower toward the beach line.
    const low = clamp((YELLOW_FADE_TOP - y) / (YELLOW_FADE_TOP - MIN_GRASS_HEIGHT), 0, 1);
    colorScratch.setHSL(
      baseHsl.h - YELLOW_HUE_SHIFT * low,
      Math.min(1, baseHsl.s + YELLOW_SAT_BOOST * low),
      baseHsl.l * (1 + lightJitter),
    );
    mesh.setColorAt(placed, colorScratch);
    placed++;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (placed > 0) {
    mesh.computeBoundingSphere(); // covers exactly this chunk's instances
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.2; // sway slack
  }
  return placed;
}

/** Recompute the wanted 5x5 set after a chunk crossing (or on first frame). */
function refreshDesired(rt: GrassRuntime, pcx: number, pcz: number): void {
  rt.desired.clear();
  const missing: Array<PendingBuild & { dist: number }> = [];

  for (let dz = -VIEW_CHUNK_RADIUS; dz <= VIEW_CHUNK_RADIUS; dz++) {
    for (let dx = -VIEW_CHUNK_RADIUS; dx <= VIEW_CHUNK_RADIUS; dx++) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = chunkKey(cx, cz);
      rt.desired.add(key);
      const entry = rt.built.get(key);
      if (entry) {
        entry.mesh.visible = entry.mesh.count > 0;
        // LRU touch: re-insert to move to the back of the iteration order.
        rt.built.delete(key);
        rt.built.set(key, entry);
      } else if (!rt.queued.has(key)) {
        missing.push({ key, cx, cz, dist: dx * dx + dz * dz });
      }
    }
  }

  for (const entry of rt.built.values()) {
    if (!rt.desired.has(entry.key)) entry.mesh.visible = false;
  }

  // Rebuild the queue: drop stale wishes, append new ones nearest-first.
  rt.queue = rt.queue.filter((p) => rt.desired.has(p.key));
  rt.queued = new Set(rt.queue.map((p) => p.key));
  missing.sort((a, b) => a.dist - b.dist);
  for (const m of missing) {
    rt.queue.push({ key: m.key, cx: m.cx, cz: m.cz });
    rt.queued.add(m.key);
  }
}

/** Keep at most MAX_BUILT_CHUNKS built; recycle the least-recently-used. */
function evictStale(rt: GrassRuntime): void {
  while (rt.built.size > MAX_BUILT_CHUNKS) {
    let evictKey: string | null = null;
    for (const key of rt.built.keys()) {
      if (!rt.desired.has(key)) {
        evictKey = key;
        break;
      }
    }
    if (evictKey === null) return; // everything in range (can't exceed cap)
    const entry = rt.built.get(evictKey);
    rt.built.delete(evictKey);
    if (!entry) continue;
    entry.mesh.visible = false;
    rt.pool.push(entry.mesh); // GPU buffers reused by the next build
  }
}

export function Grass(): ReactElement {
  const groupRef = useRef<THREE.Group>(null);

  const assets = useMemo<SharedAssets>(() => {
    const timeUniform: THREE.IUniform<number> = { value: 0 };
    return {
      geometry: createBladeGeometry(),
      material: createWindMaterial(timeUniform),
      timeUniform,
    };
  }, []);

  const runtimeRef = useRef<GrassRuntime>({
    built: new Map(),
    pool: [],
    queue: [],
    queued: new Set(),
    desired: new Set(),
    lastCx: Number.NaN,
    lastCz: Number.NaN,
  });

  useEffect(() => {
    const rt = runtimeRef.current;
    return () => {
      for (const entry of rt.built.values()) {
        entry.mesh.removeFromParent();
        entry.mesh.dispose(); // instance attributes; geometry/material shared
      }
      for (const mesh of rt.pool) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      rt.built.clear();
      rt.pool.length = 0;
      rt.queue.length = 0;
      rt.queued.clear();
      rt.desired.clear();
      assets.geometry.dispose();
      assets.material.dispose();
    };
  }, [assets]);

  useFrame((_, delta) => {
    assets.timeUniform.value += delta;

    const world = clientWorld.world;
    const group = groupRef.current;
    if (!world || !group) return;

    const rt = runtimeRef.current;
    const pcx = Math.floor(clientWorld.me.x / CHUNK_SIZE);
    const pcz = Math.floor(clientWorld.me.z / CHUNK_SIZE);
    if (pcx !== rt.lastCx || pcz !== rt.lastCz) {
      rt.lastCx = pcx;
      rt.lastCz = pcz;
      refreshDesired(rt, pcx, pcz);
    }

    // Budgeted building: at most 2 chunks per frame (each is ~700+ heightAt
    // calls plus matrix writes — cheap, but not 25-at-once cheap).
    let builds = 0;
    while (builds < MAX_BUILDS_PER_FRAME && rt.queue.length > 0) {
      const next = rt.queue.shift();
      if (!next) break;
      rt.queued.delete(next.key);
      if (!rt.desired.has(next.key) || rt.built.has(next.key)) continue;

      const mesh = rt.pool.pop() ?? createChunkMesh(assets);
      const placed = buildChunk(world, next.cx, next.cz, mesh);
      mesh.visible = placed > 0;
      if (mesh.parent !== group) group.add(mesh);
      rt.built.set(next.key, { key: next.key, mesh });
      builds++;
    }
    if (builds > 0) evictStale(rt);
  });

  return <group ref={groupRef} />;
}
