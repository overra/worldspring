#!/usr/bin/env node
// Worldspring load-test harness — drives N protocol-faithful bots against the
// GameRoom WebSocket and reports the metrics that actually validate the two
// scaling caveats (see docs/plans — scaling roadmap).
//
//   node scripts/loadtest.mjs ws://localhost:5173/ws 20 120
//                             <url>                  <bots> <seconds>
//   node scripts/loadtest.mjs <url> --ramp=8,16,24,32,40,48,56,64 --step-seconds=45
//   node scripts/loadtest.mjs <url> 24 120 --input-ms=25   # caveat-2 msg/s sweep
//
// Flags (all optional; positional <bots>/<seconds> still work when --ramp absent):
//   --ramp=a,b,c        cumulative bot counts per step (overrides positional bots)
//   --step-seconds=N    hold each ramp step this long (default 45)
//   --health-interval=N poll /api/health every N ms for the timer-INDEPENDENT
//                       metric (default 3000; 0 disables)
//   --input-ms=N        per-bot input cadence (default 50 = 20 msg/s); lower to
//                       push inbound msg/s WITHOUT adding CPU-heavy players
//   --ping-ms=N         per-bot ping cadence (default 2000)
//   --spread            disperse the fleet on fixed radial bearings instead of
//                       random-walk (varies interest-set geometry / the CPU knee)
//
// WHY THESE METRICS (the corrected methodology):
//  * The tick is a plain setInterval with NO catch-up (GameRoom.ts) — Δtick/Δwall
//    stays pinned at ~15Hz then COLLAPSES; it is a cliff, not a gradient. The real
//    gradient/early-warning is tickMsMax climbing toward the 66.7ms budget.
//  * extHz is computed off the SERVER's own Date.now() (/api/health `now`), so it
//    is immune to this client's event-loop jitter; the client-clock version is a
//    non-circular cross-check. (Δuptime/Δwall "drift" is algebraically identical
//    to Δtick/Δwall, so it is NOT used.)
//  * RTT is a NETWORK sanity number only — the server answers ping inline off the
//    tick, so RTT does NOT measure tick health. Never used as pass/fail.
//  * CLIENT EVENT-LOOP LAG is the false-pass guard: a saturated Node generator
//    under-feeds the DO, making extHz read a beautiful 15 while the test rig is
//    the real bottleneck. If client-lag p95 is high, the run is INVALID.
//  * inbound msg/s is read from the server's own received count (/api/health
//    `inMsgCount`), so caveat 2 is falsifiable: we know the DO actually received
//    the load rather than the client failing to deliver it.
//
// Node ESM, zero deps; uses the built-in WebSocket global. Run via
// `pnpm loadtest` — the script needs --experimental-strip-types for the
// shared-package import below (Node 22+, same as the other .mjs probes).

import { randomBytes } from "node:crypto";
// The join gate: imported (not mirrored) so a server protocol bump can never
// silently invalidate the load test — every join would be rejected at the
// proto check and the run would measure nothing.
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";

// --- Mirrored constants (packages/shared/src/constants.ts) ---
const MAX_INPUT_DT = 0.05; // clamp for a single cmd dt (seconds)
const MAX_CMDS_PER_FRAME = 6; // burst allowance for long frames
const RESPAWN_DELAY_S = 4; // server gates respawn requests on this
const INTERP_DELAY_MS = 120; // remote render delay -> attack `at` estimate
const TICK_RATE = 15; // server sim Hz — the extHz target
const TICK_MS = 1000 / TICK_RATE;
const TICK_BUDGET_MS = TICK_MS; // 66.67ms — tickMsMax must stay well under this
// Server per-socket rate limit (GameRoom.ts): exceeding it = 1008 close (harness
// misconfig, NOT server saturation). 600 msgs / 5s = 120 msg/s.
const SERVER_RATE_LIMIT_MSG_S = 120;
// Generator-integrity thresholds: above these the run is suspect/INVALID.
const CLIENT_LAG_P95_WARN_MS = 10;
const ACHIEVED_MSG_RATIO_MIN = 0.95;

// --- Bot behavior tunables ---
const HEADING_MIN_S = 2;
const HEADING_MAX_S = 5;
const SPRINT_CHANCE = 0.3;
const JUMP_CHANCE_PER_LOOP = 0.005;
const ATTACK_MIN_S = 3;
const ATTACK_MAX_S = 8;
const CHAT_INTERVAL_S = 60;
const JOIN_STAGGER_MS = 40;
const JOIN_TIMEOUT_MS = 10_000;
const STEP_TRANSIENT_MS = 5_000; // discard each step's first 5s (join stagger settle)
const MAX_BOT_RECONNECTS = 8; // consecutive reconnect attempts before giving up (matches client)

