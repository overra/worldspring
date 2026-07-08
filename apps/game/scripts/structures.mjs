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
import { saveWorld, loadWorld } from "../src/server/persistence.ts";

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
  check(PROTOCOL_VERSION === 9, `PROTOCOL_VERSION bumped to 9 (got ${PROTOCOL_VERSION})`);
  const place = parseClientMsg(
    JSON.stringify({ t: "place", kind: "wall", tier: 1, gx: 4.9, gz: -3, edge: 2 }),
  );
  check(
    place?.t === "place" && place.kind === "wall" && place.tier === 1 && place.gx === 4 && place.gz === -3 && place.edge === 2,
    "place parses; gx coerced |0",
  );
  const noEdge = parseClientMsg(JSON.stringify({ t: "place", kind: "foundation", tier: 0, gx: 0, gz: 0 }));
  check(noEdge?.t === "place" && noEdge.edge === undefined, "place without edge parses (cell pieces)");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "crate", tier: 0, gx: 0, gz: 0 })) === null, "crate is NOT placeable this slice");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "wall", tier: 2, gx: 0, gz: 0 })) === null, "tier outside 0|1 is malformed");
  check(parseClientMsg(JSON.stringify({ t: "place", kind: "wall", tier: 0, gx: 0, gz: 0, edge: 1 })) === null, "non-canonical edge is malformed");
  const far = parseClientMsg(JSON.stringify({ t: "place", kind: "foundation", tier: 0, gx: 99999, gz: -99999 }));
  check(far?.t === "place" && far.gx === 534 && far.gz === -534, "gx/gz clamped to the max-tier bound");
  check(parseClientMsg(JSON.stringify({ t: "demolish", id: 7.2 }))?.id === 7, "demolish parses, id |0");
  check(parseClientMsg(JSON.stringify({ t: "door", id: 5 }))?.t === "door", "door parses");
  check(parseClientMsg(JSON.stringify({ t: "door" })) === null, "door without id is malformed");
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
  check(canPlace(world, { kind: "crate", tier: 0, gx: BGX, gz: BGZ }) === "kind", "crate rejected: kind");
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
  'export { handlePlace, handleDemolish, handleDoor, toWirePiece, structuresFullMsgs } from "./structures.ts";\n',
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
    felledTrees: new Set(),
    felledDelta: [],
    treeChops: new Map(),
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
  check(!allJson.includes("ownerHash") && !allJson.includes("placedAtMs"), "serialized messages carry no ownerHash/placedAtMs");

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

  sys.handleDemolish(state, player, foundationId);
  check(!state.world.structures.pieces.has(foundationId), "bare foundation demolishes");

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

  // toWirePiece: explicit projection only carries the shared shape.
  const wire = sys.toWirePiece({ id: 1, kind: "door", tier: 0, gx: 2, gz: 3, edge: 0, floorY: 1.5, hp: 250, open: true });
  check(
    JSON.stringify(Object.keys(wire).sort()) === JSON.stringify(["edge", "floorY", "gx", "gz", "hp", "id", "kind", "open", "tier"]),
    "toWirePiece emits exactly the shared piece keys",
  );
}

// --- 4. persistence ---------------------------------------------------------
console.log("persistence (additive WorldSnapshot field):");

function makeFakeSql() {
  let rows = [];
  return {
    sql: {
      exec(query, ...bindings) {
        if (/^DELETE FROM world_state/.test(query)) { rows = []; return { toArray: () => [] }; }
        if (/^INSERT INTO world_state/.test(query)) { rows.push({ payload: bindings[0] }); return { toArray: () => [] }; }
        if (/SELECT payload FROM world_state/.test(query)) return { toArray: () => rows.map((r) => ({ payload: r.payload })) };
        return { toArray: () => [] };
      },
    },
    storage: { transactionSync: (fn) => fn() },
    payload: () => rows[0]?.payload,
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
});

