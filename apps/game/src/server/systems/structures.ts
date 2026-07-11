// doc 06 — server-authoritative base building: placement, demolish, door
// toggles, join-time full sync. The COLLISION truth lives in the shared
// world.structures index (both sides mutate identical records); this module
// owns the server-only concerns: validation order, resource costs, caps,
// ownership meta, and the toWirePiece projection that is the ONLY path from
// a piece to the wire.
//
// Realm rule (trees.ts precedent): place/demolish/door are rejected outside
// the overworld. Collision still exists in both realms — one shared World,
// exactly like worldgen buildings (players.ts realm comment).

import {
  BUILD_RANGE,
  CRATE_SLOTS,
  DECAY_SWEEP_INTERVAL_S,
  DOOR_CODE_BACKOFF_BASE_S,
  DOOR_CODE_BACKOFF_MAX_S,
  DOOR_CODE_FAILS_PER_LOCKOUT,
  DOOR_CODE_TRY_COOLDOWN_S,
  DROPPED_LOOT_TTL_S,
  PICKUP_RANGE,
  RAID_OFFLINE_GRACE_S,
  WORLD_PIECE_CAP,
} from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import { distSq2D } from "@worldspring/shared/math";
import {
  PIECE_DEFS,
  PLACE_REJECTION_TEXT,
  TIER_DMG_MULT,
  canPlace,
  pieceAabbs,
  pieceCenter,
  targetFloorY,
  type PieceKind,
  type PieceTier,
  type StructurePiece,
} from "@worldspring/shared/structures";
import type { ServerMsg, WirePiece } from "@worldspring/shared/protocol";
import { structureBucketOf } from "../persistence";
import { countOf, removeFromInventory, sendInventory } from "./players";
import {
  broadcast,
  sendTo,
  type GameState,
  type ServerPlayer,
  type StructureMeta,
} from "./state";

/** sFull batch size (doc 06: ~45KB per 500-piece message). */
const SFULL_BATCH = 500;

/**
 * Mark a piece's persistence bucket dirty so the next periodic save rewrites
 * its `structures:<b>` row (persistence.saveWorld skips clean buckets). EVERY
 * structure mutation — index add/remove, hp, open state, code/authorized,
 * crate contents — MUST pass through here; a missed site is silently stale on
 * disk until the bucket's next mutation, i.e. lost across a DO restart in
 * that window. All mutation paths currently funnel through this module (the
 * structures.mjs dirty-coverage harness pins each one); any FUTURE mutation
 * path added elsewhere must call this too. The `?.` tolerates untyped .mjs
 * harness fixtures that predate the dirty tracking (the wornWire precedent).
 */
export function touchPiece(game: GameState, piece: Pick<StructurePiece, "gx" | "gz">): void {
  game.dirtyStructureBuckets?.add(structureBucketOf(piece.gx, piece.gz));
}

/** Cap on the per-door authorized list — FIFO eviction (doc 06 M5). */
const AUTHORIZED_CAP = 16;

/**
 * The mandatory wire projection (doc 06:104): explicit field copy of the
 * shared StructurePiece shape plus ONE derived boolean (`locked` — a code is
 * set on a door/gate). The server's secrets (ownerHash/placedAtMs/code/
 * authorized/contents — game.structureMeta) live in a separate map and can
 * never leak through this, but the explicit copy is the discipline the
 * acceptance test asserts on (serialized JSON keys, not types).
 */
export function toWirePiece(piece: StructurePiece, meta?: StructureMeta): WirePiece {
  const wire: WirePiece = {
    id: piece.id,
    kind: piece.kind,
    tier: piece.tier,
    gx: piece.gx,
    gz: piece.gz,
    floorY: piece.floorY,
    hp: piece.hp,
  };
  if (piece.edge !== undefined) wire.edge = piece.edge;
  if (piece.x !== undefined) wire.x = piece.x;
  if (piece.z !== undefined) wire.z = piece.z;
  if (piece.open !== undefined) wire.open = piece.open;
  if (piece.kind === "door" || piece.kind === "gate") {
    wire.locked = meta !== undefined && meta.code !== null;
  }
  return wire;
}