// --- Args: positional <url> [bots] [seconds] + --flags ---
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

const [urlArg, botsArg, secondsArg] = positional;
if (!urlArg || !/^wss?:\/\//.test(urlArg)) {
  console.error("usage: node scripts/loadtest.mjs <ws-url> [bots] [seconds] [--flags]");
  console.error("  e.g. node scripts/loadtest.mjs ws://localhost:5173/ws 20 120");
  console.error("       node scripts/loadtest.mjs ws://localhost:5173/ws --ramp=8,16,24,32 --step-seconds=45");
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("loadtest: global WebSocket missing — Node 22+ required");
  process.exit(2);
}

const numFlag = (name, dflt) => {
  const v = flags.get(name);
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

const WS_URL = urlArg;
const INPUT_SEND_MS = Math.max(5, numFlag("input-ms", 50));
const PING_INTERVAL_MS = Math.max(250, numFlag("ping-ms", 2000));
const HEALTH_INTERVAL_MS = numFlag("health-interval", 3000);
const STEP_SECONDS = Math.max(5, numFlag("step-seconds", 45));
const SPREAD = flags.has("spread");
const RAMP = (() => {
  const v = flags.get("ramp");
  if (!v || v === true) return null;
  const steps = String(v)
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return steps.length ? steps : null;
})();
const MAX_BOTS = RAMP ? Math.max(...RAMP) : Math.max(1, Number.parseInt(botsArg ?? "20", 10) || 20);
const DURATION_S = RAMP
  ? RAMP.length * STEP_SECONDS + 2
  : Math.max(5, Number.parseInt(secondsArg ?? "120", 10) || 120);

// Per-bot target send rate (input + ping), for achieved-vs-target accounting.
const PER_BOT_MSG_S = 1000 / INPUT_SEND_MS + 1000 / PING_INTERVAL_MS;
if (1000 / INPUT_SEND_MS >= SERVER_RATE_LIMIT_MSG_S) {
  console.warn(
    `loadtest: WARNING input-ms=${INPUT_SEND_MS} => ${(1000 / INPUT_SEND_MS).toFixed(0)} input/s/bot >= ` +
      `server per-socket limit ${SERVER_RATE_LIMIT_MSG_S}/s; expect 1008 closes (harness ceiling, not server saturation).`,
  );
}

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
let testStartMs = 0;
let currentStep = 0; // 0-based index into RAMP (or 0 for fixed-N)
let currentBotTarget = 0; // bots intended live in the current step

// --- Fleet-wide instrumentation accumulators ---
const sentByType = { input: 0, ping: 0, attack: 0, chat: 0, respawn: 0, join: 0, other: 0 };
let sentTotal = 0;
let lagWindow = []; // client event-loop lag samples (ms) since last health poll
const healthRows = []; // one row per /api/health poll pair

// --- Bots ---

function createBot(index) {
  return {
    index,
    name: `Bot-${index}`,
    token: randomBytes(16).toString("hex"),
    bearing: (index / Math.max(MAX_BOTS, 1)) * Math.PI * 2, // for --spread
    ws: null,
    step: 0, // ramp step this bot was added in
    joined: false,
    everJoined: false, // got a welcome at least once (vs a first-connect failure)
    joinFailed: false,
    joinFailReason: null,
    unexpectedClose: false,
    closeInfo: null,
    alive: false,
    seq: 0,
    yaw: rand(0, Math.PI * 2),
    pitch: 0,
    sprint: false,
    nextHeadingAt: 0,
    nextAttackAt: 0,
    nextChatAt: 0,
    lastLoopMs: 0,
    lastSnapTime: 0,
    lastSnapAtMs: 0,
    snapCount: 0,
    snapBytes: 0,
    lastAck: 0,
    ackAdvances: 0,
    rtts: [],
    deaths: 0,
    respawns: 0,
    reconnects: 0, // total times this bot re-opened after an unexpected drop
    reconnectAttempts: 0, // consecutive attempts since the last welcome
    loopTimer: null,
    pingTimer: null,
    joinTimer: null,
    pendingTimeouts: [],
  };
}

function botSend(bot, msg) {
  const ws = bot.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
  const t = msg.t;
  if (t in sentByType) sentByType[t]++;
  else sentByType.other++;
  sentTotal++;
}

function stopBotTimers(bot) {
  if (bot.loopTimer !== null) clearInterval(bot.loopTimer);
  if (bot.pingTimer !== null) clearInterval(bot.pingTimer);
  if (bot.joinTimer !== null) clearTimeout(bot.joinTimer);
  for (const t of bot.pendingTimeouts) clearTimeout(t);
  bot.loopTimer = null;
  bot.pingTimer = null;
  bot.joinTimer = null;
  bot.pendingTimeouts.length = 0;
}

/** Game-time the bot's "screen" would show — mirrors doAttack()'s renderGameTime. */
function estimateRenderGameTime(bot) {
  if (bot.lastSnapAtMs === 0) return 0;
  return bot.lastSnapTime + (Date.now() - bot.lastSnapAtMs) / 1000 - INTERP_DELAY_MS / 1000;
}

function rollHeading(bot, nowS) {
  if (SPREAD) {
    // Persistent outward bearing (+small jitter) so the fleet disperses and
    // interest-set overlap stays low/roughly constant — the geometry contrast
    // to the default random-walk clustering.
    bot.yaw = bot.bearing + rand(-0.25, 0.25);
    bot.sprint = true;
    bot.nextHeadingAt = nowS + rand(HEADING_MAX_S, HEADING_MAX_S * 2);
    return;
  }
  bot.yaw = rand(0, Math.PI * 2);
  bot.pitch = rand(-0.3, 0.3);
  bot.sprint = Math.random() < SPRINT_CHANCE;
  bot.nextHeadingAt = nowS + rand(HEADING_MIN_S, HEADING_MAX_S);
}

/** Per-bot behavior loop driven by setInterval(INPUT_SEND_MS). Also samples
 * client event-loop lag = how much later than scheduled this fire landed — the
 * generator-integrity signal. */
function botLoop(bot) {
  const nowMs = Date.now();
  // Client-loop lag: gap since last fire minus the scheduled interval. A healthy
  // generator fires ~on time; a saturated one fires late and under-feeds the DO.
  if (bot.lastLoopMs > 0) {
    lagWindow.push(Math.max(0, nowMs - bot.lastLoopMs - INPUT_SEND_MS));
  }
  const nowS = nowMs / 1000;
  if (nowS >= bot.nextHeadingAt) rollHeading(bot, nowS);

  if (bot.alive) {
    const elapsed = Math.min((nowMs - bot.lastLoopMs) / 1000, MAX_INPUT_DT * MAX_CMDS_PER_FRAME);
    let remaining = Math.max(elapsed, 0.001);
    const jump = Math.random() < JUMP_CHANCE_PER_LOOP;
    const cmds = [];
    let first = true;
    while (remaining > 0 && cmds.length < MAX_CMDS_PER_FRAME) {
      const dt = Math.min(remaining, MAX_INPUT_DT);
      remaining -= dt;
      cmds.push({
        seq: ++bot.seq,
        dt: Math.round(dt * 10000) / 10000,
        mx: 0,
        mz: -1,
        yaw: Math.round(bot.yaw * 1000) / 1000,
        pitch: Math.round(bot.pitch * 1000) / 1000,
        sprint: bot.sprint,
        jump: jump && first,
      });
      first = false;
    }
    botSend(bot, { t: "input", cmds });

    if (nowS >= bot.nextAttackAt) {
      bot.nextAttackAt = nowS + rand(ATTACK_MIN_S, ATTACK_MAX_S);
      const at = estimateRenderGameTime(bot);
      botSend(bot, at > 0 ? { t: "attack", at: Math.round(at * 1000) / 1000 } : { t: "attack" });
    }

    if (nowS >= bot.nextChatAt) {
      bot.nextChatAt = nowS + CHAT_INTERVAL_S;
      const upS = Math.round((nowMs - testStartMs) / 1000);
      botSend(bot, { t: "chat", text: `${bot.name} reporting in at t+${upS}s` });
    }
  }
  bot.lastLoopMs = nowMs;
}

function onBotMessage(bot, data) {
  if (typeof data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  switch (msg.t) {
    case "welcome": {
      bot.joined = true;
      bot.everJoined = true;
      bot.reconnectAttempts = 0; // connected (initial or a successful reconnect)
      // A welcome clears any stale failure flag from a slow-but-now-recovered
      // reconnect attempt, so a real recovery isn't mis-reported as a failure.
      bot.joinFailed = false;
      bot.joinFailReason = null;
      bot.alive = msg.you.hp > 0;
      bot.lastSnapTime = msg.time;
      bot.lastSnapAtMs = Date.now();
      if (bot.joinTimer !== null) clearTimeout(bot.joinTimer);
      bot.joinTimer = null;
      const nowS = Date.now() / 1000;
      bot.lastLoopMs = Date.now();
      rollHeading(bot, nowS);
      bot.nextAttackAt = nowS + rand(ATTACK_MIN_S, ATTACK_MAX_S);
      bot.nextChatAt = nowS + rand(5, CHAT_INTERVAL_S);
      // A welcome can arrive again mid-session (the server rehydrates a socket
      // that survived a DO recycle) — clear existing timers first so we don't
      // stack a second input/ping loop and double our send rate.
      if (bot.loopTimer !== null) clearInterval(bot.loopTimer);
      if (bot.pingTimer !== null) clearInterval(bot.pingTimer);
      bot.loopTimer = setInterval(() => botLoop(bot), INPUT_SEND_MS);
      bot.pingTimer = setInterval(() => botSend(bot, { t: "ping", ts: Date.now() }), PING_INTERVAL_MS);
      return;
    }
    case "snap": {
      bot.snapCount++;
      bot.snapBytes += Buffer.byteLength(data);
      bot.lastSnapTime = msg.time;
      bot.lastSnapAtMs = Date.now();
      if (msg.ack > bot.lastAck) {
        bot.lastAck = msg.ack;
        bot.ackAdvances++;
      }
      if (!bot.alive && msg.you.hp > 0) {
        bot.alive = true;
        bot.respawns++;
      }
      return;
    }
    case "death": {
      bot.alive = false;
      bot.deaths++;
      const timer = setTimeout(
        () => botSend(bot, { t: "respawn" }),
        (RESPAWN_DELAY_S + 0.3) * 1000,
      );
      bot.pendingTimeouts.push(timer);
      return;
    }
    case "pong":
      bot.rtts.push(Date.now() - msg.ts);
      return;
    case "error": {
      if (!bot.joined) {
        bot.joinFailed = true;
        bot.joinFailReason = msg.msg;
      }
      return;
    }
    default:
      return;
  }
}

function connectBot(bot) {
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    bot.joinFailed = true;
    bot.joinFailReason = `connect threw: ${err}`;
    return;
  }
  bot.ws = ws;
  bot.step = currentStep;
  // Stale-socket identity guard (mirrors the client): after a reconnect reassigns
  // bot.ws, a late/buffered event from the OLD socket must not mutate the live one.
  const self = ws;
  ws.addEventListener("open", () => {
    if (bot.ws !== self) return;
    botSend(bot, { t: "join", name: bot.name, token: bot.token, proto: PROTOCOL_VERSION });
  });
  ws.addEventListener("message", (ev) => {
    if (bot.ws !== self) return;
    onBotMessage(bot, ev.data);
  });
  ws.addEventListener("error", () => {});
  ws.addEventListener("close", (ev) => {
    if (bot.ws !== self) return; // a superseded socket closing — ignore
    bot.closeInfo = { code: ev.code, reason: ev.reason || "" };
    stopBotTimers(bot);
    if (shuttingDown) return;
    // First-connect failure (never joined, not a reconnect): terminal.
    if (!bot.joined && bot.reconnectAttempts === 0) {
      bot.joinFailed = true;
      bot.joinFailReason ??= `closed before welcome (code ${ev.code})`;
      return;
    }
    // Policy closes are non-recoverable — don't reconnect-loop into them (1008 =
    // rate limit / incompatible version / session taken over). The client calls
    // disconnect() on a server error and never reconnects either.
    if (ev.code === 1008) {
      bot.unexpectedClose = true;
      return;
    }
    // Was in-game and the socket dropped (e.g. the DO instance was replaced and
    // the old one timed us out with 1001): auto-reconnect with the same token,
    // mirroring the client. The server's restore path re-binds the character.
    bot.reconnects++;
    bot.reconnectAttempts++;
    bot.joined = false;
    bot.alive = false;
    if (bot.reconnectAttempts > MAX_BOT_RECONNECTS) {
      bot.unexpectedClose = true; // gave up — counts as a real failure
      return;
    }
    const base = Math.min(3000, 250 * 2 ** (bot.reconnectAttempts - 1));
    const delay = base * (0.5 + Math.random() * 0.5); // ±50% jitter, anti thundering-herd
    const t = setTimeout(() => {
      if (!shuttingDown) connectBot(bot);
    }, delay);
    bot.pendingTimeouts.push(t);
  });
  bot.joinTimer = setTimeout(() => {
    if (bot.ws !== self) return;
    if (bot.joined || bot.joinFailed) return;
    // Only a FIRST-connect timeout is a terminal join failure; a reconnect
    // timeout just closes so the close handler schedules the next attempt.
    if (bot.reconnectAttempts === 0) {
      bot.joinFailed = true;
      bot.joinFailReason = "join timeout (no welcome in 10s)";
    }
    try {
      bot.ws?.close(1000, "join timeout");
    } catch {
      // Already closed.
    }
  }, JOIN_TIMEOUT_MS);
}

// --- Reporting helpers ---

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

function countJoined() {
  let n = 0;
  for (const bot of bots) if (bot.joined && bot.ws && bot.ws.readyState === WebSocket.OPEN) n++;
  return n;
}

async function fetchHealth() {
  const u = new URL(WS_URL);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/api/health";
  u.search = "";
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String(err) };
  }
}

