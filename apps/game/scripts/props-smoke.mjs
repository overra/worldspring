#!/usr/bin/env node
// Physics-props probe (doc 13 M3) — drives a real GameRoom over WS and proves
// the barrel slice end to end: a shovable, breakable loot drum spawned near a
// worldgen building. The marquee is the SHOVE: a melee swing moves a real
// dynamic body a client can see.
//
//   node --experimental-strip-types apps/game/scripts/props-smoke.mjs [mode] [ws-url]
//   modes:
//     slice   (default) single connection: exist -> shove(moves) -> settle ->
//             break(3 hits) -> loot spills. The CI-style self-contained check.
//     persist shove once, settle, wait out a world save, WRITE the resting pose
//             to a state file, exit WITHOUT breaking (feeds a restart test).
//     verify  <state-file> after a server RESTART (same SQL): the SAME barrel id
//             rehydrated at its persisted resting pose, never re-spawned at
//             origin (loadWorld's restore branch, not spawnInitialProps).
//   default url: ws://localhost:5173/ws  (dev server; .dev.vars has TESTBED=1)
//
// Requires a TESTBED server (the axe comes from the "trees" scenario provision)
// with physics enabled. Not part of `pnpm test` — like trees-probe it needs a
// live server; CI covers the physics layer via physics-replay.mjs.
//
// Run against a FRESH world (clear .wrangler/state/v3/do first): the melee
// cascade lets any LIVING target — including a lingering offline player body
// from a prior probe run — win the swing above the barrel shove, so a stale
// room can starve the shove. A restart-persistence check is:
//   clear state; start server; run `persist <file>`; restart server KEEPING
//   state; run `verify <file>`.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { decodeServerFrame } from "@worldspring/shared/snapCodec";
import {
  BARREL_HITS_TO_BREAK,
  BARREL_HALF_XZ,
  MELEE_RANGE,
  WORLD_SAVE_INTERVAL_S,
} from "@worldspring/shared/constants";
import { BARREL_LOOT_TABLE } from "@worldspring/shared/items";

// world.ts / props.ts use extensionless relative imports that strip-types can't
// resolve — bundle them with esbuild exactly like trees-probe / fingerprint.mjs.
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { clampConfig, worldParamsOf } from "./config.ts";\n' +
      'export { barrelSpawns } from "./props.ts";\n',
    resolveDir: sharedDir + "/src",
    loader: "ts",
    sourcefile: "props-smoke-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createWorld, clampConfig, worldParamsOf, barrelSpawns } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const MODE = ["slice", "persist", "verify"].includes(argv[0]) ? argv[0] : "slice";
const rest = ["slice", "persist", "verify"].includes(argv[0]) ? argv.slice(1) : argv;
const STATE_FILE =
  MODE !== "slice"
    ? rest.find((a) => !a.startsWith("ws")) ?? "/tmp/props-smoke-state.json"
    : null;
const WS_URL = rest.find((a) => a.startsWith("ws")) ?? "ws://localhost:5173/ws";

if (typeof WebSocket === "undefined") {
  console.error("props-smoke: global WebSocket missing — Node 22+ required");
  process.exit(2);
}
const fail = (msg) => {
  console.error(`\nPROPS-SMOKE (${MODE}): FAIL — ${msg}`);
  process.exit(1);
};
const results = [];
const pass = (msg) => { results.push(msg); console.log(`  PASS  ${msg}`); };
const DEBUG = process.env.PROPS_DEBUG === "1";
let lastDbg = 0;
const dbg = (s) => { if (DEBUG && Date.now() - lastDbg > 1500) { lastDbg = Date.now(); console.log(`  ..  ${s}`); } };

// --- geometry helpers (mirror trees-probe / shared math) ---------------------
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const yawToward = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));
let seq = 0;
const send = (m) => ws.send(JSON.stringify(m));
const inputCmd = (yaw, walk, sprint) =>
  ({ seq: ++seq, dt: 1 / 15, mx: 0, mz: walk ? -1 : 0, yaw, pitch: 0, sprint: !!sprint, jump: false });

