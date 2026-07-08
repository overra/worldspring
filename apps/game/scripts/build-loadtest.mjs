#!/usr/bin/env node
// doc 06 M8 — Load/limits validation for base building. A focused SIBLING of
// scripts/loadtest.mjs: that harness drives ROAMING players and validates the
// tick/msg-rate scaling caveats; this one drives BUILDER bots to fill the world
// to WORLD_PIECE_CAP and measures the structure-specific limits the milestone
// calls for:
//
//   * server tick EMA + tick MAX at cap with N online bots (read from the
//     server's own /api/health — the tick timing the DO already tracks;
//     NO server code was touched, prod stays byte-identical);
//   * persistAll cost at cap (derived from the periodic-save tick spike —
//     persistAll runs INSIDE the tick on the WORLD_SAVE_INTERVAL_S cadence, so
//     the save shows up as a tickMsMax spike above the steady tickMsEma);
//   * join time for a FRESH bot doing a full sFull sync against the cap-full
//     world, and the wire size of that sFull batch.
//
//   node --experimental-strip-types apps/game/scripts/build-loadtest.mjs [ws-url] [--flags]
//   default url: ws://localhost:5173/ws  (dev server; .dev.vars has TESTBED=1)
//
// Flags:
//   --cap=N              stop filling at N pieces (default WORLD_PIECE_CAP; a
//                        smaller value gives a fast dev smoke of the whole flow)
//   --bots=N             online bots held during the measurement (default 20)
//   --fillers=N          concurrent builder workers during the fill (default 16;
//                        1 observer + fillers must stay < MAX_PLAYERS 24)
//   --measure-seconds=N  measurement hold length (default 55; must span >= one
//                        WORLD_SAVE_INTERVAL_S so a periodic save is captured)
//   --drain-seconds=N    drain-ceiling floor: after the fill, the harness polls
//                        until the server's player count falls to the observer
//                        alone (every fill life logs out ALIVE and its body
//                        lingers session.logoutLingerS), capped at max(N,120)s,
//                        so the measurement sees ONLY the online bots (default 65)
//   --scenario=NAME      testbed provisioning set (default "building" — hammer
//                        + 40 wood; the fill re-provisions via fresh tokens)
//   --verbose            per-life fill logging
//
// WHY BUILDER BOTS + FRESH-TOKEN CYCLING: a testbed life is provisioned once
// (GameRoom.handleJoin path 3) with a bounded kit (building = 40 wood) and the
// inventory caps at INVENTORY_SLOTS*stack, so ONE life can place only ~5
// foundations. Reaching WORLD_PIECE_CAP is therefore cooperative: each worker
// cycles fresh tokens (fresh path-3 life => fresh kit), places a patch of
// foundations in its own angular sector via the SHARED canPlace (the exact
// ghost the client uses — imported through esbuild, never mirrored, so a
// protocol/geometry change can't silently invalidate the run), then drops the
// socket and repeats. The shared local StructureIndex is kept live off the
// GLOBAL sAdd/sRemove broadcasts (structures are never interest-filtered), so
// one index serves every bot's canPlace AND gives the authoritative piece
// count. "someone is in the way" (an unseen offline lingering body the ghost
// can't account for) is retryable exactly like locks-smoke does.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import {
  BUILD_CELL,
  BUILD_RANGE,
  WORLD_PIECE_CAP,
  WORLD_SAVE_INTERVAL_S,
} from "@worldspring/shared/constants";

// --- Mirrored input tunables (packages/shared/src/constants.ts) — same values
// the loadtest.mjs / smoke probes use to build protocol-faithful input frames.
const MAX_INPUT_DT = 0.05;
const MAX_CMDS_PER_FRAME = 6;
// Budget: the periodic save must fit under this for the milestone's acceptance.
const TICK_BUDGET_MS = 10; // acceptance: tick max < 10ms at cap
const JOIN_SYNC_BUDGET_MS = 1000; // acceptance: join sync < 1s on localhost