// --- /api/health poller: the timer-INDEPENDENT measurement ---

let prevHealth = null; // { wallMs, srvNow, tick, inMsgCount, snapsTotal, sentTotal }
let pollInFlight = false;

function snapsTotal() {
  let n = 0;
  for (const bot of bots) n += bot.snapCount;
  return n;
}

async function pollHealth() {
  if (pollInFlight) return; // never overlap fetches
  pollInFlight = true;
  const wallMs = Date.now();
  const h = await fetchHealth();
  pollInFlight = false;
  if (h.error) {
    console.log(`[poll] /api/health error: ${h.error}`);
    return;
  }
  const snaps = snapsTotal();
  const cur = {
    wallMs,
    srvNow: typeof h.now === "number" ? h.now : wallMs,
    tick: h.tick ?? 0,
    inMsgCount: h.inMsgCount ?? 0,
    snaps,
    sent: sentTotal,
  };

  // Drain the client event-loop-lag window for THIS interval.
  const lag = lagWindow;
  lagWindow = [];
  lag.sort((a, b) => a - b);
  const lagP50 = percentile(lag, 50);
  const lagP95 = percentile(lag, 95);

  if (prevHealth) {
    const dSrv = (cur.srvNow - prevHealth.srvNow) / 1000; // server-clock seconds (jitter-free)
    const dCli = (cur.wallMs - prevHealth.wallMs) / 1000; // client-clock seconds (cross-check)
    const joined = countJoined();
    // extHz off the SERVER clock — immune to this process's event-loop jitter.
    const extHzSrv = dSrv > 0 ? (cur.tick - prevHealth.tick) / dSrv : 0;
    const extHzCli = dCli > 0 ? (cur.tick - prevHealth.tick) / dCli : 0;
    const recvMsgS = dSrv > 0 ? (cur.inMsgCount - prevHealth.inMsgCount) / dSrv : 0;
    const sentMsgS = dCli > 0 ? (cur.sent - prevHealth.sent) / dCli : 0;
    const snapsPerBot = dCli > 0 && joined > 0 ? (cur.snaps - prevHealth.snaps) / dCli / joined : 0;
    const targetMsgS = joined * PER_BOT_MSG_S;
    const achievedRatio = targetMsgS > 0 ? sentMsgS / targetMsgS : 1;
    const upS = ((wallMs - testStartMs) / 1000).toFixed(0);
    const transient = wallMs - stepStartMs < STEP_TRANSIENT_MS;

    const row = {
      upS: Number(upS),
      step: currentStep,
      stepLabel: RAMP ? `${currentStep + 1}/${RAMP.length}` : "-",
      bots: currentBotTarget,
      joined,
      extHzSrv,
      extHzCli,
      tickMsEma: h.tickMsEma ?? 0,
      tickMsMax: h.tickMsMax ?? 0,
      recvMsgS,
      sentMsgS,
      targetMsgS,
      achievedRatio,
      lagP50,
      lagP95,
      snapsPerBot,
      transient,
    };
    healthRows.push(row);

    // Client event-loop lag is the TRUE generator-saturation signal. A low
    // send/target ratio with healthy lag just means bots are dead/respawning
    // (sending no input) — gameplay, not strain — so it does NOT flag here.
    const strain = lagP95 > CLIENT_LAG_P95_WARN_MS;
    const skew = Math.abs(extHzSrv - extHzCli) > 0.5 ? ` clkSkew(cli=${extHzCli.toFixed(1)})` : "";
    console.log(
      `[t+${upS}s ${RAMP ? `step ${row.stepLabel} ` : ""}bots ${currentBotTarget} joined ${joined}]` +
        ` extHz=${extHzSrv.toFixed(2)}${skew}` +
        ` | tickMsMax=${row.tickMsMax} ema=${row.tickMsEma} (budget ${TICK_BUDGET_MS.toFixed(1)})` +
        ` | in recv=${recvMsgS.toFixed(0)}/s sent=${sentMsgS.toFixed(0)}/s (target ${targetMsgS.toFixed(0)})` +
        ` | clientLag p50/p95=${lagP50}/${lagP95}ms` +
        ` | snaps/s/bot=${snapsPerBot.toFixed(1)}` +
        (strain ? "  ⚠ GEN-STRAIN (result suspect)" : "") +
        (transient ? "  ·transient" : ""),
    );
  }
  prevHealth = cur;
}

