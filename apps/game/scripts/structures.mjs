#!/usr/bin/env node
// Base-building harness (doc 06 core slice) — CI-run via `pnpm test`.
//
//   node --experimental-strip-types apps/game/scripts/structures.mjs
//
// Four layers:
//   1. WIRE — parseClientMsg shape checks for place/demolish/door and the
//      PROTOCOL_VERSION 8→9 bump.
//   2. SHARED — the real createWorld + structures index: every canPlace
//      rejection class, index-vs-statics consistency (queryStatics/
//      groundHeight/raycastStatics see placed pieces), and stepPlayer
//      collision parity (blocked by wall, passes doorway, door open/close,
//      steps onto foundations) — the client-prediction identicality guard.
//   3. SYSTEMS — bundles the REAL systems/structures.ts (+ players.ts) with
//      esbuild (the wear-slots.mjs data-URL pattern) and drives handlePlace/
//      handleDemolish/handleDoor over a fake GameState: hammer gate, cost
//      deduction, caps, config.building.enabled, realm gate, sFull batching,
//      and the wire-secrecy assertion (serialized messages carry NO
//      ownerHash/placedAtMs keys — asserted on JSON, not types).
//   4. PERSISTENCE — saveWorld → loadWorld round-trips pieces + ownership
//      meta as the additive WorldSnapshot field; old snapshots load clean;
//      the id ceiling folds piece ids.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  BUILD_CELL,
  BUILD_DENSITY_CAP,
  WORLD_PIECE_CAP,
} from "@worldspring/shared/constants";
import { parseClientMsg, PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import {
  saveWorld,
  loadWorld,
  structureBucketOf,
  STRUCTURE_BUCKET_COUNT,
} from "../src/server/persistence.ts";

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"} — ${msg}`);
  if (!ok) failures++;
};

// Non-leaf shared modules (world/config/movement/structures value-import each
// other with extensionless relative paths) can't be strip-types-imported
// directly — bundle them with esbuild (the wear-slots.mjs data-URL pattern).
const sharedDir = fileURLToPath(new URL("../../../packages/shared", import.meta.url));
const systemsDir = fileURLToPath(new URL("../src/server/systems", import.meta.url));
const { build } = createRequire(sharedDir + "/scripts/x.mjs")("esbuild");

async function bundleModule(contents, resolveDir, sourcefile) {
  const out = await build({
    stdin: { contents, resolveDir, loader: "ts", sourcefile },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  return import(
    "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
  );
}

const shared = await bundleModule(
  'export * from "./src/structures.ts";\n' +
    'export { createWorld } from "./src/world.ts";\n' +
    'export { DEFAULT_CONFIG, worldParamsOf } from "./src/config.ts";\n' +
    'export { stepPlayer } from "./src/movement.ts";\n',
  sharedDir,
  "shared-harness-entry.ts",
);
const {
  canPlace,
  computeFoundationFloorY,
  createWorld,
  DEFAULT_CONFIG,
  PIECE_DEFS,
  pieceAabbs,
  PLACEABLE_KINDS,
  stepPlayer,
  worldParamsOf,
} = shared;

// --- 1. wire --------------------------------------------------------------
console.log("protocol (doc 06 wire):");
{
  // doc 06 forced the bump to 10; later milestones (doc 13 M4 → 11) push it
  // higher, so assert the floor rather than an exact value that every future
  // bump would have to touch.
  check(PROTOCOL_VERSION >= 10, `PROTOCOL_VERSION is at least 10 (got ${PROTOCOL_VERSION})`);
  const place = parseClientMsg(
    JSON.stringify({ t: "place", kind: "wall", tier: 1, gx: 4.9, gz: -3, edge: 2 }),
  );
  check(
    place?.t === "place" && place.kind === "wall" && place.tier === 1 && place.gx === 4 && place.gz === -3 && place.edge === 2,
    "place parses; gx coerced |0",
  );
  const noEdge = parseClientMsg(JSON.stringify({ t: "place", kind: "foundation", tier: 0, gx: 0, gz: 0 }));
  check(noEdge?.t === "place" && noEdge.edge === undefined, "place without edge parses (cell pieces)");
  // doc 06 M6 — crates ARE placeable now, with a round2'd free position.
  const crate = parseClientMsg(
    JSON.stringify({ t: "place", kind: "crate", tier: 0, gx: 0, gz: 0, x: 1.234, z: 2.567 }),
  );
  check(
    crate?.t === "place" && crate.kind === "crate" && crate.x === 1.23 && crate.z === 2.57,
    "crate place parses; x/z round2'd",
  );
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "crate", tier: 1, gx: 0, gz: 0 })) === null, "scrap-tier crate is malformed (wood-only v1)");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "crate", tier: 0, gx: 0, gz: 0, edge: 0 })) === null, "crate with edge is malformed");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "wall", tier: 0, gx: 0, gz: 0, edge: 0, x: 1, z: 1 })) === null, "free position on a non-crate kind is malformed");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "crate", tier: 0, gx: 0, gz: 0, x: 1 })) === null, "x without z is malformed");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "wall", tier: 2, gx: 0, gz: 0 })) === null, "tier outside 0|1 is malformed");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "wall", tier: 0, gx: 0, gz: 0, edge: 1 })) === null, "non-canonical edge is malformed");
  // review: a foundation with an attached edge would shift pieceCenter 1.5m
  // and shave every center-based server check — malformed on the wire.
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "foundation", tier: 0, gx: 0, gz: 0, edge: 0 })) === null, "foundation with edge is malformed");
  // review: |x| big enough to overflow the round2 (*100 → Infinity) must not
  // leak Infinity through the parse layer's no-NaN/Infinity contract.
  check(
    parseClientMsg(JSON.stringify({ t: "place", kind: "crate", tier: 0, gx: 0, gz: 0, x: 1e307, z: 1 })) === null,
    "crate x overflowing round2 to Infinity is malformed",
  );
  const far = parseClientMsg(JSON.stringify({ t: "place", kind: "foundation", tier: 0, gx: 99999, gz: -99999 }));
  check(far?.t === "place" && far.gx === 534 && far.gz === -534, "gx/gz clamped to the max-tier bound");
  check(parseClientMsg(JSON.stringify({ t: "demolish", id: 7.2 }))?.id === 7, "demolish parses, id |0");
  check(parseClientMsg(JSON.stringify({ t: "door", id: 5 }))?.t === "door", "door parses");
  check(parseClientMsg(JSON.stringify({ t: "door" })) === null, "door without id is malformed");

  // doc 06 M5 — locks.
  const setCode = parseClientMsg(JSON.stringify({ t: "setCode", id: 3, code: "0042" }));
  check(setCode?.t === "setCode" && setCode.code === "0042", "setCode parses (4 digits)");
  check(parseClientMsg(JSON.stringify({ t: "setCode", id: 3, code: "" }))?.code === "", "setCode with empty code parses (remove lock)");
  check(parseClientMsg(JSON.stringify({ t: "setCode", id: 3, code: "123" })) === null, "setCode with 3 digits is malformed");
  check(parseClientMsg(JSON.stringify({ t: "setCode", id: 3, code: "12a4" })) === null, "setCode with non-digits is malformed");
  const tryCode = parseClientMsg(JSON.stringify({ t: "tryCode", id: 3, code: "9999" }));
  check(tryCode?.t === "tryCode" && tryCode.code === "9999", "tryCode parses (4 digits)");
  check(parseClientMsg(JSON.stringify({ t: "tryCode", id: 3, code: "" })) === null, "tryCode with empty code is malformed (strict)");
  check(parseClientMsg(JSON.stringify({ t: "tryCode", id: 3, code: 1234 })) === null, "tryCode with a numeric code is malformed");

  // doc 06 M6 — containers.
  check(parseClientMsg(JSON.stringify({ t: "cOpen", id: 4.7 }))?.id === 4, "cOpen parses, id |0");
  const cMove = parseClientMsg(JSON.stringify({ t: "cMove", id: 4, from: 1.9, to: 3, dir: "in" }));
  check(cMove?.t === "cMove" && cMove.from === 1 && cMove.to === 3 && cMove.dir === "in", "cMove parses, slots |0");
  check(parseClientMsg(JSON.stringify({ t: "cMove", id: 4, from: 1, to: 3, dir: "sideways" })) === null, "cMove with an unknown dir is malformed");
  check(parseClientMsg(JSON.stringify({ t: "cMove", id: 4, from: 1, dir: "in" })) === null, "cMove without to is malformed");
}

// --- 2. shared index + canPlace + movement parity ---------------------------
console.log("shared (canPlace + index-vs-statics + movement):");

const world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));

/** Find a cell where a foundation is legally placeable (flat, dry, no zone). */
function findBuildableCell() {
  for (let r = 8; r < 120; r++) {
    for (const [gx, gz] of [
      [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r],
    ]) {
      if (canPlace(world, { kind: "foundation", tier: 0, gx, gz }) === null) return [gx, gz];
    }
  }
  throw new Error("no buildable cell found at seed 1337");
}
const [BGX, BGZ] = findBuildableCell();
console.log(`  (buildable cell at gx=${BGX}, gz=${BGZ})`);