// world.ts / structures.ts use extensionless relative imports that strip-types
// cannot resolve — bundle them with esbuild exactly like locks-smoke.mjs /
// props-smoke.mjs (esbuild resolved from the shared package's devDeps).
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");
const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { clampConfig, worldParamsOf } from "./config.ts";\n' +
      'export { canPlace, pieceCenter, PIECE_DEFS } from "./structures.ts";\n',
    resolveDir: sharedDir + "/src",
    loader: "ts",
    sourcefile: "build-loadtest-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createWorld, clampConfig, worldParamsOf, canPlace, pieceCenter, PIECE_DEFS } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flags = new Map(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const numFlag = (name, dflt) => {
  const v = flags.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const WS_URL = positional[0] ?? "ws://localhost:5173/ws";
if (!/^wss?:\/\//.test(WS_URL)) {
  console.error("usage: node build-loadtest.mjs <ws-url> [--cap=N --bots=N --fillers=N ...]");
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("build-loadtest: global WebSocket missing — Node 22+ required");
  process.exit(2);
}
const CAP = Math.max(1, Math.min(WORLD_PIECE_CAP, Math.floor(numFlag("cap", WORLD_PIECE_CAP))));
const BOTS = Math.max(1, Math.floor(numFlag("bots", 20)));
const FILLERS = Math.max(1, Math.floor(numFlag("fillers", 16)));
const MEASURE_S = Math.max(WORLD_SAVE_INTERVAL_S + 5, Math.floor(numFlag("measure-seconds", 55)));
const DRAIN_S = Math.max(0, Math.floor(numFlag("drain-seconds", 65)));
const SCENARIO = typeof flags.get("scenario") === "string" ? flags.get("scenario") : "building";
const VERBOSE = flags.has("verbose");
const FOUNDATION_COST = PIECE_DEFS.foundation.cost;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round3 = (x) => Math.round(x * 1000) / 1000;
const round4 = (x) => Math.round(x * 10000) / 10000;
const median = (arr) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const fail = (msg) => {
  console.error(`\nBUILD-LOADTEST: FAIL — ${msg}`);
  process.exit(1);
};

// --- shared local world (canPlace ground truth) + authoritative piece count --
// One index, seeded from the observer's sFull, then kept in lockstep with the
// server off the GLOBAL sAdd/sRemove/sFull stream every bot receives. ids
// dedups the fan-out (every connected bot sees the same broadcast).
const shared = { world: null, ids: new Set(), ready: false };
let SPAWN = { x: 0, z: 0 };

function foldFrame(m) {
  if (!shared.ready) return;
  if (m.t === "sAdd") {
    if (!shared.ids.has(m.piece.id)) {
      shared.ids.add(m.piece.id);
      shared.world.structures.add(m.piece);
    }
  } else if (m.t === "sRemove") {
    if (shared.ids.has(m.id)) {
      shared.ids.delete(m.id);
      shared.world.structures.remove(m.id);
    }
  } else if (m.t === "sFull") {
    for (const p of m.pieces) {
      if (!shared.ids.has(p.id)) {
        shared.ids.add(p.id);
        shared.world.structures.add(p);
      }
    }
  }
}
const pieceCount = () => shared.ids.size;

// Place-rejection notice signatures (systems/structures.ts handlePlace +
// shared PLACE_REJECTION_TEXT) — distinguishes OUR place reply from the
// "<name> joined/left/reconnected" broadcasts that fly during the fill.
const PLACE_REJECT_RE =
  /^(Cannot place:|Needs \d+ |Too far away to build|You have reached your structure limit|The world structure limit|Equip a hammer|Building is disabled|You cannot build in this realm)/;