// --- Ramp / step driving ---

let stepStartMs = 0;
let nextBotToConnect = 0;

async function connectUpTo(target) {
  while (nextBotToConnect < target && !shuttingDown) {
    connectBot(bots[nextBotToConnect]);
    nextBotToConnect++;
    await sleep(JOIN_STAGGER_MS);
  }
}

function stepSummary(stepIdx) {
  const rows = healthRows.filter((r) => r.step === stepIdx && !r.transient);
  if (rows.length === 0) return null;
  const med = (key) => {
    const v = rows.map((r) => r[key]).sort((a, b) => a - b);
    return percentile(v, 50);
  };
  const max = (key) => rows.reduce((m, r) => Math.max(m, r[key]), 0);
  return {
    step: RAMP ? `${stepIdx + 1}/${RAMP.length}` : "-",
    bots: rows[rows.length - 1].bots,
    joined: rows[rows.length - 1].joined,
    extHz: med("extHzSrv"),
    tickMsMaxPeak: max("tickMsMax"),
    tickMsEma: med("tickMsEma"),
    recvMsgS: med("recvMsgS"),
    sentMsgS: med("sentMsgS"),
    targetMsgS: med("targetMsgS"),
    lagP95Peak: max("lagP95"),
    snapsPerBot: med("snapsPerBot"),
  };
}

