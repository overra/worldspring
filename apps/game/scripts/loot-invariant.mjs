// Loot spawn-point invariant test for the doc 04 §5 density gate.
//   node --experimental-strip-types apps/game/scripts/loot-invariant.mjs
//
// The binding invariant (doc 04 §5): under any config, every world loot spawn
// point holds EXACTLY ONE of {a stocked entity, a pending respawn timer} — never
// both, never neither. A point that ends up with neither is dead forever (it
// only re-arms via pickup or a firing timer), so at density < 1 a naive
// "roll failed → do nothing" would silently kill ~40% of the map per cycle.
//
// This drives stockInitialLoot + tickLootRespawns at ironcoast's density 0.6
// across many stock/pickup/respawn cycles and asserts the invariant throughout,
// plus a density-1 check (every point stocks) and the militaryZone=false tier
// swap. Builds a minimal fake GameState inline — it deliberately does NOT import
// config.ts (its extensionless relative imports break node --strip-types), only
// the loot system under test.
import {
  stockInitialLoot,
  startLootRespawn,
  tickLootRespawns,
} from "../src/server/systems/loot.ts";

let failures = 0;
function fail(msg) {
  console.error("  FAIL:", msg);
  failures++;
}

/** Minimal config carrying only the fields loot.ts reads. */
function makeConfig({ density, militaryZone = true, respawnRate = 1, fullLoot = true }) {
  return {
    loot: { density, tierDensity: { coastal: 1, inland: 1, military: 1 }, respawnRate, airdrops: 1 },
    threats: { militaryZone },
    pvp: { fullLoot },
  };
}

/** N synthetic spawn points across the three tiers (ids 1..N). */
function makeSpawns(n) {
  const tiers = ["coastal", "inland", "military"];
  const spawns = [];
  for (let i = 0; i < n; i++) {
    spawns.push({ id: i + 1, tier: tiers[i % 3], x: i, y: 1, z: -i });
  }
  return spawns;
}

function makeState(config, spawns) {
  return {
    world: { lootSpawns: spawns, groundHeight: () => 1 },
    loot: new Map(),
    lootRespawns: [],
    players: new Map(), // empty: no player ever blocks a respawn
    nextEntityId: 1,
    config,
  };
}

/** Assert every spawn id appears exactly once across {entities, timers}. */
function assertInvariant(state, label) {
  const seen = new Map();
  for (const loot of state.loot.values()) {
    if (loot.spawnId == null) continue; // player-dropped loot has no spawn point
    seen.set(loot.spawnId, (seen.get(loot.spawnId) ?? 0) + 1);
  }
  for (const timer of state.lootRespawns) {
    seen.set(timer.spawnId, (seen.get(timer.spawnId) ?? 0) + 1);
  }
  const missing = [];
  const dup = [];
  for (const spawn of state.world.lootSpawns) {
    const c = seen.get(spawn.id) ?? 0;
    if (c === 0) missing.push(spawn.id);
    else if (c > 1) dup.push(spawn.id);
  }
  if (missing.length || dup.length) {
    fail(
      `${label}: invariant broken — spawns=${state.world.lootSpawns.length}, ` +
        `entities=${state.loot.size}, timers=${state.lootRespawns.length}, ` +
        `missing=${missing.length}, dup=${dup.length}`,
    );
    return false;
  }
  return true;
}

/** Mimic players clearing the map: take every stocked entity and re-arm its point. */
function pickUpEverything(state) {
  for (const [id, loot] of [...state.loot]) {
    if (loot.spawnId == null) continue;
    state.loot.delete(id);
    startLootRespawn(state, loot.spawnId);
  }
}

const N = 300;

// --- Case 1: density 0.6 across stock + 50 pickup/respawn cycles ---
{
  const state = makeState(makeConfig({ density: 0.6 }), makeSpawns(N));
  stockInitialLoot(state);
  assertInvariant(state, "0.6 after stock");
  // At density 0.6 some points stock and some start as timers — both must occur,
  // or the test isn't actually exercising the gate.
  if (state.loot.size === 0 || state.loot.size === N) {
    fail(`0.6 stock did not split entities/timers (entities=${state.loot.size}/${N})`);
  }
  for (let cycle = 0; cycle < 50; cycle++) {
    pickUpEverything(state);
    // Every point is now a timer: entities must be 0, timers must be N.
    if (state.loot.size !== 0 || state.lootRespawns.length !== N) {
      fail(`0.6 cycle ${cycle}: after pickup entities=${state.loot.size}, timers=${state.lootRespawns.length}`);
    }
    assertInvariant(state, `0.6 after pickup ${cycle}`);
    tickLootRespawns(state, 100000); // huge dt → every timer fires once this pass
    assertInvariant(state, `0.6 after respawn ${cycle}`);
  }
  console.log(`  density 0.6: invariant held across 50 cycles (final entities=${state.loot.size}, timers=${state.lootRespawns.length})`);
}

// --- Case 2: density 1 stocks every point (no timers), the default behavior ---
{
  const state = makeState(makeConfig({ density: 1 }), makeSpawns(N));
  stockInitialLoot(state);
  if (state.loot.size !== N || state.lootRespawns.length !== 0) {
    fail(`density 1: expected ${N} entities and 0 timers, got ${state.loot.size}/${state.lootRespawns.length}`);
  }
  assertInvariant(state, "1.0 after stock");
  console.log(`  density 1.0: every point stocked (${state.loot.size}/${N}, 0 timers)`);
}

// --- Case 3: militaryZone=false at density 0.6 — tier swap must not break it ---
{
  const state = makeState(makeConfig({ density: 0.6, militaryZone: false }), makeSpawns(N));
  stockInitialLoot(state);
  assertInvariant(state, "militaryZone=false after stock");
  for (let cycle = 0; cycle < 10; cycle++) {
    pickUpEverything(state);
    tickLootRespawns(state, 100000);
    assertInvariant(state, `militaryZone=false cycle ${cycle}`);
  }
  // Military spawns must have rolled a valid stack (inland swap), never crashed.
  console.log(`  militaryZone=false: tier swap held the invariant across 10 cycles`);
}

if (failures > 0) {
  console.error(`LOOT-INVARIANT: FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("LOOT-INVARIANT: PASS — spawn-point entity-XOR-timer invariant holds");