{
  // Rejection classes.
  check(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ }) === null, "crate placeable (cell-center default, doc 06 M6)");
  check(canPlace(world, { kind: "spire", tier: 0, gx: BGX, gz: BGZ }) === "kind", "unknown kind rejected: kind");
  check(canPlace(world, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ, edge: 0 }) === "bounds", "foundation with stray edge rejected: bounds (defense-in-depth)");
  check(canPlace(world, { kind: "foundation", tier: 0, gx: 200, gz: 0 }) === "bounds", "out-of-bounds cell rejected: bounds");
  check(canPlace(world, { kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 0 }) === "no-foundation", "wall without foundation: no-foundation");
  check(canPlace(world, { kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0 }) === "no-doorway", "door without doorway: no-doorway");
  const town = world.towns[0];
  const tgx = Math.floor(town.cx / BUILD_CELL);
  const tgz = Math.floor(town.cz / BUILD_CELL);
  const townRej = canPlace(world, { kind: "foundation", tier: 0, gx: tgx, gz: tgz });
  check(townRej === "zone" || townRej === "occupied" || townRej === "overlap", `town center rejected (${townRej})`);
  const mgx = Math.floor(world.military.cx / BUILD_CELL);
  const mgz = Math.floor(world.military.cz / BUILD_CELL);
  check(canPlace(world, { kind: "foundation", tier: 0, gx: mgx, gz: mgz }) === "zone", "military compound rejected: zone");

  // Water: scan outward until a fully-wet cell shows up; canPlace checks
  // terrain BEFORE zones, so wet cells report water even near spawns.
  let waterRej = null;
  outer: for (let r = 100; r < 128; r++) {
    for (let g = -r; g <= r; g += 7) {
      const rej = canPlace(world, { kind: "foundation", tier: 0, gx: r, gz: g });
      if (rej === "water") { waterRej = rej; break outer; }
    }
  }
  check(waterRej === "water", "wet/shoreline cell rejected: water");

  // Occupant standing in the target cell blocks a wall on its edge.
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const cz = BGZ * BUILD_CELL + BUILD_CELL / 2;
  const fy = computeFoundationFloorY(world, BGX, BGZ);
  check(
    canPlace(world, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ }, [
      { x: cx, y: fy + 5, z: cz }, // airborne above — not blocked (y-aware)
    ]) === null,
    "occupant far above the slab does not block (y-aware)",
  );
}

// Place a base: foundation + wall(+Z), then swap wall→doorway→door.
{
  const fy = computeFoundationFloorY(world, BGX, BGZ);
  const foundation = { id: 1001, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 };
  world.structures.add(foundation);

  check(canPlace(world, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ }) === "occupied", "second foundation in the cell: occupied");
  check(canPlace(world, { kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 0 }) === null, "wall now anchors to the foundation");

  check(world.structures.floorAt(BGX * BUILD_CELL + 1, BGZ * BUILD_CELL + 1) === fy, "index floorAt returns the slab top");
  check(world.groundHeight(BGX * BUILD_CELL + 1.5, BGZ * BUILD_CELL + 1.5) === fy, "world.groundHeight folds the foundation in");

  const wall = { id: 1002, kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 400 };
  world.structures.add(wall);

  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const wallZ = (BGZ + 1) * BUILD_CELL;

  // queryStatics sees the wall box (structural compare — the index derives
  // its own boxes at add() time; identical values, not identical objects).
  const statics = world.queryStatics(cx, wallZ, 2);
  const wb = pieceAabbs(wall)[0];
  check(
    statics.walls.some(
      (w) => w.minX === wb.minX && w.maxX === wb.maxX && w.minZ === wb.minZ && w.maxZ === wb.maxZ && w.y0 === wb.y0 && w.y1 === wb.y1,
    ),
    "queryStatics returns the placed wall's box",
  );

  // Raycast occlusion + attribution.
  const origin = { x: cx, y: fy + 1.3, z: wallZ - 2 };
  const dir = { x: 0, y: 0, z: 1 };
  const t = world.raycastStatics(origin, dir, 10, false);
  check(t !== null && Math.abs(t - (2 - 0.125)) < 0.01, `raycastStatics occludes at the wall face (t=${t?.toFixed(3)})`);
  const hit = world.structures.raycastPiece(origin, dir, 10);
  check(hit !== null && hit.id === 1002, "raycastPiece attributes the hit to the wall id");

  // Movement: walk +Z into the wall — blocked.
  const mk = (x, z, y) => ({ x, y, z, vy: 0, yaw: Math.PI, pitch: 0, grounded: true });
  const cmd = { seq: 1, dt: 1 / 15, mx: 0, mz: -1, yaw: Math.PI, pitch: 0, sprint: false, jump: false };
  const p = mk(cx, wallZ - 1.5, fy);
  for (let i = 0; i < 45; i++) stepPlayer(p, cmd, world);
  check(p.z < wallZ - 0.4, `wall blocks movement (z=${p.z.toFixed(2)} < ${wallZ})`);
  check(Math.abs(p.y - fy) < 0.01, "player stands ON the foundation while walking");

  // Swap to a doorway: passes through the center gap, header overhead.
  world.structures.remove(1002);
  const doorway = { id: 1003, kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 400 };
  world.structures.add(doorway);
  const p2 = mk(cx, wallZ - 1.5, fy);
  for (let i = 0; i < 45; i++) stepPlayer(p2, cmd, world);
  check(p2.z > wallZ + 0.5, `doorway lets the player through (z=${p2.z.toFixed(2)})`);

  // Closed door blocks; open door passes — the collision swap.
  const door = { id: 1004, kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 250, open: false };
  world.structures.add(door);
  const p3 = mk(cx, wallZ - 1.5, fy);
  for (let i = 0; i < 45; i++) stepPlayer(p3, cmd, world);
  check(p3.z < wallZ - 0.4, "closed door blocks movement");
  world.structures.setOpen(1004, true);
  const p4 = mk(cx, wallZ - 1.5, fy);
  for (let i = 0; i < 45; i++) stepPlayer(p4, cmd, world);
  check(p4.z > wallZ + 0.5, "open door passes (collision box swapped out)");
  world.structures.setOpen(1004, false);
  const p5 = mk(cx, wallZ - 1.5, fy);
  for (let i = 0; i < 45; i++) stepPlayer(p5, cmd, world);
  check(p5.z < wallZ - 0.4, "re-closed door blocks again");

  // Occupant in the doorway blocks placing the door.
  world.structures.remove(1004);
  check(
    canPlace(world, { kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0 }, [{ x: cx, y: fy, z: wallZ }]) === "blocked",
    "occupant standing in the opening blocks door placement",
  );

  // Density cap: flood the index near the cell (synthetic pieces stacked on
  // one address — countNear reads the pieces map, not occupancy), clean up.
  const synth = [];
  for (let i = 0; i < BUILD_DENSITY_CAP; i++) {
    const id = 500000 + i;
    synth.push(id);
    world.structures.add({ id, kind: "foundation", tier: 0, gx: BGX + 2, gz: BGZ, floorY: fy, hp: 600 });
  }
  check(
    canPlace(world, { kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 2 }) === "density",
    "density cap rejects once BUILD_DENSITY_CAP pieces crowd the radius",
  );
  for (const id of synth) world.structures.remove(id);
  check(canPlace(world, { kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 2 }) === null, "grid clean after synthetic pieces removed");

  // add→remove→re-add leaves the grid clean.
  const before = world.queryStatics(cx, wallZ, 3).walls.length;
  world.structures.remove(1003);
  world.structures.add(doorway);
  const after = world.queryStatics(cx, wallZ, 3).walls.length;
  check(before === after, "add→remove→re-add leaves the statics grid clean");

  // pieceAabbs determinism: two derivations are structurally identical.
  check(
    JSON.stringify(pieceAabbs(doorway)) === JSON.stringify(pieceAabbs({ ...doorway })),
    "pieceAabbs derives identical boxes from identical records",
  );

  // Foundation demolish protection is server-side; here just clean up.
  world.structures.remove(1003);
  world.structures.remove(1001);
  check(world.structures.pieces.size === 0, "index empty after cleanup");
}

// --- 3. systems (real server systems/structures.ts) -------------------------
console.log("systems (handlePlace/handleDemolish/handleDoor):");

const sys = await bundleModule(
  'export { handlePlace, handleDemolish, handleDoor, handleSetCode, handleTryCode, handleContainerOpen, handleContainerMove, damageStructure, ownerOnline, sweepDecay, tickStructures, removePiece, toWirePiece, touchPiece, structuresFullMsgs } from "./structures.ts";\n' +
    'export { performAttack } from "./combat.ts";\n',
  systemsDir,
  "structures-harness-entry.ts",
);

const sysWorld = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
const physicsCalls = [];
function makeState(buildingOverrides = {}) {
  return {
    world: sysWorld,
    config: {
      building: { enabled: true, pieceCapPerPlayer: 120, decayHours: 168, offlineRaidMult: 0.25, ...buildingOverrides },
      physics: { enabled: false, bodyCap: 64 },
      pvp: { enabled: true, damageMult: 1, fullLoot: true },
    },
    time: 0,
    tick: 0,
    players: new Map(),
    zombies: new Map(),
    loot: new Map(),
    corpses: new Map(),
    fires: [],
    portals: [],
    drops: new Map(),
    animals: new Map(),
    weather: 0,
    events: [],
    outbox: [],
    nextEntityId: 1,
    structureMeta: new Map(),
    doorBackoff: new Map(),
    codeTryAt: new Map(),
    ownerPresence: new Map(),
    decayNextAt: 0,
    felledTrees: new Set(),
    felledDelta: [],
    treeChops: new Map(),
    dirtyStructureBuckets: new Set(),
    treesDirty: false,
    posHistory: [],
    physics: {
      addStructure: (id, aabbs) => physicsCalls.push(["add", id, aabbs.length]),
      removeStructure: (id) => physicsCalls.push(["remove", id]),
      setStructureOpen: (id, aabbs) => physicsCalls.push(["open", id, aabbs.length]),
    },
  };
}

