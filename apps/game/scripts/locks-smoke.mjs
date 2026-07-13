#!/usr/bin/env node
// Locks/crates/raiding smoke probe (doc 06 M5-M7) — drives a real GameRoom
// over WS with TWO identities and proves the whole locks slice end to end:
//   1. the two-sided protocol gate: an old proto is refused before welcome,
//      proto 10 joins normally;
//   2. owner places foundation + doorway + door (+ wall) through the real
//      place pipeline (shared canPlace picks the cell, exactly like the ghost);
//   3. setCode locks the door (sState.locked broadcast);
//   4. FIVE wrong tryCodes from a SECOND identity trip the PER-DOOR lockout,
//      and the second identity's CORRECT code during the lockout is refused
//      (the jam is global, not per-guess);
//   5. the owner still opens the door during the active lockout (owner never
//      burns or suffers the budget — the doc 06 M5 keying rule);
//   6. a crate placed + cOpen/cMove moves a stack in and back LOSS-FREE;
//   7. a melee axe hit on a wall broadcasts an sState.hp decrement (M7);
//   8. every sFull/sAdd/sState/cont frame is key-scanned: no code /
//      authorized / contents / ownerHash / placedAtMs ever leaks to the wire.
//
//   node --experimental-strip-types apps/game/scripts/locks-smoke.mjs [ws-url]
//   default url: ws://localhost:5173/ws  (dev server; .dev.vars has TESTBED=1)
//
// Requires a TESTBED server (hammer/axe/wood come from the "building"
// scenario). Not part of `pnpm test` — like channel-smoke/trees-probe it
// needs a live server; CI covers this layer via scripts/structures.mjs.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { decodeSnap } from "@worldspring/shared/snapCodec";
import {
  BUILD_CELL,
  BUILD_RANGE,
  DOOR_CODE_FAILS_PER_LOCKOUT,
  DOOR_CODE_TRY_COOLDOWN_S,
  PICKUP_RANGE,
} from "@worldspring/shared/constants";

// world.ts / structures.ts use extensionless relative imports, which
// strip-types cannot resolve — bundle them with esbuild exactly like
// trees-probe.mjs does (esbuild resolved from the shared package's devDeps).
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
    sourcefile: "locks-smoke-entry.ts",
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