/** Full-set sync messages for a joining socket: ≤500-piece batches, last one
 * flagged done. Always at least one message (an empty done batch anchors the
 * client's "structures are synced" state). */
export function structuresFullMsgs(game: GameState): ServerMsg[] {
  const out: ServerMsg[] = [];
  let batch: WirePiece[] = [];
  for (const piece of game.world.structures.pieces.values()) {
    batch.push(toWirePiece(piece, game.structureMeta.get(piece.id)));
    if (batch.length >= SFULL_BATCH) {
      out.push({ t: "sFull", pieces: batch, done: false });
      batch = [];
    }
  }
  out.push({ t: "sFull", pieces: batch, done: true });
  return out;
}

function notice(game: GameState, player: ServerPlayer, msg: string): void {
  sendTo(game, player.id, { t: "notice", msg });
}

/** Shared gate for all three verbs: alive + overworld (trees.ts:73 precedent). */
function actionAllowed(game: GameState, player: ServerPlayer): boolean {
  if (!player.alive) return false;
  if (player.realm !== "overworld") {
    notice(game, player, "You cannot build in this realm");
    return false;
  }
  return true;
}

/** Count pieces owned by tokenHash — O(n) scan at placement rate (doc 06). */
function ownedCount(game: GameState, ownerHash: string): number {
  let n = 0;
  for (const meta of game.structureMeta.values()) {
    if (meta.ownerHash === ownerHash) n++;
  }
  return n;
}

/**
 * Server-authoritative placement. Order: config gate → realm → hammer →
 * range → resources → per-player cap → world cap → shared canPlace (with
 * every player core as the anti-trap occupant set). On success: deduct +
 * sendInventory, mint the id, compute floorY once, mutate index + meta +
 * physics, broadcast a global sAdd. No immediate persist — the next
 * persistAll snapshots piece + inventory atomically (doc 06:204).
 */
export function handlePlace(
  game: GameState,
  player: ServerPlayer,
  msg: { kind: PieceKind; tier: PieceTier; gx: number; gz: number; edge?: 0 | 2; x?: number; z?: number },
): void {
  if (!game.config.building.enabled) {
    notice(game, player, "Building is disabled on this server");
    return;
  }
  if (!actionAllowed(game, player)) return;

  const held = player.inventory[player.selectedSlot];
  if (!held || held.type !== "hammer") {
    notice(game, player, "Equip a hammer to build");
    return;
  }

  const target = {
    kind: msg.kind,
    tier: msg.tier,
    gx: msg.gx,
    gz: msg.gz,
    edge: msg.edge,
    x: msg.x,
    z: msg.z,
  };
  const [cx, cz] = pieceCenter(target);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > BUILD_RANGE * BUILD_RANGE) {
    notice(game, player, "Too far away to build there");
    return;
  }

  const def = PIECE_DEFS[msg.kind];
  const material = msg.tier === 1 ? "scrap" : "wood";
  if (countOf(player.inventory, material) < def.cost) {
    notice(game, player, `Needs ${def.cost} ${material}`);
    return;
  }

  if (ownedCount(game, player.tokenHash) >= game.config.building.pieceCapPerPlayer) {
    notice(game, player, "You have reached your structure limit");
    return;
  }
  if (game.world.structures.pieces.size >= WORLD_PIECE_CAP) {
    notice(game, player, "The world structure limit has been reached");
    return;
  }

  // Anti-trap occupant set: every player body in the world — alive, dead-on-
  // screen or offline-lingering — is physical and must not be walled in.
  const occupants: Array<{ x: number; y: number; z: number }> = [];
  for (const p of game.players.values()) occupants.push(p.core);

  const rejection = canPlace(game.world, target, occupants);
  if (rejection !== null) {
    notice(game, player, `Cannot place: ${PLACE_REJECTION_TEXT[rejection]}`);
    return;
  }

  // canPlace passed ⇒ the anchor exists, so floorY resolves.
  const floorY = targetFloorY(game.world, target);
  if (floorY === null) return;

  removeFromInventory(player.inventory, material, def.cost);
  sendInventory(game, player);

  const id = game.nextEntityId++;
  const piece: StructurePiece = {
    id,
    kind: msg.kind,
    tier: msg.tier,
    gx: msg.gx,
    gz: msg.gz,
    ...(msg.edge !== undefined ? { edge: msg.edge } : {}),
    ...(msg.kind === "crate" && msg.x !== undefined && msg.z !== undefined
      ? { x: msg.x, z: msg.z }
      : {}),
    floorY,
    hp: def.hp[msg.tier],
    ...(msg.kind === "door" || msg.kind === "gate" ? { open: false } : {}),
  };
  game.world.structures.add(piece);
  const meta: StructureMeta = {
    ownerHash: player.tokenHash,
    placedAtMs: Date.now(),
    code: null,
    authorized: [],
    // Crates are born empty: fixed-length slot array, indices stable forever.
    contents: msg.kind === "crate" ? Array.from({ length: CRATE_SLOTS }, () => null) : null,
  };
  game.structureMeta.set(id, meta);
  touchPiece(game, piece);
  game.physics.addStructure(id, pieceAabbs(piece));
  broadcast(game, { t: "sAdd", piece: toWirePiece(piece, meta) });
}

