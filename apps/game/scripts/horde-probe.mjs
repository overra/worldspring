#!/usr/bin/env node
// Horde GameMode probe (docs/plans/00) — pure in-process sim, no server. Drives the
// horde mode's simBeforePhysics hook directly (where the whole gameplay loop lives)
// and asserts the wave loop end to end: loadout, warm-up, drip pacing, ring
// placement, kill scoring, wave clear + resupply, per-wave escalation, boss waves,
// the wave-gated respawn, the squad-wipe restart, and the 0-player freeze.
//
//   node --experimental-strip-types apps/game/scripts/horde-probe.mjs
//
// Uses a minimal hand-rolled GameState (the arena-probe pattern) carrying only the
// fields the horde mode + reused players.ts helpers read — deliberately no server,
// no network, no worldgen. Kills are simulated by deleting from game.zombies (what
// killZombie does to the map), so no tickZombies/tickCorpses/combat machinery is
// pulled in — the mode's simBeforePhysics is the only thing driven.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

// esbuild-bundle the horde mode + its constants before importing them: the server
// .ts files use extensionless value imports (for the vite bundler) which
// `node --strip-types` can't resolve, and esbuild also resolves the workspace
// @worldspring/shared exports. Same trick as arena-probe.mjs.
const modeDir = fileURLToPath(new URL("../src/server/mode", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createHordeMode } from "./hordeMode.ts";\n' +
      'export {\n' +
      "  HORDE_INTERMISSION_S, HORDE_DEFEAT_S, HORDE_SPAWN_INTERVAL_S, HORDE_MAX_CONCURRENT,\n" +
      "  HORDE_KILL_POINTS, HORDE_BOSS_SCORE, HORDE_WAVE_CLEAR_BONUS, HORDE_START_AMMO_9MM,\n" +
      "  HORDE_AMMO_PER_WAVE, HORDE_SPAWN_RING_MIN, HORDE_SPAWN_RING_MAX, HORDE_BASE_COUNT,\n" +
      "  HORDE_COUNT_GROWTH, HORDE_PLAYER_COUNT_SCALE, HORDE_SPAWN_BATCH_BASE, HORDE_HP_GROWTH,\n" +
      "  HORDE_MILITARY_STEP, HORDE_MILITARY_MAX_FRAC, HORDE_BOSS_EVERY, HORDE_BOSS_HP_BASE,\n" +
      "  HORDE_BOSS_HP_PER_TIER, ZOMBIE_HP\n" +
      '} from "@worldspring/shared/constants";\n',
    resolveDir: modeDir,
    loader: "ts",
    sourcefile: "horde-harness-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const M = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const {
  createHordeMode,
  HORDE_INTERMISSION_S,
  HORDE_DEFEAT_S,
  HORDE_SPAWN_INTERVAL_S,
  HORDE_MAX_CONCURRENT,
  HORDE_KILL_POINTS,
  HORDE_BOSS_SCORE,
  HORDE_WAVE_CLEAR_BONUS,
  HORDE_START_AMMO_9MM,
  HORDE_AMMO_PER_WAVE,
  HORDE_SPAWN_RING_MIN,
  HORDE_SPAWN_RING_MAX,
  HORDE_BASE_COUNT,
  HORDE_COUNT_GROWTH,
  HORDE_PLAYER_COUNT_SCALE,
  HORDE_SPAWN_BATCH_BASE,
  HORDE_HP_GROWTH,
  HORDE_MILITARY_STEP,
  HORDE_MILITARY_MAX_FRAC,
  HORDE_BOSS_EVERY,
  HORDE_BOSS_HP_BASE,
  HORDE_BOSS_HP_PER_TIER,
  ZOMBIE_HP,
} = M;

let failures = 0;
let checks = 0;
function check(cond, msg) {
  checks++;
  if (cond) console.log("  ok —", msg);
  else {
    console.error("  FAIL —", msg);
    failures++;
  }
}

// --- Curve helpers — MUST mirror the mode's internal formulae exactly ---
const quota = (n, p) =>
  Math.round((HORDE_BASE_COUNT + HORDE_COUNT_GROWTH * (n - 1)) * (0.7 + HORDE_PLAYER_COUNT_SCALE * p));
