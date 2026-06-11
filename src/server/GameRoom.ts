// Authoritative game server: one global room as a Durable Object. Owns socket
// lifecycle, message routing and per-player interest-filtered snapshots; all
// simulation lives in ./systems/*, all SQLite storage code in ./persistence.
//
// The live sim is in-memory; the DO's SQLite storage (new_sqlite_classes)
// holds durable snapshots: the dynamic world every WORLD_SAVE_INTERVAL_S,
// characters keyed by token hash (resume across room restarts), and the
// longest-lives leaderboard. The tick interval keeps the object resident
// while anyone is connected OR while a logged-out body lingers; when both are
// gone, everything is persisted and the interval stops — the next connection
// rebuilds the world from WORLD_SEED + the stored snapshot.

import { DurableObject } from "cloudflare:workers";
import {
  AIRDROP_SMOKE_S,
  INPUT_BUDGET_CAP_S,
  INTEREST_RADIUS,
  LOGOUT_LINGER_S,
  LOOT_INTEREST_RADIUS,
  MAX_PLAYERS,
  RESPAWN_DELAY_S,
  TICK_MS,
  WORLD_SAVE_INTERVAL_S,
  WORLD_SEED,
} from "@/shared/constants";
import { distSq2D } from "@/shared/math";
import {
  ANIM_ATTACKING,
  ANIM_MOVING,
  ANIM_SPRINTING,
  parseClientMsg,
  type DeathRecap,
  type GameEvent,
  type ServerMsg,
  type WireAnimal,
  type WireCorpse,
  type WireDrop,
  type WireFire,
  type WireLoot,
  type WirePlayer,
  type WireZombie,
  type YouState,
} from "@/shared/protocol";
import { createWorld } from "@/shared/world";
import {
  appendLeaderboard,
  clearPendingRecap,
  initSchema,
  loadCharacter,
  loadWorld,
  markCharacterDead,
  pruneStaleCharacters,
  saveCharacter,
  saveWorld,
  topLeaderboard,
} from "./persistence";
import { tickAirdrops } from "./systems/airdrops";
import { performAttack } from "./systems/combat";
import {
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
  restorePlayer,
  sanitizeName,
  useItem,
} from "./systems/players";
import { createGameState, type GameState, type ServerPlayer } from "./systems/state";
import { setDeathSink, tickFires, tickSurvival } from "./systems/survival";
import { tickWeather } from "./systems/weather";
import { spawnInitialDeer, tickDeerRespawns, tickWildlife } from "./systems/wildlife";
import { spawnInitialZombies, tickZombieRespawns, tickZombies } from "./systems/zombies";

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** SHA-256 of the client identity token, as lowercase hex. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** True while any logged-out body is still lingering in the world. */
function hasLingeringPlayers(game: GameState): boolean {
  for (const player of game.players.values()) {
    if (player.offline) return true;
  }
  return false;
}

/** Sockets that never send a valid join get closed after this long. */
const JOIN_TIMEOUT_MS = 10_000;
/** Joined sockets silent for this long are treated as dirty disconnects and
 * closed (the client pings every 2s, so 15s of silence means a dead link). */
