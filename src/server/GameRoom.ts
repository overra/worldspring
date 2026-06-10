// Authoritative game server: one global room as a Durable Object. Owns socket
// lifecycle, message routing and per-player interest-filtered snapshots; all
// simulation lives in ./systems/*.
//
// State is in-memory only (v1, per ARCHITECTURE.md): the tick interval keeps
// the object resident while anyone is connected, so it never hibernates
// mid-session. If every socket drops, the interval stops and the room may be
// evicted — the next connection lazily rebuilds the world from WORLD_SEED.

import { DurableObject } from "cloudflare:workers";
import {
  INTEREST_RADIUS,
  LOOT_INTEREST_RADIUS,
  MAX_PLAYERS,
  RESPAWN_DELAY_S,
  TICK_MS,
  WORLD_SEED,
} from "@/shared/constants";
import { distSq2D } from "@/shared/math";
import {
  ANIM_ATTACKING,
  ANIM_MOVING,
  ANIM_SPRINTING,
  parseClientMsg,
  type GameEvent,
  type ServerMsg,
  type WireCorpse,
  type WireFire,
  type WireLoot,
  type WirePlayer,
  type WireZombie,
  type YouState,
} from "@/shared/protocol";
import { createWorld } from "@/shared/world";
import { performAttack } from "./systems/combat";
import {
  spawnPlayerCorpse,
  stockInitialLoot,
  tickCorpses,
  tickDroppedLoot,
  tickLootRespawns,
} from "./systems/loot";
import {
  applyQueuedInputs,
  createPlayer,
  dropSlot,
  equipSlot,
  pickupLoot,
  queueInput,
  respawnPlayer,
  sanitizeName,
  useItem,
} from "./systems/players";
import { createGameState, type GameState, type ServerPlayer } from "./systems/state";
import { tickFires, tickSurvival } from "./systems/survival";
import { spawnInitialZombies, tickZombieRespawns, tickZombies } from "./systems/zombies";

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Sockets that never send a valid join get closed after this long. */
const JOIN_TIMEOUT_MS = 10_000;
/** Inbound message rate limit: budget per window, generous for 20Hz input. */
const RATE_LIMIT_WINDOW_MS = 5_000;
const RATE_LIMIT_MAX_MSGS = 600;

interface RateWindow {
  windowStart: number;
  count: number;
}