// --- Final report ---

function printFinalReport() {
  const joined = bots.filter((b) => b.joined).length;
  const joinFailures = bots.filter((b) => b.joinFailed);
  const unexpected = bots.filter((b) => b.unexpectedClose);
  const ackStalled = bots.filter((b) => b.joined && b.ackAdvances === 0);
  const elapsedS = Math.max((Date.now() - testStartMs) / 1000, 1);
  let totalBytes = 0;
  let totalSnaps = 0;
  let deaths = 0;
  let respawns = 0;
  const rtts = [];
  for (const bot of bots) {
    totalBytes += bot.snapBytes;
    totalSnaps += bot.snapCount;
    deaths += bot.deaths;
    respawns += bot.respawns;
    rtts.push(...bot.rtts);
  }
  rtts.sort((a, b) => a - b);
  const totalKbps = totalBytes / 1024 / elapsedS;

  console.log("\n=== LOADTEST REPORT ===");
  console.log(
    `mode ${RAMP ? `ramp ${RAMP.join(",")} @ ${STEP_SECONDS}s/step` : `fixed ${MAX_BOTS} bots`}` +
      ` | input-ms ${INPUT_SEND_MS} (${(1000 / INPUT_SEND_MS).toFixed(0)} input/s/bot)` +
      ` | spread ${SPREAD} | duration ${elapsedS.toFixed(0)}s | url ${WS_URL}`,
  );
  console.log(`join success: ${joined}/${MAX_BOTS} (${((joined / MAX_BOTS) * 100).toFixed(0)}%)`);
  for (const bot of joinFailures) console.log(`  join FAILED ${bot.name}: ${bot.joinFailReason}`);

  // Per-step steady-state table (the headline result).
  const stepCount = RAMP ? RAMP.length : 1;
  console.log("\n  step  bots joined  extHz  tickMsMax(peak) ema  recvMsg/s sentMsg/s(tgt)  lagP95(peak) snaps/s/bot");
  for (let s = 0; s < stepCount; s++) {
    const r = stepSummary(s);
    if (!r) continue;
    console.log(
      `  ${String(r.step).padEnd(5)} ${String(r.bots).padStart(4)} ${String(r.joined).padStart(6)}` +
        `  ${r.extHz.toFixed(2).padStart(5)}  ${String(r.tickMsMaxPeak).padStart(8)}     ${String(r.tickMsEma).padStart(4)}` +
        `  ${r.recvMsgS.toFixed(0).padStart(8)} ${r.sentMsgS.toFixed(0).padStart(8)}(${r.targetMsgS.toFixed(0)})` +
        `   ${String(r.lagP95Peak).padStart(6)}ms    ${r.snapsPerBot.toFixed(1).padStart(6)}`,
    );
  }

  console.log(
    `\nsnapshots: ${totalSnaps} total, ${totalKbps.toFixed(1)} KB/s total, ` +
      `${(totalKbps / Math.max(joined, 1)).toFixed(1)} KB/s mean per bot`,
  );
  console.log(
    `rtt (NETWORK sanity only — NOT tick health): p50 ${percentile(rtts, 50)}ms, p95 ${percentile(rtts, 95)}ms ` +
      `(${rtts.length} samples)`,
  );
  console.log(`deaths ${deaths}, respawns ${respawns}`);
  if (ackStalled.length > 0) {
    console.log(`WARNING: acks never advanced for: ${ackStalled.map((b) => b.name).join(", ")}`);
  }

  const closeCounts = new Map();
  for (const bot of bots) {
    if (!bot.closeInfo) continue;
    const key = `${bot.closeInfo.code}${bot.closeInfo.reason ? ` "${bot.closeInfo.reason}"` : ""}`;
    closeCounts.set(key, (closeCounts.get(key) ?? 0) + 1);
  }
  const closes = [...closeCounts.entries()].map(([key, n]) => `${key} x${n}`).join(", ");
  console.log(`socket closes: ${closes || "(none recorded)"}`);
  // Reconnect recovery: total reopens after an unexpected drop, and how many
  // bots are currently joined at the end. A recycle's 1001 closes followed by a
  // full recovery here is the SUCCESS signal (a brief blip, not a permanent drop).
  const totalReconnects = bots.reduce((s, b) => s + b.reconnects, 0);
  const joinedNow = countJoined();
  console.log(
    `reconnects: ${totalReconnects} total across ${bots.filter((b) => b.reconnects > 0).length} bots` +
      ` | currently joined ${joinedNow}/${MAX_BOTS}` +
      (totalReconnects > 0 ? "  (1001 closes above are recycle drops the bots RECOVERED from)" : ""),
  );
  for (const bot of unexpected) {
    console.log(`  GAVE UP (>${MAX_BOT_RECONNECTS} reconnects) ${bot.name}: code ${bot.closeInfo?.code} "${bot.closeInfo?.reason}"`);
  }

  // Validity verdict: a saturated GENERATOR invalidates the server reading. The
  // TRUE saturation signal is client event-loop lag. A low send/target ratio with
  // HEALTHY lag just means bots were dead/respawning (sending no input) — gameplay,
  // not strain — so only client-lag drives the verdict; low-send is a separate note.
  const peakLag = healthRows.reduce((m, r) => Math.max(m, r.lagP95), 0);
  const worstAchieved = healthRows
    .filter((r) => !r.transient)
    .reduce((m, r) => Math.min(m, r.achievedRatio), 1);
  const genStrained = peakLag > CLIENT_LAG_P95_WARN_MS;
  const lowSend = worstAchieved < ACHIEVED_MSG_RATIO_MIN;
  const rateLimitClose = [...closeCounts.keys()].some((k) => k.startsWith("1008"));
  const serverFull = [...closeCounts.keys()].some((k) => k.includes("Server full") || k.startsWith("503"));

  console.log("\n=== VALIDITY ===");
  console.log(
    `generator integrity: client-lag p95 peak ${peakLag}ms (warn >${CLIENT_LAG_P95_WARN_MS})` +
      ` -> ${genStrained ? "STRAINED ⚠  server numbers SUSPECT (shard the generator across processes)" : "OK"}`,
  );
  if (lowSend) {
    console.log(
      `note: worst send/target msg ratio ${(worstAchieved * 100).toFixed(0)}% (<${ACHIEVED_MSG_RATIO_MIN * 100}%)` +
        (genStrained
          ? "."
          : " WITH healthy client-lag — expected from bot deaths/respawns (dead bots send no input), NOT generator strain."),
    );
  }
  if (rateLimitClose) {
    console.log("NOTE: 1008 closes = per-socket rate limit (input-ms too low); harness ceiling, NOT server saturation.");
  }
  if (serverFull) {
    console.log("NOTE: 'Server full'/503 = MAX_PLAYERS cap hit; raise the cap for the test build, the knee is otherwise a cap artifact.");
  }
  // RECOVERY GATE — the whole point of reconnect: after the recycle's 1001 wave,
  // did the LIVE joined count recover and stay near peak? Read from the health
  // time series, EXCLUDING the final ~6s (a bot mid-reconnect at the instant of
  // shutdown is not a permanent drop). The old (broken) behavior left the tail
  // joined at ~0 and FAILS here; a clean recover-after-blip passes. Only gates
  // when health polling ran AND some bot ever joined.
  let recovered = true;
  let recoveryNote = "(no health polling — recovery not gated)";
  const everJoinedCount = bots.filter((b) => b.everJoined).length;
  if (healthRows.length >= 4 && everJoinedCount > 0) {
    const lastUpS = healthRows[healthRows.length - 1].upS;
    const tail = healthRows.filter((r) => r.upS <= lastUpS - 6).slice(-8); // ~last 24s minus final 6s
    const peakJoined = healthRows.reduce((m, r) => Math.max(m, r.joined), 0);
    const tailVals = tail.map((r) => r.joined).sort((a, b) => a - b);
    const tailMedian = percentile(tailVals, 50); // reuse the helper for a consistent median
    recovered = peakJoined > 0 && tailMedian >= 0.85 * peakJoined;
    recoveryNote = `tail joined median ${tailMedian} vs peak ${peakJoined} -> ${recovered ? "RECOVERED" : "DID NOT RECOVER (permanent drop)"}`;
  }
  const totalReconns = bots.reduce((s, b) => s + b.reconnects, 0);
  console.log(`recovery: ${recoveryNote}${totalReconns > 0 ? ` (${totalReconns} reconnects)` : ""}`);

  const failed = joinFailures.length > 0 || unexpected.length > 0 || !recovered;
  console.log(`RESULT: ${failed ? "FAIL" : "PASS"}${genStrained ? " (but generator strained — re-run sharded)" : ""}`);
  return failed ? 1 : 0;
}

