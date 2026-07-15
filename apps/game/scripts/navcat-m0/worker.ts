// Doc 14 M0 — navcat-in-workerd execution probe.
//
// Proves navcat's per-tile build pipeline + findPath execute INSIDE a real
// Durable Object (workerd), not just Node — the one condition the 2026-07-10
// spike left open. Run with `wrangler dev` (local workerd) and curl the root.
// Returns JSON: does it run, is the navmesh valid, does a query route around an
// obstacle, and rough build/query timings (workerd under-reports pure-CPU time,
// so treat these as order-of-magnitude, corroborated by an external wall-clock).
//
// NOT shipped, NOT wired into the game worker — a throwaway scratch DO.

import { DurableObject } from "cloudflare:workers";
import { generateSoloNavMesh } from "navcat/blocks";
import { findPath, DEFAULT_QUERY_FILTER } from "navcat";

interface Env {
  NAV_PROBE: DurableObjectNamespace<NavProbe>;
}

// navcat agent config — the exact knobs the spike used (the game's kinematic
// player/zombie: PLAYER_RADIUS 0.45, PLAYER_HEIGHT 1.8, STEP_UP_MAX 0.6).
const cellSize = 0.5;
const cellHeight = 0.25;
const OPTIONS = {
  cellSize,
  cellHeight,
  walkableRadiusWorld: 0.45,
  walkableRadiusVoxels: Math.ceil(0.45 / cellSize),
  walkableClimbWorld: 0.6,
  walkableClimbVoxels: Math.ceil(0.6 / cellHeight),
  walkableHeightWorld: 1.8,
  walkableHeightVoxels: Math.ceil(1.8 / cellHeight),
  walkableSlopeAngleDegrees: 60,
  borderSize: 0,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxSimplificationError: 1.3,
  maxEdgeLength: 12,
  maxVerticesPerPoly: 5,
  detailSampleDistance: cellSize * 6,
  detailSampleMaxError: cellHeight,
};

/** Push a box (12 triangles) into positions/indices — a surface mesh, like the
 *  static-AABB colliders the real baker feeds from PhysicsStaticsSource. */
function pushBox(
  pos: number[],
  idx: number[],
  min: [number, number, number],
  max: [number, number, number],
): void {
  const base = pos.length / 3;
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], // bottom
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], // top
  ];
  for (const [x, y, z] of v) pos.push(x, y, z);
  const faces = [
    [0, 1, 2], [0, 2, 3], // bottom
    [4, 6, 5], [4, 7, 6], // top
    [0, 4, 5], [0, 5, 1], // -z
    [1, 5, 6], [1, 6, 2], // +x
    [2, 6, 7], [2, 7, 3], // +z
    [3, 7, 4], [3, 4, 0], // -x
  ];
  for (const [a, b, c] of faces) idx.push(base + a, base + b, base + c);
}

/** A 40 m flat ground plane + a 12 m solid building block at the origin: a path
 *  across the diagonal must route AROUND the block (the "cheese enclosure" in
 *  miniature). */
function buildMesh(): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  // Ground [-20,20]^2 at y=0 (two triangles — a flat plane rasterizes fine).
  const g = 20;
  const gb = pos.length / 3;
  pos.push(-g, 0, -g, g, 0, -g, g, 0, g, -g, 0, g);
  idx.push(gb, gb + 2, gb + 1, gb, gb + 3, gb + 2);
  // Building block at the centre, 4 m tall — an obstacle to route around.
  pushBox(pos, idx, [-6, 0, -6], [6, 4, 6]);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function run(): unknown {
  const notes: string[] = [];
  const mesh = buildMesh();

  // Build (cold + a few warm reps for a rough p50).
  const buildMs: number[] = [];
  let navMesh: ReturnType<typeof generateSoloNavMesh>["navMesh"] | null = null;
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const res = generateSoloNavMesh({ positions: mesh.positions, indices: mesh.indices }, OPTIONS);
    buildMs.push(performance.now() - t0);
    navMesh = res.navMesh;
  }
  if (!navMesh) throw new Error("generateSoloNavMesh returned no navMesh");

  let polys = 0;
  let verts = 0;
  for (const id of Object.keys(navMesh.tiles)) {
    polys += navMesh.tiles[id].polys.length;
    verts += navMesh.tiles[id].vertices.length / 3;
  }

  // Query: from one corner to the opposite, straight line crosses the block.
  const start: [number, number, number] = [-15, 0, -12];
  const end: [number, number, number] = [12, 0, 15];
  const halfExtents: [number, number, number] = [2, 4, 2];
  const queryMs: number[] = [];
  let path: { x: number; z: number }[] = [];
  let success = false;
  let flags = 0;
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const r = findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);
    queryMs.push(performance.now() - t0);
    if (i === 49) {
      success = r.success;
      flags = r.flags;
      path = r.path.map((p) => ({ x: round(p.position[0]), z: round(p.position[2]) }));
    }
  }

  // A straight line from start to end passes through the block footprint
  // (x,z in [-6,6]); a routed path must have an intermediate waypoint that
  // detours outside it.
  const routed = path.length > 2 && path.some((p) => Math.abs(p.x) > 6 || Math.abs(p.z) > 6);
  notes.push(routed ? "path detours around the block (routed, not straight)" : "path is ~straight (check obstacle)");

  const p = (a: number[], q: number) => {
    const s = [...a].sort((x, y) => x - y);
    return round(s[Math.min(s.length - 1, Math.floor(s.length * q))]);
  };

  return {
    ok: true,
    runtime: "workerd (Durable Object)",
    navmesh: { tiles: Object.keys(navMesh.tiles).length, polys, verts },
    build: { coldMs: round(buildMs[0]), warmP50Ms: p(buildMs.slice(1), 0.5), reps: buildMs.length },
    query: {
      success,
      flags,
      pathPoints: path.length,
      warmP50Ms: p(queryMs.slice(20), 0.5),
      warmP95Ms: p(queryMs.slice(20), 0.95),
      path,
    },
    notes,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class NavProbe extends DurableObject {
  async fetch(_req: Request): Promise<Response> {
    try {
      return Response.json(run());
    } catch (err) {
      return Response.json(
        { ok: false, error: String(err), stack: (err as Error)?.stack },
        { status: 500 },
      );
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = env.NAV_PROBE.idFromName("probe");
    return env.NAV_PROBE.get(id).fetch(req);
  },
};