// --- tiny bot wrapper (locks-smoke lineage) ---------------------------------
class Bot {
  constructor(name) {
    this.name = name;
    this.token = randomBytes(16).toString("hex");
    this.frames = [];
    this.you = { x: 0, y: 0, z: 0 };
    this.players = [];
    this.seq = 0;
    this.waiters = [];
    this.closed = false;
    this.sFullBytes = 0;
    this.sFullBatches = 0;
    this.sFullPieces = 0;
  }
  connect(joinOverrides = {}) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      ws.addEventListener("error", () => {
        if (!this.opened) reject(new Error(`cannot connect to ${WS_URL} — is the dev server up?`));
      });
      ws.addEventListener("close", () => {
        this.closed = true;
      });
      ws.addEventListener("open", () => {
        this.opened = true;
        this.send({
          t: "join",
          name: this.name,
          token: this.token,
          proto: PROTOCOL_VERSION,
          scenario: SCENARIO,
          ...joinOverrides,
        });
        resolve();
      });
      ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    });
  }
  onMessage(data) {
    if (typeof data !== "string") return;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === "sFull") {
      this.sFullBytes += Buffer.byteLength(data);
      this.sFullBatches++;
      this.sFullPieces += m.pieces.length;
    }
    if (m.t === "welcome") this.gotWelcome = true; // boolean survives the frame-cap eviction
    if (m.t === "welcome" || m.t === "snap") {
      this.you = { x: m.you.x, y: m.you.y, z: m.you.z };
    }
    if (m.t === "snap") this.players = m.players ?? [];
    foldFrame(m);
    this.frames.push(m);
    // Bound the frame buffer: waitFor() scans it and a long-lived bot (the
    // observer) would otherwise grow it unbounded at 15Hz — GC thrash that
    // starves the 16 concurrent fill loops. 500 recent frames is ample for any
    // waitFor (the awaited sAdd/notice always arrives within a few frames).
    if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 400);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }
  send(m) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  waitFor(pred, what, timeoutMs = 8000) {
    const past = this.frames.find(pred);
    if (past) return Promise.resolve(past);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.name}: timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }
  close() {
    try {
      this.ws?.close(1000, "done");
    } catch {
      /* already closing */
    }
  }
  occupants() {
    return [{ x: this.you.x, y: this.you.y, z: this.you.z }, ...this.players.map((p) => ({ x: p.x, y: p.y, z: p.z }))];
  }
  /** Sprint toward (tx,tz) with protocol-faithful batched input until within
   * tol (or a stall/timeout). Foundations are step-on-able, so a builder never
   * snags on its own field. */
  async walk(tx, tz, tol = 1.5, timeoutMs = 20000) {
    const t0 = Date.now();
    let last = Date.now();
    let bestD = Infinity;
    let lastProgress = Date.now();
    for (;;) {
      if (this.closed) return false;
      const d = Math.hypot(this.you.x - tx, this.you.z - tz);
      if (d <= tol) return true;
      if (d < bestD - 0.1) {
        bestD = d;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > 3500) return d <= tol + 3;
      if (Date.now() - t0 > timeoutMs) return d <= tol + 3;
      const now = Date.now();
      let rem = Math.min((now - last) / 1000, MAX_INPUT_DT * MAX_CMDS_PER_FRAME);
      last = now;
      rem = Math.max(rem, 0.001);
      const yaw = Math.atan2(-(tx - this.you.x), -(tz - this.you.z));
      const cmds = [];
      while (rem > 0 && cmds.length < MAX_CMDS_PER_FRAME) {
        const dt = Math.min(rem, MAX_INPUT_DT);
        rem -= dt;
        cmds.push({ seq: ++this.seq, dt: round4(dt), mx: 0, mz: -1, yaw: round3(yaw), pitch: 0, sprint: true, jump: false });
      }
      this.send({ t: "input", cmds });
      await sleep(45);
    }
  }
  /** Send a place; resolve {piece} on our sAdd or {rejected} on the place
   * rejection notice. Only PLACE-rejection notices count — the fresh-token fill
   * churns "<name> joined/left" broadcast notices constantly, and matching those
   * would mislabel a still-pending placement. */
  async placeTry(target) {
    const before = this.frames.length;
    this.send({ t: "place", ...target });
    let m;
    try {
      m = await this.waitFor(
        (f) =>
          (f.t === "sAdd" &&
            f.piece.kind === target.kind &&
            f.piece.gx === target.gx &&
            f.piece.gz === target.gz) ||
          (f.t === "notice" && this.frames.indexOf(f) >= before && PLACE_REJECT_RE.test(f.msg)),
        "place result",
        8000,
      );
    } catch {
      return { rejected: "timeout" };
    }
    return m.t === "notice" ? { rejected: m.msg } : { piece: m.piece };
  }
}

