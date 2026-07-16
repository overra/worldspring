// The Pathfinder seam (doc 14 §1). navcat lives entirely behind this interface,
// so a fork can swap it for straight-line steering or another router without
// touching protocol, persistence, or the wire. SERVER-ONLY — never imported by
// the client or by the shared (fingerprinted) surface, so navcat's math can
// never enter a fingerprinted path (doc 14 §5).

/** A world-space XZ waypoint on a path. Y is re-derived by the mover's ground
 *  snap, so paths carry only the horizontal route. */
export interface Waypoint {
  x: number;
  z: number;
}

export interface Pathfinder {
  /**
   * Path from (ax,az) to (bx,bz) for a ground agent — a polyline of world-XZ
   * waypoints, or `null` if the endpoints are unreachable or their tiles are
   * not built yet. Callers fall back to straight-line steering on `null`
   * (doc 14 §4), so this never stalls an agent.
   */
  findPath(ax: number, az: number, bx: number, bz: number): Waypoint[] | null;

  /**
   * Queue navmesh tiles covering a `radius` around (x,z) for building —
   * activity-scoped generation around live AI/players (doc 14 §4). Cheap and
   * idempotent; the actual build is amortized through `stepBuild`.
   */
  ensureBuilt(x: number, z: number, radius: number): void;

  /**
   * Mark the tile(s) covering a world-space AABB dirty after statics change —
   * a base piece placed/demolished/opened, or a planted tree grown/felled
   * (doc 14 §2). Dirty tiles are re-carved through `stepBuild`.
   */
  dirtyTile(minX: number, minZ: number, maxX: number, maxZ: number): void;

  /**
   * Drain the build/dirty worklist, building at most `maxTiles` this call, then
   * evict cold tiles over the cap. Called once per tick from the engine's
   * `phase("nav")` (doc 14 §4). Count-based, not ms-based: workerd under-reports
   * pure-CPU time, so one tile is the unit of work.
   */
  stepBuild(maxTiles: number): void;
}
