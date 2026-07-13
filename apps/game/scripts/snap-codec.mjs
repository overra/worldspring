#!/usr/bin/env node
// Snap wire-codec harness (CI-run via `pnpm test`) — proves the binary snapshot
// codec (packages/shared/src/snapCodec.ts) round-trips the EXACT SnapMsg shape
// the JSON path produced. decodeSnap(encodeSnap(s)) must equal s: byte-exact for
// the JSON-tail fields (you/events/drops/time/weather/tick/ack/count and the
// fog/felled/planted deltas), and within quantization tolerance for the
// interpolated entity transforms (x/y/z ~0.8cm, yaw, quaternion). It also pins
// the invariants the wire depends on: null item/name/seat sentinels, every
// closed-enum value, the additive ItemType/BodyKind strings, angle wrapping past
// +-PI, and that absent optional deltas decode back to `undefined`.

import { encodeSnap, decodeSnap, decodeServerFrame } from "@worldspring/shared/snapCodec";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`  ok — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
};

const POS_TOL = 0.02; // m — POS_SCALE (256/32767 ~= 0.0078) + f32 ref slop
const YAW_TOL = 0.001; // rad — YAW_SCALE ~= 0.0001
const Q_TOL = 0.001;

const wrap = (a) => {
  const TWO_PI = Math.PI * 2;
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x < -Math.PI) x += TWO_PI;
  return x;
};
const angClose = (a, b, tol) => {
  let d = Math.abs(wrap(a) - wrap(b));
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d <= tol;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const posClose = (e, o, ref) =>
  near(e.x, o.x, POS_TOL) && near(e.y, o.y, POS_TOL) && near(e.z, o.z, POS_TOL);

// A representative reference position (the receiving player). Binary entities
// are encoded as i16 offsets from it; most sit inside the real 220 m interest
// filter, but players[2] is pushed to ~200 m on each of x/z on purpose — near
// the +-256 m per-axis codec window — to prove offsets that large don't clamp.
const YOU = {
  x: 123.45,
  y: 6.78,
  z: -90.12,
  vy: -2.5,
  grounded: false,
  realm: "overworld",
  hp: 87,
  food: 55,
  water: 40,
  temp: 20,
  action: { kind: "craft", remainingS: 1.25, totalS: 3.5 },
  seat: { id: 9001, index: 0, fuel: 42.5, hp: 88, speed: 12.34 },
};

const off = (base, dx, dy, dz) => ({ x: base.x + dx, y: base.y + dy, z: base.z + dz });

// A maximal snap: every array populated, every optional flag exercised, both
// realms, all enum values, null sentinels, angle > PI, UTF-8 name.
const full = {
  t: "snap",
  tick: 123456,
  time: 4321.75,
  ack: 987654,
  you: YOU,
  players: [
    { id: "self", name: "Överlord", ...off(YOU, 0, 0, 0), yaw: 0.5, hp: 87, item: "rifle", anim: 7 },
    { id: "p2", name: "Bob", ...off(YOU, 12.5, 1.2, -8.3), yaw: 3.5, hp: 100, item: null, anim: 0 },
    { id: "p3", name: "", ...off(YOU, -200, -5, 199.9), yaw: -4.0, hp: 1, item: "bandage", anim: 2 },
  ],
  zombies: [
    { id: 1, ...off(YOU, 5, 0, 5), yaw: 1.1, state: "idle", mil: false },
    { id: 2, ...off(YOU, -5, 0, -5), yaw: -1.1, state: "wander", mil: true },
    { id: 3, ...off(YOU, 10, 0, -10), yaw: 2.2, state: "chase", mil: false },
    { id: 4, ...off(YOU, -10, 0, 10), yaw: -2.2, state: "attack", mil: true },
  ],
  loot: [
    { id: 10, type: "wood", count: 300, ...off(YOU, 3, 0, 3) },
    { id: 11, type: "pistol_ammo", count: 1, ...off(YOU, -3, 0, -3) },
  ],
  corpses: [
    { id: 20, kind: "player", name: "Fallen", ...off(YOU, 6, 0, 6), yaw: 0.3, items: 5 },
    { id: 21, kind: "zombie", name: null, ...off(YOU, -6, 0, -6), yaw: -0.3, items: 0 },
  ],
  fires: [{ id: 30, ...off(YOU, 2, 0, 2) }],
  portals: [
    { id: 40, ...off(YOU, 7, 0, 7), to: "red" },
    { id: 41, ...off(YOU, -7, 0, -7), to: "overworld" },
  ],
  bodies: [
    // crate: no optional fields
    { id: 50, kind: "crate", ...off(YOU, 4, 0, 4), q: [0, 0, 0, 1] },
    // trunk: dims + asleep
    { id: 51, kind: "trunk", ...off(YOU, -4, 0, -4), q: [0.1, 0.2, 0.3, 0.927], dims: [0.5, 8.25, 0.5], asleep: true },
    // barrel: bare
    { id: 52, kind: "barrel", ...off(YOU, 8, 0, -8), q: [-0.5, 0.5, -0.5, 0.5] },
    // vehicle: seats (driver + empty) + wrecked
    { id: 53, kind: "vehicle", ...off(YOU, -8, 0, 8), q: [0, 0.707, 0, 0.707], seats: ["p2", null], wrecked: true },
    // an unknown future kind (additive contract): must round-trip the string
    { id: 54, kind: "hovercraft", ...off(YOU, 1, 0, 1), q: [0, 0, 0, 1] },
  ],
  drops: [
    { id: 60, x: 700, y: 120, z: -650, smoke: true, falling: false },
    { id: 61, x: -400, y: 5, z: 400, smoke: false, falling: true },
  ],
  animals: [
    { id: 70, ...off(YOU, 9, 0, 9), yaw: 0.9, state: "idle" },
    { id: 71, ...off(YOU, -9, 0, -9), yaw: -0.9, state: "wander" },
    { id: 72, ...off(YOU, 11, 0, -11), yaw: 1.9, state: "flee" },
  ],
  weather: 0.42,
  events: [
    { e: "shot", w: "rifle", sx: 1, sy: 2, sz: 3, tx: 4, ty: 5, tz: 6 },
    { e: "swing", id: "p2" },
    { e: "hit", x: 7, y: 8, z: 9 },
    { e: "zdie", x: 10, y: 11, z: 12 },
    { e: "break", id: 52, kind: "barrel", x: 13, y: 14, z: 15, q: [0, 0, 0, 1] },
    { e: "treeCut", id: 99, species: "oak", final: true, x: 16, y: 17, z: 18 },
    { e: "hurt" },
  ],
  count: 3,
  fog: [100, 101, 102],
  felled: [7, 8],
  planted: [
    { op: "upsert", tree: { i: 5, s: "pine", x: 1, z: 2, r: 0.5, h: 0.8, age: 3 } },
    { op: "remove", id: 6 },
  ],
};

console.log("snap-codec: round-trip full snapshot");
const buf = encodeSnap(full);
ok(buf instanceof ArrayBuffer, `encodeSnap returns an ArrayBuffer (${buf.byteLength} bytes)`);
const d = decodeSnap(buf);

// --- Byte-exact scalars + JSON tail ---
ok(d.t === "snap", "t is snap");
ok(d.tick === full.tick, "tick exact");
ok(d.ack === full.ack, "ack exact (reconciliation depends on it)");
ok(d.count === full.count, "count exact");
ok(d.time === full.time, "time exact (JSON tail)");
ok(d.weather === full.weather, "weather exact (JSON tail)");
ok(JSON.stringify(d.you) === JSON.stringify(full.you), "you exact incl. action + seat (JSON tail)");
ok(JSON.stringify(d.drops) === JSON.stringify(full.drops), "drops exact incl. far/high positions (JSON tail)");
ok(JSON.stringify(d.events) === JSON.stringify(full.events), "events exact — all 7 kinds (JSON tail)");
ok(JSON.stringify(d.fog) === JSON.stringify(full.fog), "fog delta exact");
ok(JSON.stringify(d.felled) === JSON.stringify(full.felled), "felled delta exact");
ok(JSON.stringify(d.planted) === JSON.stringify(full.planted), "planted delta exact");

// --- Players ---
ok(d.players.length === 3, "players length");
for (let i = 0; i < 3; i++) {
  const o = full.players[i];
  const e = d.players[i];
  ok(e.id === o.id && e.name === o.name, `player[${i}] id + name (UTF-8) exact`);
  ok(posClose(e, o), `player[${i}] position within tol`);
  ok(angClose(e.yaw, o.yaw, YAW_TOL), `player[${i}] yaw within tol (incl. wrap past PI)`);
  ok(e.hp === o.hp, `player[${i}] hp exact`);
  ok(e.item === o.item, `player[${i}] item preserved (${o.item === null ? "null sentinel" : o.item})`);
  ok(e.anim === o.anim, `player[${i}] anim flags exact`);
}

// --- Zombies (every state + mil) ---
ok(d.zombies.length === 4, "zombies length");
for (let i = 0; i < 4; i++) {
  const o = full.zombies[i];
  const e = d.zombies[i];
  ok(e.id === o.id && posClose(e, o) && angClose(e.yaw, o.yaw, YAW_TOL), `zombie[${i}] id/pos/yaw`);
  ok(e.state === o.state, `zombie[${i}] state '${o.state}' exact`);
  ok(e.mil === o.mil, `zombie[${i}] mil flag exact`);
}

// --- Loot ---
ok(d.loot.length === 2, "loot length");
ok(d.loot[0].type === "wood" && d.loot[0].count === 300, "loot type + count exact (count>255 exercises u16)");
ok(posClose(d.loot[0], full.loot[0]), "loot position within tol");

// --- Corpses (player w/ name, zombie w/ null name) ---
ok(d.corpses.length === 2, "corpses length");
ok(d.corpses[0].kind === "player" && d.corpses[0].name === "Fallen" && d.corpses[0].items === 5, "player corpse kind/name/items");
ok(d.corpses[1].kind === "zombie" && d.corpses[1].name === null && d.corpses[1].items === 0, "zombie corpse null name sentinel");

// --- Fires / portals ---
ok(d.fires.length === 1 && posClose(d.fires[0], full.fires[0]), "fire position");
ok(d.portals[0].to === "red" && d.portals[1].to === "overworld", "portal realm enum both values");

// --- Bodies (optional-field matrix + additive kind string) ---
ok(d.bodies.length === 5, "bodies length");
const bc = d.bodies[0], bt = d.bodies[1], bb = d.bodies[2], bv = d.bodies[3], bh = d.bodies[4];
ok(bc.kind === "crate" && bc.dims === undefined && bc.asleep === undefined && bc.seats === undefined && bc.wrecked === undefined, "crate: no optional fields present");
ok(bt.kind === "trunk" && Array.isArray(bt.dims) && bt.asleep === true, "trunk: dims + asleep flags");
ok(near(bt.dims[1], 8.25, POS_TOL), "trunk dims quantized within tol");
ok(bt.q.every((v, k) => near(v, full.bodies[1].q[k], Q_TOL)), "trunk quaternion within tol");
ok(bb.kind === "barrel" && bb.dims === undefined && bb.seats === undefined && bb.wrecked === undefined, "barrel: bare");
ok(bv.kind === "vehicle" && Array.isArray(bv.seats) && bv.seats[0] === "p2" && bv.seats[1] === null && bv.wrecked === true, "vehicle: seats (id + null) + wrecked");
ok(bh.kind === "hovercraft", "unknown BodyKind string survives (additive contract)");

// --- Animals (every state) ---
ok(d.animals.length === 3 && d.animals[0].state === "idle" && d.animals[1].state === "wander" && d.animals[2].state === "flee", "animals: all 3 states");

// --- Minimal snap: empty arrays, no optional deltas -> stay undefined ---
console.log("snap-codec: round-trip minimal snapshot");
const minimal = {
  t: "snap",
  tick: 0,
  time: 0,
  ack: 0,
  you: { x: 0, y: 0, z: 0, vy: 0, grounded: true, realm: "overworld", hp: 100, food: 100, water: 100, temp: 20 },
  players: [],
  zombies: [],
  loot: [],
  corpses: [],
  fires: [],
  portals: [],
  bodies: [],
  drops: [],
  animals: [],
  weather: 0,
  events: [],
  count: 1,
};
const dm = decodeSnap(encodeSnap(minimal));
ok(dm.players.length === 0 && dm.zombies.length === 0 && dm.bodies.length === 0, "minimal: all arrays empty");
ok(dm.fog === undefined && dm.felled === undefined && dm.planted === undefined, "absent deltas decode to undefined (matches JSON omission)");
ok(dm.you.action === undefined && dm.you.seat === undefined, "absent you.action/seat stay absent");
ok(JSON.stringify(dm.you) === JSON.stringify(minimal.you), "minimal you exact");

// --- Bad magic throws ---
console.log("snap-codec: guards");
let threw = false;
try {
  decodeSnap(new ArrayBuffer(32));
} catch {
  threw = true;
}
ok(threw, "decodeSnap throws on a zeroed/bad-magic buffer");

// --- decodeServerFrame: the shared binary/text dispatch used by the client +
//     the live smoke harnesses ---
console.log("snap-codec: decodeServerFrame dispatch");
const framedSnap = decodeServerFrame(encodeSnap(full));
ok(framedSnap !== null && framedSnap.t === "snap" && framedSnap.tick === full.tick, "binary frame -> decoded snap");
const framedText = decodeServerFrame(JSON.stringify({ t: "welcome", id: "x" }));
ok(framedText !== null && framedText.t === "welcome", "text frame -> JSON.parse'd message");
ok(decodeServerFrame(12345) === null, "non-string/non-ArrayBuffer frame -> null (e.g. a Blob)");
let threwFrame = false;
try {
  decodeServerFrame("{not json");
} catch {
  threwFrame = true;
}
ok(threwFrame, "malformed text frame throws (caller logs + drops)");

// --- Size win sanity: binary is much smaller than JSON ---
const jsonBytes = new TextEncoder().encode(JSON.stringify(full)).byteLength;
ok(buf.byteLength < jsonBytes * 0.6, `binary ${buf.byteLength}B < 60% of JSON ${jsonBytes}B`);
console.log(`  info — full snap: JSON ${jsonBytes}B -> binary ${buf.byteLength}B (${((buf.byteLength / jsonBytes) * 100).toFixed(0)}%)`);

if (failures > 0) {
  console.error(`\nsnap-codec: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nsnap-codec: ALL OK");