const BARREL_REACH = MELEE_RANGE + BARREL_HALF_XZ; // horiz reach a shove lands within
const MOVE_THRESHOLD = 0.5; // metres of displacement that count as a shove
const LOOT_TYPES = new Set(BARREL_LOOT_TABLE.map((e) => e.type));

// --- state -------------------------------------------------------------------
const ws = new WebSocket(WS_URL);
ws.binaryType = "arraybuffer"; // snapshots ship as binary frames (snapCodec)
let world = null;
let you = { x: 0, z: 0, y: 0 };
let axeSlot = -1;
let target = null; // chosen barrel ground pos {x,z}
let barrelId = null; // locked once seen in snap.bodies
let origin = null; // first observed body pose
let lastPose = null; // most recent observed body pose
let maxDelta = 0;
let shoveObserved = false;
let settleObserved = false;
let settleTime = 0; // game.time at settle
let restingPose = null;
let brokeObserved = false;
const breakEvents = [];
let swings = 0;
let lastAttackAt = 0;
let prevStill = { x: 0, z: 0 };
let stillSince = 0;
let phase = "join"; // join -> walk -> shove -> settle -> (persist|break) -> loot -> done
let want = null; // verify-mode: {id, restingPose, origin, target}

if (MODE === "verify") {
  want = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  target = want.target;
  barrelId = want.id;
}

const DEADLINE_MS = 200_000;
const deadline = setTimeout(() => fail(`timed out in phase "${phase}" after ${DEADLINE_MS / 1000}s`), DEADLINE_MS);
const pinger = setInterval(() => { try { send({ t: "ping", ts: Date.now() }); } catch { /* closing */ } }, 5_000);
const done = (label) => {
  clearTimeout(deadline); clearInterval(pinger);
  console.log(`\nPROPS-SMOKE (${MODE}): PASS (${results.length} checks) — ${label}`);
  try { ws.close(); } catch { /* done */ }
  process.exit(0);
};

ws.addEventListener("open", () => {
  send({ t: "join", name: `barrelbot-${MODE}`, token: randomBytes(16).toString("hex"), proto: PROTOCOL_VERSION, scenario: "trees" });
});
ws.addEventListener("error", () => fail(`cannot connect to ${WS_URL} — is the dev server running?`));