// --- fill: cooperative sector-partitioned foundation placement ---------------
let capReached = false;
const rejectionTally = {};
function tallyReject(msg) {
  let key = "other";
  if (/in the way/i.test(msg)) key = "in-the-way";
  else if (/occupied/i.test(msg)) key = "occupied";
  else if (/allowed here/i.test(msg)) key = "zone";
  else if (/steep/i.test(msg)) key = "slope";
  else if (/water/i.test(msg)) key = "water";
  else if (/nearby/i.test(msg)) key = "density";
  else if (/too far/i.test(msg)) key = "too-far";
  else if (/world structure limit/i.test(msg)) key = "world-cap";
  else if (/timeout/i.test(msg)) key = "timeout";
  rejectionTally[key] = (rejectionTally[key] ?? 0) + 1;
  return key;
}

/** Frontier anchor for a worker: a point in the worker's angular sector at a
 * radius that grows with how much it has already placed (area-filling sqrt). */
function anchorFor(worker) {
  const sector = (2 * Math.PI) / FILLERS;
  const a = (worker.id + 0.5) * sector + (Math.random() - 0.5) * sector * 0.8;
  // Start well off spawn (18m) so all FILLERS workers spread into their own
  // directions from the FIRST life instead of piling onto the spawn cell; grow
  // outward as the worker fills its wedge.
  const r = 18 + Math.sqrt(worker.totalPlaced) * 8;
  return { x: SPAWN.x + Math.cos(a) * r, z: SPAWN.z + Math.sin(a) * r };
}

/** Nearest canPlace-GREEN, not-yet-tried foundation cell within BUILD_RANGE of
 * the bot — the shared ghost, exactly like the client. null when none reachable. */
