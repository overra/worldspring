#!/usr/bin/env node
// Falling-trees probe (doc 13 M2) — drives a real GameRoom over WS and proves
// the whole chop → fell → settle → despawn-to-loot slice end to end:
//   1. joins with the "trees" testbed scenario (axe provisioned, inland spawn),
//   2. walks to the nearest tree (worldgen is shared: createWorld(welcome.seed)
//      gives the bot the same forest the server has),
//   3. swings the axe until the fell — asserting wood arrives per chop, the
//      snap carries a `felled` delta, and a kind:"trunk" body appears,
//   4. waits out settle + TTL — asserting the trunk despawns AND wood loot
//      appears near its RESTING pose.
//
//   node --experimental-strip-types apps/game/scripts/trees-probe.mjs [ws-url]
//   default url: ws://localhost:5173/ws  (dev server; .dev.vars has TESTBED=1)
//
// Requires a TESTBED server (the axe comes from the scenario provision) with
// physics enabled. Not part of `pnpm test` — like channel-smoke, it needs a
// live server; CI covers the physics layer via physics-replay.mjs instead.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { TREE_CHOPS_TO_FELL, TRUNK_SETTLE_TTL_S } from "@worldspring/shared/constants";

// world.ts uses extensionless relative imports, which strip-types cannot
// resolve — bundle it with esbuild exactly like shared's fingerprint.mjs /
// map-render.mjs do (esbuild resolved from the shared package's devDeps).
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { clampConfig, worldParamsOf } from "./config.ts";\n',
    resolveDir: sharedDir + "/src",
    loader: "ts",
    sourcefile: "trees-probe-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createWorld, clampConfig, worldParamsOf } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

