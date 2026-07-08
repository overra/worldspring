// Offline acceptance harness for the directory heartbeat sender (doc 03 §6 M3).
//   node --experimental-strip-types apps/game/scripts/heartbeat-cadence.mjs
//
// Drives DirectoryHeartbeat against a fake clock + recording fetch and asserts
// the doc-03 cadence contract: boot → edge(join) → periodic×N (50–70 s gaps) →
// edge(leave) → quiet with correct players at each step; edge debounce; the
// every-beat-reschedules rule; backoff on failure (never a tick error); 401
// disarm; 429 Retry-After; and that an unset env produces ZERO outbound
// requests. This is the local half of the doc 03 §11 acceptance; the deployed
// soak is operational, not a script.
import assert from "node:assert/strict";
import { DirectoryHeartbeat } from "../src/server/heartbeat.ts";
import {
  HEARTBEAT_EDGE_DEBOUNCE_S,
  HEARTBEAT_INTERVAL_S,
  HEARTBEAT_JITTER_S,
} from "@worldspring/shared/constants";

const TICK_MS = 1000; // sim granularity; the real tick is faster, which only helps

function makeInfo(players, status) {
  return {
    schemaVersion: 1,
    gameVersion: "0.1.0",
    protocolVersion: 6,
    worldSeed: 1337,
    name: "Harness",
    motd: "",
    rules: {
      preset: "deadcoast",
      zombies: "normal",
      pvp: true,
      fullLoot: true,
      loot: "normal",
      vitals: "normal",
      night: "cycle",
      dayLengthMin: 20,
      worldSize: "standard",
      maxPlayers: 24,
      wipe: "never",
      map: "full",
    },
    players,
    maxPlayers: 24,
    status,
    uptimeS: status === "occupied" ? 60 : 0,
    worldAgeS: 100,
    colo: null,
    joinUrl: "https://harness.example.workers.dev",
    directoryChallenge: null,
  };
}

function makeWorld({ respond } = {}) {
  const world = {
    now: 1_000_000_000_000,
    players: 0,
    occupied: false,
    beats: [], // { event, players, status, sentAt }
    warns: [],
    respond: respond ?? (() => new Response(null, { status: 204 })),
  };
  world.hb = new DirectoryHeartbeat({
    directoryUrl: "https://directory.example",
    directoryToken:
      "dcd1.01ARZ3NDEKTSV4RRFFQ69G5FAV." + "ab".repeat(32),
    buildInfo: () =>
      makeInfo(world.occupied ? world.players : 0, world.occupied ? "occupied" : "idle"),
    fetchFn: async (url, init) => {
      assert.equal(url, "https://directory.example/api/v1/heartbeat");
      assert.match(init.headers.authorization, /^Bearer dcd1\./);
      const body = JSON.parse(init.body);
      world.beats.push({
        event: body.event,
        players: body.info.players,
        status: body.info.status,
        sentAt: body.sentAt,
      });
      return world.respond(body);
    },
    now: () => world.now,
    random: () => 0.5, // jitter = 0 → deterministic 60 s periodic cadence
    warn: (msg) => world.warns.push(msg),
  });
  return world;
}

// Fire-and-forget fetches settle on the microtask queue; drain it.
const settle = () => new Promise((r) => setTimeout(r, 0));

async function advance(world, seconds) {
  for (let i = 0; i < seconds; i++) {
    world.now += TICK_MS;
    if (world.occupied) world.hb.onTick();
    await settle();
  }
}

// --- 1. Full session: boot → edge(join) → periodic×N → edge(leave) → quiet ---
{
  const w = makeWorld();
  // idle→occupied: first player connects
  w.occupied = true;
  w.hb.onBoot();
  await settle();
  w.players = 1;
  w.hb.onEdge();
  await advance(w, HEARTBEAT_EDGE_DEBOUNCE_S + 1); // debounced edge flushes
  await advance(w, 130); // two periodic beats
  w.players = 2;
  w.hb.onEdge(); // second join
  await advance(w, HEARTBEAT_EDGE_DEBOUNCE_S + 1);
  w.players = 1;
  w.hb.onEdge(); // leave
  await advance(w, HEARTBEAT_EDGE_DEBOUNCE_S + 1);
  // last leaver → stopAndPersist → quiet AFTER stopTicking
  w.players = 0;
  w.occupied = false;
  w.hb.onQuiet();
  await settle();

  const events = w.beats.map((b) => b.event);
  assert.equal(events[0], "boot", `boot first, got ${events}`);
  assert.equal(events[1], "edge", "join edge after debounce");
  assert.equal(w.beats[1].players, 1);
  assert.ok(
    events.slice(2, -3).every((e) => e === "periodic"),
    `middle beats periodic: ${events}`,
  );
  assert.equal(events.at(-3), "edge");
  assert.equal(w.beats.at(-3).players, 2);
  assert.equal(events.at(-2), "edge");
  assert.equal(w.beats.at(-2).players, 1);
  assert.equal(events.at(-1), "quiet");
  assert.equal(w.beats.at(-1).players, 0);
  assert.equal(w.beats.at(-1).status, "idle");
  // Gap contract: consecutive periodic beats 50–70 s apart (jitter pinned 0 → 60);
  // and EVERY beat reschedules, so no gap between ANY beats exceeds INTERVAL+JITTER.
  for (let i = 1; i < w.beats.length; i++) {
    const gapS = (w.beats[i].sentAt - w.beats[i - 1].sentAt) / 1000;
    assert.ok(
      gapS <= HEARTBEAT_INTERVAL_S + HEARTBEAT_JITTER_S + 5,
      `gap ${gapS}s exceeds interval+jitter`,
    );
    if (w.beats[i].event === "periodic" && w.beats[i - 1].event === "periodic") {
      assert.ok(gapS >= 50 && gapS <= 70, `periodic gap ${gapS}s outside 50-70s`);
    }
  }
  assert.equal(w.warns.length, 0, `clean run must not warn: ${w.warns}`);
  console.log(`session cadence OK (${events.join(" → ")})`);
}

