#!/usr/bin/env node
// Worldspring load-test harness — drives N protocol-faithful bots against the
// GameRoom WebSocket and reports join success, snapshot bandwidth, RTT
// percentiles, socket closes and the server's /api/health stats.
//
//   node scripts/loadtest.mjs ws://localhost:4173/ws 20 120
//                             <url>                  <bots> <seconds>
//
// Plain Node ESM, zero deps; uses the built-in WebSocket global (Node 22+).
// The message shapes mirror src/shared/protocol.ts and the cadences mirror
// src/client/net/connection.ts + NetSystem.tsx — the server validates
// strictly, so any drift here shows up as silently dropped messages.

import { randomBytes } from "node:crypto";

// --- Mirrored constants (src/shared/constants.ts) ---
const INPUT_SEND_MS = 50; // client batches input cmds at this interval
const MAX_INPUT_DT = 0.05; // clamp for a single cmd dt (seconds)
const MAX_CMDS_PER_FRAME = 6; // burst allowance for long frames
const RESPAWN_DELAY_S = 4; // server gates respawn requests on this
const INTERP_DELAY_MS = 120; // remote render delay -> attack `at` estimate
const PING_INTERVAL_MS = 2000;

// --- Bot behavior tunables ---
const HEADING_MIN_S = 2;
const HEADING_MAX_S = 5;
const SPRINT_CHANCE = 0.3; // rolled on every heading change
const JUMP_CHANCE_PER_LOOP = 0.005; // ~once per 10s at 20Hz
const ATTACK_MIN_S = 3;
const ATTACK_MAX_S = 8;
const CHAT_INTERVAL_S = 60;
const JOIN_STAGGER_MS = 40; // spread connection bursts a little
const JOIN_TIMEOUT_MS = 10_000; // matches the server's join eviction
const SUMMARY_INTERVAL_MS = 10_000;

// --- Args ---
const [, , urlArg, botsArg, secondsArg] = process.argv;
if (!urlArg || !/^wss?:\/\//.test(urlArg)) {
  console.error("usage: node scripts/loadtest.mjs <ws-url> [botCount] [seconds]");
  console.error("  e.g. node scripts/loadtest.mjs ws://localhost:4173/ws 20 120");
  process.exit(2);
}
const WS_URL = urlArg;
const BOT_COUNT = Math.max(1, Number.parseInt(botsArg ?? "20", 10) || 20);
const DURATION_S = Math.max(5, Number.parseInt(secondsArg ?? "120", 10) || 120);

if (typeof WebSocket === "undefined") {
  console.error("loadtest: global WebSocket missing — Node 22+ required");
  process.exit(2);
}

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
let testStartMs = 0;

// --- Bots ---