/** The four edges bordering cell (gx,gz) in canonical form. */
function cellEdges(gx: number, gz: number): Array<[number, number, 0 | 2]> {
  return [
    [gx, gz, 0], // +Z
    [gx, gz - 1, 0], // -Z
    [gx, gz, 2], // +X
    [gx - 1, gz, 2], // -X
  ];
}

/** The two cells an edge borders (shared structures.ts edgeCells mirror). */
function edgeBorderCells(gx: number, gz: number, edge: 0 | 2): Array<[number, number]> {
  return edge === 0
    ? [
        [gx, gz],
        [gx, gz + 1],
      ]
    : [
        [gx, gz],
        [gx + 1, gz],
      ];
}

/**
 * Anchor-owner demolish rights. canPlace is shared and ownership-blind, so
 * foreign pieces can legally attach to YOUR structures — a 6-wood enemy wall
 * on your foundation's open edge (or a foreign locked door on your doorway)
 * would otherwise pin/lock your base forever. The anchor's owner therefore
 * gets demolish rights over foreign attachments on their structure:
 *  - crate: you own the foundation whose cell it stands in;
 *  - door: you own the doorway it attaches to;
 *  - edge piece: you own a bordering anchor foundation AND no bordering
 *    foundation belongs to anyone else.
 * The "no foreign co-anchor" clause is load-bearing (adversarial review):
 * foundations place freely flush against enemy walls (the overlap check
 * subtracts ALL structure boxes), so the old "owns EITHER bordering cell"
 * rule let an attacker drop an 8-wood slab behind any enemy perimeter piece
 * and demolish it instantly — an HP-free breach bypassing raid damage,
 * tiers, locks and the offline shield entirely.
 */
function ownsAnchor(game: GameState, player: ServerPlayer, piece: StructurePiece): boolean {
  const index = game.world.structures;
  const owns = (id: number): boolean =>
    game.structureMeta.get(id)?.ownerHash === player.tokenHash;
  if (piece.kind === "crate") {
    const cell = index.cellPiece(piece.gx, piece.gz);
    return cell !== null && cell.kind === "foundation" && owns(cell.id);
  }
  if (piece.edge === undefined) return false;
  if (piece.kind === "door") {
    const { wall } = index.edgePieces(piece.gx, piece.gz, piece.edge);
    return wall !== null && wall.kind === "doorway" && owns(wall.id);
  }
  let ownsOne = false;
  for (const [cgx, cgz] of edgeBorderCells(piece.gx, piece.gz, piece.edge)) {
    const cell = index.cellPiece(cgx, cgz);
    if (!cell || cell.kind !== "foundation") continue;
    if (!owns(cell.id)) return false; // a foreign co-anchor kills the claim
    ownsOne = true;
  }
  return ownsOne;
}