const batch = (n) => HORDE_SPAWN_BATCH_BASE + Math.floor(n / 4);
const milFrac = (n) => Math.min(Math.max(HORDE_MILITARY_STEP * (n - 2), 0), HORDE_MILITARY_MAX_FRAC);
const hpScale = (n) => 1 + HORDE_HP_GROWTH * (n - 1);
const bossHp = (n) => HORDE_BOSS_HP_BASE + HORDE_BOSS_HP_PER_TIER * (Math.floor(n / HORDE_BOSS_EVERY) - 1);

/** Flat island: heightAt 5 everywhere (dry land — the ring never falls back), a
 *  distinct groundHeight, and four spawn points. */
function makeWorld() {
  return {
    size: 800,
    spawnPoints: [
      { x: 10, z: 10 },
      { x: -10, z: -10 },
      { x: 20, z: 0 },
      { x: 0, z: 20 },
    ],
    groundHeight: () => 1,
    heightAt: () => 5,
  };
}

/** Minimal GameState with the horde preset's relevant config. */
function makeState(mode) {
  return {
    world: makeWorld(),
    config: {
      map: { acquire: "none", reveal: "full" },
      threats: { zombies: true, zombieDensity: 1, zombieDamage: 1, zombieSpeed: 1, militaryZone: false },
      pvp: { enabled: false, fullLoot: false, damageMult: 1 },
      session: { respawnDelayS: 0, logoutLingerS: 0 },
    },
    mode,
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
    zombieRespawns: [],
    corpses: new Map(),
    loot: new Map(),
    fires: [],
    drops: new Map(),
    animals: new Map(),
    events: [],
    outbox: [],
    nextEntityId: 1,
  };
}

const noPhase = () => {};
const DT = 1 / 15;
const notices = (g) => g.outbox.filter((o) => o.msg && o.msg.t === "notice").map((o) => o.msg.msg);
const countType = (inv, type) => inv.reduce((n, s) => n + (s && s.type === type ? s.count : 0), 0);

function fresh(nPlayers) {
  const mode = createHordeMode();
  const game = makeState(mode);
  // Mirror GameRoom boot order: the world is ready (and game.time restored) BEFORE
  // any player joins. This is what arms the opening warm-up clock — without it the
  // FSM would leave intermission on tick 1.
  mode.onWorldReady(game, true);
  const players = [];
  for (let i = 0; i < nPlayers; i++) players.push(mode.createPlayer(game, `p${i + 1}`, `Fighter${i + 1}`, `t${i + 1}`));
  return { mode, game, players };
}

const tick = (game) => game.mode.simBeforePhysics(game, DT, noPhase);
/** From intermission → active (past the phase clock), running the first drip. */
function advanceToActive(game) {
  game.time += HORDE_INTERMISSION_S + 1;
  tick(game);
}
/** Drive an active wave to its clear (squad wipes each batch as it lands). Clears
 *  the outbox first so a stale "cleared" notice from an earlier wave can't make it
 *  return before THIS wave is actually down. */
function driveClear(game) {
  game.outbox.length = 0;
  for (let i = 0; i < 400; i++) {
    game.zombies.clear();
    game.mode.simBeforePhysics(game, HORDE_SPAWN_INTERVAL_S, noPhase);
    if (notices(game).some((n) => n.includes("cleared"))) return true;
  }
  return false;
}
/** Drive an active wave to its FULL spawn (never clearing) — size settles at quota. */
function driveFullSpawn(game) {
  let prev = -1;
  for (let i = 0; i < 400; i++) {
    game.mode.simBeforePhysics(game, HORDE_SPAWN_INTERVAL_S, noPhase);
    if (game.zombies.size === prev) return;
    prev = game.zombies.size;
  }
}