function createBot(index) {
  return {
    index,
    name: `Bot-${index}`,
    token: randomBytes(16).toString("hex"), // 32 hex chars, unique identity
    ws: null,
    // join / liveness
    joined: false,
    joinFailed: false,
    joinFailReason: null,
    unexpectedClose: false,
    closeInfo: null, // { code, reason }
    // sim state
    alive: false,
    seq: 0,
    yaw: rand(0, Math.PI * 2),
    pitch: 0,
    sprint: false,
    nextHeadingAt: 0, // all "...At" fields are wall-clock seconds
    nextAttackAt: 0,
    nextChatAt: 0,
    lastLoopMs: 0,
    lastSnapTime: 0, // server game-time from the last snap
    lastSnapAtMs: 0,
    // stats
    snapCount: 0,
    snapBytes: 0,
    lastAck: 0,
    ackAdvances: 0,
    rtts: [],
    deaths: 0,
    respawns: 0,
    // timers
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

/** Game-time the bot's "screen" would be showing — mirrors doAttack()'s
 * clientWorld.renderGameTime (interpolation runs INTERP_DELAY_MS behind). */
function estimateRenderGameTime(bot) {
  if (bot.lastSnapAtMs === 0) return 0;
  return bot.lastSnapTime + (Date.now() - bot.lastSnapAtMs) / 1000 - INTERP_DELAY_MS / 1000;
}

function rollHeading(bot, nowS) {
  bot.yaw = rand(0, Math.PI * 2);
  bot.pitch = rand(-0.3, 0.3);
  bot.sprint = Math.random() < SPRINT_CHANCE;
  bot.nextHeadingAt = nowS + rand(HEADING_MIN_S, HEADING_MAX_S);
}

/** 20Hz behavior loop: input batches, attacks, chat. Mirrors NetSystem's
 * frame sampling + INPUT_SEND_MS batching (at 20Hz each batch is ~1 cmd;
 * a late timer fire splits into sub-cmds of MAX_INPUT_DT like a slow frame). */
function botLoop(bot) {
  const nowMs = Date.now();
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
        mz: -1, // forward (client convention: -1 forward .. 1 back)
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
      bot.alive = msg.you.hp > 0;
      bot.lastSnapTime = msg.time;
      bot.lastSnapAtMs = Date.now();
      if (bot.joinTimer !== null) clearTimeout(bot.joinTimer);
      bot.joinTimer = null;
      // Start behaving only once the server has accepted us.
      const nowS = Date.now() / 1000;
      bot.lastLoopMs = Date.now();
      rollHeading(bot, nowS);
      bot.nextAttackAt = nowS + rand(ATTACK_MIN_S, ATTACK_MAX_S);
      bot.nextChatAt = nowS + rand(5, CHAT_INTERVAL_S); // stagger first lines
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
        // Server confirmed our respawn (mirrors connection.ts onSnap).
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
        (RESPAWN_DELAY_S + 0.3) * 1000, // +epsilon: server checks game-time elapsed
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
      return; // inv / chat / notice — irrelevant to the harness
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
  ws.addEventListener("open", () => {
    botSend(bot, { t: "join", name: bot.name, token: bot.token });
  });
  ws.addEventListener("message", (ev) => onBotMessage(bot, ev.data));
  ws.addEventListener("error", () => {
    // The paired close event carries the useful info; nothing to do here.
  });
  ws.addEventListener("close", (ev) => {
    bot.closeInfo = { code: ev.code, reason: ev.reason || "" };
    stopBotTimers(bot);
    if (shuttingDown) return;
    if (!bot.joined) {
      bot.joinFailed = true;
      bot.joinFailReason ??= `closed before welcome (code ${ev.code})`;
      return;
    }
    bot.unexpectedClose = true;
  });
  // Server evicts never-joined sockets after 10s; mirror that locally so a
  // black-holed welcome doesn't hang the verdict.
  bot.joinTimer = setTimeout(() => {
    if (bot.joined || bot.joinFailed) return;
    bot.joinFailed = true;
    bot.joinFailReason = "join timeout (no welcome in 10s)";
    try {
      bot.ws?.close(1000, "join timeout");
    } catch {
      // Already closed.
    }
  }, JOIN_TIMEOUT_MS);
}

// --- Reporting ---

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

function collectRtts() {
  const all = [];
  for (const bot of bots) all.push(...bot.rtts);
  all.sort((a, b) => a - b);
  return all;
}

function printFleetSummary() {
  const upS = Math.round((Date.now() - testStartMs) / 1000);
  let open = 0;
  let joined = 0;
  let snaps = 0;
  let bytes = 0;
  let deaths = 0;
  let respawns = 0;
  for (const bot of bots) {
    if (bot.ws && bot.ws.readyState === WebSocket.OPEN) open++;
    if (bot.joined) joined++;
    snaps += bot.snapCount;
    bytes += bot.snapBytes;
    deaths += bot.deaths;
    respawns += bot.respawns;
  }
  const elapsedS = Math.max((Date.now() - testStartMs) / 1000, 1);
  const kbps = bytes / 1024 / elapsedS;
  const rtts = collectRtts();
  console.log(
    `[t+${upS}s] up ${open}/${BOT_COUNT} joined ${joined} | ` +
      `snaps ${snaps} (${kbps.toFixed(1)} KB/s total) | ` +
      `rtt p50 ${percentile(rtts, 50)}ms p95 ${percentile(rtts, 95)}ms | ` +
      `deaths ${deaths} respawns ${respawns}`,
  );
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

function printFinalReport(health, elapsedS) {
  const joined = bots.filter((b) => b.joined).length;
  const joinFailures = bots.filter((b) => b.joinFailed);
  const unexpected = bots.filter((b) => b.unexpectedClose);
  const ackStalled = bots.filter((b) => b.joined && b.ackAdvances === 0);
  let totalBytes = 0;
  let totalSnaps = 0;
  let deaths = 0;
  let respawns = 0;
  for (const bot of bots) {
    totalBytes += bot.snapBytes;
    totalSnaps += bot.snapCount;
    deaths += bot.deaths;
    respawns += bot.respawns;
  }
  const totalKbps = totalBytes / 1024 / elapsedS;
  const rtts = collectRtts();

  console.log("\n=== LOADTEST REPORT ===");
  console.log(`bots ${BOT_COUNT}, duration ${elapsedS.toFixed(0)}s, url ${WS_URL}`);
  console.log(
    `join success: ${joined}/${BOT_COUNT} (${((joined / BOT_COUNT) * 100).toFixed(0)}%)`,
  );
  for (const bot of joinFailures) {
    console.log(`  join FAILED ${bot.name}: ${bot.joinFailReason}`);
  }
  console.log(
    `snapshots: ${totalSnaps} total, ${totalKbps.toFixed(1)} KB/s total, ` +
      `${(totalKbps / Math.max(joined, 1)).toFixed(1)} KB/s mean per bot`,
  );
  console.log(
    `rtt: p50 ${percentile(rtts, 50)}ms, p95 ${percentile(rtts, 95)}ms, ` +
      `max ${rtts.length > 0 ? rtts[rtts.length - 1] : 0}ms (${rtts.length} samples)`,
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
  for (const bot of unexpected) {
    console.log(
      `  UNEXPECTED close ${bot.name}: code ${bot.closeInfo?.code} "${bot.closeInfo?.reason}"`,
    );
  }
  console.log(`/api/health: ${JSON.stringify(health)}`);

  const failed = joinFailures.length > 0 || unexpected.length > 0;
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  return failed ? 1 : 0;
}

// --- Main ---

const bots = Array.from({ length: BOT_COUNT }, (_, i) => createBot(i + 1));

async function main() {
  console.log(`loadtest: ${BOT_COUNT} bots -> ${WS_URL} for ${DURATION_S}s`);
  testStartMs = Date.now();
  for (const bot of bots) {
    connectBot(bot);
    await sleep(JOIN_STAGGER_MS);
  }
  const summaryTimer = setInterval(printFleetSummary, SUMMARY_INTERVAL_MS);
  await sleep(Math.max(0, DURATION_S * 1000 - (Date.now() - testStartMs)));
  const elapsedS = (Date.now() - testStartMs) / 1000;

  shuttingDown = true;
  clearInterval(summaryTimer);
  for (const bot of bots) {
    stopBotTimers(bot);
    try {
      bot.ws?.close(1000, "test complete");
    } catch {
      // Already closed.
    }
  }
  await sleep(500); // let close frames flush before sampling health
  const health = await fetchHealth();
  const code = printFinalReport(health, elapsedS);
  process.exit(code);
}

main().catch((err) => {
  console.error("loadtest: fatal", err);
  process.exit(1);
});