/**
 * Would removing this foundation orphan an anchored edge piece or strand a
 * crate on the vanished slab? Doc 06:207: foundations "can't be demolished/
 * DESTROYED while edge pieces anchor to them" — this guard is shared by BOTH
 * removal verbs (handleDemolish and damageStructure's hp<=0 branch;
 * adversarial review: the damage path used to skip it, so ~100 axe swings on
 * the slab left walls/doors/crates floating forever and the freed cell handed
 * demolish rights over them to whoever rebuilt a foundation there).
 */
function foundationPinned(game: GameState, piece: StructurePiece): boolean {
  if (piece.kind !== "foundation") return false;
  const index = game.world.structures;
  // A crate standing on the slab pins it too — no floating crates.
  if (index.cratePiece(piece.gx, piece.gz)) return true;
  for (const [egx, egz, edge] of cellEdges(piece.gx, piece.gz)) {
    const { wall, door } = index.edgePieces(egx, egz, edge);
    if (!wall && !door) continue;
    // The far-side cell of this edge (relative to the dying cell): if it
    // holds a foundation the edge piece stays anchored — not pinning.
    const farGx = edge === 0 ? egx : egx === piece.gx ? egx + 1 : egx;
    const farGz = edge === 0 ? (egz === piece.gz ? egz + 1 : egz) : egz;
    const far = index.cellPiece(farGx, farGz);
    if (far && far.kind === "foundation" && far.id !== piece.id) continue;
    return true;
  }
  return false;
}

/**
 * Owner demolish (hold-X client-side) — "owner" is the piece's placer OR the
 * owner of the structure it attaches to (see ownsAnchor). A foundation whose
 * edge pieces would be left UNANCHORED (no foundation on the far side) is
 * rejected — no orphan-wall bookkeeping (doc 06:207). Demolishing a doorway
 * cascades its attached door. No refund (doc open Q4).
 */
export function handleDemolish(game: GameState, player: ServerPlayer, id: number): void {
  if (!actionAllowed(game, player)) return;
  const index = game.world.structures;
  const piece = index.pieces.get(id);
  const meta = game.structureMeta.get(id);
  if (!piece || !meta) return;
  if (meta.ownerHash !== player.tokenHash && !ownsAnchor(game, player, piece)) {
    notice(game, player, "You can only demolish your own structures");
    return;
  }
  const [cx, cz] = pieceCenter(piece);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > BUILD_RANGE * BUILD_RANGE) {
    notice(game, player, "Too far away");
    return;
  }

  if (foundationPinned(game, piece)) {
    notice(game, player, "Remove the attached pieces first");
    return;
  }

  // Demolishing (like destroying) a crate spills its contents (doc 06 M6).
  removePiece(game, id, true);
}

/** Drop one stack on the ground at (x, z) — the dropAtFeet shape, `mag`
 * preserved so a crated gun keeps its loaded rounds (doc 11 M3). */
function spillStack(game: GameState, x: number, z: number, stack: ItemStack): void {
  const id = game.nextEntityId++;
  game.loot.set(id, {
    id,
    type: stack.type,
    count: stack.count,
    x,
    y: game.world.groundHeight(x, z),
    z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
    ...(stack.mag !== undefined ? { mag: stack.mag } : {}),
  });
}

/**
 * The ONE removal path (demolish / raid destruction / decay): drop the piece
 * from the shared index + meta + physics, broadcast sRemove, cascade an
 * attached door when a doorway dies, and — when `spillContents` — spill a
 * crate's stacks as dropped loot at its position. Decay passes false: crate
 * contents vanish with the base (doc 06 §Decay). Idempotent per id.
 */
export function removePiece(game: GameState, id: number, spillContents: boolean): void {
  const index = game.world.structures;
  const piece = index.pieces.get(id);
  if (!piece) return;

  const removed: number[] = [id];
  // A doorway takes its attached door with it.
  if (piece.kind === "doorway" && piece.edge !== undefined) {
    const { door } = index.edgePieces(piece.gx, piece.gz, piece.edge);
    if (door) removed.push(door.id);
  }
  for (const rid of removed) {
    const p = index.pieces.get(rid);
    const meta = game.structureMeta.get(rid);
    if (spillContents && p && meta?.contents) {
      const [cx, cz] = pieceCenter(p);
      for (const stack of meta.contents) {
        if (stack) spillStack(game, cx, cz, stack);
      }
    }
    if (p) touchPiece(game, p);
    index.remove(rid);
    game.structureMeta.delete(rid);
    game.doorBackoff.delete(rid);
    game.physics.removeStructure(rid);
    broadcast(game, { t: "sRemove", id: rid });
  }
}