const WS_URL = process.argv[2] ?? "ws://localhost:5173/ws";
if (typeof WebSocket === "undefined") {
  console.error("trees-probe: global WebSocket missing — Node 22+ required");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`\nTREES-PROBE: FAIL — ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
const ws = new WebSocket(WS_URL);
let seq = 0;
const send = (m) => ws.send(JSON.stringify(m));
/** Face `yaw` and optionally walk forward for one tick of game-time. The
 * server's forward vector for yaw is (-sin yaw, -cos yaw) (shared math). */
const inputCmd = (yaw, walk) =>
  ({ seq: ++seq, dt: 1 / 15, mx: 0, mz: walk ? -1 : 0, yaw, pitch: 0, sprint: false, jump: false });
const yawToward = (fromX, fromZ, toX, toZ) => Math.atan2(-(toX - fromX), -(toZ - fromZ));
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

let world = null;
let target = null; // { index, x, z }
let you = { x: 0, z: 0 };
let phase = "join"; // join -> walk -> chop -> trunk -> loot
let axeSlot = -1;
let woodSeen = 0;
let chopsSent = 0;
let lastAttackAt = 0;
let felledDeltaSeen = [];
let trunkId = null;
let trunkPose = null; // last seen pose of the trunk body
let trunkAsleepAt = 0;

const results = [];
const pass = (msg) => {
  results.push(msg);
  console.log(`  PASS  ${msg}`);
};

// Global timeout: walk + 3 chops + settle + 30s TTL fits well inside this.
const DEADLINE_MS = 150_000;
const deadline = setTimeout(() => fail(`timed out in phase "${phase}" after ${DEADLINE_MS / 1000}s`), DEADLINE_MS);

// Keep the liveness sweep happy during the long settle/TTL waits.
const pinger = setInterval(() => { try { send({ t: "ping", ts: Date.now() }); } catch { /* closing */ } }, 5_000);

ws.addEventListener("open", () => {
  send({ t: "join", name: "treebot", token: randomBytes(16).toString("hex"), proto: PROTOCOL_VERSION, scenario: "trees" });
});
ws.addEventListener("error", () => fail(`cannot connect to ${WS_URL} — is the dev server running?`));

ws.addEventListener("message", (ev) => {
  if (typeof ev.data !== "string") return;
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  if (m.t === "welcome") {
    axeSlot = m.inv.findIndex((s) => s && s.type === "axe");
    if (axeSlot === -1) {
      fail("no axe in the spawn inventory — server must run with TESTBED=1 (scenario 'trees')");
    }
    send({ t: "equip", slot: axeSlot });
    // doc 07 M2: mirror the client — clamp welcome.config, coerce the legacy
    // top-level seed, build the world from the derived params.
    const worldCfg = clampConfig(m.config).world;
    if (worldCfg.seed !== m.seed) worldCfg.seed = m.seed;
    world = createWorld(worldParamsOf(worldCfg));
    you = { x: m.you.x, z: m.you.z };
    // Nearest STANDING tree to the spawn (worldgen is deterministic + shared;
    // welcome.felled excludes trees earlier probe runs already brought down).
    const alreadyFelled = new Set(m.felled ?? []);
    let best = Infinity;
    world.trees.forEach((tree, index) => {
      if (alreadyFelled.has(index)) return;
      const d = dist2(you.x, you.z, tree.x, tree.z);
      if (d < best) { best = d; target = { index, x: tree.x, z: tree.z }; }
    });
    if (!target) fail("worldgen produced no (standing) trees?");
    if (alreadyFelled.size > 0) {
      pass(`welcome.felled restored ${alreadyFelled.size} previously-felled tree(s) — fells persist`);
    }
    console.log(`trees-probe: ${WS_URL} | proto ${PROTOCOL_VERSION} | seed ${m.seed}`);
    console.log(`  spawn (${you.x.toFixed(1)}, ${you.z.toFixed(1)}) -> tree #${target.index} at (${target.x.toFixed(1)}, ${target.z.toFixed(1)}), ${best.toFixed(1)}m away`);
    phase = "walk";
    return;
  }

  if (m.t === "inv") {
    const wood = m.slots.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);
    if (wood > woodSeen && phase === "chop") {
      console.log(`  chop landed: wood in inventory ${woodSeen} -> ${wood}`);
    }
    woodSeen = Math.max(woodSeen, wood);
    return;
  }

  if (m.t !== "snap") return;
  you = { x: m.you.x, z: m.you.z };
  if (m.felled) felledDeltaSeen.push(...m.felled);

  if (phase === "walk") {
    const d = dist2(you.x, you.z, target.x, target.z);
    if (d > 2.0) {
      // One walking tick per snap (~15Hz) — the input budget accrues at
      // wall-clock rate, so this never outruns it.
      send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, target.x, target.z), true)] });
      return;
    }
    phase = "chop";
    console.log(`  arrived (${d.toFixed(2)}m from trunk) — chopping`);
  }

  if (phase === "chop") {
    // Face the trunk (a zero-move cmd updates yaw without moving), then swing
    // on the attack cooldown (0.7s) with headroom.
    send({ t: "input", cmds: [inputCmd(yawToward(you.x, you.z, target.x, target.z), false)] });
    const now = Date.now();
    if (now - lastAttackAt > 900 && chopsSent < TREE_CHOPS_TO_FELL + 4) {
      lastAttackAt = now;
      chopsSent++;
      send({ t: "attack" });
    }
    if (chopsSent > TREE_CHOPS_TO_FELL + 3) {
      fail(`no trunk body after ${chopsSent} swings — chop or fell not landing`);
    }
    const trunk = m.bodies.find((b) => b.kind === "trunk");
    if (trunk) {
      trunkId = trunk.id;
      trunkPose = trunk;
      pass(`trunk body appeared in snap.bodies (id ${trunk.id}, dims ${JSON.stringify(trunk.dims)}) after ${chopsSent} swings`);
      if (Array.isArray(trunk.dims) && trunk.dims.length === 3 && trunk.dims[1] >= 3) {
        pass("trunk carries its half-extents on the wire (client scales the mesh from these)");
      } else {
        fail(`trunk WireBody.dims missing/malformed: ${JSON.stringify(trunk.dims)}`);
      }
      if (woodSeen >= TREE_CHOPS_TO_FELL) pass(`chops granted wood (${woodSeen} in inventory)`);
      else fail(`expected >= ${TREE_CHOPS_TO_FELL} wood from chops, saw ${woodSeen}`);
      if (felledDeltaSeen.includes(target.index)) pass(`snap.felled delta carried tree #${target.index}`);
      else fail(`snap.felled never carried tree #${target.index} (saw ${JSON.stringify(felledDeltaSeen)})`);
      phase = "trunk";
    }
    return;
  }

  if (phase === "trunk") {
    const trunk = m.bodies.find((b) => b.id === trunkId);
    if (trunk) {
      trunkPose = trunk;
      if (trunk.asleep && trunkAsleepAt === 0) {
        trunkAsleepAt = Date.now();
        console.log(`  trunk settled at (${trunk.x.toFixed(1)}, ${trunk.y.toFixed(1)}, ${trunk.z.toFixed(1)}) — waiting out the ${TRUNK_SETTLE_TTL_S}s TTL`);
      }
      return;
    }
    // Gone from snapshots at our position = despawned (we stand right there).
    pass(`trunk despawned after settling (~${trunkAsleepAt ? ((Date.now() - trunkAsleepAt) / 1000).toFixed(0) : "?"}s asleep)`);
    phase = "loot";
    return;
  }

  if (phase === "loot") {
    const wood = m.loot.find(
      (l) => l.type === "wood" && trunkPose && dist2(l.x, l.z, trunkPose.x, trunkPose.z) < 3,
    );
    if (!wood) return; // next snap
    pass(`bonus wood loot (${wood.count}) dropped within 3m of the trunk's resting pose`);
    clearTimeout(deadline);
    clearInterval(pinger);
    console.log(`\nTREES-PROBE: PASS (${results.length} checks)`);
    try { ws.close(); } catch { /* done */ }
    process.exit(0);
  }
});