// =====================================================================
// 1. Spawn loadout
// =====================================================================
console.log("[1] loadout");
{
  const { game, players } = fresh(2);
  const [alpha] = players;
  check(alpha.alive && alpha.vitals.hp > 0, "fighter spawns alive at full HP");
  check(alpha.selectedSlot === 0 && alpha.inventory[0]?.type === "pistol", "pistol equipped in slot 0");
  check(alpha.inventory.some((s) => s?.type === "axe"), "axe in the loadout (never-empty fallback)");
  check(countType(alpha.inventory, "ammo_9mm") >= HORDE_START_AMMO_9MM, "spawns with reserve 9mm");
  check(alpha.inventory.some((s) => s?.type === "bandage"), "spawns with bandages");
  check(alpha.worn.body === null, "nothing worn");
  check(countType(alpha.inventory, "map") === 0 && countType(alpha.inventory, "flashlight") === 0, "no survival kit (map/flashlight stripped)");
  check(game.players.size === 2, "both fighters registered in the room");
}

// =====================================================================
// 2. Warm-up — no wave before the intermission clock elapses
// =====================================================================
console.log("[2] warm-up");
{
  const { game } = fresh(2);
  game.outbox.length = 0;
  tick(game); // game.time still 0 < HORDE_INTERMISSION_S
  check(game.zombies.size === 0 && !notices(game).some((n) => n.includes("Wave")), "no wave spawns during warm-up");
  check(game.mode.respawnDelayS(game) === 0, "intermission → respawn honored (delay 0)");

  // 9. Respawn-queue hygiene — the ambient queue is drained every tick.
  console.log("[9] respawn-queue hygiene");
  game.zombieRespawns.push({ t: 30, mil: false });
  tick(game);
  check(game.zombieRespawns.length === 0, "zombieRespawns drained every tick (horde owns spawning)");
}

// =====================================================================
// 3+4+5+6+7. Wave 1 lifecycle (2 players)
// =====================================================================
console.log("[3] intermission → active");
const P2 = 2;
const Q1 = quota(1, P2); // 8
{
  const { game, players } = fresh(P2);
  game.outbox.length = 0;
  advanceToActive(game); // → wave 1 active, runs the first drip this tick
  check(notices(game).some((n) => n.includes("Wave 1")), "intermission elapses → Wave 1 begins");
  check(game.mode.respawnDelayS(game) === Infinity, "active → respawn refused (Infinity)");
  check(game.zombies.size > 0, "wave 1 has begun spawning");

  console.log("[4] drip not burst");
  check(game.zombies.size === batch(1), `first active tick drips exactly batch(1) === ${batch(1)}`);
  check(game.zombies.size < Q1, "one batch is less than the wave quota");
  let maxSize = game.zombies.size;
  for (let i = 0; i < 8; i++) {
    game.mode.simBeforePhysics(game, HORDE_SPAWN_INTERVAL_S, noPhase);
    maxSize = Math.max(maxSize, game.zombies.size);
  }
  check(game.zombies.size === Q1, `drip reaches the full quota (${Q1}) over intervals`);
  check(maxSize <= HORDE_MAX_CONCURRENT, "concurrent count never exceeds HORDE_MAX_CONCURRENT");

  console.log("[5] ring placement");
  const alive = players.filter((p) => !p.offline && p.alive);
  let allInRing = true;
  for (const z of game.zombies.values()) {
    const inBand = alive.some((p) => {
      const d = Math.hypot(z.x - p.core.x, z.z - p.core.z);
      return d >= HORDE_SPAWN_RING_MIN - 1e-6 && d <= HORDE_SPAWN_RING_MAX + 1e-6;
    });
    const onLand = game.world.heightAt(z.x, z.z) >= 0.3;
    if (!inBand || !onLand) allInRing = false;
  }
  check(allInRing, "every spawned zombie sits in [RING_MIN, RING_MAX] of an alive player, on land");

  console.log("[6] kill scoring");
  // The kill award surfaces only on the next clear/boss/over notice — the score is
  // shared closure state. Assert here that mid-wave kills fire no false clear/over;
  // the exact total (Q1 kills * KILL_POINTS + clear bonus) is proven by [7]'s notice.
  const ids = [...game.zombies.keys()];
  for (let i = 0; i < 4; i++) game.zombies.delete(ids[i]);
  game.outbox.length = 0;
  tick(game);
  check(
    !notices(game).some((n) => n.includes("cleared") || n.includes("Overrun")),
    "mid-wave kills emit no clear/over notice",
  );

  console.log("[7] clear + advance + resupply");
  const ammoBefore = players.map((p) => countType(p.inventory, "ammo_9mm"));
  for (const id of [...game.zombies.keys()]) game.zombies.delete(id);
  game.outbox.length = 0;
  tick(game); // waveSpawned === quota && size 0 → clearWave
  const clearNotice = notices(game).find((n) => n.includes("cleared"));
  check(!!clearNotice && clearNotice.includes("Wave 1 cleared"), "emptying the quota clears wave 1");
  // teamScore = Q1 kills * KILL_POINTS + WAVE_CLEAR_BONUS*1 — every quota zombie was
  // deleted (all counted as kills), so this pins the kill-scoring accumulator too.
  const expectScore = Q1 * HORDE_KILL_POINTS + HORDE_WAVE_CLEAR_BONUS;
  check(!!clearNotice && clearNotice.includes(`Score ${expectScore}`), `clear notice carries the shared score (${expectScore})`);
  check(!!clearNotice && clearNotice.includes(`+${HORDE_WAVE_CLEAR_BONUS}`), "clear notice carries the wave-clear bonus");
  check(game.mode.respawnDelayS(game) === 0, "wave cleared → back in intermission (respawn honored)");
  const ammoAfter = players.map((p) => countType(p.inventory, "ammo_9mm"));
  check(
    ammoAfter.every((a, i) => a === ammoBefore[i] + HORDE_AMMO_PER_WAVE),
    `each survivor resupplied +${HORDE_AMMO_PER_WAVE} 9mm on clear`,
  );
}