const WS_URL = process.argv[2] ?? "ws://localhost:5173/ws";
if (typeof WebSocket === "undefined") {
  console.error("locks-smoke: global WebSocket missing — Node 22+ required");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`\nLOCKS-SMOKE: FAIL — ${msg}`);
  process.exit(1);
};
const results = [];
const pass = (msg) => {
  results.push(msg);
  console.log(`  PASS  ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global deadline: two joins + short walks + 5 spaced tries + melee swings.
const DEADLINE_MS = 120_000;
setTimeout(() => fail(`timed out after ${DEADLINE_MS / 1000}s`), DEADLINE_MS).unref?.();

// --- wire-secrecy scan (gate: sFull/sAdd/sState/cont carry no server meta) --
const FORBIDDEN_KEYS = ["code", "authorized", "contents", "ownerHash", "placedAtMs"];
let scannedFrames = 0;
function scanKeys(node, frameT) {
  if (Array.isArray(node)) {
    for (const v of node) scanKeys(v, frameT);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      fail(`server secret key "${key}" leaked in a ${frameT} frame: ${JSON.stringify(node)}`);
    }
    scanKeys(node[key], frameT);
  }
}

// --- tiny bot wrapper --------------------------------------------------------
class Bot {
  constructor(name) {
    this.name = name;
    this.token = randomBytes(16).toString("hex");
    this.frames = []; // parsed server frames, in order
    this.you = { x: 0, y: 0, z: 0 };
    this.seq = 0;
    this.waiters = [];
    this.closed = false;
  }
  connect(url, joinOverrides = {}) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer"; // snapshots ship as binary (snapCodec)
      this.ws.addEventListener("error", () =>
        reject(new Error(`cannot connect to ${url} — is the dev server running?`)),
      );
      this.ws.addEventListener("close", () => {
        this.closed = true;
      });
      this.ws.addEventListener("open", () => {
        this.send({
          t: "join",
          name: this.name,
          token: this.token,
          proto: PROTOCOL_VERSION,
          scenario: "building",
          ...joinOverrides,
        });
        resolve();
      });
      this.ws.addEventListener("message", (ev) => {
        let m;
        if (ev.data instanceof ArrayBuffer) {
          try {
            m = decodeSnap(ev.data);
          } catch {
            return;
          }
        } else if (typeof ev.data === "string") {
          try {
            m = JSON.parse(ev.data);
          } catch {
            return;
          }
        } else {
          return;
        }
        if (m.t === "sFull" || m.t === "sAdd" || m.t === "sState" || m.t === "cont") {
          scannedFrames++;
          scanKeys(m, m.t);
        }
        if (m.t === "snap" || m.t === "welcome") {
          this.you = { x: m.you.x, y: m.you.y, z: m.you.z };
        }
        this.frames.push(m);
        for (const w of [...this.waiters]) {
          if (w.pred(m)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(m);
          }
        }
      });
    });
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  /** Resolve with the FIRST frame (past or future) matching pred. */
  waitFor(pred, what, timeoutMs = 8000) {
    const past = this.frames.find(pred);
    if (past) return Promise.resolve(past);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: timed out waiting for ${what}`)),
        timeoutMs,
      );
      this.waiters.push({ pred, resolve, timer });
    });
  }
  /**
   * Walk toward (x, z) one input per snap (server-stepped) until within tol.
   * Straight-line walking can snag on statics (old probe runs leave pieces
   * behind) — a stall inside `maxTol` is accepted, a stall outside it fails.
   */
  async walkTo(x, z, tol, maxTol = tol, timeoutMs = 30_000) {
    const t0 = Date.now();
    let bestD = Infinity;
    let lastProgressAt = Date.now();
    for (;;) {
      const d = Math.hypot(this.you.x - x, this.you.z - z);
      if (d <= tol) return;
      if (d < bestD - 0.05) {
        bestD = d;
        lastProgressAt = Date.now();
      }
      const stalled = Date.now() - lastProgressAt > 4000;
      if (stalled && d <= maxTol) return;
      if ((stalled || Date.now() - t0 > timeoutMs) && d > maxTol) {
        fail(`${this.name}: walk to (${x.toFixed(1)}, ${z.toFixed(1)}) stalled at ${d.toFixed(2)}m`);
      }
      const mark = this.frames.length;
      const yaw = Math.atan2(-(x - this.you.x), -(z - this.you.z));
      this.send({
        t: "input",
        cmds: [{ seq: ++this.seq, dt: 1 / 15, mx: 0, mz: -1, yaw, pitch: 0, sprint: false, jump: false }],
      });
      await this.waitFor((m) => m.t === "snap" && this.frames.length > mark, "snap", 5000);
    }
  }
  /** Face (x, z) without moving (zero-move cmd sets yaw server-side). */
  face(x, z) {
    const yaw = Math.atan2(-(x - this.you.x), -(z - this.you.z));
    this.send({
      t: "input",
      cmds: [{ seq: ++this.seq, dt: 1 / 15, mx: 0, mz: 0, yaw, pitch: 0, sprint: false, jump: false }],
    });
  }
  noticeCount(text) {
    return this.frames.filter((m) => m.t === "notice" && m.msg.includes(text)).length;
  }
}

