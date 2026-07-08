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
import { WORLD_SIZE } from "@worldspring/shared/constants";

// Minimal structural types for the injected Rapier namespace — `import type`
// only (erased at runtime; the harness runs this file via strip-types).
type RapierNamespace = (typeof import("@dimforge/rapier3d-compat"))["default"];
type RapierWorld = import("@dimforge/rapier3d-compat").World;
type RapierBody = import("@dimforge/rapier3d-compat").RigidBody;

/** What the terrain/statics collider build needs from the game World — a
 * structural subset so the replay harness can pass a tiny fake. */
export interface PhysicsStaticsSource {
  heightAt(x: number, z: number): number;
  buildings: ReadonlyArray<{ walls: ReadonlyArray<Aabb>; roof: Aabb }>;
  militaryWalls: ReadonlyArray<Aabb>;
  trees: ReadonlyArray<{ x: number; z: number; r: number; height: number }>;
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
  asleep: boolean;
}

/** Terrain heightfield sampling resolution: (N-1)×(N-1) cells over
 * WORLD_SIZE². 201 → 4 m cells at 800 m, ~160 KB of floats, built once per
 * room. Bodies rest on this sampled field while players stand on the analytic
 * heightAt — a ≤ half-cell seam that reads fine for props (doc 13 §1). */
const HEIGHTFIELD_N = 201;
/** Crates half-extent (matches the client's crate mesh + loot-crate scale). */
const CRATE_HALF = 0.4;
/** Seconds a body must sleep before it counts as "settled" for eviction. */
const SETTLED_AFTER_S = 2;
/** Engine substeps per game tick. Rapier's solver is tuned for ~1/60s steps;
 * at the raw 1/15 tick, fast-falling bodies TUNNEL through colliders (found
 * empirically by the replay harness's probes — contacts miss when per-step
 * displacement exceeds the contact window). 4 substeps ≈ 16.7 ms each; cost
 * is 4× the M0 per-step number, still <1% of the tick at the body cap. */
const PHYSICS_SUBSTEPS = 4;

interface BodyRec {
  id: number;
  kind: BodyKind;
  body: RapierBody;
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
  private statics: PhysicsStaticsSource;
  private cfg: PhysicsConfig;
  private gameTime = 0;

  constructor(statics: PhysicsStaticsSource, cfg: PhysicsConfig) {
    this.statics = statics;
    this.cfg = cfg;
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
    // the origin like the world itself (WORLD_SIZE square, constants.ts:7).
    // Rapier heightfield data is COLUMN-major: heights[col * nrows+1 + row],
    // columns along x, rows along z — validated empirically by the replay
    // harness's slope probes (swap = probe failure, not a silent tilt).
    const n = HEIGHTFIELD_N;
    const heights = new Float32Array(n * n);
    for (let col = 0; col < n; col++) {
      const x = (col / (n - 1) - 0.5) * WORLD_SIZE;
      for (let row = 0; row < n; row++) {
        const z = (row / (n - 1) - 0.5) * WORLD_SIZE;
        heights[col * n + row] = Math.fround(this.statics.heightAt(x, z));
      }
    }
    world.createCollider(
      engine.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: WORLD_SIZE, y: 1, z: WORLD_SIZE }),
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
    for (const t of this.statics.trees) {
      const y0 = this.statics.heightAt(t.x, t.z);
      world.createCollider(
        engine.ColliderDesc.cuboid(t.r, t.height / 2, t.r).setTranslation(t.x, y0 + t.height / 2, t.z),
      );
    }

    const buffered = this.pending;
    this.pending = [];
    for (const p of buffered) this.materialize(p);
  }

  get ready(): boolean {
    return this.engine !== null;
  }

  /** Spawn a new dynamic body. Returns its id, or null when disabled. The
   * caller supplies the id (game.nextEntityId — shared entity id space). */
  spawnBody(id: number, kind: BodyKind, x: number, y: number, z: number): number | null {
    if (!this.cfg.enabled) return null;
    const rec: PersistedBody = {
      id, kind, x, y, z, q: [0, 0, 0, 1], lv: [0, 0, 0], av: [0, 0, 0], asleep: false,
    };
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

  /** Poses for the snapshot path (unquantized — GameRoom round2's). */
  *poses(): IterableIterator<WireBody> {
    if (this.engine) {
      for (const rec of this.bodies.values()) {
        const t = rec.body.translation(), r = rec.body.rotation();
        const w: WireBody = { id: rec.id, kind: rec.kind, x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w] };
        if (rec.body.isSleeping()) w.asleep = true;
        yield w;
      }
      return;
    }
    // Pre-attach: restored bodies render at their persisted poses.
    for (const p of this.pending) {
      const w: WireBody = { id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, q: p.q };
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
      out.push({
        id: rec.id, kind: rec.kind,
        x: t.x, y: t.y, z: t.z, q: [r.x, r.y, r.z, r.w],
        lv: [lv.x, lv.y, lv.z], av: [av.x, av.y, av.z],
        asleep: rec.body.isSleeping(),
      });
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
    // Restore asleep bodies asleep — no wake-storm on boot (doc 13 §4).
    if (p.asleep) desc.setCanSleep(true).sleeping = true;
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(
      engine.ColliderDesc.cuboid(CRATE_HALF, CRATE_HALF, CRATE_HALF).setRestitution(0.3).setFriction(0.8),
      body,
    );
    this.bodies.set(p.id, {
      id: p.id, kind: p.kind, body,
      sleptAt: p.asleep ? this.gameTime : null,
      createdAt: this.gameTime,
    });
    this.enforceCap();
  }

  /** Over-cap eviction: oldest-SETTLED first (doc 13 §3); if none are settled
   * yet, oldest-created. Runs after step and after spawns, so a lowered LIVE
   * bodyCap drains on the next tick. */
  private enforceCap(): void {
    while (this.bodies.size > Math.max(0, this.cfg.bodyCap)) {
      let victim: BodyRec | null = null;
      for (const rec of this.bodies.values()) {
        const settled = rec.sleptAt !== null && this.gameTime - rec.sleptAt >= SETTLED_AFTER_S;
        if (settled && (victim === null || (victim.sleptAt ?? Infinity) > (rec.sleptAt ?? Infinity))) {
          victim = rec;
        }
      }
      if (!victim) {
        for (const rec of this.bodies.values()) {
          if (victim === null || rec.createdAt < victim.createdAt) victim = rec;
        }
      }
      if (!victim) return;
      this.removeBody(victim.id);
    }
  }
}