{
  const g = persistBase();
  g.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const fy = computeFoundationFloorY(g.world, BGX, BGZ);
  g.world.structures.add({ id: 41, kind: "foundation", tier: 0, gx: BGX, gz: BGZ, floorY: fy, hp: 600 });
  g.world.structures.add({ id: 42, kind: "gate", tier: 1, gx: BGX, gz: BGZ, edge: 0, floorY: fy, hp: 1350, open: true });
  g.structureMeta.set(41, { ownerHash: "own-a", placedAtMs: 123 });
  g.structureMeta.set(42, { ownerHash: "own-a", placedAtMs: 456 });
  g.nextEntityId = 43;

  const fake = makeFakeSql();
  saveWorld(fake.storage, fake.sql, g);
  check(fake.payload().includes('"structures"'), "snapshot payload carries the structures key");
  check(fake.payload().includes("own-a"), "persisted pieces carry ownerHash (server-side only)");

  const g2 = persistBase();
  g2.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  const loaded = loadWorld(fake.sql, g2);
  check(loaded === true, "loadWorld returns true on a snapshot row");
  const f = g2.world.structures.pieces.get(41);
  const gate = g2.world.structures.pieces.get(42);
  check(f?.kind === "foundation" && f.floorY === fy, "foundation restored with quantized floorY");
  check(gate?.kind === "gate" && gate.tier === 1 && gate.open === true, "gate restored open (zero collision boxes)");
  check(g2.structureMeta.get(41)?.ownerHash === "own-a", "ownership meta restored");
  check(g2.nextEntityId >= 43, `id ceiling folds piece ids (nextEntityId=${g2.nextEntityId})`);
  check(g2.world.groundHeight(BGX * BUILD_CELL + 1.5, BGZ * BUILD_CELL + 1.5) === fy, "restored foundation feeds groundHeight (statics consistency)");
  const gateBoxes = g2.world.queryStatics(BGX * BUILD_CELL + 1.5, (BGZ + 1) * BUILD_CELL, 1).walls;
  check(pieceAabbs(gate).length === 0, "open gate derives zero boxes after restore");
  void gateBoxes;

  // Old snapshot (no structures key) loads clean.
  const oldFake = makeFakeSql();
  const oldSnapshot = JSON.parse(fake.payload());
  delete oldSnapshot.structures;
  oldFake.sql.exec("INSERT INTO world_state (kind, payload) VALUES ('snapshot', ?)", JSON.stringify(oldSnapshot));
  const g3 = persistBase();
  g3.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(loadWorld(oldFake.sql, g3) === true && g3.world.structures.pieces.size === 0, "pre-structures snapshot loads clean (no pieces)");

  // Garbage entries are skipped per-entry, not fatal.
  const dirtyFake = makeFakeSql();
  const dirty = JSON.parse(fake.payload());
  dirty.structures.push(null, { id: "x" }, { id: 99, kind: "nonsense", gx: 0, gz: 0, floorY: 0 });
  dirtyFake.sql.exec("INSERT INTO world_state (kind, payload) VALUES ('snapshot', ?)", JSON.stringify(dirty));
  const g4 = persistBase();
  g4.world = createWorld(worldParamsOf(DEFAULT_CONFIG.world));
  check(loadWorld(dirtyFake.sql, g4) === true && g4.world.structures.pieces.size === 2, "garbage structure entries skipped, good ones kept");
}

check(WORLD_PIECE_CAP === 3000, "WORLD_PIECE_CAP pinned at 3000 (doc 06 math)");
check(PLACEABLE_KINDS.length === 6 && !PLACEABLE_KINDS.includes("crate"), "PLACEABLE_KINDS = 6 kinds, no crate");
// The parse-time whitelist in protocol.ts is a deliberate literal mirror of
// PLACEABLE_KINDS (strip-types leaf-module constraint) — pin them equal.
for (const kind of PLACEABLE_KINDS) {
  const msg = parseClientMsg(JSON.stringify({ t: "place", kind, tier: 0, gx: 0, gz: 0, edge: kind === "foundation" ? undefined : 0 }));
  check(msg !== null && msg.kind === kind, `parse whitelist mirrors PLACEABLE_KINDS (${kind})`);
}
// Persistence's PIECE_KINDS literal mirrors PIECE_DEFS' keys — pinned by the
// dirty-entry test above accepting every real kind; assert count here.
check(Object.keys(PIECE_DEFS).length === 7, "PIECE_DEFS carries the full 7-kind union");

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
