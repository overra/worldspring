// Binary wire codec for the per-tick `snap` message — the one hot-path message
// (built + sent per connected client, every tick). Everything else on the wire
// stays JSON; only `snap` rides this format.
//
// Shape of the frame (little-endian):
//   [header] magic u8 · format u8 · tick u32 · ack u32 · count u16 ·
//            refX f32 · refY f32 · refZ f32          (ref = the receiving
//                                                      player's position)
//   [8 entity sections] players, zombies, loot, corpses, fires, portals,
//            bodies, animals — each a u16 count then that many packed entries.
//            Entity x/y/z are i16 OFFSETS from ref (entities are interest-
//            filtered to <=220 m, so a +-256 m range gives ~0.8 cm resolution —
//            finer than the JSON path's round2). Yaw and quaternion components
//            are i16; the CLOSED enums (zombie/animal state, realm) are u8
//            indices; the ADDITIVE enums (ItemType, BodyKind) and all names/ids
//            stay length-prefixed strings so they keep growing without a
//            PROTOCOL_VERSION bump (their documented contract).
//   [tail] a u32-length-prefixed UTF-8 JSON blob of everything that must stay
//            byte-exact: { time, weather, you, drops, events, fog?, felled?,
//            planted? }. Reconciliation (`ack`/`you`), lag-comp (`time`), the
//            GameEvent union, the island-wide `drops`, and the small deltas all
//            live here, so quantization tolerance touches ONLY interpolated
//            entity transforms.
//
// decodeSnap reconstructs the EXACT SnapMsg object the JSON path produced, so
// every downstream consumer (onSnap/pushSnap/reconcile) is untouched. Parity is
// proven by apps/game/scripts/snap-codec.mjs (round-trips every field + edge).
//
// All imports are TYPE-ONLY (the enum orders are defined here as local arrays),
// so this module is safe under `node --experimental-strip-types` in the
// offline harnesses that import it.

import type {
  AnimalState,
  BodyKind,
  Realm,
  ServerMsg,
  WireAnimal,
  WireBody,
  WireCorpse,
  WireDrop,
  WireFire,
  WireLoot,
  WirePlayer,
  WirePortal,
  WireZombie,
  ZombieState,
} from "./protocol";

type SnapMsg = Extract<ServerMsg, { t: "snap" }>;

const MAGIC = 0x57; // 'W'
const FORMAT = 1;

// Closed enums: a new value here IS a protocol-shape change (doc 03) and forces
// a PROTOCOL_VERSION bump, so an index mapping is safe. Order is WIRE-CRITICAL —
// append only, never reorder.
const ZOMBIE_STATES: readonly ZombieState[] = ["idle", "wander", "chase", "attack"];
const ANIMAL_STATES: readonly AnimalState[] = ["idle", "wander", "flee"];
const REALMS: readonly Realm[] = ["overworld", "red"];

// Entities are interest-filtered to <= INTEREST_RADIUS (220 m) from the ref, so
// a +-256 m offset window covers them with margin; i16 over that window is
// ~0.0078 m/step. Anything outside clamps to the edge (never happens in
// practice) rather than wrapping.
const POS_RANGE = 256;
const POS_SCALE = POS_RANGE / 32767;
const YAW_SCALE = Math.PI / 32767; // yaw normalized to [-PI, PI] before packing
const Q_SCALE = 1 / 32767; // quaternion components are unit-bounded [-1, 1]

const TE = new TextEncoder();
const TD = new TextDecoder();

const clampI16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0);
const clampU8 = (v: number): number => (v > 255 ? 255 : v < 0 ? 0 : v | 0);

/** Normalize any angle to [-PI, PI]; yaw is modular so this is lossless for
 * rendering (rotation.y / angleLerp both wrap). */
function wrapAngle(a: number): number {
  const TWO_PI = Math.PI * 2;
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x < -Math.PI) x += TWO_PI;
  return x;
}