// =====================================================================
// 8. Escalation — drive to wave 3 (1 player, deterministic mix)
// =====================================================================
console.log("[8] escalation to wave 3");
{
  const { game } = fresh(1);
  advanceToActive(game); // wave 1
  driveClear(game);
  advanceToActive(game); // wave 2
  driveClear(game);
  advanceToActive(game); // wave 3
  driveFullSpawn(game); // spawn the whole wave, never clearing
  const Q3 = quota(3, 1);
  const Q1p1 = quota(1, 1);
  check(Q3 > Q1p1, `wave 3 quota (${Q3}) exceeds wave 1 (${Q1p1})`);
  check(game.zombies.size === Q3, `wave 3 fully spawned to quota (${Q3})`);
  const mils = [...game.zombies.values()].filter((z) => z.mil === true);
  const expectMil = Math.floor(Q3 * milFrac(3));
  check(expectMil >= 1 && mils.length === expectMil, `wave 3 fields exactly floor(quota·milFrac) === ${expectMil} brutes`);
  const normal = [...game.zombies.values()].find((z) => z.mil === false);
  const expectNormalHp = Math.round(ZOMBIE_HP * hpScale(3));
  check(!!normal && normal.hp === expectNormalHp && normal.hp > ZOMBIE_HP, `a wave-3 normal zombie has scaled hp (${expectNormalHp} > ${ZOMBIE_HP})`);
}

// =====================================================================
// 10. Boss wave — drive to wave 5
// =====================================================================
console.log("[10] boss wave");
{
  const { game } = fresh(1);
  for (let w = 1; w <= 4; w++) {
    advanceToActive(game);
    check(driveClear(game), `wave ${w} cleared en route to the boss wave`);
  }
  advanceToActive(game); // wave 5
  game.outbox.length = 0;
  driveFullSpawn(game); // spawns the whole wave including the boss (its final unit)
  const bhp = bossHp(5);
  const boss = [...game.zombies.values()].find((z) => z.hp === bhp);
  check(!!boss, `wave 5 spawns a boss at hp ${bhp}`);
  check(notices(game).some((n) => n.includes("A BRUTE emerges")), "boss spawn is announced");
  // Kill only the boss → next tick books the boss bonus (+ the flat kill).
  game.zombies.delete(boss.id);
  game.outbox.length = 0;
  tick(game);
  check(notices(game).some((n) => n.includes("Brute down")), "boss death is announced");
  // The clear notice would also carry the running score; assert the boss bonus via
  // a fresh wave to isolate it is unnecessary — instead confirm no clear fired (the
  // wave still has its normal zombies alive) and the announce fired.
  check(!notices(game).some((n) => n.includes("cleared")), "boss down does not clear the wave (normals remain)");
}

