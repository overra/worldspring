// doc 13 M1 — the PhysicsWorld seam + Rapier implementation. Server-only:
// clients never import this; they interpolate WireBody poses (doc 13 §1).
//
// The engine namespace is INJECTED (attachEngine) rather than imported so this
// module stays importable everywhere: workerd attaches via loader.ts (wasm
// module import), the physics-replay harness attaches via rapier3d-compat's
// normal Node init. Engine init is async on workerd, so the system buffers
// state (restored/persisted bodies, early spawns) until the engine attaches —
// ticks before that are no-ops and persistence passes the buffer through
// unchanged, so a save before attach can never drop restored bodies.
//
// Determinism note (doc 13 §4): the engine is bit-deterministic per M0, but
// THIS system's outputs feed only snapshots + persistence — never client
// prediction. The replay harness pins engine behavior; nothing here enters
// worldFingerprintOf.

import type { BodyKind, WireBody } from "@worldspring/shared/protocol";
import type { PhysicsConfig } from "@worldspring/shared/config";
import type { StructurePiece } from "@worldspring/shared/structures";

/** doc 06 — derives a piece's collision AABBs (shared `pieceAabbs`). INJECTED
 * by state.ts at construction, like the engine namespace, so this module keeps
 * zero non-leaf value imports and stays strip-types importable by the replay
 * harness. Null (harness fakes) ⇒ attach builds no structure colliders. */
export type PieceGeometryFn = (piece: StructurePiece) => Aabb[];

// Minimal structural types for the injected Rapier namespace — `import type`
// only (erased at runtime; the harness runs this file via strip-types).
type RapierNamespace = (typeof import("@dimforge/rapier3d-compat"))["default"];
type RapierWorld = import("@dimforge/rapier3d-compat").World;
type RapierBody = import("@dimforge/rapier3d-compat").RigidBody;
type RapierCollider = import("@dimforge/rapier3d-compat").Collider;

/** What the terrain/statics collider build needs from the game World — a
 * structural subset so the replay harness can pass a tiny fake. */
export interface PhysicsStaticsSource {
  /** World edge length in meters (World.size — doc 07 M2). Drives the
   * heightfield extent and sample count (cell size stays ~4 m at every tier). */
  size: number;
  heightAt(x: number, z: number): number;
  buildings: ReadonlyArray<{ walls: ReadonlyArray<Aabb>; roof: Aabb }>;
  militaryWalls: ReadonlyArray<Aabb>;
  trees: ReadonlyArray<{ x: number; z: number; r: number; height: number }>;
  /** doc 06 — player structures. OPTIONAL so the replay harness's tiny fake
   * World needs no change; the real World always carries it. Restored pieces
   * are already in this index when attachEngine runs (loadWorld is
   * synchronous, the Rapier attach is async), so attach builds them all. */
  structures?: { pieces: ReadonlyMap<number, StructurePiece> };
}
interface Aabb {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y0: number;
  y1: number;
}

/** Persisted body record — OUR serialization, never engine snapshot bytes
 * (engine upgrades would break those, doc 13 §4). Velocities + sleep state
 * are included so momentum resumes and settled stacks restore asleep. */
export interface PersistedBody {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  z: number;
  q: [number, number, number, number];
  lv: [number, number, number];
  av: [number, number, number];
  /** Collider half-extents for per-instance-sized kinds (trunks, doc 13 M2).
   * ADDITIVE optional: absent (all pre-M2 rows, and every crate) falls back
   * to the fixed crate cube — crates keep serializing WITHOUT the key so the
   * replay-harness hash is untouched. */
  dims?: [number, number, number];
  asleep: boolean;
}

/** Terrain heightfield cell size in meters. The sample count scales with the
 * world edge (doc 07 M2, open decision #4): n = size/4 + 1 → 201 at standard
 * 800 m (~160 KB of floats, exactly the pre-M2 resolution), 801 at huge
 * (801² Float32 ≈ 2.6 MB, one-time, server-only — trivial vs the 128 MB DO).
 * Bodies rest on this sampled field while players stand on the analytic
 * heightAt — a ≤ half-cell seam that reads fine for props (doc 13 §1). */