// --- 2. Edge debounce: N joins in one window → ONE edge beat ---
{
  const w = makeWorld();
  w.occupied = true;
  w.hb.onBoot();
  await settle();
  for (let i = 0; i < 5; i++) {
    w.players++;
    w.hb.onEdge();
    await advance(w, 2);
  }
  await advance(w, HEARTBEAT_EDGE_DEBOUNCE_S);
  const edges = w.beats.filter((b) => b.event === "edge");
  assert.equal(edges.length, 1, `5 rapid joins → 1 debounced edge, got ${edges.length}`);
  assert.equal(edges[0].players, 5, "trailing edge carries the settled count");
  console.log("edge debounce OK (5 joins → 1 beat, players=5)");
}

// --- 3. Failure → warn + exponential backoff, edge suppressed, recovery resets ---
{
  let failing = true;
  const w = makeWorld({
    respond: () => {
      if (failing) return new Response(null, { status: 503 });
      return new Response(null, { status: 204 });
    },
  });
  w.occupied = true;
  w.players = 1;
  w.hb.onBoot(); // fails → backoff 60s
  await settle();
  assert.equal(w.warns.length, 1);
  assert.match(w.warns[0], /backing off 60s/);
  const beatsAfterFail = w.beats.length;
  w.hb.onEdge();
  await advance(w, 30); // inside the backoff window: edge suppressed
  assert.equal(w.beats.length, beatsAfterFail, "no beats during backoff");
  await advance(w, 40); // backoff expires → retry fails → 120s
  assert.match(w.warns.at(-1), /backing off 120s/);
  failing = false;
  await advance(w, 130); // retry succeeds → backoff reset
  const okBeat = w.beats.at(-1);
  assert.ok(okBeat, "beat sent after recovery");
  await advance(w, 70);
  assert.equal(w.beats.at(-1).event, "periodic", "normal periodic cadence resumed");
  console.log("failure backoff OK (60s → 120s → reset on success)");
}

// --- 4. 401 → loud warn + disarm until restart ---
{
  const w = makeWorld({ respond: () => new Response(null, { status: 401 }) });
  w.occupied = true;
  w.players = 1;
  w.hb.onBoot();
  await settle();
  assert.equal(w.warns.length, 1);
  assert.match(w.warns[0], /401.*unlisted.*disarming/);
  const n = w.beats.length;
  w.hb.onEdge();
  await advance(w, 200);
  w.hb.onQuiet();
  await settle();
  assert.equal(w.beats.length, n, "disarmed sender sends nothing more");
  console.log("401 disarm OK");
}

// --- 5. 429 honors Retry-After ---
{
  let limited = true;
  const w = makeWorld({
    respond: () =>
      limited
        ? new Response(null, { status: 429, headers: { "retry-after": "45" } })
        : new Response(null, { status: 204 }),
  });
  w.occupied = true;
  w.players = 1;
  w.hb.onBoot();
  await settle();
  limited = false;
  const n = w.beats.length;
  await advance(w, 40);
  assert.equal(w.beats.length, n, "silent through Retry-After window");
  await advance(w, 30);
  assert.ok(w.beats.length > n, "resumes after Retry-After");
  console.log("429 Retry-After OK");
}

// --- 6. Env unset → completely inert, zero outbound requests ---
{
  let fetches = 0;
  const hb = new DirectoryHeartbeat({
    directoryUrl: undefined,
    directoryToken: undefined,
    buildInfo: () => makeInfo(1, "occupied"),
    fetchFn: async () => {
      fetches++;
      return new Response(null, { status: 204 });
    },
    now: () => 1_000_000_000_000,
    random: () => 0.5,
    warn: () => {},
  });
  hb.onBoot();
  hb.onEdge();
  for (let i = 0; i < 500; i++) hb.onTick();
  hb.onQuiet();
  await settle();
  assert.equal(fetches, 0, "unset env must produce zero outbound requests");
  console.log("inert-when-unset OK");
}

console.log("heartbeat-cadence: all checks passed");