export class GameRoom extends DurableObject<Env> {
  private game: GameState | null = null;
  /** Connection state lives in memory, keyed by WebSocket (see header note). */
  private playerBySocket = new Map<WebSocket, string>();
  private socketByPlayer = new Map<string, WebSocket>();
  private rateBySocket = new Map<WebSocket, RateWindow>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("Server full", { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.ensureGame();
    this.startTicking();
    // Evict sockets that connect but never join — otherwise idle connections
    // could hold "server full" slots indefinitely. The tick interval keeps the
    // object resident, so this timer survives as long as it matters.
    setTimeout(() => {
      if (!this.playerBySocket.has(server)) {
        try {
          server.close(1008, "join timeout");
        } catch {
          // Already closed.
        }
      }
    }, JOIN_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** True when the socket exceeded its message budget (and was closed). */
  private rateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    let window = this.rateBySocket.get(ws);
    if (!window || now - window.windowStart >= RATE_LIMIT_WINDOW_MS) {
      window = { windowStart: now, count: 0 };
      this.rateBySocket.set(ws, window);
    }
    window.count++;
    if (window.count <= RATE_LIMIT_MAX_MSGS) return false;
    try {
      ws.close(1008, "rate limit");
    } catch {
      // Already closed.
    }
    return true;
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (this.rateLimited(ws)) return;
    const msg = parseClientMsg(message);
    if (!msg) return;

    // Pong immediately — never queued behind the tick.
    if (msg.t === "ping") {
      this.send(ws, { t: "pong", ts: msg.ts });
      return;
    }

    const game = this.ensureGame();
    if (msg.t === "join") {
      this.handleJoin(ws, game, msg.name);
      this.flushOutbox(game);
      return;
    }

    const playerId = this.playerBySocket.get(ws);
    if (playerId === undefined) return; // must join first
    const player = game.players.get(playerId);
    if (!player) return;

    switch (msg.t) {
      case "input":
        queueInput(player, msg.cmds);
        break;
      case "attack":
        // Deferred to the tick so queued movement (and the yaw/pitch in it)
        // applies first — resolving on receipt used stale aim.
        player.wantsAttack = true;
        break;
      case "use":
        useItem(game, player, msg.slot);
        break;
      case "equip":
        equipSlot(game, player, msg.slot);
        break;
      case "pickup":
        pickupLoot(game, player, msg.id);
        break;
      case "drop":
        dropSlot(game, player, msg.slot);
        break;
      case "respawn":
        if (!player.alive && game.time - player.diedAt >= RESPAWN_DELAY_S) {
          respawnPlayer(game, player);
        }
        break;
    }
    this.flushOutbox(game);
  }

  override webSocketClose(ws: WebSocket): void {
    this.dropSocket(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.dropSocket(ws);
  }

  // --- Lifecycle ---

  private ensureGame(): GameState {
    if (this.game) return this.game;
    const world = createWorld(WORLD_SEED);
    const game = createGameState(world);
    stockInitialLoot(game);
    spawnInitialZombies(game);
    this.game = game;
    return game;
  }

  private startTicking(): void {
    if (this.tickHandle !== null) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.tickHandle === null) return;
    clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  private handleJoin(ws: WebSocket, game: GameState, rawName: string): void {
    if (this.playerBySocket.has(ws)) return; // already joined
    if (game.players.size >= MAX_PLAYERS) {
      this.send(ws, { t: "error", msg: "Server full" });
      return;
    }
    const name = sanitizeName(rawName, game);
    const id = crypto.randomUUID().slice(0, 8);
    const player = createPlayer(game, id, name);
    this.playerBySocket.set(ws, id);
    this.socketByPlayer.set(id, ws);
    this.send(ws, {
      t: "welcome",
      id,
      seed: game.world.seed,
      time: game.time,
      you: this.youState(player),
      inv: player.inventory.map((stack) => (stack ? { ...stack } : null)),
      selected: player.selectedSlot,
    });
    this.broadcastMsg({ t: "notice", msg: `${name} joined` });
  }

  private dropSocket(ws: WebSocket): void {
    const playerId = this.playerBySocket.get(ws);
    this.playerBySocket.delete(ws);
    this.rateBySocket.delete(ws);
    if (playerId !== undefined) {
      this.socketByPlayer.delete(playerId);
      const game = this.game;
      if (game) {
        const player = game.players.get(playerId);
        game.players.delete(playerId);
        if (player) {
          // Combat-log deterrent: leaving while alive drops your body and
          // everything you carried, exactly as if you had died on the spot.
          if (player.alive) spawnPlayerCorpse(game, player);
          this.broadcastMsg({ t: "notice", msg: `${player.name} left` });
        }
      }
    }
    // getWebSockets() can still include the socket whose close handler is
    // running — filter it out, or the tick never stops for the last leaver.
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length === 0) {
      this.stopTicking();
    }
  }

  // --- Tick ---

  private tick(): void {
    const game = this.game;
    if (!game) return;
    // Self-terminate a stale interval (belt-and-braces vs dropSocket timing).
    if (this.ctx.getWebSockets().length === 0) {
      this.stopTicking();
      return;
    }
    const dt = TICK_MS / 1000;

    applyQueuedInputs(game, dt);
    // Attacks resolve after this tick's movement so aim is current.
    for (const player of game.players.values()) {
      if (player.wantsAttack) {
        player.wantsAttack = false;
        if (player.alive) performAttack(game, player);
      }
    }
    tickZombies(game, dt);
    tickZombieRespawns(game, dt);
    tickSurvival(game, dt);
    tickFires(game, dt);
    tickLootRespawns(game, dt);
    tickCorpses(game, dt);
    tickDroppedLoot(game, dt);
    game.time += dt;
    game.tick++;

    this.flushOutbox(game);
    this.broadcastSnapshots(game);
    game.events.length = 0;
  }

  // --- Snapshots ---

  private broadcastSnapshots(game: GameState): void {
    const count = game.players.size;
    for (const [id, ws] of this.socketByPlayer) {
      const player = game.players.get(id);
      if (!player) continue;
      this.send(ws, this.buildSnapshot(game, player, count));
    }
  }

  private buildSnapshot(game: GameState, player: ServerPlayer, count: number): ServerMsg {
    const px = player.core.x;
    const pz = player.core.z;
    const interestSq = INTEREST_RADIUS * INTEREST_RADIUS;
    const lootSq = LOOT_INTEREST_RADIUS * LOOT_INTEREST_RADIUS;

    const players: WirePlayer[] = [];
    for (const other of game.players.values()) {
      if (!other.alive) continue;
      if (
        other.id !== player.id &&
        distSq2D(px, pz, other.core.x, other.core.z) > interestSq
      ) {
        continue;
      }
      const held = other.inventory[other.selectedSlot];
      players.push({
        id: other.id,
        name: other.name,
        x: round2(other.core.x),
        y: round2(other.core.y),
        z: round2(other.core.z),
        yaw: round3(other.core.yaw),
        hp: Math.round(other.vitals.hp),
        item: held ? held.type : null,
        anim:
          (other.movedThisTick ? ANIM_MOVING : 0) |
          (other.sprintedThisTick ? ANIM_SPRINTING : 0) |
          (other.attackAnimT > 0 ? ANIM_ATTACKING : 0),
      });
    }

    const zombies: WireZombie[] = [];
    for (const zombie of game.zombies.values()) {
      if (distSq2D(px, pz, zombie.x, zombie.z) > interestSq) continue;
      zombies.push({
        id: zombie.id,
        x: round2(zombie.x),
        y: round2(zombie.y),
        z: round2(zombie.z),
        yaw: round3(zombie.yaw),
        state: zombie.state,
      });
    }

    const loot: WireLoot[] = [];
    for (const entity of game.loot.values()) {
      if (distSq2D(px, pz, entity.x, entity.z) > lootSq) continue;
      loot.push({
        id: entity.id,
        type: entity.type,
        count: entity.count,
        x: round2(entity.x),
        y: round2(entity.y),
        z: round2(entity.z),
      });
    }

    const corpses: WireCorpse[] = [];
    for (const corpse of game.corpses.values()) {
      if (distSq2D(px, pz, corpse.x, corpse.z) > lootSq) continue;
      corpses.push({
        id: corpse.id,
        kind: corpse.kind,
        name: corpse.name,
        x: round2(corpse.x),
        y: round2(corpse.y),
        z: round2(corpse.z),
        yaw: round3(corpse.yaw),
        items: corpse.contents.length,
      });
    }

    const fires: WireFire[] = [];
    for (const fire of game.fires) {
      if (distSq2D(px, pz, fire.x, fire.z) > interestSq) continue;
      fires.push({ id: fire.id, x: round2(fire.x), y: round2(fire.y), z: round2(fire.z) });
    }

    const events: GameEvent[] = [];
    for (const queued of game.events) {
      if (queued.onlyTo !== undefined) {
        if (queued.onlyTo === player.id) events.push(queued.ev);
        continue;
      }
      if (distSq2D(px, pz, queued.x, queued.z) <= interestSq) events.push(queued.ev);
    }

    return {
      t: "snap",
      tick: game.tick,
      time: game.time,
      ack: player.lastAck,
      you: this.youState(player),
      players,
      zombies,
      loot,
      corpses,
      fires,
      events,
      count,
    };
  }

  private youState(player: ServerPlayer): YouState {
    const c = player.core;
    const v = player.vitals;
    return {
      x: round2(c.x),
      y: round2(c.y),
      z: round2(c.z),
      vy: c.vy,
      grounded: c.grounded,
      hp: v.hp,
      food: v.food,
      water: v.water,
      temp: v.temp,
    };
  }

  // --- Sending ---

  /** Send, swallowing errors from sockets that are mid-close. */
  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket is closing/closed; webSocketClose will clean it up.
    }
  }

  private broadcastMsg(msg: ServerMsg): void {
    for (const ws of this.socketByPlayer.values()) this.send(ws, msg);
  }

  /** Deliver direct/broadcast messages queued by the systems. */
  private flushOutbox(game: GameState): void {
    if (game.outbox.length === 0) return;
    const queue = game.outbox;
    game.outbox = [];
    for (const out of queue) {
      if (out.to === "all") {
        this.broadcastMsg(out.msg);
        continue;
      }
      const ws = this.socketByPlayer.get(out.to);
      if (ws) this.send(ws, out.msg);
    }
  }
}