// =====================================================================
// 11. Down is wave-gated — the fallen wait for the clear-revive
// =====================================================================
console.log("[11] down is wave-gated");
{
  const { game, players } = fresh(2);
  const [alpha, bravo] = players;
  advanceToActive(game); // wave 1 active
  bravo.alive = false;
  bravo.diedAt = game.time;
  check(game.mode.respawnDelayS(game) === Infinity, "a downed fighter's respawn is refused mid-wave");
  check(alpha.alive && !bravo.alive, "one fighter down, one up — the squad is a gun short");
  driveClear(game); // survivor holds the line and clears it
  check(bravo.alive, "the fallen is revived at the wave-clear breather");
  check(bravo.inventory[0]?.type === "pistol", "the revived fighter returns kitted (pistol in slot 0)");
}

// =====================================================================
// 12. Squad wipe → restart at wave 1
// =====================================================================
console.log("[12] squad wipe → restart");
{
  const { game, players } = fresh(2);
  const [alpha, bravo] = players;
  advanceToActive(game); // wave 1 active
  driveFullSpawn(game); // a wave is up
  alpha.alive = false;
  alpha.diedAt = game.time;
  bravo.alive = false;
  bravo.diedAt = game.time;
  game.outbox.length = 0;
  tick(game); // aliveCount 0, online 2 → overrun
  check(notices(game).some((n) => n.includes("Overrun on wave 1")), "a full squad wipe overruns the run");
  check(game.mode.respawnDelayS(game) === Infinity, "no revive during the overrun hold");

  game.time += HORDE_DEFEAT_S + 1;
  game.outbox.length = 0;
  tick(game); // defeat clock elapsed → restartRun
  check(notices(game).some((n) => n.includes("New run")), "the overrun hold elapses → the run restarts");
  check(game.zombies.size === 0, "the board is cleared on restart");
  check(alpha.alive && bravo.alive, "everyone is revived on restart");
  check(alpha.inventory[0]?.type === "pistol", "revived with a fresh kit");

  game.time += HORDE_INTERMISSION_S + 1;
  game.outbox.length = 0;
  tick(game); // restart intermission elapsed → startWave
  check(notices(game).some((n) => n.includes("Wave 1")), "the restart re-arms at Wave 1 (wave counter reset to 0)");
  // teamScore reset to 0: the fresh wave-1 clear carries the from-scratch score.
  driveClear(game);
  const expectScore = quota(1, 2) * HORDE_KILL_POINTS + HORDE_WAVE_CLEAR_BONUS;
  check(
    notices(game).some((n) => n.includes(`Score ${expectScore}`)),
    `the shared score restarted from zero (fresh clear reads Score ${expectScore})`,
  );
}

// =====================================================================
// 13. 0-player freeze — an empty room never advances, spawns, or loses
// =====================================================================
console.log("[13] 0-player freeze");
{
  const { game, players } = fresh(2);
  for (const p of players) p.offline = true;
  game.time += HORDE_INTERMISSION_S + 5; // well past the warm-up clock
  game.outbox.length = 0;
  tick(game);
  check(!notices(game).some((n) => n.includes("Wave")) && game.zombies.size === 0, "no wave starts while the room is empty");
  // A rejoin resumes the run in place.
  for (const p of players) p.offline = false;
  game.time += HORDE_INTERMISSION_S + 1;
  game.outbox.length = 0;
  tick(game);
  check(notices(game).some((n) => n.includes("Wave 1")), "a rejoin resumes the run (Wave 1 arms)");
}

console.log(
  failures === 0
    ? `\n${checks}/${checks} checks passed`
    : `\nhorde-probe: ${failures}/${checks} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