// ---------------------------------------------------------------------------
// 0. Protocol gate: an old proto must be refused BEFORE welcome.
async function probeProtoGate() {
  const stale = new Bot("staleproto");
  await stale.connect(WS_URL, { proto: PROTOCOL_VERSION - 1 });
  const err = await stale.waitFor((m) => m.t === "error", "proto-gate error");
  if (!/incompatible/i.test(err.msg)) fail(`proto gate error text unexpected: "${err.msg}"`);
  if (stale.frames.some((m) => m.t === "welcome")) fail("old-proto join received a welcome");
  // The server also closes the socket (1008).
  for (let i = 0; i < 20 && !stale.closed; i++) await sleep(100);
  if (!stale.closed) fail("old-proto socket left open after refusal");
  pass(`old proto ${PROTOCOL_VERSION - 1} refused with error + close; no welcome`);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`locks-smoke: ${WS_URL} | proto ${PROTOCOL_VERSION}\n`);
  await probeProtoGate();

  // 1. Owner joins at proto 10 with the "building" testbed kit.
  const owner = new Bot("lockowner");
  await owner.connect(WS_URL);
  const welcome = await owner.waitFor((m) => m.t === "welcome", "welcome");
  pass(`owner joined at proto ${PROTOCOL_VERSION} (welcome received)`);

  const hammerSlot = welcome.inv.findIndex((s) => s && s.type === "hammer");
  const axeSlot = welcome.inv.findIndex((s) => s && s.type === "axe");
  if (hammerSlot === -1 || axeSlot === -1) {
    fail("no hammer/axe in spawn inventory — server must run TESTBED=1 (scenario 'building')");
  }

  // Mirror the client: clamp welcome.config, coerce the legacy seed, build the
  // shared world, then fold the sFull batches into its structure index — the
  // probe's canPlace then sees exactly what the server sees.
  const worldCfg = clampConfig(welcome.config).world;
  if (worldCfg.seed !== welcome.seed) worldCfg.seed = welcome.seed;
  const world = createWorld(worldParamsOf(worldCfg));
  await owner.waitFor((m) => m.t === "sFull" && m.done === true, "sFull done batch");
  let preexisting = 0;
  for (const m of owner.frames) {
    if (m.t !== "sFull") continue;
    for (const p of m.pieces) {
      world.structures.add(p);
      preexisting++;
    }
  }
  pass(`sFull synced (${preexisting} pre-existing pieces) — all frames key-scanned clean`);
  // Keep the local index live: every sAdd/sRemove/sState(open) mirrors in.
  const KNOWN = new Set();
  const foldDeltas = (bot) => {
    const applied = new Set();
    const apply = (m, i) => {
      if (applied.has(i)) return;
      applied.add(i);
      if (m.t === "sAdd" && !KNOWN.has(m.piece.id)) {
        KNOWN.add(m.piece.id);
        world.structures.add(m.piece);
      }
      if (m.t === "sRemove" && KNOWN.has(m.id)) {
        KNOWN.delete(m.id);
        world.structures.remove(m.id);
      }
    };
    bot.frames.forEach(apply);
    return () => bot.frames.forEach(apply);
  };
  const refold = foldDeltas(owner);

  // 2. Find a valid foundation cell near spawn — shared canPlace IS the ghost.
  // Occupants = EVERY player body in the latest snap (the server's anti-trap
  // check counts lingering offline bodies from earlier probe runs too), plus
  // ourselves.
  const occupants = (bot) => {
    const snap = [...bot.frames].reverse().find((m) => m.t === "snap");
    const others = (snap?.players ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    return [{ ...bot.you }, ...others];
  };
  await owner.waitFor((m) => m.t === "snap", "first snap");
  const spawnGx = Math.floor(owner.you.x / BUILD_CELL);
  const spawnGz = Math.floor(owner.you.z / BUILD_CELL);
  const cellCandidates = [];
  for (let r = 0; r <= 8; r++) {
    for (let dgx = -r; dgx <= r; dgx++) {
      for (let dgz = -r; dgz <= r; dgz++) {
        if (Math.max(Math.abs(dgx), Math.abs(dgz)) !== r) continue;
        const t = { kind: "foundation", tier: 0, gx: spawnGx + dgx, gz: spawnGz + dgz };
        if (canPlace(world, t, occupants(owner)) === null) cellCandidates.push(t);
      }
    }
  }
  if (cellCandidates.length === 0) fail("no placeable foundation cell within 8 cells of spawn");

  // 3. Place foundation + doorway + door (+ wall for the raid check).
  owner.send({ t: "equip", slot: hammerSlot });
  const woodBefore = welcome.inv.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);

  /** Send a place and wait for its sAdd — or the server's rejection notice.
   * Returns { piece } on success, { rejected } on a notice. */
  const placeTry = async (bot, target, what) => {
    const before = bot.frames.length;
    bot.send({ t: "place", ...target });
    let m;
    try {
      m = await bot.waitFor(
        (f) =>
          (f.t === "sAdd" &&
            f.piece.kind === target.kind &&
            f.piece.gx === target.gx &&
            f.piece.gz === target.gz &&
            (target.edge === undefined || f.piece.edge === target.edge)) ||
          (f.t === "notice" && bot.frames.indexOf(f) >= before),
        `sAdd for ${what}`,
      );
    } catch (e) {
      const recent = bot.frames.slice(before).map((f) => f.t);
      fail(`${e.message} (frames since send: ${JSON.stringify(recent)})`);
    }
    refold();
    if (m.t === "notice") return { rejected: m.msg };
    return { piece: m.piece };
  };
  const placeAndWait = async (bot, target, what) => {
    const r = await placeTry(bot, target, what);
    if (r.rejected) fail(`server rejected ${what}: "${r.rejected}"`);
    return r.piece;
  };

  // "someone is in the way" is retryable: offline lingering bodies (earlier
  // probe runs, combat-log deterrent) are counted by the server's anti-trap
  // check but are NOT in snap.players, so the probe's ghost can read green
  // where the server rejects. A real player just aims at the next spot —
  // so does the probe. Any OTHER rejection is a ghost-parity failure.
  const IN_THE_WAY = "someone is in the way";
  let cell = null;
  let foundation = null;
  for (const candidate of cellCandidates.slice(0, 6)) {
    const [cx, cz] = pieceCenter(candidate);
    // Any stall inside 3m keeps all four cell edges within BUILD_RANGE (6).
    await owner.walkTo(cx, cz, 1.0, 3.0);
    refold();
    if (canPlace(world, candidate, occupants(owner)) !== null) continue; // deltas landed meanwhile
    const r = await placeTry(owner, candidate, "foundation");
    if (r.rejected) {
      if (r.rejected.includes(IN_THE_WAY)) continue;
      fail(`server rejected foundation: "${r.rejected}"`);
    }
    cell = candidate;
    foundation = r.piece;
    break;
  }
  if (!foundation) fail("every candidate foundation cell was occupied by a lingering body");
  pass(`foundation placed (id ${foundation.id}) at cell (${cell.gx}, ${cell.gz})`);
  const [cellX, cellZ] = pieceCenter(cell);

  // Pick edges the shared validator accepts (doorway, then a wall elsewhere).
  const edgeCandidates = [
    { gx: cell.gx, gz: cell.gz, edge: 0 },
    { gx: cell.gx, gz: cell.gz - 1, edge: 0 },
    { gx: cell.gx, gz: cell.gz, edge: 2 },
    { gx: cell.gx - 1, gz: cell.gz, edge: 2 },
  ];
  const me = () => occupants(owner);
  let doorwayAt = null;
  let doorway = null;
  for (const e of edgeCandidates) {
    if (canPlace(world, { kind: "doorway", tier: 0, ...e }, me()) !== null) continue;
    const r = await placeTry(owner, { kind: "doorway", tier: 0, ...e }, "doorway");
    if (r.rejected) {
      if (r.rejected.includes(IN_THE_WAY)) continue;
      fail(`server rejected doorway: "${r.rejected}"`);
    }
    doorwayAt = e;
    doorway = r.piece;
    break;
  }
  if (!doorway) fail("no valid doorway edge on the fresh foundation");
  const door = await placeAndWait(owner, { kind: "door", tier: 0, ...doorwayAt }, "door");
  if (door.open !== false || door.locked !== false) {
    fail(`fresh door wire state wrong: open=${door.open} locked=${door.locked}`);
  }
  pass(`doorway ${doorway.id} + door ${door.id} placed (door open:false locked:false)`);

  let wall = null;
  for (const e of edgeCandidates) {
    if (e.gx === doorwayAt.gx && e.gz === doorwayAt.gz && e.edge === doorwayAt.edge) continue;
    if (canPlace(world, { kind: "wall", tier: 0, ...e }, me()) !== null) continue;
    const r = await placeTry(owner, { kind: "wall", tier: 0, ...e }, "wall");
    if (r.rejected) {
      if (r.rejected.includes(IN_THE_WAY)) continue;
      fail(`server rejected wall: "${r.rejected}"`);
    }
    wall = r.piece;
    break;
  }
  if (!wall) fail("no valid wall edge on the fresh foundation");
  pass(`wall placed (id ${wall.id}, hp ${wall.hp})`);

  const invNow = await owner.waitFor((m) => m.t === "inv", "inv after placements");
  const woodNow = invNow.slots.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);
  const spent =
    PIECE_DEFS.foundation.cost + PIECE_DEFS.doorway.cost + PIECE_DEFS.door.cost + PIECE_DEFS.wall.cost;
  if (woodBefore - woodNow !== spent) {
    // inv frames race the last placement — re-check the latest one.
    const last = [...owner.frames].reverse().find((m) => m.t === "inv");
    const woodLast = last.slots.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);
    if (woodBefore - woodLast !== spent) {
      fail(`wood deduction wrong: ${woodBefore} -> ${woodLast}, expected -${spent}`);
    }
  }
  pass(`resources deducted server-side (-${spent} wood)`);

  // 4. setCode locks the door.
  owner.send({ t: "setCode", id: door.id, code: "4242" });
  await owner.waitFor(
    (m) => m.t === "sState" && m.id === door.id && m.locked === true,
    "sState locked:true",
  );
  pass("setCode 4242 → sState.locked broadcast (door is locked)");

  // 5. Second identity: fresh token, walks up, burns the per-door budget.
  const raider = new Bot("coderaider");
  await raider.connect(WS_URL);
  await raider.waitFor((m) => m.t === "welcome", "raider welcome");
  await raider.waitFor((m) => m.t === "sFull" && m.done === true, "raider sFull");
  const rDoor = raider.frames
    .filter((m) => m.t === "sFull")
    .flatMap((m) => m.pieces)
    .find((p) => p.id === door.id);
  if (!rDoor || rDoor.locked !== true) {
    fail(`raider's sFull view of the door is wrong: ${JSON.stringify(rDoor)}`);
  }
  pass("second identity sees the door locked in its own sFull (and no secrets)");

  const [doorX, doorZ] = pieceCenter(door);
  await raider.walkTo(doorX, doorZ, Math.min(BUILD_RANGE - 2, 4), BUILD_RANGE - 0.5);

  // A locked door refuses the plain toggle for the unauthorized.
  raider.send({ t: "door", id: door.id });
  await raider.waitFor(
    (m) => m.t === "notice" && m.msg.includes("lock holds"),
    "locked-door toggle refusal",
  );
  pass("unauthorized door toggle refused (the lock holds)");

  // Five wrong codes from the SECOND identity — spaced past the per-identity
  // anti-mash cooldown so every try reaches the shared per-door budget.
  const gapMs = DOOR_CODE_TRY_COOLDOWN_S * 1000 + 400;
  for (let i = 0; i < DOOR_CODE_FAILS_PER_LOCKOUT; i++) {
    await sleep(gapMs);
    const before = raider.frames.length;
    raider.send({ t: "tryCode", id: door.id, code: String(1111 * (i + 1) === 4242 ? 1234 : 1111 * (i + 1)).padStart(4, "0") });
    await raider.waitFor(
      (m) =>
        m.t === "notice" &&
        (m.msg.includes("Wrong code") || m.msg.includes("jams shut")) &&
        raider.frames.indexOf(m) >= before,
      `tryCode reply #${i + 1}`,
    );
  }
  if (raider.noticeCount("Wrong code") !== DOOR_CODE_FAILS_PER_LOCKOUT - 1) {
    fail(
      `expected ${DOOR_CODE_FAILS_PER_LOCKOUT - 1}× "Wrong code", saw ${raider.noticeCount("Wrong code")}`,
    );
  }
  if (raider.noticeCount("jams shut") !== 1) fail("5th combined failure did not trip the lockout");
  pass(`${DOOR_CODE_FAILS_PER_LOCKOUT} wrong tries → per-door lockout (the lock jams shut)`);

  // 6. The CORRECT code during the lockout is refused — the jam is global.
  await sleep(gapMs);
  raider.send({ t: "tryCode", id: door.id, code: "4242" });
  await raider.waitFor(
    (m) => m.t === "notice" && m.msg.includes("jammed"),
    "correct-code-during-lockout refusal",
  );
  if (raider.frames.some((m) => m.t === "sState" && m.id === door.id && m.open === true)) {
    fail("door opened for the raider during the lockout");
  }
  pass("correct code DURING lockout refused (door stayed shut)");

  // 7. The owner opens the door normally during the active lockout.
  owner.send({ t: "door", id: door.id });
  await owner.waitFor(
    (m) => m.t === "sState" && m.id === door.id && m.open === true,
    "owner open during lockout",
  );
  pass("owner opened the door during the active lockout (budget never touches them)");

  // 8. Melee raid check: axe swing on the wall broadcasts an sState.hp drop.
  owner.send({ t: "equip", slot: axeSlot });
  const [wallX, wallZ] = pieceCenter(wall);
  await owner.walkTo(wallX, wallZ, 1.6, 2.25); // MELEE_RANGE is 2.3

  let hpState = null;
  for (let swing = 0; swing < 8 && !hpState; swing++) {
    owner.face(wallX, wallZ);
    await sleep(150);
    owner.send({ t: "attack" });
    try {
      hpState = await owner.waitFor(
        (m) => m.t === "sState" && m.id === wall.id && typeof m.hp === "number",
        "wall sState.hp",
        1000,
      );
    } catch {
      /* swing missed or on cooldown — reface and retry */
    }
  }
  if (!hpState) fail("no sState.hp broadcast after 8 axe swings at the wall");
  if (!(hpState.hp < wall.hp)) fail(`wall hp did not decrease: ${wall.hp} -> ${hpState.hp}`);
  pass(`axe hit the wall: hp ${wall.hp} -> ${hpState.hp} broadcast via sState`);

  // 9. Crate + loss-free cMove round-trip. Driven by the SECOND identity:
  // crates are open-access by design (walls are the security), and the owner
  // spent its whole (slot-truncated) wood kit on the base — the raider's 24
  // wood is untouched. Placed at the raider's own feet on terrain (crates
  // are non-colliding, so standing in the spot is legal), distance ≈ 0.
  const rWelcome = raider.frames.find((m) => m.t === "welcome");
  const rHammer = rWelcome.inv.findIndex((s) => s && s.type === "hammer");
  if (rHammer === -1) fail("no hammer in the raider kit");
  raider.send({ t: "equip", slot: rHammer });
  const crX = Math.round(raider.you.x * 100) / 100;
  const crZ = Math.round(raider.you.z * 100) / 100;
  const crateTarget = {
    kind: "crate",
    tier: 0,
    gx: Math.floor(crX / BUILD_CELL),
    gz: Math.floor(crZ / BUILD_CELL),
    x: crX,
    z: crZ,
  };
  refold();
  const crateRej = canPlace(world, crateTarget, occupants(raider));
  if (crateRej !== null) fail(`shared canPlace rejects the crate target: ${crateRej}`);
  const crate = await placeAndWait(raider, crateTarget, "crate");
  const crateDist = Math.hypot(raider.you.x - crate.x, raider.you.z - crate.z);
  if (crateDist > PICKUP_RANGE) fail(`crate landed out of pickup range (${crateDist.toFixed(2)}m)`);
  pass(`crate placed (id ${crate.id}) by the second identity — crates are open-access`);

  raider.send({ t: "cOpen", id: crate.id });
  const cont0 = await raider.waitFor((m) => m.t === "cont" && m.id === crate.id, "cont on cOpen");
  if (!Array.isArray(cont0.slots) || cont0.slots.some((s) => s !== null)) {
    fail(`fresh crate not empty: ${JSON.stringify(cont0.slots)}`);
  }
  pass(`cOpen → cont with ${cont0.slots.length} empty slots`);

  const lastInv = [...raider.frames].reverse().find((m) => m.t === "inv") ?? { slots: rWelcome.inv };
  const stackSlot = lastInv.slots.findIndex((s) => s && s.type === "wood");
  if (stackSlot === -1) fail("no wood stack left to round-trip through the crate");
  const stack = { ...lastInv.slots[stackSlot] };

  const mark1 = raider.frames.length;
  raider.send({ t: "cMove", id: crate.id, from: stackSlot, to: 3, dir: "in" });
  const contIn = await raider.waitFor(
    (m) => m.t === "cont" && m.id === crate.id && raider.frames.indexOf(m) >= mark1,
    "cont after cMove in",
  );
  const invIn = await raider.waitFor(
    (m) => m.t === "inv" && raider.frames.indexOf(m) >= mark1,
    "inv after cMove in",
  );
  if (!contIn.slots[3] || contIn.slots[3].type !== stack.type || contIn.slots[3].count !== stack.count) {
    fail(`cMove in lost the stack: ${JSON.stringify(contIn.slots[3])} vs ${JSON.stringify(stack)}`);
  }
  if (invIn.slots[stackSlot] !== null) fail("cMove in did not null the inventory source slot");

  const mark2 = raider.frames.length;
  raider.send({ t: "cMove", id: crate.id, from: 3, to: stackSlot, dir: "out" });
  const contOut = await raider.waitFor(
    (m) => m.t === "cont" && m.id === crate.id && raider.frames.indexOf(m) >= mark2,
    "cont after cMove out",
  );
  const invOut = await raider.waitFor(
    (m) => m.t === "inv" && raider.frames.indexOf(m) >= mark2,
    "inv after cMove out",
  );
  if (contOut.slots[3] !== null) fail("cMove out did not null the crate slot");
  const back = invOut.slots[stackSlot];
  if (!back || back.type !== stack.type || back.count !== stack.count) {
    fail(`round-trip lost the stack: ${JSON.stringify(back)} vs ${JSON.stringify(stack)}`);
  }
  pass(`cMove round-trip loss-free (${stack.count}× ${stack.type} in → slot 3 → back out)`);

  pass(`wire secrecy held across ${scannedFrames} scanned sFull/sAdd/sState/cont frames`);

  console.log(`\nLOCKS-SMOKE: PASS (${results.length} checks)`);
  try {
    owner.ws.close();
    raider.ws.close();
  } catch {
    /* done */
  }
  process.exit(0);
}

main().catch((e) => fail(e?.message ?? String(e)));
