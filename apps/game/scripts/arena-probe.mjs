#!/usr/bin/env node
// Arena GameMode probe (docs/plans/00) — pure in-process sim, no server. Drives
// the arena mode's hooks directly and asserts the round loop end to end:
//   1. spawn loadout   — fighters arrive with a pistol + reserve ammo, full HP
//   2. frag scoring    — onKill tallies per-round frags and announces each
//   3. win → reset     — reaching the frag limit wins the round; after the
//                        intermission the next round starts, reviving everyone
//                        and clearing scores
//   4. auto-respawn    — a dead fighter is revived after the respawn delay
//                        (arena never sits on a death screen)
//
//   node --experimental-strip-types apps/game/scripts/arena-probe.mjs
//
// Uses a minimal hand-rolled GameState (the loot-invariant.mjs pattern) carrying
// only the fields the arena + reused players.ts helpers read — deliberately no
// server, no network, no worldgen.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

// esbuild-bundle the arena mode + its constants before importing them: the
// server .ts files use extensionless value imports (for the vite bundler) which
// `node --strip-types` can't resolve, and esbuild also resolves the workspace
// @worldspring/shared exports. Same trick as reload-magazine.mjs.
const modeDir = fileURLToPath(new URL("../src/server/mode", import.meta.url));
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createArenaMode } from "./arenaMode.ts";\n' +
      'export { ARENA_FRAG_LIMIT, ARENA_ROUND_INTERMISSION_S } from "@worldspring/shared/constants";\n',
    resolveDir: modeDir,
    loader: "ts",
    sourcefile: "arena-harness-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createArenaMode, ARENA_FRAG_LIMIT, ARENA_ROUND_INTERMISSION_S } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("  ok —", msg);
  else {
    console.error("  FAIL —", msg);
    failures++;
  }
}

/** Flat 4-point island. */
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
  };
}

/** Minimal GameState with the arena preset's relevant config. */
function makeState(mode) {
  return {
    world: makeWorld(),
    config: {
      map: { acquire: "none", reveal: "full" },
      pvp: { enabled: true, fullLoot: false, damageMult: 1 },
      session: { respawnDelayS: 3, logoutLingerS: 0 },
    },
    mode,
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
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
const notices = (g) => g.outbox.filter((o) => o.msg && o.msg.t === "notice").map((o) => o.msg.msg);
const countType = (inv, type) => inv.reduce((n, s) => n + (s && s.type === type ? s.count : 0), 0);

const mode = createArenaMode();
const game = makeState(mode);

// --- 1. Spawn loadout ---------------------------------------------------------
const alpha = mode.createPlayer(game, "p1", "Alpha", "t1");
const bravo = mode.createPlayer(game, "p2", "Bravo", "t2");
check(alpha.alive && alpha.vitals.hp > 0, "fighter spawns alive at full HP");
check(alpha.selectedSlot === 0 && alpha.inventory[0]?.type === "pistol", "pistol equipped in slot 0");
check(countType(alpha.inventory, "ammo_9mm") >= 30, "spawns with reserve 9mm");
check(countType(alpha.inventory, "map") === 0, "no survival kit (map/flashlight stripped)");
check(game.players.size === 2, "both fighters registered in the room");

// --- 2. Frag scoring, up to (but not reaching) the limit ----------------------
game.outbox.length = 0;
for (let i = 0; i < ARENA_FRAG_LIMIT - 1; i++) mode.onKill(game, alpha, bravo);
check(
  notices(game).length === ARENA_FRAG_LIMIT - 1 && !notices(game).some((n) => n.includes("wins round")),
  `${ARENA_FRAG_LIMIT - 1} frags announced, no premature win`,
);

// --- 3. The frag that reaches the limit wins the round ------------------------
game.outbox.length = 0;
mode.onKill(game, alpha, bravo);
check(notices(game).some((n) => n.includes("wins round 1")), "reaching the frag limit wins round 1");

// intermission: scoring is closed until the next round starts
game.outbox.length = 0;
mode.onKill(game, bravo, alpha);
check(notices(game).length === 0, "no scoring during the intermission");

// the intermission elapses → the mode's tick starts the next round
game.time += ARENA_ROUND_INTERMISSION_S + 1;
game.outbox.length = 0;
mode.simBeforePhysics(game, 1 / 15, noPhase);
check(notices(game).some((n) => n.includes("Round 2")), "intermission elapses → round 2 begins");
check(alpha.alive && bravo.alive, "round reset revives every fighter");

// scores were cleared — a fresh frag reads 1 / LIMIT
game.outbox.length = 0;
mode.onKill(game, alpha, bravo);
check(notices(game).some((n) => n.includes(`(1/${ARENA_FRAG_LIMIT})`)), "round reset cleared the frag tally");

// --- 4. Auto-respawn ----------------------------------------------------------
bravo.alive = false;
bravo.diedAt = game.time;
game.time += game.config.session.respawnDelayS + 0.1;
mode.simBeforePhysics(game, 1 / 15, noPhase);
check(bravo.alive, "a dead fighter auto-respawns after the respawn delay");

console.log(failures === 0 ? "\narena-probe: ALL OK" : `\narena-probe: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