/** Resolve a door/gate the player can legally interact with (alive, in the
 * overworld, in range) or null. Shared by door/setCode/tryCode. */
function reachableDoor(
  game: GameState,
  player: ServerPlayer,
  id: number,
): StructurePiece | null {
  if (!actionAllowed(game, player)) return null;
  const piece = game.world.structures.pieces.get(id);
  if (!piece || (piece.kind !== "door" && piece.kind !== "gate")) return null;
  const [cx, cz] = pieceCenter(piece);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > BUILD_RANGE * BUILD_RANGE) return null;
  return piece;
}

/** True when `player` may pass a lock: owner or on the authorized list. */
function isDoorAuthorized(meta: StructureMeta | undefined, player: ServerPlayer): boolean {
  if (!meta) return false;
  return meta.ownerHash === player.tokenHash || meta.authorized.includes(player.tokenHash);
}

/** Flip a door/gate's open state on index + physics and broadcast the sState
 * delta — the ONE mutation path for door state (toggle + tryCode success). */
function setDoorOpen(game: GameState, piece: StructurePiece, open: boolean): void {
  if (piece.open === open) return;
  game.world.structures.setOpen(piece.id, open);
  touchPiece(game, piece);
  // Collision swap on the physics side too, or a trunk rolls up against an
  // invisible box in an open doorway (doc 06 §physics interaction).
  game.physics.setStructureOpen(piece.id, pieceAabbs(piece));
  broadcast(game, { t: "sState", id: piece.id, open });
}

/**
 * Door/gate open/close toggle (doc 06 M5 auth rule): opens iff the piece is
 * UNLOCKED (no code) or the sender's tokenHash is owner/authorized. The
 * unauthorized get a notice; the client's code pad rides the wire `locked`
 * flag, not this handler.
 */
export function handleDoor(game: GameState, player: ServerPlayer, id: number): void {
  const piece = reachableDoor(game, player, id);
  if (!piece) return;
  const meta = game.structureMeta.get(id);
  if (meta && meta.code !== null && !isDoorAuthorized(meta, player)) {
    notice(game, player, "The lock holds — it wants a code");
    return;
  }
  setDoorOpen(game, piece, piece.open !== true);
}

/**
 * Owner-only: set/change a door/gate's code — which CLEARS the authorized
 * list (changing the code revokes everyone, doc 06 M5). The empty code
 * removes the lock entirely (the owner unlock affordance); parse guarantees
 * `code` is "" or exactly 4 digits.
 */
export function handleSetCode(
  game: GameState,
  player: ServerPlayer,
  id: number,
  code: string,
): void {
  const piece = reachableDoor(game, player, id);
  if (!piece) return;
  const meta = game.structureMeta.get(id);
  if (!meta || meta.ownerHash !== player.tokenHash) {
    notice(game, player, "Only the owner can set the lock");
    return;
  }
  meta.code = code === "" ? null : code;
  meta.authorized = []; // revocation: share the NEW code to re-grant
  touchPiece(game, piece);
  // A fresh code starts a fresh guessing budget; removal clears the lockout.
  game.doorBackoff.delete(id);
  broadcast(game, { t: "sState", id, locked: meta.code !== null });
  notice(game, player, meta.code === null ? "Lock removed" : "Code set — the old list is revoked");
}

/**
 * Try a code on a locked door (doc 06 M5). Owner/authorized never burn the
 * budget — the door simply opens for them (so a griefer hammering the door
 * can never lock the owner out; the keying must stay exactly this way).
 * Everyone else shares the PER-DOOR budget: DOOR_CODE_FAILS_PER_LOCKOUT
 * consecutive failures from ANY identities combined lock the door's tryCode
 * for a doubling backoff (base 30s, cap 1h); a correct code resets both and
 * appends the sender to the authorized list (cap 16, FIFO).
 */