const HEIGHTFIELD_CELL_M = 4;
/** Crates half-extent (matches the client's crate mesh + loot-crate scale). */
const CRATE_HALF = 0.4;
/** Barrel collider half-extents (doc 13 M3). LOCAL mirror of shared
 * BARREL_HALF_XZ / BARREL_HALF_Y (constants.ts) — this module stays value-
 * import-free of non-leaf shared modules for the strip-types replay harness
 * (the CRATE_HALF precedent), so the values are duplicated, not imported. They
 * MUST equal the shared pair (the client mesh + the server spawn lift read it). */
const BARREL_HALF_XZ = 0.3;
const BARREL_HALF_Y = 0.5;
/** Vehicle hull half-extents (doc 13 M4). LOCAL mirror of shared VEHICLE_HALF_X/
 * Y/Z (constants.ts) — the BARREL_HALF precedent keeps this module value-import-
 * free of non-leaf shared modules for the strip-types replay harness. MUST equal
 * the shared trio (the client mesh + server spawn lift read those). Local -Z is
 * forward, so the hull is longer on Z (length) than wide on X (width). */
const VEHICLE_HALF_X = 0.75;
const VEHICLE_HALF_Y = 0.55;
const VEHICLE_HALF_Z = 1.25;
/**
 * Driven-body controller tuning (doc 13 M4). Server-only, deterministic: the
 * controller in `driveVehicle` reads ONLY the engine body state + the clamped
 * driver input and applies impulses/torques with pure float math (mul/add/
 * min/max/abs/sqrt — NO transcendentals, so it is bit-reproducible like the
 * rest of the engine). Balance lives here (engine-adjacent) so the replay
 * harness exercises the production controller, not a re-implementation — the
 * TOPPLE_SPEED/BARREL_SHOVE precedent of keeping the impulse math beside the
 * body. NOT folded into the HASHED replay scenario, so baseline b7036dc6 stands.
 */
/** Forward drive acceleration at full throttle (m/s²). */
const VEHICLE_DRIVE_ACCEL = 11;
/** Forward speed cap (m/s) — drive force cuts out past it. */
const VEHICLE_MAX_SPEED = 15;
/** Reverse speed cap (m/s). */
const VEHICLE_MAX_REVERSE = 6;
/** Braking deceleration at full brake (m/s²). Bounded so a normal brake never
 * looks like a crash to the forward-speed-drop detector (constants.ts
 * VEHICLE_CRASH_MIN_DROP sits above VEHICLE_BRAKE_ACCEL × tick dt). */
const VEHICLE_BRAKE_ACCEL = 14;
/** Fraction of LATERAL (sideways) velocity cancelled each tick — grip, so the
 * hull corners instead of sliding like ice. 0 = ice, 1 = on rails. */
const VEHICLE_GRIP = 0.85;
/** Yaw steer acceleration (rad/s²) at full steer and full speed authority. */
const VEHICLE_STEER_ACCEL = 3.4;
/** Speed (m/s) at which steering reaches full authority (scales linearly to it,
 * so a near-stationary hull barely turns — no pirouetting in place). */
const VEHICLE_STEER_REF_SPEED = 5;
/** Linear/angular damping baked onto the hull body so it coasts to rest and
 * steering settles (deterministic — part of the engine step). */
const VEHICLE_LINEAR_DAMPING = 0.35;
const VEHICLE_ANGULAR_DAMPING = 2.2;
/** Seconds a body must sleep before it counts as "settled" for eviction. */
const SETTLED_AFTER_S = 2;
/** Engine substeps per game tick. Rapier's solver is tuned for ~1/60s steps;
 * at the raw 1/15 tick, fast-falling bodies TUNNEL through colliders (found
 * empirically by the replay harness's probes — contacts miss when per-step
 * displacement exceeds the contact window). 4 substeps ≈ 16.7 ms each; cost
 * is 4× the M0 per-step number, still <1% of the tick at the body cap. */
const PHYSICS_SUBSTEPS = 4;