const LIVENESS_TIMEOUT_MS = 15_000;
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
  /** Last inbound message per socket — dirty disconnects are closed by the
   * tick once silent past LIVENESS_TIMEOUT_MS, which starts their linger. */
  private lastMsgAt = new Map<WebSocket, number>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Game time of the last periodic world+character save. */
  private lastSaveTime = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      initSchema(ctx.storage.sql);
      pruneStaleCharacters(ctx.storage.sql);
    });
    // killPlayer reports every finished life here (see survival.ts).
    setDeathSink((victim, recap) => this.handleDeath(victim, recap));
  }

  override fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/api/leaderboard") {
      return new Response(JSON.stringify(topLeaderboard(this.ctx.storage.sql, 10)), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
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

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    this.lastMsgAt.set(ws, Date.now());
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
      await this.handleJoin(ws, game, msg.name, msg.token);
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
          // Persist the new life right away (atomically with the world):
          // overwrites the dead row and clears any stale pending recap.
          this.persistAll(game);
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
    // loadWorld hydrates loot/corpses/fires/respawn timers and restores
    // game.time/tick from meta; a fresh database stocks the world instead.
    if (!loadWorld(this.ctx.storage.sql, game)) stockInitialLoot(game);
    // Zombies and deer are never persisted — they always spawn fresh.
    spawnInitialZombies(game);
    spawnInitialDeer(game);
    this.game = game;
    this.lastSaveTime = game.time;
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

  private async handleJoin(
    ws: WebSocket,
    game: GameState,
    rawName: string,
    token: string,
  ): Promise<void> {
    if (this.playerBySocket.has(ws)) return; // already joined
    const tokenHash = await sha256Hex(token);
    // Re-check after the await: a duplicate join racing across the digest.
    if (this.playerBySocket.has(ws)) return;
    const sql = this.ctx.storage.sql;

    // (1) The character is in the live world: a reconnect during the logout
    // linger, or a second tab/device taking the session over. Either way the
    // new socket adopts the existing character; no capacity is consumed.
    for (const existing of game.players.values()) {
      if (existing.tokenHash !== tokenHash) continue;
      const oldWs = this.socketByPlayer.get(existing.id);
      if (oldWs && oldWs !== ws) {
        this.playerBySocket.delete(oldWs);
        this.rateBySocket.delete(oldWs);
        try {
          oldWs.close(1008, "session taken over");
        } catch {
          // Already closed.
        }
      }
      existing.offline = false;
      existing.offlineSince = 0;
      existing.cmdQueue.length = 0;
      existing.wantsAttack = false;
      existing.inputBudget = INPUT_BUDGET_CAP_S;
      existing.lastAck = 0;
      this.playerBySocket.set(ws, existing.id);
      this.socketByPlayer.set(existing.id, ws);
      this.lastMsgAt.set(ws, Date.now());
      this.sendWelcome(ws, game, existing, true, null);
      if (!existing.alive) {
        // Taking over a character that is sitting on the death screen: the
        // death message was consumed by the old socket, so without this the
        // new client renders the playing HUD at 0 hp with no respawn path.
        this.send(ws, {
          t: "death",
          by: existing.lastRecap?.by ?? "the wasteland",
          recap: existing.lastRecap ?? {
            by: "the wasteland",
            survivedS: 0,
            kills: 0,
            zombieKills: 0,
            distanceM: 0,
          },
        });
      }
      this.persistAll(game);
      this.broadcastMsg({ t: "notice", msg: `${existing.name} reconnected` });
      return;
    }

    let connected = 0;
    for (const p of game.players.values()) {
      if (!p.offline) connected++;
    }
    if (connected >= MAX_PLAYERS) {
      this.send(ws, { t: "error", msg: "Server full" });
      return;
    }

    const saved = loadCharacter(sql, tokenHash);

    // (2) A living character saved before a room restart: resume it. The
    // persisted name stays authoritative — a transient collision with an
    // online namesake must not permanently rename a saved character (the
    // token already disambiguates identity).
    if (saved && saved.alive) {
      const player = restorePlayer(game, saved.id, saved.name, tokenHash, saved.state);
      this.playerBySocket.set(ws, player.id);
      this.socketByPlayer.set(player.id, ws);
      this.lastMsgAt.set(ws, Date.now());
      this.sendWelcome(ws, game, player, true, null);
      this.persistAll(game);
      this.broadcastMsg({ t: "notice", msg: `${player.name} joined` });
      return;
    }

    // (3) Dead row or no row: a brand-new life. If the previous life ended
    // while its owner was offline, deliver the stored recap exactly once.
    const name = sanitizeName(rawName, game);
    const id = crypto.randomUUID().slice(0, 8);
    const player = createPlayer(game, id, name, tokenHash);
    const recap = saved ? saved.pendingRecap : null;
    if (recap) clearPendingRecap(sql, tokenHash);
    this.playerBySocket.set(ws, id);
    this.socketByPlayer.set(id, ws);
    this.lastMsgAt.set(ws, Date.now());
    this.sendWelcome(ws, game, player, false, recap);
    this.persistAll(game);
    this.broadcastMsg({ t: "notice", msg: `${name} joined` });
  }

  private sendWelcome(
    ws: WebSocket,
    game: GameState,
    player: ServerPlayer,
    resumed: boolean,
    recap: DeathRecap | null,
  ): void {
    this.send(ws, {
      t: "welcome",
      id: player.id,
      seed: game.world.seed,
      time: game.time,
      you: this.youState(player),
      inv: player.inventory.map((stack) => (stack ? { ...stack } : null)),
      selected: player.selectedSlot,
      resumed,
      recap,
    });
  }

  private dropSocket(ws: WebSocket): void {
    const playerId = this.playerBySocket.get(ws);
    this.playerBySocket.delete(ws);
    this.rateBySocket.delete(ws);
    this.lastMsgAt.delete(ws);
    if (playerId !== undefined) {
      this.socketByPlayer.delete(playerId);
      const game = this.game;
      if (game) {
        const player = game.players.get(playerId);
        if (player) {
          if (player.alive) {
            // Combat-log deterrent: the body lingers in the world,
            // defenseless, for LOGOUT_LINGER_S (it drops a real corpse only
            // if something kills it). Replaces the old instant death bag.
            player.offline = true;
            player.offlineSince = game.time;
            player.cmdQueue.length = 0;
            player.wantsAttack = false;
            this.persistAll(game);
          } else {
            // Dead characters were already marked dead in storage at kill
            // time; nothing lingers.
            game.players.delete(playerId);
          }
          this.broadcastMsg({ t: "notice", msg: `${player.name} left` });
        }
      }
    }
    // getWebSockets() can still include the socket whose close handler is
    // running — filter it out, or the tick never stops for the last leaver.
    // While offline bodies linger the tick keeps running even with zero
    // sockets (zombies can still reach them); the tick's own check stops the
    // loop once the lingers expire.
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length === 0) {
      const game = this.game;
      if (!game) {
        this.stopTicking();
        return;
      }
      if (!hasLingeringPlayers(game)) this.stopAndPersist(game);
    }
  }

  /** Persist a death: leaderboard row + character row (recap stored for
   * offline victims, who are removed from the world immediately — their
   * lingering body is now a corpse entity). */
  private handleDeath(victim: ServerPlayer, recap: DeathRecap): void {
    const sql = this.ctx.storage.sql;
    appendLeaderboard(sql, {
      name: victim.name,
      survivedS: recap.survivedS,
      kills: recap.kills,
      zombieKills: recap.zombieKills,
      distanceM: recap.distanceM,
      by: recap.by,
      endedAt: Date.now(),
    });
    markCharacterDead(sql, victim.tokenHash, victim.offline ? JSON.stringify(recap) : null);
    if (victim.offline) this.game?.players.delete(victim.id);
    // The victim's inventory just became a world corpse — make that corpse
    // durable in the same breath as the death, or a restart in the gap
    // destroys it while the death is already permanent.
    if (this.game) this.persistAll(this.game);
  }

  /** Snapshot the world and every character (online, offline and dead) in
   * ONE transaction. World entities and inventories trade items between
   * them; saving either alone opens duplication/destruction windows across
   * an unclean restart, so this is the only way anything gets saved. */
  private persistAll(game: GameState): void {
    const storage = this.ctx.storage;
    storage.transactionSync(() => {
      saveWorld(storage, storage.sql, game);
      for (const player of game.players.values()) {
        saveCharacter(storage.sql, player, game.time);
      }
    });
  }

  /**
   * Final save before the room goes idle. Any offline players still lingering
   * are saved and removed right now rather than waiting out the linger (this
   * is belt-and-braces — the callers only stop once no lingers remain).
   */
  private stopAndPersist(game: GameState): void {
    const sql = this.ctx.storage.sql;
    for (const player of game.players.values()) {
      if (!player.offline) continue;
      saveCharacter(sql, player, game.time);
      game.players.delete(player.id);
    }
    this.persistAll(game);
    this.stopTicking();
  }

  // --- Tick ---

  private tick(): void {
    const game = this.game;
    if (!game) return;
    // No sockets: keep simulating while offline bodies linger (zombies may
    // still eat them); once none remain, persist everything and go idle.
    if (this.ctx.getWebSockets().length === 0 && !hasLingeringPlayers(game)) {
      this.stopAndPersist(game);
      return;
    }
    const dt = TICK_MS / 1000;

    // Logged-out bodies past the linger window are saved and removed —
    // no corpse, no notice; they simply fade from the world. The save is a
    // full persistAll AFTER removal so world + characters stay coherent
    // (the character row was already saved when the linger began; vitals
    // drift during the linger is persisted by the same persistAll).
    let lingersExpired = false;
    for (const player of game.players.values()) {
      if (!player.offline) continue;
      if (game.time - player.offlineSince < LOGOUT_LINGER_S) continue;
      saveCharacter(this.ctx.storage.sql, player, game.time);
      game.players.delete(player.id);
      lingersExpired = true;
    }
    if (lingersExpired) this.persistAll(game);

    // Dirty disconnects: joined sockets silent past the liveness window are
    // closed here, which fires webSocketClose -> dropSocket -> linger.
    const nowMs = Date.now();
    for (const [ws] of this.playerBySocket) {
      const last = this.lastMsgAt.get(ws);
      if (last !== undefined && nowMs - last > LIVENESS_TIMEOUT_MS) {
        try {
          ws.close(1001, "liveness timeout");
        } catch {
          // Already closing.
        }
      }
    }

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
    tickWeather(game, dt);
    tickAirdrops(game, dt);
    tickWildlife(game, dt);
    tickDeerRespawns(game, dt);
    tickFires(game, dt);
    tickLootRespawns(game, dt);
    tickCorpses(game, dt);
    tickDroppedLoot(game, dt);
    game.time += dt;
    game.tick++;

    // Periodic durable snapshot of the world + every character.
    if (game.time - this.lastSaveTime >= WORLD_SAVE_INTERVAL_S) {
      this.lastSaveTime = game.time;
      this.persistAll(game);
    }

    this.flushOutbox(game);
    this.broadcastSnapshots(game);
    game.events.length = 0;
  }

  // --- Snapshots ---

  private broadcastSnapshots(game: GameState): void {
    // Connected players only — lingering offline bodies are in game.players
    // (and in the players array below) but are not "online".
    const count = this.socketByPlayer.size;
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
        mil: zombie.mil,
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

    // Airdrops are NEVER interest-filtered: the smoke column (and the falling
    // crate) must be visible from anywhere on the island.
    const drops: WireDrop[] = [];
    for (const drop of game.drops.values()) {
      drops.push({
        id: drop.id,
        x: round2(drop.x),
        y: round2(drop.y),
        z: round2(drop.z),
        smoke: game.time >= drop.landsAt && game.time < drop.landsAt + AIRDROP_SMOKE_S,
        falling: game.time < drop.landsAt,
      });
    }

    const animals: WireAnimal[] = [];
    for (const deer of game.animals.values()) {
      if (distSq2D(px, pz, deer.x, deer.z) > interestSq) continue;
      animals.push({
        id: deer.id,
        x: round2(deer.x),
        y: round2(deer.y),
        z: round2(deer.z),
        yaw: round3(deer.yaw),
        state: deer.state,
      });
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
      drops,
      animals,
      weather: round2(game.weather),
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