export function handleTryCode(
  game: GameState,
  player: ServerPlayer,
  id: number,
  code: string,
): void {
  const piece = reachableDoor(game, player, id);
  if (!piece) return;
  const meta = game.structureMeta.get(id);
  // Owner/authorized (or an unlocked door): just open — never touch the
  // budget, never even read the code.
  if (!meta || meta.code === null || isDoorAuthorized(meta, player)) {
    setDoorOpen(game, piece, true);
    return;
  }

  // Per-identity anti-mash — UX only (Sybil-bypassable, doc 06 M5). Never
  // burns the shared door budget, and replies with a notice: a silent drop
  // would make a fast correct retype (typo → retype under 1s, common on a
  // numpad) read as a dead code pad.
  const lastTry = game.codeTryAt.get(player.tokenHash);
  if (lastTry !== undefined && game.time - lastTry < DOOR_CODE_TRY_COOLDOWN_S) {
    notice(game, player, "The lock resists — try again in a moment");
    return;
  }
  game.codeTryAt.set(player.tokenHash, game.time);

  // Per-DOOR global backoff — the actual security control.
  let budget = game.doorBackoff.get(id);
  if (budget && game.time < budget.lockedUntil) {
    notice(game, player, "The lock is jammed — try again later");
    return;
  }

  if (code === meta.code) {
    game.doorBackoff.delete(id); // correct code resets fails AND backoff
    if (!meta.authorized.includes(player.tokenHash)) {
      meta.authorized.push(player.tokenHash);
      if (meta.authorized.length > AUTHORIZED_CAP) meta.authorized.shift(); // FIFO
      touchPiece(game, piece); // the grant persists even if the door was already open
    }
    setDoorOpen(game, piece, true);
    notice(game, player, "The code clicks — you are in");
    return;
  }

  if (!budget) {
    budget = { fails: 0, lockedUntil: 0, backoff: DOOR_CODE_BACKOFF_BASE_S };
    game.doorBackoff.set(id, budget);
  }
  budget.fails++;
  if (budget.fails >= DOOR_CODE_FAILS_PER_LOCKOUT) {
    budget.fails = 0;
    budget.lockedUntil = game.time + budget.backoff;
    budget.backoff = Math.min(budget.backoff * 2, DOOR_CODE_BACKOFF_MAX_S);
    notice(game, player, "The lock jams shut");
    return;
  }
  notice(game, player, "Wrong code");
}

// --- Containers (doc 06 M6): cOpen / cMove / cont --------------------------

/** Resolve a crate the player can reach (alive, overworld, PICKUP_RANGE of
 * its position — the doc's 2.6m rule), or null. Re-run on EVERY message: no
 * server-side open-session state exists. */
function reachableCrate(
  game: GameState,
  player: ServerPlayer,
  id: number,
): { piece: StructurePiece; contents: (ItemStack | null)[] } | null {
  if (!player.alive || player.realm !== "overworld") return null;
  const piece = game.world.structures.pieces.get(id);
  if (!piece || piece.kind !== "crate") return null;
  const meta = game.structureMeta.get(id);
  if (!meta?.contents) return null;
  const [cx, cz] = pieceCenter(piece);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > PICKUP_RANGE * PICKUP_RANGE) return null;
  return { piece, contents: meta.contents };
}

/** Authoritative container state to ONE player (deep-copied stacks). */
function sendContainer(
  game: GameState,
  player: ServerPlayer,
  id: number,
  contents: (ItemStack | null)[],
): void {
  sendTo(game, player.id, {
    t: "cont",
    id,
    slots: contents.map((stack) => (stack ? { ...stack } : null)),
  });
}

/** cOpen: validate range and reply with the authoritative container view. */
export function handleContainerOpen(game: GameState, player: ServerPlayer, id: number): void {
  const crate = reachableCrate(game, player, id);
  if (!crate) return;
  sendContainer(game, player, id, crate.contents);
}