ws.addEventListener("message", (ev) => {
  let m;
  try { m = decodeServerFrame(ev.data); } catch { return; }
  if (m === null) return;

  if (m.t === "welcome") {
    axeSlot = m.inv.findIndex((s) => s && s.type === "axe");
    if (axeSlot === -1) fail("no axe in spawn inventory — server must run with TESTBED=1 (scenario 'trees')");
    send({ t: "equip", slot: axeSlot });
    const cfg = clampConfig(m.config).world;
    if (cfg.seed !== m.seed) cfg.seed = m.seed;
    world = createWorld(worldParamsOf(cfg));
    you = { x: m.you.x, y: m.you.y, z: m.you.z };
    if (MODE !== "verify") {
      // Score every worldgen barrel by (a) TREE CLEARANCE so a chop — the
      // cascade tier just above the shove — can never steal our swing (worldgen
      // buildings are static AABBs the melee cascade ignores: tryHitStructure
      // hits only player-built pieces, none on a fresh world), and (b) local
      // FLATNESS so a shoved barrel rolls to rest quickly instead of running
      // away downhill forever. Then take the nearest good one.
      const gh = (x, z) => world.groundHeight(x, z);
      const barrels = barrelSpawns(world).map((b) => {
        let treeClear = Infinity;
        for (const t of world.trees) treeClear = Math.min(treeClear, dist2(b.x, b.z, t.x, t.z));
        const c = gh(b.x, b.z);
        const grad = Math.max(
          Math.abs(gh(b.x + 3, b.z) - c), Math.abs(gh(b.x - 3, b.z) - c),
          Math.abs(gh(b.x, b.z + 3) - c), Math.abs(gh(b.x, b.z - 3) - c),
        );
        return { x: b.x, z: b.z, d: dist2(you.x, you.z, b.x, b.z), treeClear, grad };
      }).sort((a, bb) => a.d - bb.d);
      if (barrels.length === 0) fail("worldgen produced no barrels — spawnInitialProps didn't run (physics disabled or non-fresh world)");
      pass(`worldgen placed ${barrels.length} barrel(s); nearest ${barrels[0].d.toFixed(1)}m from spawn`);
      target =
        barrels.find((b) => b.treeClear > 5 && b.grad < 1.0) ??
        barrels.find((b) => b.treeClear > 5) ??
        barrels[0];
      console.log(`  chose barrel ${target.d.toFixed(1)}m away (treeClear ${target.treeClear.toFixed(1)}m, 3m-grad ${target.grad.toFixed(2)}m)`);
    }
    console.log(`props-smoke[${MODE}]: ${WS_URL} | proto ${PROTOCOL_VERSION} | seed ${m.seed}`);
    console.log(`  spawn (${you.x.toFixed(1)},${you.z.toFixed(1)}) -> barrel (${target.x.toFixed(1)},${target.z.toFixed(1)}), ${dist2(you.x, you.z, target.x, target.z).toFixed(1)}m away`);
    phase = "walk";
    return;
  }

  if (m.t === "inv") {
    if (DEBUG) { const w = m.slots.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0); if (w) console.log(`  ..  wood in inventory: ${w} (a swing is CHOPPING A TREE, not the barrel)`); }
    return;
  }
  if (m.t !== "snap") return;
  you = { x: m.you.x, y: m.you.y, z: m.you.z };
  for (const event of m.events ?? []) {
    if (event.e === "break" && event.id === barrelId) breakEvents.push(event);
  }

  // Locate our barrel body in the interest-filtered snapshot.
  const findBarrel = () => {
    if (barrelId != null) return m.bodies.find((b) => b.id === barrelId);
    // Not locked yet: nearest kind:"barrel" to the target ground pos.
    let best = Infinity, hit = null;
    for (const b of m.bodies) {
      if (b.kind !== "barrel") continue;
      const d = dist2(b.x, b.z, target.x, target.z);
      if (d < best && d < 5) { best = d; hit = b; }
    }
    return hit;
  };

  // Avoid feeding the swing to a wandering living target (they win the cascade
  // above the barrel): skip a swing if a zombie/deer is within reach of us.
  const livingNear = () => {
    for (const z of m.zombies ?? []) if (dist2(you.x, you.z, z.x, z.z) < BARREL_REACH + 0.6) return true;
    for (const a of m.animals ?? []) if (dist2(you.x, you.z, a.x, a.z) < BARREL_REACH + 0.6) return true;
    return false;
  };

  const walkTo = (tx, tz, closeEnough) => {
    const d = dist2(you.x, you.z, tx, tz);
    if (d > closeEnough) {
      send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, tx, tz), true, d > 6)] });
      return false;
    }
    return true;
  };

  // --- verify-mode persistence gate (runs first on the restarted server) -----
  if (MODE === "verify" && phase === "walk") {
    // Walk to where the barrel came to rest last run; assert it rehydrated
    // there from SQL (loadWorld branch — never re-spawned at origin).
    if (!walkTo(want.restingPose.x, want.restingPose.z, 4)) return;
    const b = findBarrel();
    if (!b) return; // give interest/snap a tick
    const dRest = dist2(b.x, b.z, want.restingPose.x, want.restingPose.z);
    const dOrigin = dist2(b.x, b.z, want.origin.x, want.origin.z);
    if (dRest < 1.0) pass(`barrel id ${barrelId} rehydrated from SQL at its persisted resting pose (Δ=${dRest.toFixed(2)}m < 1.0)`);
    else fail(`restored barrel not at persisted pose: Δrest=${dRest.toFixed(2)}m (origin Δ=${dOrigin.toFixed(2)}m)`);
    if (dOrigin > MOVE_THRESHOLD) pass(`restored pose is the SHOVED pose, not the spawn origin (Δorigin=${dOrigin.toFixed(2)}m > ${MOVE_THRESHOLD}) — no double-spawn`);
    else fail(`restored barrel is back at spawn origin (Δorigin=${dOrigin.toFixed(2)}m) — persistence lost the shove or it re-spawned`);
    // Persistence proven. break->loot is covered by the slice run, and a
    // lingering offline body from the persist run could sit on this barrel and
    // absorb break swings — so don't gate the persistence result on a break.
    done("shoved barrel survived a server restart (rehydrated from SQL at its persisted pose)");
    return;
  }

  // --- walk to the barrel ----------------------------------------------------
  if (phase === "walk") {
    if (!walkTo(target.x, target.z, 6)) return;
    const b = findBarrel();
    if (!b) return; // in range now; wait for the body to enter the snapshot
    barrelId = b.id;
    origin = { x: b.x, y: b.y, z: b.z };
    lastPose = b;
    pass(`barrel body present in snap.bodies (id ${b.id}) at (${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)})`);
    if (b.dims === undefined) pass("barrel pose carries NO dims (fixed-size wire shape — dims is trunk-only)");
    else fail(`barrel unexpectedly carried dims ${JSON.stringify(b.dims)}`);
    phase = "shove";
    return;
  }

  // --- shove: approach, land ONE swing, watch the barrel jump ----------------
  if (phase === "shove") {
    const b = findBarrel();
    if (!b) return;
    lastPose = b;
    const delta = dist2(b.x, b.z, origin.x, origin.z);
    if (delta > maxDelta) maxDelta = delta;
    if (maxDelta > MOVE_THRESHOLD) {
      shoveObserved = true;
      pass(`melee swing SHOVED the barrel (Δ=${maxDelta.toFixed(2)}m > ${MOVE_THRESHOLD}) — id ${barrelId} moved from (${origin.x.toFixed(1)},${origin.z.toFixed(1)}) to (${b.x.toFixed(1)},${b.z.toFixed(1)})`);
      // STOP driving it — let it roll to rest so the settle is real, not a
      // frame between our hits. No inputs at all in the settle phase.
      phase = "settle";
      lastPose = b; prevStill = { x: b.x, z: b.z }; stillSince = Date.now();
      return;
    }
    // Not yet shoved: close to reach, face, swing on the attack cooldown.
    const d = dist2(you.x, you.z, b.x, b.z);
    const trunks = m.bodies.filter((bb) => bb.kind === "trunk").length;
    const playersNear = (m.players ?? []).filter((p) => dist2(you.x, you.z, p.x, p.z) < 3).length;
    dbg(`shove you=(${you.x.toFixed(1)},${you.z.toFixed(1)}) barrel=(${b.x.toFixed(1)},${b.z.toFixed(1)}) horiz=${d.toFixed(2)} dy=${Math.abs(b.y - you.y).toFixed(2)} living=${livingNear()} playersNear=${playersNear} trunks=${trunks} swings=${swings}`);
    if (d > BARREL_REACH - 0.3) {
      send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, b.x, b.z), true, d > 6)] });
      return;
    }
    send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, b.x, b.z), false, false)] });
    if (Date.now() - lastAttackAt > 850 && !livingNear()) {
      lastAttackAt = Date.now(); swings++; send({ t: "attack" });
    }
    return;
  }

  // --- settle: send NO inputs; wait for the barrel to sleep (or hold still) ---
  if (phase === "settle") {
    const b = findBarrel();
    if (!b) return;
    lastPose = b;
    if (dist2(b.x, b.z, prevStill.x, prevStill.z) > 0.05) { prevStill = { x: b.x, z: b.z }; stillSince = Date.now(); }
    const stableFor = (Date.now() - stillSince) / 1000;
    dbg(`settle barrel=(${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}) asleep=${!!b.asleep} stableFor=${stableFor.toFixed(1)}s`);
    // Rapier's sleep flag is the real signal; the stability fallback covers a
    // barrel that keeps micro-rolling on a hair of slope without the flag.
    if (b.asleep || stableFor > 4) {
      settleObserved = true;
      settleTime = m.time;
      restingPose = { x: b.x, y: b.y, z: b.z };
      pass(`shoved barrel came to REST at (${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)})${b.asleep ? " (asleep)" : " (position-stable)"}`);
      phase = MODE === "persist" ? "save" : "break";
    }
    return;
  }

  // --- break: settle-gated swings until the body is gone (opened for loot) ---
  if (phase === "break") {
    const b = findBarrel();
    if (!b) {
      if (swings >= 1) {
        brokeObserved = true;
        pass(`barrel BROKE after ${swings} swings (body removed from snap.bodies)`);
        if (breakEvents.length !== 1) {
          fail(`expected exactly one barrel break event, saw ${breakEvents.length}`);
        }
        const event = breakEvents[0];
        const finitePose = [event.x, event.y, event.z, ...(event.q ?? [])].every(Number.isFinite);
        if (event.kind !== "barrel" || event.q?.length !== 4 || !finitePose) {
          fail(`malformed break event: ${JSON.stringify(event)}`);
        }
        const poseDelta = lastPose ? dist2(event.x, event.z, lastPose.x, lastPose.z) : Infinity;
        if (poseDelta >= 0.5 || !lastPose || Math.abs(event.y - lastPose.y) >= 0.5) {
          fail(`break event pose diverged from final body pose by ${poseDelta.toFixed(2)}m`);
        }
        pass("one break event carried the barrel's final position + quaternion");
        phase = "loot";
      }
      return;
    }
    lastPose = b;
    const d = dist2(you.x, you.z, b.x, b.z);
    dbg(`break you=(${you.x.toFixed(1)},${you.z.toFixed(1)}) barrel=(${b.x.toFixed(1)},${b.z.toFixed(1)}) horiz=${d.toFixed(2)} asleep=${!!b.asleep} living=${livingNear()} swings=${swings}`);
    if (d > BARREL_REACH - 0.3) {
      send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, b.x, b.z), true, d > 6)] });
      return;
    }
    // Face it; only swing once it has SETTLED (asleep) so each hit is clean and
    // we don't just chase a rolling barrel forever.
    send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, b.x, b.z), false, false)] });
    if (b.asleep && Date.now() - lastAttackAt > 850 && !livingNear()) {
      lastAttackAt = Date.now(); swings++; send({ t: "attack" });
    }
    return;
  }

  // --- persist mode: wait out a world save, record the pose, exit ------------
  if (phase === "save") {
    const b = findBarrel();
    if (b) { lastPose = b; restingPose = { x: b.x, y: b.y, z: b.z }; }
    // A periodic save fires within WORLD_SAVE_INTERVAL_S of game-time; wait a
    // full interval past settle so the shoved pose is guaranteed on disk.
    if (m.time - settleTime < WORLD_SAVE_INTERVAL_S + 2) return;
    writeFileSync(STATE_FILE, JSON.stringify({ id: barrelId, origin, restingPose, target }, null, 2));
    pass(`waited a full save interval (${(m.time - settleTime).toFixed(0)}s game-time); wrote resting pose to ${STATE_FILE}`);
    done("shove + settle persisted; state written for the restart verify");
    return;
  }

  // --- loot: the break spilled a valid stack near the barrel's last pose -----
  if (phase === "loot") {
    const stack = (m.loot ?? []).find(
      (l) => LOOT_TYPES.has(l.type) && lastPose && dist2(l.x, l.z, lastPose.x, lastPose.z) < 4,
    );
    if (!stack) return;
    pass(`break spilled a BARREL_LOOT_TABLE stack (${stack.count}x ${stack.type}) within 4m of the barrel's last pose`);
    const label = MODE === "verify" ? "persistence + break->loot on the restored barrel" : "shove + settle + break->loot";
    done(label);
    return;
  }
});
