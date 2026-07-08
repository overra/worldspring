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
  WORLD_PIECE_CAP,
} from "@worldspring/shared/constants";
import { distSq2D } from "@worldspring/shared/math";
import {
  PIECE_DEFS,
  PLACE_REJECTION_TEXT,
  canPlace,
  pieceAabbs,
  pieceCenter,
  targetFloorY,
  type PieceKind,
  type PieceTier,
  type StructurePiece,
} from "@worldspring/shared/structures";
import type { ServerMsg, WirePiece } from "@worldspring/shared/protocol";
import { countOf, removeFromInventory, sendInventory } from "./players";
import { broadcast, sendTo, type GameState, type ServerPlayer } from "./state";

/** sFull batch size (doc 06: ~45KB per 500-piece message). */
const SFULL_BATCH = 500;

/**
 * The mandatory wire projection (doc 06:104): explicit field copy of the
 * shared StructurePiece shape and nothing else. The server's secrets
 * (ownerHash/placedAtMs — game.structureMeta) live in a separate map and can
 * never leak through this, but the explicit copy is the discipline the
 * acceptance test asserts on (serialized JSON keys, not types).
 */
export function toWirePiece(piece: StructurePiece): WirePiece {
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
  return wire;
}

/** Full-set sync messages for a joining socket: ≤500-piece batches, last one
 * flagged done. Always at least one message (an empty done batch anchors the
 * client's "structures are synced" state). */
export function structuresFullMsgs(game: GameState): ServerMsg[] {
  const out: ServerMsg[] = [];
  let batch: WirePiece[] = [];
  for (const piece of game.world.structures.pieces.values()) {
    batch.push(toWirePiece(piece));
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
  msg: { kind: PieceKind; tier: PieceTier; gx: number; gz: number; edge?: 0 | 2 },
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

  const target = { kind: msg.kind, tier: msg.tier, gx: msg.gx, gz: msg.gz, edge: msg.edge };
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
    floorY,
    hp: def.hp[msg.tier],
    ...(msg.kind === "door" || msg.kind === "gate" ? { open: false } : {}),
  };
  game.world.structures.add(piece);
  game.structureMeta.set(id, { ownerHash: player.tokenHash, placedAtMs: Date.now() });
  game.physics.addStructure(id, pieceAabbs(piece));
  broadcast(game, { t: "sAdd", piece: toWirePiece(piece) });
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

/**
 * Owner-only demolish (hold-X client-side). A foundation whose edge pieces
 * would be left UNANCHORED (no foundation on the far side) is rejected —
 * no orphan-wall bookkeeping (doc 06:207). Demolishing a doorway cascades
 * its attached door. No refund (doc open Q4).
 */
export function handleDemolish(game: GameState, player: ServerPlayer, id: number): void {
  if (!actionAllowed(game, player)) return;
  const index = game.world.structures;
  const piece = index.pieces.get(id);
  const meta = game.structureMeta.get(id);
  if (!piece || !meta) return;
  if (meta.ownerHash !== player.tokenHash) {
    notice(game, player, "You can only demolish your own structures");
    return;
  }
  const [cx, cz] = pieceCenter(piece);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > BUILD_RANGE * BUILD_RANGE) {
    notice(game, player, "Too far away");
    return;
  }

  if (piece.kind === "foundation") {
    for (const [egx, egz, edge] of cellEdges(piece.gx, piece.gz)) {
      const { wall, door } = index.edgePieces(egx, egz, edge);
      const anchored = wall ?? door;
      if (!anchored) continue;
      // The far-side cell of this edge (relative to the demolished cell):
      // if it holds a foundation the edge piece stays anchored — allow.
      const farGx = edge === 0 ? egx : egx === piece.gx ? egx + 1 : egx;
      const farGz = edge === 0 ? (egz === piece.gz ? egz + 1 : egz) : egz;
      const far = index.cellPiece(farGx, farGz);
      if (far && far.kind === "foundation" && far.id !== piece.id) continue;
      notice(game, player, "Remove the attached pieces first");
      return;
    }
  }

  const removed: number[] = [id];
  // A doorway takes its attached door with it.
  if (piece.kind === "doorway" && piece.edge !== undefined) {
    const { door } = index.edgePieces(piece.gx, piece.gz, piece.edge);
    if (door) removed.push(door.id);
  }
  for (const rid of removed) {
    index.remove(rid);
    game.structureMeta.delete(rid);
    game.physics.removeStructure(rid);
    broadcast(game, { t: "sRemove", id: rid });
  }
}

/**
 * Door/gate open/close toggle. NO auth check this slice — locks (setCode/
 * tryCode/authorized/backoff) are doc 06 M5's remaining half; a base with no
 * operable door would be unusable, so the toggle ships now.
 */
export function handleDoor(game: GameState, player: ServerPlayer, id: number): void {
  if (!actionAllowed(game, player)) return;
  const index = game.world.structures;
  const piece = index.pieces.get(id);
  if (!piece || (piece.kind !== "door" && piece.kind !== "gate")) return;
  const [cx, cz] = pieceCenter(piece);
  if (distSq2D(player.core.x, player.core.z, cx, cz) > BUILD_RANGE * BUILD_RANGE) return;

  const open = piece.open !== true;
  index.setOpen(id, open);
  // Collision swap on the physics side too, or a trunk rolls up against an
  // invisible box in an open doorway (doc 06 §physics interaction).
  game.physics.setStructureOpen(id, pieceAabbs(piece));
  broadcast(game, { t: "sState", id, open });
}