function makePlayer(state, id, tokenHash, x, z, inventory) {
  const player = {
    id,
    name: id,
    tokenHash,
    core: { x, y: state.world.groundHeight(x, z), z, vy: 0, yaw: 0, pitch: 0, grounded: true },
    vitals: { hp: 100, food: 100, water: 100, temp: 37 },
    inventory,
    worn: { body: null, back: null },
    selectedSlot: 0,
    alive: true,
    offline: false,
    offlineSince: 0,
    stats: { bornAt: 0, kills: 0, zombieKills: 0, distanceM: 0 },
    lastRecap: null,
    diedAt: -Infinity,
    cmdQueue: [],
    lastAck: 0,
    inputBudget: 0,
    wantsAttack: false,
    lastChatAt: -Infinity,
    attackCooldown: 0,
    attackAnimT: 0,
    sprinting: false,
    movedThisTick: false,
    sprintedThisTick: false,
    fishCooldownT: 0,
    explored: null,
    fogDelta: [],
    lastFogCell: -1,
    action: null,
    tookDamageThisTick: false,
    realm: "overworld",
    portalArmed: true,
  };
  state.players.set(id, player);
  return player;
}

{
  // A buildable cell for the fresh systems world (same seed ⇒ same cell).
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const cz = BGZ * BUILD_CELL + BUILD_CELL / 2;

  // Player stands one cell south of the target so the slab can't "block" them.
  const px = cx;
  const pz = cz - BUILD_CELL;

  // building.enabled=false → rejected with notice, nothing placed.
  {
    const state = makeState({ enabled: false });
    const player = makePlayer(state, "p1", "hash1", px, pz, [
      { type: "hammer", count: 1 },
      { type: "wood", count: 8 },
    ]);
    sys.handlePlace(state, player, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
    const notices = state.outbox.filter((o) => o.msg.t === "notice");
    check(state.world.structures.pieces.size === 0 && notices.length === 1, "building.enabled=false → notice, no piece");
  }

  const state = makeState();
  const player = makePlayer(state, "p1", "hash1", px, pz, [
    { type: "hammer", count: 1 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
  ]);

  // No hammer equipped (equip slot 1 = wood) → rejected.
  player.selectedSlot = 1;
  sys.handlePlace(state, player, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
  check(state.world.structures.pieces.size === 0, "no hammer equipped → rejected");
  player.selectedSlot = 0;

  // Red realm → rejected.
  player.realm = "red";
  sys.handlePlace(state, player, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
  check(state.world.structures.pieces.size === 0, "red realm → rejected");
  player.realm = "overworld";

  // Success: foundation placed, 8 wood deducted, sAdd broadcast, physics add.
  state.outbox.length = 0;
  sys.handlePlace(state, player, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
  const foundationId = state.nextEntityId - 1;
  const placed = state.world.structures.pieces.get(foundationId);
  check(placed !== undefined && placed.kind === "foundation", "foundation placed via handlePlace");
  const woodLeft = player.inventory.reduce((n, s) => n + (s && s.type === "wood" ? s.count : 0), 0);
  check(woodLeft === 24 - PIECE_DEFS.foundation.cost, `cost deducted (${woodLeft} wood left)`);
  const sAdds = state.outbox.filter((o) => o.to === "all" && o.msg.t === "sAdd");
  check(sAdds.length === 1, "sAdd broadcast to all");
  check(physicsCalls.some((c) => c[0] === "add" && c[1] === foundationId), "physics.addStructure called");
  check(state.structureMeta.get(foundationId)?.ownerHash === "hash1", "ownership meta recorded");

  // Wire secrecy: NO server-only keys in ANY outbound JSON.
  const allJson = JSON.stringify(state.outbox);
  check(
    !allJson.includes("ownerHash") &&
      !allJson.includes("placedAtMs") &&
      !allJson.includes('"code"') &&
      !allJson.includes('"authorized"') &&
      !allJson.includes('"contents"'),
    "serialized messages carry no ownerHash/placedAtMs/code/authorized/contents",
  );

  // Doorway + door on the +Z edge, then toggle.
  sys.handlePlace(state, player, { kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorwayId = state.nextEntityId - 1;
  sys.handlePlace(state, player, { kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorId = state.nextEntityId - 1;
  check(state.world.structures.pieces.get(doorId)?.kind === "door", "door placed on the doorway");

  state.outbox.length = 0;
  sys.handleDoor(state, player, doorId);
  const sState = state.outbox.find((o) => o.msg.t === "sState");
  check(sState !== undefined && sState.msg.open === true, "handleDoor broadcasts sState open:true");
  check(state.world.structures.pieces.get(doorId)?.open === true, "index open state flipped");
  check(physicsCalls.some((c) => c[0] === "open" && c[1] === doorId && c[2] === 0), "physics collision swap: open door has zero boxes");
  sys.handleDoor(state, player, doorId);
  check(state.world.structures.pieces.get(doorId)?.open === false, "second toggle closes");

  // Demolish: non-owner rejected; foundation with anchored pieces rejected;
  // doorway demolish cascades the door.
  const raider = makePlayer(state, "p2", "hash2", px, pz, [{ type: "hammer", count: 1 }]);
  state.outbox.length = 0;
  sys.handleDemolish(state, raider, foundationId);
  check(state.world.structures.pieces.has(foundationId), "non-owner demolish rejected");

  sys.handleDemolish(state, player, foundationId);
  check(state.world.structures.pieces.has(foundationId), "foundation with anchored doorway refuses demolish");

  state.outbox.length = 0;
  sys.handleDemolish(state, player, doorwayId);
  check(!state.world.structures.pieces.has(doorwayId) && !state.world.structures.pieces.has(doorId), "doorway demolish cascades its door");
  const removes = state.outbox.filter((o) => o.msg.t === "sRemove").map((o) => o.msg.id);
  check(removes.includes(doorwayId) && removes.includes(doorId), "both sRemove broadcasts sent");

  // review: anchor-owner demolish rights — a foreign wall on YOUR foundation
  // must not pin it forever (demolish is otherwise owner-only, and structure
  // damage + decay are follow-up slices).
  const griefer = makePlayer(state, "p4", "hash4", px, pz, [
    { type: "hammer", count: 1 },
    { type: "wood", count: 8 },
  ]);
  sys.handlePlace(state, griefer, { kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 2 });
  const grieferWallId = state.nextEntityId - 1;
  check(state.world.structures.pieces.get(grieferWallId)?.kind === "wall", "foreign wall anchors to another player's foundation");
  sys.handleDemolish(state, player, foundationId);
  check(state.world.structures.pieces.has(foundationId), "foundation with the foreign wall still refuses demolish (sole anchor)");
  sys.handleDemolish(state, raider, grieferWallId);
  check(state.world.structures.pieces.has(grieferWallId), "unrelated player cannot demolish the foreign wall");
  sys.handleDemolish(state, player, grieferWallId);
  check(!state.world.structures.pieces.has(grieferWallId), "foundation owner demolishes a foreign wall anchored to their slab");

  sys.handleDemolish(state, player, foundationId);
  check(!state.world.structures.pieces.has(foundationId), "bare foundation demolishes");

  // review (adversarial): demolish-rights hardening. The old rule granted
  // demolish over any edge piece bordering a foundation you own — but
  // foundations place freely FLUSH against enemy walls (canPlace's overlap
  // subtracts all structure boxes), so an attacker could drop an 8-wood slab
  // behind any perimeter wall and delete it: an HP-free breach bypassing
  // raid damage, tiers, locks and the offline shield.
  {
    const fy = computeFoundationFloorY(sysWorld, BGX, BGZ);
    const victim = makePlayer(state, "vic", "hash-vic", px, pz, []);
    const attacker = makePlayer(state, "atk", "hash-atk", px, pz, []);
    const meta = (ownerHash, extra = {}) => ({
      ownerHash, placedAtMs: 0, code: null, authorized: [], contents: null, ...extra,
    });

    // Victim's base: foundation + perimeter wall on its +X edge; the far
    // cell is empty — true of EVERY perimeter edge by definition.
    sysWorld.structures.add({ id: 9101, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 });
    sysWorld.structures.add({ id: 9102, kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 2, floorY: fy, hp: 400 });
    state.structureMeta.set(9101, meta("hash-vic"));
    state.structureMeta.set(9102, meta("hash-vic"));
    // The attack: a slab flush against the wall (legal placement)…
    sysWorld.structures.add({ id: 9103, kind: "foundation", tier: 0, gx: BGX + 1, gz: BGZ, floorY: fy, hp: 600 });
    state.structureMeta.set(9103, meta("hash-atk"));
    // …must grant NO demolish rights: a foreign co-anchor kills the claim.
    sys.handleDemolish(state, attacker, 9102);
    check(state.world.structures.pieces.has(9102), "adjacent-slab demolish exploit closed (foreign co-anchored wall refuses)");
    // The wall's owner still demolishes it, co-anchor or not.
    sys.handleDemolish(state, victim, 9102);
    check(!state.world.structures.pieces.has(9102), "piece owner demolish unaffected by a foreign co-anchor");

    // Foreign LOCKED door on YOUR doorway: the doorway owner clears it (the
    // lockout-grief counterpart of the anchor rule).
    sysWorld.structures.add({ id: 9104, kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 400 });
    sysWorld.structures.add({ id: 9105, kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 250, open: false });
    state.structureMeta.set(9104, meta("hash-vic"));
    state.structureMeta.set(9105, meta("hash-atk", { code: "1234" }));
    sys.handleDemolish(state, attacker, 9104);
    check(state.world.structures.pieces.has(9104), "attacker gains no rights over the victim's doorway");
    sys.handleDemolish(state, victim, 9105);
    check(!state.world.structures.pieces.has(9105), "doorway owner demolishes a foreign locked door on their doorway");

    // Foreign crate on YOUR slab: the foundation owner clears it (it spills —
    // a griefer crate must not be a permanent cell blocker).
    sysWorld.structures.add({ id: 9106, kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: cx, z: cz, floorY: fy, hp: 200 });
    state.structureMeta.set(9106, meta("hash-atk", {
      contents: [{ type: "wood", count: 3 }, ...Array.from({ length: 11 }, () => null)],
    }));
    const lootBefore = state.loot.size;
    sys.handleDemolish(state, victim, 9106);
    check(!state.world.structures.pieces.has(9106), "foundation owner demolishes a foreign crate on their slab");
    check(state.loot.size === lootBefore + 1, "the foreign crate's contents spill (not destroyed)");

    for (const id of [9101, 9103, 9104]) {
      sysWorld.structures.remove(id);
      state.structureMeta.delete(id);
    }
    for (const l of [...state.loot.values()]) state.loot.delete(l.id);
    check(state.world.structures.pieces.size === 0, "demolish-rights section cleaned up");
  }

  // Per-player cap.
  {
    const capState = makeState({ pieceCapPerPlayer: 10 });
    const rich = makePlayer(capState, "p3", "hash3", px, pz, [
      { type: "hammer", count: 1 },
      { type: "wood", count: 8 },
    ]);
    for (let i = 0; i < 10; i++) capState.structureMeta.set(90000 + i, { ownerHash: "hash3", placedAtMs: 0 });
    capState.outbox.length = 0;
    sys.handlePlace(capState, rich, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
    check(capState.world.structures.pieces.size === 0, "pieceCapPerPlayer enforced");
  }

  // sFull batching: 501 synthetic pieces → 500-piece batch + 1-piece done batch.
  {
    const batchState = makeState();
    for (let i = 0; i < 501; i++) {
      batchState.world.structures.pieces.set(700000 + i, {
        id: 700000 + i, kind: "foundation", tier: 0, gx: 0, gz: 0, floorY: 1, hp: 600,
      });
    }
    const msgs = sys.structuresFullMsgs(batchState);
    check(
      msgs.length === 2 && msgs[0].pieces.length === 500 && msgs[0].done === false && msgs[1].pieces.length === 1 && msgs[1].done === true,
      "sFull batches at 500 with done on the last",
    );
    // makeState() shares sysWorld — clear the synthetic pieces BEFORE the
    // empty-world assertion.
    batchState.world.structures.pieces.clear();
    const emptyMsgs = sys.structuresFullMsgs(makeState());
    check(emptyMsgs.length === 1 && emptyMsgs[0].done === true && emptyMsgs[0].pieces.length === 0, "empty world still sends one done sFull");
  }

  // toWirePiece: explicit projection only carries the shared shape + the
  // derived `locked` boolean on doors/gates (doc 06 M5).
  const doorMeta = { ownerHash: "secret", placedAtMs: 1, code: "1234", authorized: ["a"], contents: null };
  const wire = sys.toWirePiece({ id: 1, kind: "door", tier: 0, gx: 2, gz: 3, edge: 0, floorY: 1.5, hp: 250, open: true }, doorMeta);
  check(
    JSON.stringify(Object.keys(wire).sort()) === JSON.stringify(["edge", "floorY", "gx", "gz", "hp", "id", "kind", "locked", "open", "tier"]),
    "toWirePiece emits exactly the shared piece keys + locked",
  );
  check(wire.locked === true, "toWirePiece derives locked from the meta code");
  const wireWall = sys.toWirePiece({ id: 2, kind: "wall", tier: 0, gx: 2, gz: 3, edge: 0, floorY: 1.5, hp: 400 }, doorMeta);
  check(!("locked" in wireWall), "non-door kinds never carry locked");
}

// --- 3b. locks (doc 06 M5): setCode / tryCode / per-DOOR backoff ------------
console.log("locks (setCode/tryCode/per-door backoff):");
{
  const state = makeState();
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const cz = BGZ * BUILD_CELL + BUILD_CELL / 2;
  const px = cx;
  const pz = cz + 0.5; // inside the cell, in range of the +Z edge door

  const owner = makePlayer(state, "own", "hash-own", px, pz, [
    { type: "hammer", count: 1 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
  ]);
  sys.handlePlace(state, owner, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
  const foundationId = state.nextEntityId - 1;
  sys.handlePlace(state, owner, { kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorwayId = state.nextEntityId - 1;
  sys.handlePlace(state, owner, { kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorId = state.nextEntityId - 1;
  const doorPiece = () => state.world.structures.pieces.get(doorId);
  const meta = () => state.structureMeta.get(doorId);

  const friend = makePlayer(state, "frd", "hash-frd", px, pz, []);
  const sybilA = makePlayer(state, "syA", "hash-syA", px, pz, []);
  const sybilB = makePlayer(state, "syB", "hash-syB", px, pz, []);
  const sybilC = makePlayer(state, "syC", "hash-syC", px, pz, []);

  // Advance past the per-identity UX cooldown before every try.
  const tryCode = (player, code) => {
    state.time += 1.1;
    sys.handleTryCode(state, player, doorId, code);
  };
  const closeDoor = () => {
    if (doorPiece().open === true) state.world.structures.setOpen(doorId, false);
  };

  // Non-owner cannot set a code.
  sys.handleSetCode(state, friend, doorId, "1111");
  check(meta().code === null, "non-owner setCode rejected");

  // Owner sets the code; sState locked:true broadcast.
  state.outbox.length = 0;
  sys.handleSetCode(state, owner, doorId, "4321");
  check(meta().code === "4321", "owner setCode sets the code");
  check(
    state.outbox.some((o) => o.to === "all" && o.msg.t === "sState" && o.msg.locked === true),
    "setCode broadcasts sState locked:true",
  );

  // Locked door: stranger toggle rejected, owner toggles fine.
  sys.handleDoor(state, sybilA, doorId);
  check(doorPiece().open !== true, "locked door refuses a stranger's toggle");
  sys.handleDoor(state, owner, doorId);
  check(doorPiece().open === true, "owner toggles their locked door");
  sys.handleDoor(state, owner, doorId);
  check(doorPiece().open !== true, "owner closes it again");

  // Friend learns the code once → authorized forever (until revoked).
  tryCode(friend, "4321");
  check(doorPiece().open === true && meta().authorized.includes("hash-frd"), "correct tryCode opens + authorizes");
  closeDoor();

  // BACKOFF IS PER-DOOR, NEVER PER-IDENTITY: two fresh tokens splitting
  // guesses on one door hit the SAME shared lockout.
  tryCode(sybilA, "0001");
  tryCode(sybilB, "0002");
  tryCode(sybilA, "0003");
  tryCode(sybilB, "0004");
  check(state.doorBackoff.get(doorId)?.fails === 4, "4 shared fails across two identities");
  tryCode(sybilA, "0005"); // 5th combined fail → lockout
  const budget1 = state.doorBackoff.get(doorId);
  check(
    budget1 !== undefined && budget1.lockedUntil > state.time && Math.round(budget1.lockedUntil - state.time) === 30,
    `5th combined fail locks the door for 30s (got ${budget1 ? (budget1.lockedUntil - state.time).toFixed(1) : "none"})`,
  );

  // During the lockout even the CORRECT code is rejected for strangers…
  tryCode(sybilC, "4321");
  check(doorPiece().open !== true && !meta().authorized.includes("hash-syC"), "lockout rejects tryCode even with the correct code");
  // …but the owner and the authorized friend are untouched (never tryCode-keyed).
  sys.handleDoor(state, owner, doorId);
  check(doorPiece().open === true, "owner opens normally during an active lockout");
  closeDoor();
  tryCode(friend, "4321");
  check(doorPiece().open === true, "authorized friend opens during an active lockout (tryCode short-circuits)");
  closeDoor();

  // Exponential doubling: wait out lockout 1, burn 5 more fails → 60s.
  state.time = budget1.lockedUntil + 1;
  tryCode(sybilA, "0006");
  tryCode(sybilB, "0007");
  tryCode(sybilA, "0008");
  tryCode(sybilB, "0009");
  tryCode(sybilA, "0010");
  const budget2 = state.doorBackoff.get(doorId);
  check(
    budget2 !== undefined && Math.round(budget2.lockedUntil - state.time) === 60,
    `second lockout doubles to 60s (got ${budget2 ? (budget2.lockedUntil - state.time).toFixed(1) : "none"})`,
  );

  // A correct code (after the lockout lapses) resets fails AND backoff.
  state.time = budget2.lockedUntil + 1;
  tryCode(sybilC, "4321");
  check(doorPiece().open === true && meta().authorized.includes("hash-syC"), "correct code after lockout opens + authorizes");
  check(state.doorBackoff.get(doorId) === undefined, "correct code resets the door's backoff budget");
  closeDoor();

  // setCode REVOKES: the friend's grant dies with the old code.
  sys.handleSetCode(state, owner, doorId, "9999");
  check(meta().authorized.length === 0, "setCode clears the authorized list");
  sys.handleDoor(state, friend, doorId);
  check(doorPiece().open !== true, "revoked friend can no longer toggle");

  // Empty code removes the lock entirely — anyone toggles again.
  state.outbox.length = 0;
  sys.handleSetCode(state, owner, doorId, "");
  check(meta().code === null, "empty setCode removes the lock");
  check(
    state.outbox.some((o) => o.msg.t === "sState" && o.msg.locked === false),
    "lock removal broadcasts sState locked:false",
  );
  sys.handleDoor(state, sybilA, doorId);
  check(doorPiece().open === true, "unlocked door toggles for anyone again");

  // Cleanup (doorway demolish cascades the door).
  sys.handleDemolish(state, owner, doorwayId);
  sys.handleDemolish(state, owner, foundationId);
  check(state.world.structures.pieces.size === 0, "locks section cleaned up");
}

// --- 3c. containers (doc 06 M6): cOpen / cMove / cont ------------------------
console.log("containers (cOpen/cMove/cont):");
{
  const state = makeState();
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const cz = BGZ * BUILD_CELL + BUILD_CELL / 2;
  // The trailing wood stack pays the crate's 6-wood cost (removeFromInventory
  // drains back-to-front), so slot 1's stack of 8 stays intact for the moves.
  const player = makePlayer(state, "cp", "hash-cp", cx, cz + 1, [
    { type: "hammer", count: 1 },
    { type: "wood", count: 8 },
    { type: "beans", count: 3 },
    { type: "wood", count: 6 },
  ]);

  sys.handlePlace(state, player, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: cx, z: cz });
  const crateId = state.nextEntityId - 1;
  const contents = () => state.structureMeta.get(crateId)?.contents ?? [];
  check(state.world.structures.pieces.get(crateId)?.kind === "crate", "crate placed via handlePlace (free position)");
  check(contents().length === 12 && contents().every((s) => s === null), "crate born with 12 empty stable slots");

  const totalOf = (type) => {
    let n = 0;
    for (const s of player.inventory) if (s && s.type === type) n += s.count;
    for (const s of contents()) if (s && s.type === type) n += s.count;
    for (const l of state.loot.values()) if (l.type === type) n += l.count;
    return n;
  };
  const woodBefore = totalOf("wood");
  const beansBefore = totalOf("beans");

  // cOpen replies an authoritative cont to the requester only.
  state.outbox.length = 0;
  sys.handleContainerOpen(state, player, crateId);
  const opened = state.outbox.find((o) => o.msg.t === "cont");
  check(opened !== undefined && opened.to === "cp" && opened.msg.slots.length === 12, "cOpen replies cont (12 slots) to the requester");

  // Move wood (inv slot 1) INTO crate slot 4 — whole stack, fixed indices.
  state.outbox.length = 0;
  sys.handleContainerMove(state, player, { id: crateId, from: 1, to: 4, dir: "in" });
  check(player.inventory[1] === null && contents()[4]?.type === "wood" && contents()[4].count === 8, "cMove in: whole stack moved to the fixed slot");
  check(
    state.outbox.some((o) => o.msg.t === "cont") && state.outbox.some((o) => o.msg.t === "inv"),
    "cMove replies authoritative cont + full inv",
  );

  // Move beans in to slot 0, then remove the wood: slot 0 must be untouched
  // and slot 4 nulls (never compacts).
  sys.handleContainerMove(state, player, { id: crateId, from: 2, to: 0, dir: "in" });
  check(contents()[0]?.type === "beans", "second stack lands at its own fixed slot");
  sys.handleContainerMove(state, player, { id: crateId, from: 4, to: 1, dir: "out" });
  check(contents()[4] === null && contents()[0]?.type === "beans", "removal NULLS the slot; neighbors never shift");
  check(player.inventory[1]?.type === "wood" && player.inventory[1].count === 8, "cMove out lands the whole stack in the chosen inv slot");

  // Loss-free + dupe-free across the whole dance.
  check(totalOf("wood") === woodBefore && totalOf("beans") === beansBefore, "moves are loss-free and dupe-free");

  // Bad slot indices: dropped outright, nothing mutates, no reply.
  const outboxLen = state.outbox.length;
  sys.handleContainerMove(state, player, { id: crateId, from: 99, to: 0, dir: "in" });
  sys.handleContainerMove(state, player, { id: crateId, from: 0, to: 99, dir: "in" });
  sys.handleContainerMove(state, player, { id: crateId, from: -1, to: 3, dir: "out" });
  check(state.outbox.length === outboxLen && totalOf("wood") === woodBefore, "out-of-bounds slots rejected without mutation or reply");

  // Occupied target: a legit race — no mutation, but the corrective reply.
  sys.handleContainerMove(state, player, { id: crateId, from: 1, to: 0, dir: "in" });
  check(contents()[0]?.type === "beans" && player.inventory[1]?.type === "wood", "occupied target slot rejects the move");

  // Out of range: reachableCrate re-validates per message — silent drop.
  player.core.x = cx + 20;
  const outboxLen2 = state.outbox.length;
  sys.handleContainerMove(state, player, { id: crateId, from: 1, to: 2, dir: "in" });
  sys.handleContainerOpen(state, player, crateId);
  check(state.outbox.length === outboxLen2 && contents()[2] === null, "out-of-range cMove/cOpen rejected (2.6m re-validated per message)");
  player.core.x = cx;

  // Moving the stack a cast is bound to cancels the cast (dropSlot rule).
  player.action = { kind: "use", slot: 1, arg: 0, totalS: 1, remainingS: 1 };
  sys.handleContainerMove(state, player, { id: crateId, from: 1, to: 2, dir: "in" });
  check(player.action === null && contents()[2]?.type === "wood", "cMove in cancels a cast bound to the moved slot");

  // Demolish SPILLS: both stacks land as loot at the crate.
  const lootBefore = state.loot.size;
  sys.handleDemolish(state, player, crateId);
  check(!state.world.structures.pieces.has(crateId), "crate demolished");
  check(state.loot.size === lootBefore + 2, "demolish spills the crate's stacks as dropped loot");
  check(totalOf("wood") === woodBefore && totalOf("beans") === beansBefore, "spill conserves every item");
  for (const l of [...state.loot.values()]) state.loot.delete(l.id);
}

// --- 3d. raiding (doc 06 M7): damage math + offline shield -------------------
console.log("raiding (damage math + offline shield + destruction):");
{
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const wallZ = (BGZ + 1) * BUILD_CELL;
  const fy = computeFoundationFloorY(sysWorld, BGX, BGZ);
  const wallId = 8001;
  const mkWall = (state, tier = 0) => {
    sysWorld.structures.add({ id: wallId, kind: "wall", tier, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: tier === 1 ? 1200 : 400 });
    state.structureMeta.set(wallId, { ownerHash: "hash-own", placedAtMs: 0, code: null, authorized: [], contents: null });
  };
  const wallHp = () => sysWorld.structures.pieces.get(wallId)?.hp;

  // Owner ONLINE (alive, connected): full damage; sState.hp broadcast.
  {
    const state = makeState();
    mkWall(state);
    makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, []);
    state.outbox.length = 0;
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 394, `online owner: axe hit = 6 (hp ${wallHp()})`);
    check(
      state.outbox.some((o) => o.to === "all" && o.msg.t === "sState" && o.msg.hp === 394),
      "every structure hit broadcasts sState.hp",
    );

    // DEAD but still connected counts ONLINE (killing the defender must not
    // grant the shield — doc 06 anti-cheese #1).
    state.players.get("own").alive = false;
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 388, "dead-but-connected owner still counts online (no shield)");

    // Lingering logout body counts online too (anti-cheese #2).
    state.players.get("own").offline = true;
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 382, "offline-lingering body still counts online");

    // Entry gone but within the grace window → still 1×.
    state.time = 1000;
    state.players.delete("own");
    state.ownerPresence.set("hash-own", state.time - 100); // 100s ago < 300s grace
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 376, "grace window after the entry left holds 1× (combat-logging buys nothing)");

    // Past the grace → offlineRaidMult (0.25).
    state.ownerPresence.set("hash-own", state.time - 400);
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 374.5, `past grace: 6 × 0.25 = 1.5 (hp ${wallHp()})`);

    // offlineRaidMult 0 = invulnerable while away.
    state.config.building.offlineRaidMult = 0;
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 374.5, "offlineRaidMult 0: the shield eats the hit");

    // Bullet column vs wood = 0.5; owner back online.
    makePlayer(state, "own2", "hash-own", cx, wallZ - 1.5, []);
    sys.damageStructure(state, wallId, 2, 1);
    check(wallHp() === 373.5, `rifle bullet vs wood: 2 × 0.5 = 1 (hp ${wallHp()})`);
    sysWorld.structures.remove(wallId);
  }

  // Scrap tier melee mult 0.25.
  {
    const state = makeState();
    mkWall(state, 1);
    makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, []);
    sys.damageStructure(state, wallId, 6, 0);
    check(wallHp() === 1198.5, `scrap melee: 6 × 0.25 = 1.5 (hp ${wallHp()})`);
    sysWorld.structures.remove(wallId);
  }

  // COMBAT INTEGRATION — the real performAttack path: axe swing, fist punch,
  // pistol shot, all attributed through raycastPiece.
  {
    const state = makeState();
    mkWall(state);
    // Attacker faces +Z (yaw π) at the wall, 1.5m out; owns the wall (1×).
    const attacker = makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, [{ type: "axe", count: 1 }]);
    attacker.core.yaw = Math.PI;
    attacker.core.pitch = 0;
    sys.performAttack(state, attacker, undefined);
    check(wallHp() === 394, `melee whiff lands on the aimed wall: axe structDmg 6 (hp ${wallHp()})`);

    attacker.inventory[0] = null; // bare fists
    attacker.attackCooldown = 0;
    sys.performAttack(state, attacker, undefined);
    check(wallHp() === 393, `fists fall back to FIST_STRUCT_DMG 1 (hp ${wallHp()})`);

    attacker.inventory[0] = { type: "pistol", count: 1 };
    attacker.attackCooldown = 0;
    sys.performAttack(state, attacker, undefined);
    check(wallHp() === 392.5, `pistol pellet: structDmg 1 × bullet 0.5 (hp ${wallHp()})`);
    sysWorld.structures.remove(wallId);
    state.structureMeta.delete(wallId);
  }

  // Destruction cascade: a doorway dying takes its door; sRemove for both.
  {
    const state = makeState();
    makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, []);
    sysWorld.structures.add({ id: 8002, kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 5 });
    sysWorld.structures.add({ id: 8003, kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 250, open: false });
    state.structureMeta.set(8002, { ownerHash: "hash-own", placedAtMs: 0, code: null, authorized: [], contents: null });
    state.structureMeta.set(8003, { ownerHash: "hash-own", placedAtMs: 0, code: null, authorized: [], contents: null });
    state.outbox.length = 0;
    sys.damageStructure(state, 8002, 6, 0);
    const removes = state.outbox.filter((o) => o.msg.t === "sRemove").map((o) => o.msg.id);
    check(
      !sysWorld.structures.pieces.has(8002) && !sysWorld.structures.pieces.has(8003) && removes.includes(8002) && removes.includes(8003),
      "hp<=0 removes the doorway AND cascades its door (both sRemove)",
    );
  }

  // review (adversarial): the DAMAGE path honors the no-orphan rule (doc
  // 06:207 — foundations "can't be demolished/DESTROYED while edge pieces
  // anchor to them"). handleDemolish always rejected this; ~100 axe swings
  // on the slab used to delete it anyway, stranding floating walls/crates
  // forever and freeing the cell for a demolish-rights takeover.
  {
    const state = makeState();
    makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, []);
    const meta = () => ({ ownerHash: "hash-own", placedAtMs: 0, code: null, authorized: [], contents: null });
    sysWorld.structures.add({ id: 8010, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 4 });
    sysWorld.structures.add({ id: 8011, kind: "wall", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 12 });
    sysWorld.structures.add({ id: 8012, kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: cx, z: BGZ * BUILD_CELL + 1, floorY: fy, hp: 6 });
    state.structureMeta.set(8010, meta());
    state.structureMeta.set(8011, meta());
    state.structureMeta.set(8012, meta());
    state.outbox.length = 0;
    sys.damageStructure(state, 8010, 6, 0);
    check(sysWorld.structures.pieces.get(8010)?.hp === 1, "anchored foundation CLAMPS at 1 hp on the damage path (no orphans)");
    check(
      state.outbox.some((o) => o.msg.t === "sState" && o.msg.id === 8010 && o.msg.hp === 1),
      "the clamp still broadcasts sState.hp",
    );
    sys.damageStructure(state, 8010, 6, 0);
    check(sysWorld.structures.pieces.has(8010), "repeat overkill keeps clamping");
    // Clear the anchors the raider's way (destruction)…
    sys.damageStructure(state, 8011, 12, 0);
    sys.damageStructure(state, 8012, 6, 0);
    check(
      !sysWorld.structures.pieces.has(8011) && !sysWorld.structures.pieces.has(8012),
      "anchored wall + crate still die to damage normally",
    );
    // …then the slab falls to the same swing that used to orphan them.
    sys.damageStructure(state, 8010, 6, 0);
    check(!sysWorld.structures.pieces.has(8010), "cleared foundation is destroyable");
    for (const id of [8010, 8011, 8012]) state.structureMeta.delete(id);
  }

  // review: combat reaches CRATES end-to-end — the index carries a
  // raycast-only body box (crateAabb), so melee attribution, damage and the
  // destruction spill work; collision stays zero (queryWalls never returns
  // the body box).
  {
    const state = makeState();
    const attacker = makePlayer(state, "atk", "hash-atk", cx, wallZ - 1.5, [{ type: "axe", count: 1 }]);
    attacker.core.yaw = Math.PI; // faces +Z
    attacker.core.pitch = -0.7; // looks down at the crate ~1m ahead
    const cfy = Math.round(attacker.core.y * 20) / 20; // quantized, chest-relative
    sysWorld.structures.add({ id: 8020, kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: cx, z: wallZ - 0.5, floorY: cfy, hp: 10 });
    state.structureMeta.set(8020, {
      ownerHash: "hash-atk", placedAtMs: 0, code: null, authorized: [],
      contents: [{ type: "wood", count: 5 }, ...Array.from({ length: 11 }, () => null)],
    });
    check(sysWorld.structures.queryWalls(cx, wallZ - 0.5, 2).length === 0, "crate body box never enters queryWalls (still non-colliding)");
    sys.performAttack(state, attacker, undefined);
    check(
      sysWorld.structures.pieces.get(8020)?.hp === 4,
      `axe swing lands on the crate via raycast attribution (hp ${sysWorld.structures.pieces.get(8020)?.hp})`,
    );
    attacker.attackCooldown = 0;
    sys.performAttack(state, attacker, undefined);
    check(!sysWorld.structures.pieces.has(8020), "second swing destroys the crate");
    check(
      [...state.loot.values()].some((l) => l.type === "wood" && l.count === 5),
      "combat destruction spills the crate contents",
    );
    state.structureMeta.delete(8020);
    for (const l of [...state.loot.values()]) state.loot.delete(l.id);
  }

  // ownerOnline direct: presence map is stamped by tickStructures.
  {
    const state = makeState();
    makePlayer(state, "own", "hash-own", cx, wallZ - 1.5, []);
    state.time = 50;
    // review: the tryCode anti-mash map is pruned on the same sweep —
    // identities are free to mint, so an unpruned map grows without bound.
    state.codeTryAt.set("hash-stale", 1); // 49s old — can never gate again
    state.codeTryAt.set("hash-fresh", 49.5); // inside the 1s cooldown window
    sys.tickStructures(state, () => Date.now());
    check(state.ownerPresence.get("hash-own") === 50, "tickStructures stamps presence each tick");
    check(sys.ownerOnline(state, "hash-own") === true, "connected owner reads online");
    check(sys.ownerOnline(state, "hash-nobody") === false, "unknown hash reads offline");
    check(
      !state.codeTryAt.has("hash-stale") && state.codeTryAt.has("hash-fresh"),
      "codeTryAt entries older than the cooldown are pruned on the sweep",
    );
  }
}

// --- 3e. decay (doc 06 M7): wall-clock owner-absence sweep -------------------
console.log("decay (sweepDecay + lastSeen window):");
{
  const cx = BGX * BUILD_CELL;
  const fy = computeFoundationFloorY(sysWorld, BGX, BGZ);
  const now = Date.now();
  const hours = (h) => h * 3600_000;

  const seed = (state) => {
    sysWorld.structures.add({ id: 8101, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 });
    sysWorld.structures.add({ id: 8102, kind: "foundation", tier: 0, gx: BGX + 1, gz: BGZ, floorY: fy, hp: 600 });
    sysWorld.structures.add({ id: 8103, kind: "crate", tier: 0, gx: BGX + 2, gz: BGZ, x: cx + 7, z: BGZ * BUILD_CELL + 1, floorY: fy, hp: 200 });
    state.structureMeta.set(8101, { ownerHash: "hash-old", placedAtMs: 0, code: null, authorized: [], contents: null });
    state.structureMeta.set(8102, { ownerHash: "hash-fresh", placedAtMs: 0, code: null, authorized: [], contents: null });
    state.structureMeta.set(8103, { ownerHash: "hash-gone", placedAtMs: 0, code: null, authorized: [], contents: [{ type: "wood", count: 8 }, ...Array.from({ length: 11 }, () => null)] });
  };
  const clear = (state) => {
    for (const id of [8101, 8102, 8103]) {
      sysWorld.structures.remove(id);
      state.structureMeta.delete(id);
    }
  };
  const lastSeen = (h) =>
    h === "hash-old" ? now - hours(169) : h === "hash-fresh" ? now - hours(1) : null;

  {
    const state = makeState(); // decayHours 168
    seed(state);
    state.outbox.length = 0;
    sys.sweepDecay(state, lastSeen);
    check(!sysWorld.structures.pieces.has(8101), "owner unseen 169h decays (window 168h)");
    check(sysWorld.structures.pieces.has(8102), "owner seen 1h ago is kept");
    check(!sysWorld.structures.pieces.has(8103), "missing character row (pruned) decays");
    check(state.loot.size === 0, "decayed crate spills NOTHING (contents vanish with the base)");
    check(state.outbox.filter((o) => o.msg.t === "sRemove").length === 2, "decay broadcasts sRemove per piece");
    clear(state);
  }

  {
    const state = makeState({ decayHours: 0 }); // 0 disables decay
    seed(state);
    sys.sweepDecay(state, lastSeen);
    check(
      sysWorld.structures.pieces.has(8101) && sysWorld.structures.pieces.has(8103),
      "decayHours 0 disables the sweep entirely",
    );
    clear(state);
  }

  {
    // The tick cadence: no sweep before decayNextAt, sweep + reschedule after.
    const state = makeState();
    seed(state);
    state.decayNextAt = 100;
    state.time = 50;
    sys.tickStructures(state, lastSeen);
    check(sysWorld.structures.pieces.has(8101), "no sweep before the 5-game-minute cadence");
    state.time = 100;
    sys.tickStructures(state, lastSeen);
    check(!sysWorld.structures.pieces.has(8101) && state.decayNextAt === 400, "cadence sweep fires and reschedules +300s");
    clear(state);
  }
}

// --- 3f. wire secrecy (doc 06): serialized sFull/sAdd carry NO secrets -------
console.log("wire secrecy (sFull/sAdd serialized JSON):");
{
  const state = makeState();
  const fy = computeFoundationFloorY(sysWorld, BGX, BGZ);
  sysWorld.structures.add({ id: 8201, kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 250, open: false });
  sysWorld.structures.add({ id: 8202, kind: "crate", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 200 });
  state.structureMeta.set(8201, { ownerHash: "sec-owner", placedAtMs: 42, code: "1234", authorized: ["sec-friend"], contents: null });
  state.structureMeta.set(8202, { ownerHash: "sec-owner", placedAtMs: 42, code: null, authorized: [], contents: [{ type: "rifle", count: 1, mag: 3 }, ...Array.from({ length: 11 }, () => null)] });

  const fullJson = JSON.stringify(sys.structuresFullMsgs(state));
  for (const secret of ['"ownerHash"', '"placedAtMs"', '"code"', '"authorized"', '"contents"']) {
    check(!fullJson.includes(secret), `sFull JSON carries no ${secret}`);
  }
  check(fullJson.includes('"locked":true'), "sFull JSON derives locked:true for the coded door");
  check(!fullJson.includes("sec-owner") && !fullJson.includes("sec-friend") && !fullJson.includes("1234"), "sFull JSON leaks no secret VALUES either");

  const sAddJson = JSON.stringify({ t: "sAdd", piece: sys.toWirePiece(sysWorld.structures.pieces.get(8202), state.structureMeta.get(8202)) });
  for (const secret of ['"ownerHash"', '"placedAtMs"', '"code"', '"authorized"', '"contents"']) {
    check(!sAddJson.includes(secret), `sAdd JSON carries no ${secret}`);
  }
  sysWorld.structures.remove(8201);
  sysWorld.structures.remove(8202);
}

// --- 3g. persistence dirty tracking (doc 06 M8 follow-up) --------------------
// The split-row save (persistence.saveWorld) SKIPS clean structure buckets, so
// its correctness rests on EVERY mutation path marking its bucket via
// touchPiece. This section pins each handler: a missed mark here means a
// mutation silently lost across a DO restart.
console.log("dirty tracking (every mutation marks its persistence bucket):");
{
  const state = makeState();
  const cx = BGX * BUILD_CELL + BUILD_CELL / 2;
  const cz = BGZ * BUILD_CELL + BUILD_CELL / 2;
  const bucket = structureBucketOf(BGX, BGZ);
  const dirty = () => state.dirtyStructureBuckets;
  const clearAndCheck = (what) => {
    check(dirty().has(bucket), `${what} marks bucket ${bucket} dirty`);
    dirty().clear();
  };

  const owner = makePlayer(state, "own", "hash-own", cx, cz + 0.5, [
    { type: "hammer", count: 1 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
    { type: "wood", count: 8 },
  ]);
  const stranger = makePlayer(state, "str", "hash-str", cx, cz + 0.5, []);

  // place
  sys.handlePlace(state, owner, { kind: "foundation", tier: 0, gx: BGX, gz: BGZ });
  const foundationId = state.nextEntityId - 1;
  clearAndCheck("handlePlace");

  sys.handlePlace(state, owner, { kind: "doorway", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorwayId = state.nextEntityId - 1;
  sys.handlePlace(state, owner, { kind: "door", tier: 0, gx: BGX, gz: BGZ, edge: 0 });
  const doorId = state.nextEntityId - 1;
  dirty().clear();

  // door toggle (open, then close)
  sys.handleDoor(state, owner, doorId);
  clearAndCheck("handleDoor (open)");
  sys.handleDoor(state, owner, doorId);
  clearAndCheck("handleDoor (close)");

  // setCode
  sys.handleSetCode(state, owner, doorId, "1234");
  clearAndCheck("handleSetCode");

  // tryCode grant with the door ALREADY open: isolates the authorized-list
  // mark from the door-state mark (setDoorOpen early-returns on no change).
  state.world.structures.setOpen(doorId, true);
  state.time += 2;
  sys.handleTryCode(state, stranger, doorId, "1234");
  check(state.structureMeta.get(doorId)?.authorized.includes("hash-str"), "tryCode grant landed");
  clearAndCheck("handleTryCode (authorized grant)");
  state.world.structures.setOpen(doorId, false);

  // crate contents (cMove)
  sys.handlePlace(state, owner, { kind: "crate", tier: 0, gx: BGX, gz: BGZ, x: cx, z: cz });
  const crateId = state.nextEntityId - 1;
  dirty().clear();
  sys.handleContainerMove(state, owner, { id: crateId, from: 1, to: 0, dir: "in" });
  check(state.structureMeta.get(crateId)?.contents?.[0]?.type === "wood", "cMove landed");
  clearAndCheck("handleContainerMove");
  // a REJECTED move (occupied target) must NOT mark
  sys.handleContainerMove(state, owner, { id: crateId, from: 2, to: 0, dir: "in" });
  check(!dirty().has(bucket), "a rejected cMove does not mark the bucket");

  // damage (hp change), including the pinned-foundation clamp branch
  sys.damageStructure(state, doorId, 6, 0);
  clearAndCheck("damageStructure (hp)");
  state.world.structures.pieces.get(foundationId).hp = 4;
  sys.damageStructure(state, foundationId, 6, 0); // pinned → clamps at 1 hp
  check(state.world.structures.pieces.get(foundationId)?.hp === 1, "clamp branch taken");
  clearAndCheck("damageStructure (pinned clamp)");

  // destruction (hp<=0 → removePiece), cascading the door
  state.world.structures.pieces.get(doorwayId).hp = 1;
  sys.damageStructure(state, doorwayId, 6, 0);
  check(!state.world.structures.pieces.has(doorwayId), "destruction landed");
  clearAndCheck("damageStructure (destroy → removePiece)");

  // demolish
  sys.handleDemolish(state, owner, crateId);
  check(!state.world.structures.pieces.has(crateId), "demolish landed");
  clearAndCheck("handleDemolish");

  // decay removal
  sys.sweepDecay(state, () => null); // every owner reads as decayed
  check(state.world.structures.pieces.size === 0, "decay removed the rest");
  clearAndCheck("sweepDecay (decay removal)");

  // touchPiece itself is bucket-accurate + fixture-tolerant
  sys.touchPiece(state, { gx: 100, gz: 4 });
  check(dirty().has(structureBucketOf(100, 4)), "touchPiece marks the piece's own bucket");
  sys.touchPiece({}, { gx: 0, gz: 0 }); // fixture without the set: must not throw
  check(true, "touchPiece tolerates fixtures without dirty tracking");
  check(
    structureBucketOf(-1, -1) >= 0 && structureBucketOf(-1, -1) < STRUCTURE_BUCKET_COUNT,
    "negative cells map into the bucket range",
  );
}

// --- 4. persistence ---------------------------------------------------------
console.log("persistence (split structures:<b> bucket rows):");

function makeFakeSql() {
  let rows = []; // { kind, payload }
  return {
    sql: {
      exec(query, ...bindings) {
        if (/^DELETE FROM world_state WHERE kind = \?/.test(query)) {
          rows = rows.filter((r) => r.kind !== bindings[0]);
          return { toArray: () => [] };
        }
        if (/^DELETE FROM world_state$/.test(query)) { rows = []; return { toArray: () => [] }; }
        if (/^INSERT INTO world_state/.test(query)) { rows.push({ kind: bindings[0], payload: bindings[1] }); return { toArray: () => [] }; }
        if (/SELECT kind, payload FROM world_state/.test(query)) return { toArray: () => rows.map((r) => ({ kind: r.kind, payload: r.payload })) };
        return { toArray: () => [] };
      },
    },
    storage: { transactionSync: (fn) => fn() },
    rowOf: (kind) => rows.find((r) => r.kind === kind),
    allPayloads: () => rows.map((r) => r.payload).join("\n"),
    insert: (kind, payload) => rows.push({ kind, payload }),
  };
}

const persistBase = () => ({
  loot: new Map(),
  corpses: new Map(),
  fires: [],
  lootRespawns: [],
  drops: new Map(),
  time: 10,
  tick: 150,
  nextEntityId: 1,
  weather: 0,
  weatherNextAt: 0,
  weatherRaining: false,
  airdropNextAt: 0,
  physics: { serialize: () => [], restore: () => {}, fellTree: () => {} },
  felledTrees: new Set(),
  structureMeta: new Map(),
  dirtyStructureBuckets: new Set(),
  treesDirty: false,
});

{
  const g = persistBase();
  g.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const fy = computeFoundationFloorY(g.world, BGX, BGZ);
  g.world.structures.add({ id: 41, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 });
  g.world.structures.add({ id: 42, kind: "gate", tier: 1, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 1350, open: true });
  g.world.structures.add({ id: 43, kind: "crate", tier: 0, gx: BGX + 1, gz: BGZ, x: (BGX + 1) * BUILD_CELL + 1.25, z: BGZ * BUILD_CELL + 2, floorY: fy, hp: 200 });
  g.structureMeta.set(41, { ownerHash: "own-a", placedAtMs: 123, code: null, authorized: [], contents: null });
  // doc 06 M5/M6 — lock + contents ride the same blob.
  g.structureMeta.set(42, { ownerHash: "own-a", placedAtMs: 456, code: "7788", authorized: ["hash-f1", "hash-f2"], contents: null });
  g.structureMeta.set(43, {
    ownerHash: "own-a",
    placedAtMs: 789,
    code: null,
    authorized: [],
    contents: [{ type: "rifle", count: 1, mag: 2 }, null, { type: "wood", count: 8 }, ...Array.from({ length: 9 }, () => null)],
  });
  g.nextEntityId = 44;

  // Pieces persist through their spatial bucket rows — mark them dirty the
  // way live mutations (touchPiece) would have.
  for (const p of g.world.structures.pieces.values()) {
    g.dirtyStructureBuckets.add(structureBucketOf(p.gx, p.gz));
  }

  const fake = makeFakeSql();
  saveWorld(fake.storage, fake.sql, g);
  const bucketKind = `structures:${structureBucketOf(BGX, BGZ)}`;
  check(fake.rowOf(bucketKind) !== undefined, "pieces persist into their structures:<b> bucket row");
  check(!fake.rowOf("snapshot").payload.includes('"structures"'), "snapshot row is slim (no inline structures key)");
  check(fake.rowOf(bucketKind).payload.includes("own-a"), "persisted pieces carry ownerHash (server-side only)");

  const g2 = persistBase();
  g2.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const loaded = loadWorld(fake.sql, g2);
  check(loaded === true, "loadWorld returns true on a snapshot row");
  const f = g2.world.structures.pieces.get(41);
  const gate = g2.world.structures.pieces.get(42);
  check(f?.kind === "foundation" && f.floorY === fy, "foundation restored with quantized floorY");
  check(gate?.kind === "gate" && gate.tier === 1 && gate.open === true, "gate restored open (zero collision boxes)");
  check(g2.structureMeta.get(41)?.ownerHash === "own-a", "ownership meta restored");
  const gateMeta = g2.structureMeta.get(42);
  check(gateMeta?.code === "7788", "door code survives the restart");
  check(JSON.stringify(gateMeta?.authorized) === JSON.stringify(["hash-f1", "hash-f2"]), "authorized list survives the restart");
  const crate = g2.world.structures.pieces.get(43);
  const crateMeta = g2.structureMeta.get(43);
  check(crate?.kind === "crate" && crate.x === (BGX + 1) * BUILD_CELL + 1.25, "crate free position survives the restart");
  check(
    crateMeta?.contents?.length === 12 && crateMeta.contents[0]?.type === "rifle" && crateMeta.contents[0].mag === 2 && crateMeta.contents[1] === null && crateMeta.contents[2]?.count === 8,
    "crate contents survive at their fixed slots (mag preserved)",
  );
  check(g2.structureMeta.get(41)?.code === null && g2.structureMeta.get(41)?.contents === null, "non-door/non-crate meta normalizes to unlocked/no contents");
  check(g2.nextEntityId >= 44, `id ceiling folds piece ids (nextEntityId=${g2.nextEntityId})`);
  check(g2.world.groundHeight(BGX * BUILD_CELL + 1.5, BGZ * BUILD_CELL + 1.5) === fy, "restored foundation feeds groundHeight (statics consistency)");
  const gateBoxes = g2.world.queryStatics(BGX * BUILD_CELL + 1.5, (BGZ + 1) * BUILD_CELL, 1).walls;
  check(pieceAabbs(gate).length === 0, "open gate derives zero boxes after restore");
  void gateBoxes;

  // Old snapshot (no structures key, no bucket rows) loads clean.
  const oldFake = makeFakeSql();
  oldFake.insert("snapshot", fake.rowOf("snapshot").payload);
  const g3 = persistBase();
  g3.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(loadWorld(oldFake.sql, g3) === true && g3.world.structures.pieces.size === 0, "pre-structures snapshot loads clean (no pieces)");
  check(g3.dirtyStructureBuckets.size === 0, "nothing to migrate ⇒ nothing marked dirty");

  // LEGACY fat snapshot (inline structures key, the pre-split format): loads
  // fully AND marks every bucket dirty so the next save materializes the
  // split rows (the one-transaction migration).
  const legacyFake = makeFakeSql();
  const legacySnapshot = JSON.parse(fake.rowOf("snapshot").payload);
  legacySnapshot.structures = JSON.parse(fake.rowOf(bucketKind).payload);
  legacyFake.insert("snapshot", JSON.stringify(legacySnapshot));
  const gL = persistBase();
  gL.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(
    loadWorld(legacyFake.sql, gL) === true && gL.world.structures.pieces.size === 3 && gL.structureMeta.get(42)?.code === "7788",
    "legacy inline-structures snapshot hydrates fully (pieces + meta)",
  );
  check(gL.dirtyStructureBuckets.size === STRUCTURE_BUCKET_COUNT, "legacy load marks ALL buckets dirty (migration)");
  saveWorld(legacyFake.storage, legacyFake.sql, gL);
  check(
    legacyFake.rowOf(bucketKind) !== undefined && !legacyFake.rowOf("snapshot").payload.includes('"structures"'),
    "first save after a legacy load materializes bucket rows + slims the snapshot",
  );

  // Garbage entries are skipped per-entry, not fatal. review: an edge-kind
  // piece with a corrupt/missing edge would restore as an invisible,
  // collisionless phantom (zero AABBs, no occupancy, un-aimable) that still
  // counts toward every cap — skip it; a cell piece with a stray edge would
  // shift pieceCenter 1.5m — strip the edge instead.
  const dirtyFake = makeFakeSql();
  dirtyFake.insert("snapshot", fake.rowOf("snapshot").payload);
  const dirtyPieces = JSON.parse(fake.rowOf(bucketKind).payload);
  dirtyPieces.push(
    null,
    { id: "x" },
    { id: 99, kind: "nonsense", gx: 0, gz: 0, floorY: 0 },
    { id: 98, kind: "wall", tier: 0, gx: 0, gz: 0, floorY: 1, hp: 400 }, // edge missing
    { id: 97, kind: "wall", tier: 0, gx: 0, gz: 0, edge: 1, floorY: 1, hp: 400 }, // edge corrupt
    { id: 96, kind: "foundation", tier: 0, gx: 30, gz: 30, edge: 0, floorY: 1, hp: 600 }, // stray edge
  );
  dirtyFake.insert(bucketKind, JSON.stringify(dirtyPieces));
  const g4 = persistBase();
  g4.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(loadWorld(dirtyFake.sql, g4) === true && g4.world.structures.pieces.size === 4, "garbage structure entries skipped, good ones kept");
  check(!g4.world.structures.pieces.has(98) && !g4.world.structures.pieces.has(97), "edge-kind entries without a canonical edge are skipped (no phantoms)");
  const strayFoundation = g4.world.structures.pieces.get(96);
  check(strayFoundation?.kind === "foundation" && strayFoundation.edge === undefined, "stray edge on a cell piece is stripped on restore");
}

check(WORLD_PIECE_CAP === 3000, "WORLD_PIECE_CAP pinned at 3000 (doc 06 math)");
check(PLACEABLE_KINDS.length === 7 && PLACEABLE_KINDS.includes("crate"), "PLACEABLE_KINDS = all 7 kinds incl. crate (doc 06 M6)");
// The parse-time whitelist in protocol.ts is a deliberate literal mirror of
// PLACEABLE_KINDS (strip-types leaf-module constraint) — pin them equal.
for (const kind of PLACEABLE_KINDS) {
  const cellPiece = kind === "foundation" || kind === "crate";
  const msg = parseClientMsg(JSON.stringify({ t: "place", kind, tier: 0, gx: 0, gz: 0, edge: cellPiece ? undefined : 0 }));
  check(msg !== null && msg.kind === kind, `parse whitelist mirrors PLACEABLE_KINDS (${kind})`);
}
// Persistence's PIECE_KINDS literal mirrors PIECE_DEFS' keys — pinned by the
// dirty-entry test above accepting every real kind; assert count here.
check(Object.keys(PIECE_DEFS).length === 7, "PIECE_DEFS carries the full 7-kind union");

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
