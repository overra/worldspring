// doc 13 M0 — the fixed physics scenario, shared verbatim by every runtime
// (Node macOS/Linux, browser, workerd). Determinism discipline: every input is
// integer-derived (xorshift32 → /2^32 — exact powers of two only), NO
// Math.sin/cos/sqrt anywhere, so any hash divergence is the ENGINE's, not ours.
//
// Scenario: a 64×64 procedural heightfield + N dynamic bodies (cuboid/ball mix)
// dropped from above, with a scripted impulse burst every 60 steps, stepped
// K times at the game tick dt (1/15s). The result hash is FNV-1a over the
// Float32 bytes of every body's translation+rotation, in creation order —
// bit-exact comparison, not epsilon comparison.

export const SCENARIO_VERSION = 1;

function xorshift32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s;
  };
}
// [0,1) with an exact /2^32 — no rounding surprises.
const unit = (next) => () => next() / 4294967296;

// FNV-1a 32-bit over bytes — pure integer JS, portable to every runtime.
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

/**
 * Runs the scenario against an initialized RAPIER namespace.
 * Returns { hash, bodies, steps, dt } — hash must be identical everywhere.
 */
export function runScenario(RAPIER, { bodies = 100, steps = 1000, seed = 1337 } = {}) {
  const rand = unit(xorshift32(seed));
  const dt = 1 / 15;

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;

  // 64×64 heightfield, heights 0..8m, 128m×128m footprint.
  const N = 64;
  const heights = new Float32Array(N * N);
  for (let i = 0; i < heights.length; i++) heights[i] = Math.fround(rand() * 8);
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(N - 1, N - 1, heights, { x: 128, y: 1, z: 128 }),
  );

  // Bodies: alternating cuboids and balls, dropped over the field's middle.
  const handles = [];
  for (let i = 0; i < bodies; i++) {
    const x = Math.fround((rand() - 0.5) * 80);
    const z = Math.fround((rand() - 0.5) * 80);
    const y = Math.fround(12 + rand() * 20);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    const desc = i % 2 === 0
      ? RAPIER.ColliderDesc.cuboid(0.4, 0.4, 0.4)
      : RAPIER.ColliderDesc.ball(0.5);
    world.createCollider(desc.setRestitution(0.4).setFriction(0.7), body);
    handles.push(body);
  }

  // Step, with a scripted impulse burst every 60 steps (round-robin target).
  for (let s = 0; s < steps; s++) {
    if (s > 0 && s % 60 === 0) {
      const body = handles[(s / 60) % handles.length | 0];
      body.applyImpulse(
        { x: Math.fround((rand() - 0.5) * 6), y: Math.fround(rand() * 4), z: Math.fround((rand() - 0.5) * 6) },
        true,
      );
    }
    world.step();
  }

  // Hash every pose, bit-exact through Float32.
  const out = new Float32Array(handles.length * 7);
  handles.forEach((b, i) => {
    const t = b.translation(), r = b.rotation();
    out.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
  });
  const hash = fnv1a(new Uint8Array(out.buffer));
  world.free();
  return { scenarioVersion: SCENARIO_VERSION, bodies, steps, dt, seed, hash };
}