/**
 * cMove (doc 06 M6): move ONE whole stack between a fixed player inventory
 * slot and a fixed container slot. Removal NULLS the source slot — never
 * compacts — so a slot address can't shift under a racing move; every move is
 * validated against CURRENT contents and answered with an authoritative
 * `cont` + full `inv` (the no-deltas inventory precedent). Malformed indices
 * are dropped (hostile client); a legit race (source emptied / target filled
 * since the panel rendered) mutates nothing but still gets the corrective
 * reply.
 */
export function handleContainerMove(
  game: GameState,
  player: ServerPlayer,
  msg: { id: number; from: number; to: number; dir: "in" | "out" },
): void {
  const crate = reachableCrate(game, player, msg.id);
  if (!crate) return;
  const contents = crate.contents;
  const inv = player.inventory;

  const invSlot = msg.dir === "in" ? msg.from : msg.to;
  const crateSlot = msg.dir === "in" ? msg.to : msg.from;
  if (!Number.isInteger(invSlot) || invSlot < 0 || invSlot >= inv.length) return;
  if (!Number.isInteger(crateSlot) || crateSlot < 0 || crateSlot >= contents.length) return;

  const source = msg.dir === "in" ? inv[invSlot] : contents[crateSlot];
  const targetOccupied = msg.dir === "in" ? contents[crateSlot] !== null : inv[invSlot] !== null;
  if (source && !targetOccupied) {
    touchPiece(game, crate.piece); // crate contents changed — persist the bucket
    if (msg.dir === "in") {
      // Moving the stack a cast is bound to cancels it (the dropSlot rule:
      // the cast's source stack is gone from that slot).
      if (player.action !== null && player.action.slot === invSlot) player.action = null;
      contents[crateSlot] = source;
      inv[invSlot] = null;
    } else {
      inv[invSlot] = source;
      contents[crateSlot] = null;
    }
  }
  // Always answer authoritatively — success and rejected-race alike.
  sendContainer(game, player, msg.id, contents);
  sendInventory(game, player);
}

// --- Raiding (doc 06 M7): structure damage + offline shield -----------------

/**
 * Is the piece owner "online" for the raid shield? TRUE when ANY game.players
 * entry carries the hash — REGARDLESS of alive/offline — or one did within
 * the last RAID_OFFLINE_GRACE_S (game.ownerPresence, stamped on the tick).
 * Both relaxations are load-bearing anti-cheese (doc 06 §Offline protection):
 * requiring `alive` would hand the shield to a defender the raider just
 * KILLED (dead players sit in game.players until respawn, and the death
 * screen is player-controllable); requiring `offline === false` would make
 * combat-logging an instant shield. Neither dying nor yanking the cable
 * interrupts a raid in progress; the shield arrives only after the owner has
 * genuinely been gone.
 */
export function ownerOnline(game: GameState, ownerHash: string): boolean {
  for (const p of game.players.values()) {
    if (p.tokenHash === ownerHash) return true;
  }
  const lastPresent = game.ownerPresence.get(ownerHash);
  return lastPresent !== undefined && game.time - lastPresent <= RAID_OFFLINE_GRACE_S;
}

/**
 * Apply structure damage (doc 06 M7). `baseDmg` = the weapon's structDmg (per
 * swing / per pellet; FIST_STRUCT_DMG fallback is the CALLER's concern via
 * `?? FIST_STRUCT_DMG` — combat resolves the equipped def). `column` indexes
 * TIER_DMG_MULT: 0 = melee, 1 = bullet. Effective damage additionally scales
 * by config.building.offlineRaidMult while the owner is offline past the
 * grace (0 = invulnerable). Broadcasts `sState.hp` on EVERY hit (damage-tier
 * rendering); at hp <= 0 the piece is destroyed via removePiece (door cascade
 * + crate spill) — EXCEPT a pinned foundation (doc 06:207: can't be destroyed
 * while edge pieces/crates anchor to it), which clamps at 1 hp until the
 * attached pieces are cleared, mirroring handleDemolish's rejection. Returns
 * true when the hit landed on a live piece.
 */