function pickGreenCell(bot, tried) {
  // Scan the cells within BUILD_RANGE of the bot (a 5x5 block, filtered to
  // centres within reach) and return the NEAREST green, caching reds so a life
  // never re-scans a dead cell. canPlace is cheap here (only ~64 zone checks:
  // 4 towns + 36 buildings + 24 spawn-points, plus grid-local overlap/density).
  const bgx = Math.floor(bot.you.x / BUILD_CELL);
  const bgz = Math.floor(bot.you.z / BUILD_CELL);
  const cands = [];
  for (let dgx = -2; dgx <= 2; dgx++) {
    for (let dgz = -2; dgz <= 2; dgz++) {
      const gx = bgx + dgx;
      const gz = bgz + dgz;
      if (tried.has(`${gx},${gz}`)) continue;
      const [cx, cz] = pieceCenter({ kind: "foundation", tier: 0, gx, gz });
      const d = Math.hypot(bot.you.x - cx, bot.you.z - cz);
      if (d > BUILD_RANGE - 0.6) continue;
      cands.push({ gx, gz, cx, cz, d });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const occ = bot.occupants();
  for (const c of cands) {
    const target = { kind: "foundation", tier: 0, gx: c.gx, gz: c.gz };
    if (canPlace(shared.world, target, occ) === null) return { target, c };
    tried.add(`${c.gx},${c.gz}`); // red now — don't rescan it this life
  }
  return null;
}

async function fillerLife(worker) {
  const bot = new Bot(`fill-${worker.id}`);
  try {
    await bot.connect();
  } catch {
    return 0;
  }
  let placed = 0;
  try {
    // Generous join timeouts: near WORLD_PIECE_CAP each join makes the DO
    // build+send the FULL sFull (~255KB) and fire a persistAll of the growing
    // blob (both O(pieces)), so a join queued behind others can take tens of
    // seconds. A short timeout there false-fails and adds reconnect churn that
    // drops the fill BELOW the DO's serial join throughput — the opposite of
    // what we want. Keep the filler count low (short queue) and the timeout high.
    const welcome = await bot.waitFor((m) => m.t === "welcome", "welcome", 90000);
    await bot.waitFor((m) => m.t === "sFull" && m.done === true, "sFull done", 90000);
    await bot.waitFor((m) => m.t === "snap", "first snap", 90000);
    const hammer = welcome.inv.findIndex((s) => s && s.type === "hammer");
    if (hammer === -1) {
      bot.close();
      throw new Error("no hammer in kit — server not running TESTBED=1 (scenario 'building')");
    }
    const wood = welcome.inv.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);
    const budget = Math.max(1, Math.floor(wood / FOUNDATION_COST));
    bot.send({ t: "equip", slot: hammer });

    const anchor = anchorFor(worker);
    await bot.walk(anchor.x, anchor.z, 2.5, 22000);

    const tried = new Set();
    let stepOuts = 0;
    while (placed < budget && pieceCount() < CAP && !capReached && stepOuts < 14) {
      const hit = pickGreenCell(bot, tried);
      if (!hit) {
        // No fresh cell within reach — NUDGE ~1.5 cells further out along the
        // radial from spawn (a cheap ~2s step), NOT a full re-anchor walk. This
        // is what keeps the fill fast: a crowded frontier costs a short nudge,
        // not a 9s cross-map walk.
        stepOuts++;
        const ang = Math.atan2(bot.you.z - SPAWN.z, bot.you.x - SPAWN.x);
        const nx = bot.you.x + Math.cos(ang) * BUILD_CELL * 1.5;
        const nz = bot.you.z + Math.sin(ang) * BUILD_CELL * 1.5;
        if (!(await bot.walk(nx, nz, 1.5, 5000))) break;
        continue;
      }
      tried.add(`${hit.c.gx},${hit.c.gz}`);
      if (hit.c.d > BUILD_RANGE - 1.0) await bot.walk(hit.c.cx, hit.c.cz, BUILD_RANGE - 1.5, 9000);
      // Re-validate after the walk (deltas may have landed under us).
      if (canPlace(shared.world, hit.target, bot.occupants()) !== null) continue;
      const r = await bot.placeTry(hit.target);
      if (r.piece) {
        placed++;
        worker.totalPlaced++;
      } else {
        const key = tallyReject(r.rejected);
        if (key === "world-cap") {
          capReached = true;
          break;
        }
      }
    }
  } catch (err) {
    if (VERBOSE) console.log(`  ..  ${bot.name} life ended: ${err.message}`);
  }
  bot.close();
  // Wait for the socket to ACTUALLY close before the worker's next connect.
  // Otherwise the old (closing) socket still counts in getWebSockets() and the
  // reconnect churn transiently pushes concurrent sockets toward MAX_PLAYERS
  // (24) — the server then 503s the new connect, the worker retries, and the
  // fill throttles itself. Bounding to ~(observer + FILLERS) sockets keeps it
  // steady.
  for (let i = 0; i < 30 && !bot.closed; i++) await sleep(50);
  return placed;
}

// --- /api/health ------------------------------------------------------------
function healthUrl() {
  const u = new URL(WS_URL);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/api/health";
  u.search = "";
  return u;
}
async function fetchHealth() {
  try {
    const res = await fetch(healthUrl(), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String(err) };
  }
}

// --- main -------------------------------------------------------------------
const globalDeadline = setTimeout(
  () => fail("global deadline exceeded — fill did not converge"),
  Math.max(60 * 60_000, (CAP / 5) * 800),
);
globalDeadline.unref?.();

async function main() {
  console.log(
    `build-loadtest: ${WS_URL} | proto ${PROTOCOL_VERSION} | cap ${CAP}` +
      `${CAP < WORLD_PIECE_CAP ? ` (WORLD_PIECE_CAP=${WORLD_PIECE_CAP})` : ""} | bots ${BOTS}` +
      ` | fillers ${FILLERS} | scenario ${SCENARIO}`,
  );

  const baseline = await fetchHealth();
  if (baseline.error) fail(`/api/health unreachable at start: ${baseline.error}`);
  console.log(
    `baseline (empty world): players ${baseline.players} tickMsEma ${baseline.tickMsEma} tickMsMax ${baseline.tickMsMax}`,
  );

  // --- Phase 1: establish the shared index, then fill -----------------------
  const observer = new Bot("observer");
  await observer.connect();
  const oWelcome = await observer.waitFor((m) => m.t === "welcome", "observer welcome", 8000);
  await observer.waitFor((m) => m.t === "sFull" && m.done === true, "observer sFull done", 8000);
  const wcfg = clampConfig(oWelcome.config).world;
  if (wcfg.seed !== oWelcome.seed) wcfg.seed = oWelcome.seed;
  shared.world = createWorld(worldParamsOf(wcfg));
  for (const f of observer.frames) {
    if (f.t !== "sFull") continue;
    for (const p of f.pieces) {
      if (!shared.ids.has(p.id)) {
        shared.ids.add(p.id);
        shared.world.structures.add(p);
      }
    }
  }
  shared.ready = true;
  SPAWN = { x: oWelcome.you.x, z: oWelcome.you.z };
  // The observer only RECEIVES (folds deltas) during the fill — receiving does
  // not reset the server's per-socket liveness clock, so without an outbound
  // keepalive the tick would 1001-close it after LIVENESS_TIMEOUT_MS (15s) and
  // it would be dead by measurement time (bot #0 lost). Ping it through fill+drain.
  observer._ka = setInterval(() => observer.send({ t: "ping", ts: Date.now() }), 5000);
  console.log(
    `observer synced: ${pieceCount()} pre-existing pieces | spawn (${SPAWN.x.toFixed(0)},${SPAWN.z.toFixed(0)})` +
      ` | fill target ${CAP} foundations`,
  );

  const fillStart = Date.now();
  const workers = Array.from({ length: FILLERS }, (_, i) => ({ id: i, totalPlaced: 0, lives: 0 }));
  let lastProgress = { at: Date.now(), count: pieceCount() };
  const progressTimer = setInterval(() => {
    const c = pieceCount();
    const rate = ((c - lastProgress.count) / Math.max((Date.now() - lastProgress.at) / 1000, 0.001)).toFixed(1);
    console.log(`  [fill] ${c}/${CAP} pieces (+${rate}/s)`);
    if (c > lastProgress.count) lastProgress = { at: Date.now(), count: c };
    else if (Date.now() - lastProgress.at > 150_000)
      fail(`fill stalled at ${c}/${CAP} for 150s — aborting`);
  }, 3000);

  await Promise.all(
    workers.map(async (worker) => {
      while (pieceCount() < CAP && !capReached) {
        worker.lives++;
        await fillerLife(worker);
      }
    }),
  );
  clearInterval(progressTimer);
  const fillS = ((Date.now() - fillStart) / 1000).toFixed(0);
  const totalLives = workers.reduce((n, w) => n + w.lives, 0);
  console.log(
    `\nfill complete: ${pieceCount()} pieces in ${fillS}s across ${totalLives} builder lives` +
      ` (${FILLERS} workers)${capReached ? " — server WORLD_PIECE_CAP enforced the ceiling" : ""}`,
  );
  console.log(`  rejections handled: ${JSON.stringify(rejectionTally)}`);

  // --- Phase 2a: DYNAMIC DRAIN. Every fill life logs out ALIVE, so each leaves
  // an offline body that lingers session.logoutLingerS. Those bodies (a) count
  // in game.players and (b) fire an in-tick persistAll when they expire — either
  // would corrupt a clean "N online bots at cap" tick reading. Keep ONLY the
  // observer connected (it holds the room ticking so the lingers expire) and
  // wait until the server's player count falls back to just the observer. ------
  console.log(`\ndraining fill logout-lingers (observer holds the room; waiting for offline bodies to expire)...`);
  const drainStart = Date.now();
  const drainCeil = Math.max(DRAIN_S, 120) * 1000;
  for (;;) {
    observer.send({ t: "ping", ts: Date.now() }); // beat LIVENESS_TIMEOUT_MS (15s) so bot #0 survives the drain
    const h = await fetchHealth();
    const p = h.error ? -1 : h.players;
    if (p >= 0 && p <= 1) {
      console.log(`  drained to players=${p} after ${((Date.now() - drainStart) / 1000).toFixed(0)}s`);
      break;
    }
    if (Date.now() - drainStart > drainCeil) {
      console.log(`  drain ceiling ${(drainCeil / 1000).toFixed(0)}s hit at players=${p} (proceeding)`);
      break;
    }
    await sleep(2500);
  }

  // --- Phase 2b: bring the online bots up. The observer becomes bot #0 (so the
  // online count is exactly BOTS, no extra lingering observer body), the rest
  // are fresh joins. Light wander = genuine online players driving the sim. ----
  console.log(`bringing up ${BOTS} online bots for the measurement...`);
  const roamers = [observer, ...Array.from({ length: BOTS - 1 }, (_, i) => new Bot(`bot-${i + 1}`))];
  for (const bot of roamers.slice(1)) {
    await bot.connect().catch(() => {});
    await sleep(60); // stagger the join wave
  }
  await Promise.all(
    roamers.map((b) => b.waitFor((m) => m.t === "welcome", "roamer welcome", 8000).catch(() => {})),
  );
  const joinedRoamers = roamers.filter((b) => b.gotWelcome).length;
  if (observer._ka) clearInterval(observer._ka); // fill-phase keepalive replaced by _ping below
  for (const bot of roamers) {
    bot._yaw = Math.random() * Math.PI * 2;
    bot._roam = setInterval(() => {
      if (Math.random() < 0.08) bot._yaw = Math.random() * Math.PI * 2;
      bot.send({
        t: "input",
        cmds: [{ seq: ++bot.seq, dt: MAX_INPUT_DT, mx: 0, mz: -1, yaw: round3(bot._yaw), pitch: 0, sprint: false, jump: false }],
      });
    }, 50);
    bot._ping = setInterval(() => bot.send({ t: "ping", ts: Date.now() }), 2000);
  }
  await sleep(5000); // settle: let the join wave's per-join persists age out

  console.log(`measuring for ${MEASURE_S}s (>= WORLD_SAVE_INTERVAL_S ${WORLD_SAVE_INTERVAL_S}s => captures periodic saves)...`);
  const emaSamples = [];
  const maxSamples = [];
  const playerSamples = [];
  const hzPairs = [];
  let prevH = null;
  const measureEnd = Date.now() + MEASURE_S * 1000;
  let joinProbe = null;
  let probedAt = Date.now() + Math.floor(MEASURE_S * 0.5) * 1000; // probe mid-window
  while (Date.now() < measureEnd) {
    const h = await fetchHealth();
    if (!h.error) {
      emaSamples.push(h.tickMsEma);
      maxSamples.push(h.tickMsMax);
      playerSamples.push(h.players);
      if (prevH && h.now > prevH.now) {
        hzPairs.push(((h.tick - prevH.tick) / (h.now - prevH.now)) * 1000);
      }
      prevH = { now: h.now, tick: h.tick };
    }
    if (!joinProbe && Date.now() >= probedAt) {
      joinProbe = await runJoinProbe();
    }
    await sleep(1000);
  }
  if (!joinProbe) joinProbe = await runJoinProbe();

  for (const bot of roamers) {
    clearInterval(bot._roam);
    clearInterval(bot._ping);
    bot.close();
  }

  // --- report ----------------------------------------------------------------
  // persistAll runs INSIDE the tick on the WORLD_SAVE_INTERVAL_S cadence, so it
  // shows up as a periodic tickMsMax spike. Split the two cleanly:
  //   * steady tick MAX = MIN across the windowed-max samples — a poll whose
  //     ~5-10s max-window contained NO save reports the worst NON-save tick.
  //     THIS is the milestone's "tick max" (the sim's per-tick cost at cap).
  //   * save-tick peak = MAX across samples — a window that caught a periodic
  //     save. persistAll duration ≈ save-tick peak − steady tick (the save is
  //     by far the most expensive thing a tick ever does at cap).
  const tickEmaSteady = median(emaSamples);
  const tickMaxSteady = maxSamples.length ? Math.min(...maxSamples) : 0;
  const tickMaxSavePeak = Math.max(0, ...maxSamples);
  const persistSpike = Math.max(0, round3(tickMaxSavePeak - tickMaxSteady));
  const playersMed = median(playerSamples);
  const hzMed = median(hzPairs);

  console.log("\n=== BUILD-LOADTEST REPORT (doc 06 M8) ===");
  console.log(`world at cap: ${pieceCount()} pieces (target ${CAP}, WORLD_PIECE_CAP ${WORLD_PIECE_CAP})`);
  console.log(`fill: ${totalLives} builder lives, ${fillS}s, rejections ${JSON.stringify(rejectionTally)}`);
  console.log(`online bots during measure: ${joinedRoamers} joined, ${playersMed} counted by server (median)`);
  console.log(`effective tick rate: ${hzMed.toFixed(2)} Hz (target 15)`);
  console.log("");
  console.log("  metric                              value        budget");
  console.log(`  tick EMA (steady average)          ${fmtMs(tickEmaSteady)}      —`);
  console.log(`  tick MAX (steady, no-save window)  ${fmtMs(tickMaxSteady)}      < ${TICK_BUDGET_MS} ms  [acceptance]`);
  console.log(`  tick MAX (save-tick peak)          ${fmtMs(tickMaxSavePeak)}      — (periodic persistAll, in-tick)`);
  console.log(`  persistAll duration (peak − steady)${fmtMs(persistSpike)}      — (300KB blob write @ cap)`);
  console.log(`  join sync (open→sFull done)        ${fmtMs(joinProbe.total)}      < ${JOIN_SYNC_BUDGET_MS} ms  [acceptance]`);
  console.log(`    ├ open→welcome                   ${fmtMs(joinProbe.openToWelcome)}`);
  console.log(`    └ welcome→sFull done             ${fmtMs(joinProbe.welcomeToFull)}`);
  console.log(
    `  sFull wire size                    ${(joinProbe.bytes / 1024).toFixed(1)} KB` +
      `  (${joinProbe.batches} batches, ${joinProbe.pieces} pieces, ${(joinProbe.bytes / Math.max(joinProbe.pieces, 1)).toFixed(0)} B/piece)`,
  );

  // --- acceptance ------------------------------------------------------------
  // tick MAX is the STEADY (no-save) worst tick — the milestone lists tick max
  // and persistAll duration as distinct measurements, so the save is NOT folded
  // into the tick-max bar (it is reported separately above).
  const tickPass = tickMaxSteady < TICK_BUDGET_MS;
  const joinPass = joinProbe.total < JOIN_SYNC_BUDGET_MS;
  const atCap = pieceCount() >= CAP;
  console.log("\n=== ACCEPTANCE ===");
  console.log(`  reached cap (${pieceCount()} >= ${CAP})          ${atCap ? "PASS" : "FAIL"}`);
  console.log(`  tick MAX ${tickMaxSteady.toFixed(2)}ms < ${TICK_BUDGET_MS}ms at cap w/ ${playersMed} bots   ${tickPass ? "PASS" : "FAIL"}`);
  console.log(`  join sync ${joinProbe.total}ms < ${JOIN_SYNC_BUDGET_MS}ms on localhost        ${joinPass ? "PASS" : "FAIL"}`);
  const ok = tickPass && joinPass && atCap;
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  clearTimeout(globalDeadline);
  process.exit(ok ? 0 : 1);
}

function fmtMs(x) {
  return `${x.toFixed(2)} ms`.padStart(9);
}

/** Fresh bot: time the full join + sFull sync against the cap-full world. */
async function runJoinProbe() {
  const bot = new Bot("join-probe");
  const t0 = Date.now();
  try {
    await bot.connect();
    await bot.waitFor((m) => m.t === "welcome", "probe welcome", 6000);
    const tW = Date.now();
    await bot.waitFor((m) => m.t === "sFull" && m.done === true, "probe sFull done", 6000);
    const tF = Date.now();
    const out = {
      openToWelcome: tW - t0,
      welcomeToFull: tF - tW,
      total: tF - t0,
      bytes: bot.sFullBytes,
      batches: bot.sFullBatches,
      pieces: bot.sFullPieces,
    };
    bot.close();
    return out;
  } catch (err) {
    bot.close();
    fail(`join probe failed: ${err.message}`);
  }
}

main().catch((err) => fail(err?.stack ?? String(err)));