// --- Main ---

const bots = Array.from({ length: MAX_BOTS }, (_, i) => createBot(i + 1));

async function main() {
  console.log(
    `loadtest: ${RAMP ? `ramp ${RAMP.join(",")} @ ${STEP_SECONDS}s/step` : `${MAX_BOTS} bots`}` +
      ` -> ${WS_URL} | input-ms ${INPUT_SEND_MS} ping-ms ${PING_INTERVAL_MS}` +
      ` health-interval ${HEALTH_INTERVAL_MS}ms spread ${SPREAD}`,
  );
  testStartMs = Date.now();

  const healthTimer =
    HEALTH_INTERVAL_MS > 0 ? setInterval(() => void pollHealth(), HEALTH_INTERVAL_MS) : null;

  if (RAMP) {
    for (let s = 0; s < RAMP.length && !shuttingDown; s++) {
      currentStep = s;
      currentBotTarget = RAMP[s];
      stepStartMs = Date.now();
      console.log(`\n--- step ${s + 1}/${RAMP.length}: ramp to ${RAMP[s]} bots ---`);
      await connectUpTo(RAMP[s]);
      const holdMs = STEP_SECONDS * 1000 - (Date.now() - stepStartMs);
      if (holdMs > 0) await sleep(holdMs);
    }
  } else {
    currentStep = 0;
    currentBotTarget = MAX_BOTS;
    stepStartMs = Date.now();
    await connectUpTo(MAX_BOTS);
    const holdMs = DURATION_S * 1000 - (Date.now() - testStartMs);
    if (holdMs > 0) await sleep(holdMs);
  }

  shuttingDown = true;
  if (healthTimer) clearInterval(healthTimer);
  for (const bot of bots) {
    stopBotTimers(bot);
    try {
      bot.ws?.close(1000, "test complete");
    } catch {
      // Already closed.
    }
  }
  await sleep(500);
  const code = printFinalReport();
  process.exit(code);
}

main().catch((err) => {
  console.error("loadtest: fatal", err);
  process.exit(1);
});