export function damageStructure(
  game: GameState,
  id: number,
  baseDmg: number,
  column: 0 | 1,
): boolean {
  const piece = game.world.structures.pieces.get(id);
  if (!piece) return false;
  const meta = game.structureMeta.get(id);
  const online = meta ? ownerOnline(game, meta.ownerHash) : true;
  const shield = online ? 1 : game.config.building.offlineRaidMult;
  const dmg = baseDmg * TIER_DMG_MULT[piece.tier][column] * shield;
  if (dmg <= 0) return true; // hit landed; the shield ate it (mult 0)

  piece.hp -= dmg;
  touchPiece(game, piece); // hp changed (covers the clamp branch too; removePiece re-marks)
  if (piece.hp <= 0) {
    if (foundationPinned(game, piece)) {
      // The no-orphan rule holds on the damage path too: raiders clear the
      // anchored walls/doors/crates first, then the slab.
      piece.hp = 1;
      broadcast(game, { t: "sState", id, hp: 1 });
      return true;
    }
    // Destruction spills crate contents (unlike decay).
    removePiece(game, id, true);
    return true;
  }
  broadcast(game, { t: "sState", id, hp: Math.round(piece.hp * 100) / 100 });
  return true;
}

// --- Presence + decay (doc 06 M7) -------------------------------------------

/**
 * Per-tick bookkeeping: stamp every present tokenHash into ownerPresence
 * (the grace window reads it after the entry leaves game.players), and every
 * DECAY_SWEEP_INTERVAL_S run the decay sweep. `lastSeenMs` is injected by
 * GameRoom (persistence.lastSeenMs over characters.updated_at) so this module
 * — and its harness — never touch SQL directly.
 */
export function tickStructures(
  game: GameState,
  lastSeenMs: (tokenHash: string) => number | null,
): void {
  for (const p of game.players.values()) game.ownerPresence.set(p.tokenHash, game.time);
  if (game.time < game.decayNextAt) return;
  game.decayNextAt = game.time + DECAY_SWEEP_INTERVAL_S;
  // Bound the presence map: entries past the grace can never matter again.
  for (const [hash, t] of game.ownerPresence) {
    if (game.time - t > RAID_OFFLINE_GRACE_S) game.ownerPresence.delete(hash);
  }
  // Same discipline for the tryCode anti-mash stamps: identities are free to
  // mint, so an unpruned per-tokenHash map is unbounded DO memory growth; an
  // entry older than the cooldown can never gate again.
  for (const [hash, t] of game.codeTryAt) {
    if (game.time - t > DOOR_CODE_TRY_COOLDOWN_S) game.codeTryAt.delete(hash);
  }
  sweepDecay(game, lastSeenMs);
}

/**
 * Decay sweep (doc 06 §Decay): per distinct ownerHash read the character
 * row's wall-clock updated_at; owners unseen for decayHours (default 168h) —
 * or whose row no longer exists (pruned after 30 days) — lose every piece.
 * Crates spill NOTHING on decay: contents vanish with the base. decayHours 0
 * disables. Runs at boot (ensureGame) and on the 5-game-minute cadence.
 */
export function sweepDecay(
  game: GameState,
  lastSeenMs: (tokenHash: string) => number | null,
): void {
  const decayHours = game.config.building.decayHours;
  if (decayHours <= 0) return;
  const cutoffMs = decayHours * 3600_000;
  const now = Date.now();

  const owners = new Set<string>();
  for (const meta of game.structureMeta.values()) owners.add(meta.ownerHash);

  const decayed = new Set<string>();
  for (const owner of owners) {
    const lastSeen = lastSeenMs(owner);
    if (lastSeen === null || now - lastSeen > cutoffMs) decayed.add(owner);
  }
  if (decayed.size === 0) return;

  // Collect ids first: removePiece cascades doors and mutates the map.
  const ids: number[] = [];
  for (const [id, meta] of game.structureMeta) {
    if (decayed.has(meta.ownerHash)) ids.push(id);
  }
  for (const id of ids) removePiece(game, id, false);
}