/** doc 13 M4 — post-step readout of a vehicle body for the driving system:
 * position, forward unit vector on XZ (facing), horizontal speed (for ramming)
 * and signed forward speed (for the crash detector). */
export interface VehicleSensors {
  x: number;
  y: number;
  z: number;
  /** Forward unit vector, XZ only (the hull is upright — X/Z rotation locked). */
  fx: number;
  fz: number;
  /** |horizontal velocity| (m/s). */
  speed: number;
  /** Signed forward speed vf = v·forward (m/s). */
  forward: number;
}

/** Rotate vector (vx,vy,vz) by quaternion (qx,qy,qz,qw). Pure float math
 * (mul/add only — NO transcendentals), so it is bit-deterministic alongside the
 * WASM engine (doc 13 M4). v' = v + 2·qw·(q×v) + 2·q×(q×v). */
function rotateByQuat(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
): [number, number, number] {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

interface BodyRec {
  id: number;
  kind: BodyKind;
  body: RapierBody;
  /** Half-extents for per-instance-sized kinds (mirrored to the wire). */
  dims?: [number, number, number];
  /** game.time when the body last entered sleep, or null while awake. */
  sleptAt: number | null;
  createdAt: number;
}

export class PhysicsSystem {
  private engine: RapierNamespace | null = null;
  private world: RapierWorld | null = null;
  private bodies = new Map<number, BodyRec>();
  /** Restored/persisted + pre-attach spawns, drained into the engine on attach. */
  private pending: PersistedBody[] = [];
  /** Static tree colliders by index in statics.trees, so a felled tree's
   * collider can be REMOVED at runtime (doc 13 M2). Empty until attach. */
  private treeColliders = new Map<number, RapierCollider>();
  /** doc 06 — static colliders per structure piece id (the fellTree handle
   * pattern in reverse): runtime placements add, demolish removes, door
   * toggles swap. Empty until attach; pre-attach mutations are no-ops because
   * attachEngine reads the structure index itself. */
  private structColliders = new Map<number, RapierCollider[]>();
  /** Felled tree indices — excluded from the static build at attach (restored
   * worlds) and removed live after it (fresh fells). Grows monotonically. */
  private felledTrees = new Set<number>();
  private statics: PhysicsStaticsSource;
  private cfg: PhysicsConfig;
  private gameTime = 0;
  /** doc 06 — injected shared pieceAabbs (see PieceGeometryFn). */
  private readonly pieceGeometry: PieceGeometryFn | null;

  constructor(statics: PhysicsStaticsSource, cfg: PhysicsConfig, pieceGeometry: PieceGeometryFn | null = null) {
    this.statics = statics;
    this.cfg = cfg;
    this.pieceGeometry = pieceGeometry;
  }

  /** Hydrate persisted bodies (before OR after attach — both safe). */
  restore(persisted: PersistedBody[]): void {
    if (this.engine) for (const p of persisted) this.materialize(p);
    else this.pending.push(...persisted);
  }

  /** Wire the initialized Rapier namespace in; builds the static world and
   * drains buffered bodies. Idempotent. */
  attachEngine(engine: RapierNamespace, dt: number): void {
    if (this.engine || !this.cfg.enabled) return;
    this.engine = engine;
    const world = new engine.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = dt / PHYSICS_SUBSTEPS;
    this.world = world;

    // Terrain: one sampled heightfield spanning the whole island, centered on
    // the origin like the world itself (world.size square, doc 07 M2).
    // Rapier heightfield data is COLUMN-major: heights[col * nrows+1 + row],
    // columns along x, rows along z — validated empirically by the replay
    // harness's slope probes (swap = probe failure, not a silent tilt).
    const size = this.statics.size;
    const n = Math.round(size / HEIGHTFIELD_CELL_M) + 1;
    const heights = new Float32Array(n * n);
    for (let col = 0; col < n; col++) {
      const x = (col / (n - 1) - 0.5) * size;
      for (let row = 0; row < n; row++) {
        const z = (row / (n - 1) - 0.5) * size;
        heights[col * n + row] = Math.fround(this.statics.heightAt(x, z));
      }
    }
    world.createCollider(
      engine.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: size, y: 1, z: size }),
    );

    // Statics: the SAME AABBs the kinematic sim collides with (world.ts) —
    // no second source of truth. Trees as cuboids from their trunk radius.
    const addAabb = (a: Aabb) => {
      const hx = (a.maxX - a.minX) / 2, hy = (a.y1 - a.y0) / 2, hz = (a.maxZ - a.minZ) / 2;
      if (hx <= 0 || hy <= 0 || hz <= 0) return;
      world.createCollider(
        engine.ColliderDesc.cuboid(hx, hy, hz).setTranslation(a.minX + hx, a.y0 + hy, a.minZ + hz),
      );
    };
    for (const b of this.statics.buildings) {
      for (const w of b.walls) addAabb(w);
      addAabb(b.roof);
    }
    for (const w of this.statics.militaryWalls) addAabb(w);
    // Trees keep their collider HANDLE per index (doc 13 M2): felling removes
    // exactly one collider at runtime. Already-felled indices (restored from
    // the world snapshot via fellTree before attach) are never built at all.
    this.statics.trees.forEach((t, index) => {
      if (this.felledTrees.has(index)) return;
      const y0 = this.statics.heightAt(t.x, t.z);
      this.treeColliders.set(
        index,
        world.createCollider(
          engine.ColliderDesc.cuboid(t.r, t.height / 2, t.r).setTranslation(t.x, y0 + t.height / 2, t.z),
        ),
      );
    });

    // doc 06 — player structures: everything already in the shared index
    // (restored pieces included — loadWorld ran synchronously before this
    // async attach). Open doors/gates derive zero AABBs, so they build no
    // colliders, matching the kinematic collision swap.
    if (this.statics.structures && this.pieceGeometry) {
      for (const piece of this.statics.structures.pieces.values()) {
        this.addStructure(piece.id, this.pieceGeometry(piece));
      }
    }

    const buffered = this.pending;
    this.pending = [];
    for (const p of buffered) this.materialize(p);
  }

  /**
   * doc 06 — static colliders for a placed piece (runtime add). Pre-attach
   * this is a deliberate no-op: attachEngine iterates the structure index, so
   * a piece placed before the wasm resolves is built then. Idempotent per id
   * (a duplicate add for a live id is dropped).
   */
  addStructure(id: number, aabbs: Aabb[]): void {
    if (!this.engine || !this.world || !this.cfg.enabled) return;
    if (this.structColliders.has(id)) return;
    const engine = this.engine;
    const world = this.world;
    const handles: RapierCollider[] = [];
    for (const a of aabbs) {
      const hx = (a.maxX - a.minX) / 2;
      const hy = (a.y1 - a.y0) / 2;
      const hz = (a.maxZ - a.minZ) / 2;
      if (hx <= 0 || hy <= 0 || hz <= 0) continue;
      handles.push(
        world.createCollider(
          engine.ColliderDesc.cuboid(hx, hy, hz).setTranslation(a.minX + hx, a.y0 + hy, a.minZ + hz),
        ),
      );
    }
    this.structColliders.set(id, handles);
  }

  /** doc 06 — remove a demolished piece's colliders (fellTree precedent).
   * Pre-attach no-op: the piece is already gone from the index attach reads. */
  removeStructure(id: number): void {
    const handles = this.structColliders.get(id);
    if (!handles) return;
    this.structColliders.delete(id);
    if (!this.world) return;
    for (const h of handles) this.world.removeCollider(h, true);
  }

  /**
   * doc 06 — door/gate collision swap: replace the piece's colliders with the
   * boxes derived from its CURRENT open state (open ⇒ zero boxes ⇒ zero
   * colliders). Without this a trunk rolls into an open doorway and stops on
   * an invisible physics box — a visible desync vs the interpolated bodies.
   */
  setStructureOpen(id: number, aabbs: Aabb[]): void {
    if (!this.engine) return;
    this.removeStructure(id);
    this.addStructure(id, aabbs);
  }

  get ready(): boolean {
    return this.engine !== null;
  }

  /** Spawn a new dynamic body. Returns its id, or null when disabled. The
   * caller supplies the id (game.nextEntityId — shared entity id space).
   * `dims` = collider half-extents for per-instance-sized kinds (trunks);
   * omitted for the fixed-size crate. */
  spawnBody(
    id: number,
    kind: BodyKind,
    x: number,
    y: number,
    z: number,
    dims?: [number, number, number],
  ): number | null {
    if (!this.cfg.enabled) return null;
    const rec: PersistedBody = {
      id, kind, x, y, z, q: [0, 0, 0, 1], lv: [0, 0, 0], av: [0, 0, 0], asleep: false,
    };
    if (dims) rec.dims = dims;
    if (!this.engine) {
      this.pending.push(rec);
      return id;
    }
    this.materialize(rec);
    return id;
  }

  applyImpulse(id: number, ix: number, iy: number, iz: number): void {
    this.bodies.get(id)?.body.applyImpulse({ x: ix, y: iy, z: iz }, true);
  }

  /** Impulse at a world-space point — off-center application yields the torque
   * that TOPPLES a freshly-felled trunk (doc 13 M2). No-op pre-attach: fell
   * completion only spawns trunks once the room is live, and a buffered spawn
   * simply falls straight down on attach — degraded, never wrong. */
  applyImpulseAtPoint(
    id: number,
    ix: number, iy: number, iz: number,
    px: number, py: number, pz: number,
  ): void {
    this.bodies.get(id)?.body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true);
  }

  /**
   * doc 13 M4 — apply ONE tick of driver control to a "vehicle" body. The
   * driven-body controller: forward/reverse drive along the hull's facing
   * (throttle, speed-capped), braking opposing forward motion, lateral grip so
   * it corners instead of ice-sliding, and speed-scaled yaw steering. Applied
   * as impulses/torques ONCE per tick, right BEFORE step()'s substeps.
   *
   * Deterministic: reads ONLY the engine body state + the driver input, which
   * the caller has already parse-clamped (throttle/steer ∈ [-1,1], brake ∈
   * [0,1]) AND fuel-gated (throttle passed as 0 when the tank is dry). Pure
   * float math, no transcendentals, no wall-clock. No-op for a non-vehicle id
   * or when disabled; a fully-idle call on a near-stopped hull is skipped so a
   * parked-but-occupied vehicle can still sleep (no wake-on-zero).
   */
  driveVehicle(id: number, throttle: number, steer: number, brake: number, dt: number): void {
    const rec = this.bodies.get(id);
    if (!rec || rec.kind !== "vehicle") return;
    const body = rec.body;
    const q = body.rotation();
    const v = body.linvel();
    const mass = body.mass();
    const [fx, fy, fz] = rotateByQuat(q.x, q.y, q.z, q.w, 0, 0, -1); // forward (-Z)
    const [rx, , rz] = rotateByQuat(q.x, q.y, q.z, q.w, 1, 0, 0); // right (+X)
    const vf = v.x * fx + v.y * fy + v.z * fz; // signed forward speed
    const vr = v.x * rx + v.z * rz; // lateral (sideways) speed on XZ
    const idle = throttle === 0 && steer === 0 && brake === 0;
    if (idle && Math.abs(vf) < 0.05 && Math.abs(vr) < 0.05) return;

    // Drive force along the hull's facing, capped at the speed limits.
    let accel = 0;
    if (throttle > 0 && vf < VEHICLE_MAX_SPEED) accel = throttle * VEHICLE_DRIVE_ACCEL;
    else if (throttle < 0 && vf > -VEHICLE_MAX_REVERSE) accel = throttle * VEHICLE_DRIVE_ACCEL;
    // Braking opposes forward motion (bounded, so it never reads as a crash).
    if (brake > 0 && Math.abs(vf) > 1e-3) accel += (vf > 0 ? -1 : 1) * brake * VEHICLE_BRAKE_ACCEL;
    const along = accel * mass * dt; // forward impulse magnitude
    // Lateral grip: cancel a fraction of the sideways velocity this tick — an
    // instantaneous velocity change (Δp = mass·Δv), so it is NOT dt-scaled.
    const lat = -vr * VEHICLE_GRIP * mass;
    body.applyImpulse({ x: fx * along + rx * lat, y: fy * along, z: fz * along + rz * lat }, true);
    // Steering: yaw torque scaled by forward-speed authority (barely turns near
    // standstill), inverted in reverse (steer a reversing car the natural way).
    if (steer !== 0) {
      const authority = Math.min(1, Math.abs(vf) / VEHICLE_STEER_REF_SPEED);
      const dir = vf >= 0 ? 1 : -1;
      const yawImpulse = -steer * VEHICLE_STEER_ACCEL * authority * dir * mass * dt;
      body.applyTorqueImpulse({ x: 0, y: yawImpulse, z: 0 }, true);
    }
  }

  /** doc 13 M4 — read a vehicle body's post-step pose/velocity (see
   * VehicleSensors). Null for a non-vehicle id or before the engine attaches. */
  vehicleSensors(id: number): VehicleSensors | null {
    const rec = this.bodies.get(id);
    if (!rec || rec.kind !== "vehicle") return null;
    const body = rec.body;
    const t = body.translation();
    const q = body.rotation();
    const v = body.linvel();
    const [fx, , fz] = rotateByQuat(q.x, q.y, q.z, q.w, 0, 0, -1);
    const speed = Math.sqrt(v.x * v.x + v.z * v.z);
    const forward = v.x * fx + v.z * fz;
    return { x: t.x, y: t.y, z: t.z, fx, fz, speed, forward };
  }

  /**
   * Mark a tree (by index in statics.trees) as felled: its STATIC collider is
   * removed from the physics world so the dynamic trunk (and future props)
   * stop colliding where it stood (doc 13 M2). Pre-attach calls just record
   * the index — attachEngine skips building those colliders — which is how a
   * restored felled set from the world snapshot is honored. Idempotent. Note
   * the KINEMATIC statics (movement.ts queryStatics) intentionally still
   * contain the tree — player movement vs stumps is doc 05's concern.
   */
  fellTree(index: number): void {
    this.felledTrees.add(index);
    const collider = this.treeColliders.get(index);
    if (collider && this.world) {
      this.world.removeCollider(collider, true);
      this.treeColliders.delete(index);
    }
  }

  /**
   * Remove and return every body of `kind` that has been ASLEEP for at least
   * `ttlS` game-seconds, with its resting pose — the trunk despawn-to-loot
   * sweep (doc 13 M2). Wake-ups reset the clock (sleptAt nulls on wake), so a
   * trunk nudged by another body lives on until it re-settles.
   */
  expireSettled(kind: BodyKind, ttlS: number, gameTime: number): Array<{ id: number; x: number; y: number; z: number }> {
    const out: Array<{ id: number; x: number; y: number; z: number }> = [];
    for (const rec of this.bodies.values()) {
      if (rec.kind !== kind) continue;
      if (rec.sleptAt === null || gameTime - rec.sleptAt < ttlS) continue;
      const t = rec.body.translation();
      out.push({ id: rec.id, x: t.x, y: t.y, z: t.z });
    }
    for (const b of out) this.removeBody(b.id);
    return out;
  }

  removeBody(id: number): void {
    const rec = this.bodies.get(id);
    if (!rec || !this.world) return;
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(id);
  }

  /** Step the world one tick. No-op until the engine attaches or when
   * disabled. Also runs sleep bookkeeping + cap eviction. */
  step(dt: number, gameTime: number): void {
    this.gameTime = gameTime;
    if (!this.world || !this.cfg.enabled) return;
    this.world.timestep = dt / PHYSICS_SUBSTEPS;
    for (let i = 0; i < PHYSICS_SUBSTEPS; i++) this.world.step();
    for (const rec of this.bodies.values()) {
      const sleeping = rec.body.isSleeping();
      if (sleeping && rec.sleptAt === null) rec.sleptAt = gameTime;
      else if (!sleeping) rec.sleptAt = null;
    }
    this.enforceCap();
  }

  /**
   * Live body positions of `kind` — for server-side melee target selection
   * (doc 13 M3: the barrel-shove cone test lives in systems/props.ts, which
   * has no engine handle). Reads current translations; empty before the engine
   * attaches or when disabled (a buffered-but-unmaterialized barrel can't be
   * shoved — it materializes on attach, effectively at boot).
   */
  bodyPositions(kind: BodyKind): Array<{ id: number; x: number; y: number; z: number }> {
    const out: Array<{ id: number; x: number; y: number; z: number }> = [];
    if (!this.engine) return out;
    for (const rec of this.bodies.values()) {
      if (rec.kind !== kind) continue;
      const t = rec.body.translation();
      out.push({ id: rec.id, x: t.x, y: t.y, z: t.z });
    }
    return out;
  }

  /** Final unquantized pose for a server-confirmed interaction such as a
   * barrel break. Read-only; callers capture it before removeBody(). */
  bodyPose(id: number): { x: number; y: number; z: number; q: [number, number, number, number] } | null {
    const rec = this.bodies.get(id);
    if (!rec) return null;
    const t = rec.body.translation();
    const r = rec.body.rotation();
    return { x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w] };
  }

  /** Poses for the snapshot path (unquantized — GameRoom round2's). */
  *poses(): IterableIterator<WireBody> {
    if (this.engine) {
      for (const rec of this.bodies.values()) {
        const t = rec.body.translation(), r = rec.body.rotation();
        const w: WireBody = { id: rec.id, kind: rec.kind, x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w] };
        if (rec.dims) w.dims = rec.dims;
        if (rec.body.isSleeping()) w.asleep = true;
        yield w;
      }
      return;
    }
    // Pre-attach: restored bodies render at their persisted poses.
    for (const p of this.pending) {
      const w: WireBody = { id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, q: p.q };
      if (p.dims) w.dims = p.dims;
      if (p.asleep) w.asleep = true;
      yield w;
    }
  }

  /** Full state for persistence (doc 13 §4: poses + velocities + sleep). */
  serialize(): PersistedBody[] {
    if (!this.engine) return [...this.pending];
    const out: PersistedBody[] = [];
    for (const rec of this.bodies.values()) {
      const t = rec.body.translation(), r = rec.body.rotation();
      const lv = rec.body.linvel(), av = rec.body.angvel();
      const p: PersistedBody = {
        id: rec.id, kind: rec.kind,
        x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w],
        lv: [lv.x, lv.y, lv.z], av: [av.x, av.y, av.z],
        asleep: rec.body.isSleeping(),
      };
      // Conditional so crate rows serialize byte-identically to M1 (the
      // replay-harness hash covers exactly this JSON).
      if (rec.dims) p.dims = rec.dims;
      out.push(p);
    }
    return out;
  }

  get count(): number {
    return this.engine ? this.bodies.size : this.pending.length;
  }

  private materialize(p: PersistedBody): void {
    if (!this.engine || !this.world) return;
    const engine = this.engine;
    const desc = engine.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] })
      .setLinvel(p.lv[0], p.lv[1], p.lv[2])
      .setAngvel({ x: p.av[0], y: p.av[1], z: p.av[2] });
    // doc 13 M4 — the vehicle hull coasts and its steering settles: bake
    // linear/angular damping onto the body (part of the deterministic step).
    if (p.kind === "vehicle") {
      desc.setLinearDamping(VEHICLE_LINEAR_DAMPING).setAngularDamping(VEHICLE_ANGULAR_DAMPING);
    }
    // Restore asleep bodies asleep — no wake-storm on boot (doc 13 §4).
    if (p.asleep) desc.setCanSleep(true).sleeping = true;
    const body = this.world.createRigidBody(desc);
    // doc 13 M4 — a ground buggy stays UPRIGHT: lock pitch/roll (X/Z rotation),
    // leave only yaw (Y) free. This is the v1 no-rollover simplification (the
    // "scope gravity" discipline — a flippable box getting stuck on its roof is
    // exactly the kind of physics grief v1 avoids); it also makes the pose a
    // pure yaw the client renders trivially and the crash detector reads cleanly.
    if (p.kind === "vehicle") body.setEnabledRotations(false, true, false, false);
    // Half-extents per kind: trunks carry per-instance dims (doc 13 M2);
    // barrels are a fixed upright drum (doc 13 M3, dims-less); crates the M1
    // cube. A dims-carrying row always wins, so crates/pre-M2 rows still fall
    // to the CRATE_HALF cube byte-identically (the replay hash covers exactly
    // this — the barrel branch never runs in the crate/trunk-only scenario).
    let hx: number, hy: number, hz: number;
    if (p.dims) {
      [hx, hy, hz] = p.dims;
    } else if (p.kind === "barrel") {
      hx = BARREL_HALF_XZ;
      hy = BARREL_HALF_Y;
      hz = BARREL_HALF_XZ;
    } else if (p.kind === "vehicle") {
      hx = VEHICLE_HALF_X;
      hy = VEHICLE_HALF_Y;
      hz = VEHICLE_HALF_Z;
    } else {
      hx = hy = hz = CRATE_HALF;
    }
    const collider = engine.ColliderDesc.cuboid(hx, hy, hz);
    // Surface response per kind: trunks slide and stop (felled tree, doc 13
    // M2); barrels tumble a little then settle (the shove feel, doc 13 M3);
    // the vehicle hull is LOW-friction so ground drag doesn't fight the drive
    // force (an arcade "box car" — the manual lateral GRIP impulse in
    // driveVehicle supplies cornering, not the collider friction, doc 13 M4);
    // crates keep the M1 default exactly.
    if (p.kind === "trunk") collider.setRestitution(0.05).setFriction(0.9);
    else if (p.kind === "barrel") collider.setRestitution(0.1).setFriction(0.6);
    else if (p.kind === "vehicle") collider.setRestitution(0.1).setFriction(0.25);
    else collider.setRestitution(0.3).setFriction(0.8);
    this.world.createCollider(collider, body);
    const rec: BodyRec = {
      id: p.id, kind: p.kind, body,
      // Restored-asleep bodies start with a NULL settle clock even though they
      // sleep: this.gameTime is still 0 when attachEngine drains the buffer
      // before the first step (warm-isolate boot), and stamping 0 would make
      // expireSettled reap them instantly against the restored game.time. The
      // first step() stamps sleeping bodies at the CURRENT game time — the
      // fresh-settle-clock restore behavior tickTrunks documents.
      sleptAt: null,
      createdAt: this.gameTime,
    };
    if (p.dims) rec.dims = p.dims;
    this.bodies.set(p.id, rec);
    this.enforceCap();
  }

  /** Over-cap eviction: oldest-SETTLED first (doc 13 §3); if none are settled
   * yet, oldest-created. Runs after step and after spawns, so a lowered LIVE
   * bodyCap drains on the next tick. */
  private enforceCap(): void {
    // doc 13 M4 — vehicles are cap-EXEMPT: they never count toward the cap and
    // are never chosen as a victim. A handful spawn deterministically per island
    // and they ARE the endgame retention feature — evicting an occupied (or just
    // parked) buggy to make room for a shoved barrel would be a terrible trade,
    // and enforceCap can't tell "occupied" from "recently driven" cheaply. The
    // cap therefore governs only the transient population (crates/trunks/barrels).
    const cap = Math.max(0, this.cfg.bodyCap);
    let evictable = 0;
    for (const rec of this.bodies.values()) if (rec.kind !== "vehicle") evictable++;
    while (evictable > cap) {
      let victim: BodyRec | null = null;
      for (const rec of this.bodies.values()) {
        if (rec.kind === "vehicle") continue;
        const settled = rec.sleptAt !== null && this.gameTime - rec.sleptAt >= SETTLED_AFTER_S;
        if (settled && (victim === null || (victim.sleptAt ?? Infinity) > (rec.sleptAt ?? Infinity))) {
          victim = rec;
        }
      }
      if (!victim) {
        for (const rec of this.bodies.values()) {
          if (rec.kind === "vehicle") continue;
          if (victim === null || rec.createdAt < victim.createdAt) victim = rec;
        }
      }
      if (!victim) return;
      this.removeBody(victim.id);
      evictable--;
    }
  }
}