class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8: Uint8Array;
  off = 0;
  constructor(initial = 2048) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
  }
  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.off + n) cap *= 2;
    const nbuf = new ArrayBuffer(cap);
    new Uint8Array(nbuf).set(this.u8);
    this.buf = nbuf;
    this.view = new DataView(nbuf);
    this.u8 = new Uint8Array(nbuf);
  }
  u8w(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }
  u16w(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
  }
  u32w(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }
  i16w(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.off, clampI16(Math.round(v)), true);
    this.off += 2;
  }
  f32w(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
  }
  strw(s: string): void {
    const b = TE.encode(s);
    this.u16w(b.length);
    this.ensure(b.length);
    this.u8.set(b, this.off);
    this.off += b.length;
  }
  blobU32(b: Uint8Array): void {
    this.u32w(b.length);
    this.ensure(b.length);
    this.u8.set(b, this.off);
    this.off += b.length;
  }
  bytes(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }
}

class ByteReader {
  private view: DataView;
  private u8: Uint8Array;
  off = 0;
  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.u8 = new Uint8Array(buf);
  }
  u8r(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u16r(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32r(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  i16r(): number {
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  f32r(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  strr(): string {
    const n = this.u16r();
    const s = TD.decode(this.u8.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
  blobU32(): Uint8Array {
    const n = this.u32r();
    const b = this.u8.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

const qW = (w: ByteWriter, v: number): void => w.i16w(v / Q_SCALE);
const qR = (r: ByteReader): number => r.i16r() * Q_SCALE;
const yawW = (w: ByteWriter, v: number): void => w.i16w(wrapAngle(v) / YAW_SCALE);
const yawR = (r: ByteReader): number => r.i16r() * YAW_SCALE;

/** Encode the `snap` message to a compact binary frame. `snap.you.{x,y,z}` is
 * the offset reference for every entity in this client's snapshot. */
export function encodeSnap(snap: SnapMsg): ArrayBuffer {
  const w = new ByteWriter();
  const rx = snap.you.x;
  const ry = snap.you.y;
  const rz = snap.you.z;

  w.u8w(MAGIC);
  w.u8w(FORMAT);
  w.u32w(snap.tick);
  w.u32w(snap.ack);
  w.u16w(snap.count);
  w.f32w(rx);
  w.f32w(ry);
  w.f32w(rz);

  const offW = (v: number, ref: number): void => w.i16w((v - ref) / POS_SCALE);
  const sizeW = (v: number): void => w.i16w(v / POS_SCALE);

  // players
  w.u16w(snap.players.length);
  for (const p of snap.players) {
    w.strw(p.id);
    w.strw(p.name);
    offW(p.x, rx);
    offW(p.y, ry);
    offW(p.z, rz);
    yawW(w, p.yaw);
    w.u8w(clampU8(p.hp));
    w.strw(p.item ?? ""); // "" == null (ItemType is never the empty string)
    w.u8w(p.anim);
  }

  // zombies
  w.u16w(snap.zombies.length);
  for (const z of snap.zombies) {
    w.u32w(z.id);
    offW(z.x, rx);
    offW(z.y, ry);
    offW(z.z, rz);
    yawW(w, z.yaw);
    const state = ZOMBIE_STATES.indexOf(z.state);
    w.u8w((state < 0 ? 0 : state) | (z.mil ? 0x80 : 0));
  }

  // loot
  w.u16w(snap.loot.length);
  for (const l of snap.loot) {
    w.u32w(l.id);
    w.strw(l.type);
    w.u16w(l.count);
    offW(l.x, rx);
    offW(l.y, ry);
    offW(l.z, rz);
  }

  // corpses
  w.u16w(snap.corpses.length);
  for (const c of snap.corpses) {
    w.u32w(c.id);
    const hasName = c.name !== null && c.name !== undefined;
    w.u8w((c.kind === "zombie" ? 1 : 0) | (hasName ? 2 : 0));
    if (hasName) w.strw(c.name as string);
    offW(c.x, rx);
    offW(c.y, ry);
    offW(c.z, rz);
    yawW(w, c.yaw);
    w.u8w(clampU8(c.items));
  }

  // fires
  w.u16w(snap.fires.length);
  for (const f of snap.fires) {
    w.u32w(f.id);
    offW(f.x, rx);
    offW(f.y, ry);
    offW(f.z, rz);
  }

  // portals
  w.u16w(snap.portals.length);
  for (const p of snap.portals) {
    w.u32w(p.id);
    offW(p.x, rx);
    offW(p.y, ry);
    offW(p.z, rz);
    const to = REALMS.indexOf(p.to);
    w.u8w(to < 0 ? 0 : to);
  }

  // bodies (the only entry with optional fields — a flags byte gates them)
  w.u16w(snap.bodies.length);
  for (const b of snap.bodies) {
    w.u32w(b.id);
    w.strw(b.kind);
    let flags = 0;
    if (b.dims) flags |= 1;
    if (b.asleep) flags |= 2;
    if (b.seats) flags |= 4;
    if (b.wrecked) flags |= 8;
    w.u8w(flags);
    offW(b.x, rx);
    offW(b.y, ry);
    offW(b.z, rz);
    qW(w, b.q[0]);
    qW(w, b.q[1]);
    qW(w, b.q[2]);
    qW(w, b.q[3]);
    if (b.dims) {
      sizeW(b.dims[0]);
      sizeW(b.dims[1]);
      sizeW(b.dims[2]);
    }
    if (b.seats) {
      w.u16w(b.seats.length);
      for (const s of b.seats) w.strw(s ?? ""); // "" == null (empty seat)
    }
  }

  // animals
  w.u16w(snap.animals.length);
  for (const a of snap.animals) {
    w.u32w(a.id);
    offW(a.x, rx);
    offW(a.y, ry);
    offW(a.z, rz);
    yawW(w, a.yaw);
    const state = ANIMAL_STATES.indexOf(a.state);
    w.u8w(state < 0 ? 0 : state);
  }

  // Exact JSON tail. Optional deltas are added only when present, so a decoded
  // snap has them `undefined` exactly like the JSON path omits them.
  const tail: Record<string, unknown> = {
    time: snap.time,
    weather: snap.weather,
    you: snap.you,
    drops: snap.drops,
    events: snap.events,
  };
  if (snap.fog !== undefined) tail.fog = snap.fog;
  if (snap.felled !== undefined) tail.felled = snap.felled;
  if (snap.planted !== undefined) tail.planted = snap.planted;
  w.blobU32(TE.encode(JSON.stringify(tail)));

  return w.bytes();
}

/** Decode a binary `snap` frame back to the exact SnapMsg the JSON path built.
 * Throws on a bad magic/format so the caller can log + drop the frame. */
export function decodeSnap(buf: ArrayBuffer): SnapMsg {
  const r = new ByteReader(buf);
  if (r.u8r() !== MAGIC) throw new Error("snapCodec: bad magic");
  const format = r.u8r();
  if (format !== FORMAT) throw new Error(`snapCodec: unsupported format ${format}`);
  const tick = r.u32r();
  const ack = r.u32r();
  const count = r.u16r();
  const rx = r.f32r();
  const ry = r.f32r();
  const rz = r.f32r();

  const offR = (ref: number): number => ref + r.i16r() * POS_SCALE;
  const sizeR = (): number => r.i16r() * POS_SCALE;

  const players: WirePlayer[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.strr();
    const name = r.strr();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const yaw = yawR(r);
    const hp = r.u8r();
    const itemStr = r.strr();
    const anim = r.u8r();
    players.push({ id, name, x, y, z, yaw, hp, item: itemStr === "" ? null : (itemStr as WirePlayer["item"]), anim });
  }

  const zombies: WireZombie[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const yaw = yawR(r);
    const sf = r.u8r();
    zombies.push({ id, x, y, z, yaw, state: ZOMBIE_STATES[sf & 0x7f] ?? "idle", mil: (sf & 0x80) !== 0 });
  }

  const loot: WireLoot[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const type = r.strr() as WireLoot["type"];
    const cnt = r.u16r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    loot.push({ id, type, count: cnt, x, y, z });
  }

  const corpses: WireCorpse[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const flags = r.u8r();
    const name = (flags & 2) !== 0 ? r.strr() : null;
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const yaw = yawR(r);
    const items = r.u8r();
    corpses.push({ id, kind: (flags & 1) !== 0 ? "zombie" : "player", name, x, y, z, yaw, items });
  }

  const fires: WireFire[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    fires.push({ id, x, y, z });
  }

  const portals: WirePortal[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const to = REALMS[r.u8r()] ?? "overworld";
    portals.push({ id, x, y, z, to });
  }

  const bodies: WireBody[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const kind = r.strr() as BodyKind;
    const flags = r.u8r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const q: [number, number, number, number] = [qR(r), qR(r), qR(r), qR(r)];
    const body: WireBody = { id, kind, x, y, z, q };
    if ((flags & 1) !== 0) body.dims = [sizeR(), sizeR(), sizeR()];
    if ((flags & 2) !== 0) body.asleep = true;
    if ((flags & 4) !== 0) {
      const seats: (string | null)[] = [];
      for (let sn = r.u16r(), j = 0; j < sn; j++) {
        const s = r.strr();
        seats.push(s === "" ? null : s);
      }
      body.seats = seats;
    }
    if ((flags & 8) !== 0) body.wrecked = true;
    bodies.push(body);
  }

  const animals: WireAnimal[] = [];
  for (let n = r.u16r(), i = 0; i < n; i++) {
    const id = r.u32r();
    const x = offR(rx);
    const y = offR(ry);
    const z = offR(rz);
    const yaw = yawR(r);
    animals.push({ id, x, y, z, yaw, state: ANIMAL_STATES[r.u8r()] ?? "idle" });
  }

  const tail = JSON.parse(TD.decode(r.blobU32())) as {
    time: number;
    weather: number;
    you: SnapMsg["you"];
    drops: WireDrop[];
    events: SnapMsg["events"];
    fog?: number[];
    felled?: number[];
    planted?: SnapMsg["planted"];
  };

  const snap: SnapMsg = {
    t: "snap",
    tick,
    time: tail.time,
    ack,
    you: tail.you,
    players,
    zombies,
    loot,
    corpses,
    fires,
    portals,
    bodies,
    drops: tail.drops,
    animals,
    weather: tail.weather,
    events: tail.events,
    count,
  };
  if (tail.fog !== undefined) snap.fog = tail.fog;
  if (tail.felled !== undefined) snap.felled = tail.felled;
  if (tail.planted !== undefined) snap.planted = tail.planted;
  return snap;
}

/**
 * Decode one inbound server WebSocket frame into a ServerMsg. This is THE wire
 * contract: a binary (ArrayBuffer) frame is a snapshot (snapCodec), a text frame
 * is JSON. Centralizing it keeps the client and the offline harnesses in
 * lock-step — a second binary message type would change only here.
 *
 * Throws on a malformed/unrecognized frame (bad magic, bad JSON) so the caller
 * can log + drop it. Returns null for a payload that is neither string nor
 * ArrayBuffer (e.g. a Blob when binaryType wasn't set to "arraybuffer").
 */
export function decodeServerFrame(data: unknown): ServerMsg | null {
  if (data instanceof ArrayBuffer) return decodeSnap(data);
  if (typeof data === "string") return JSON.parse(data) as ServerMsg;
  return null;
}
