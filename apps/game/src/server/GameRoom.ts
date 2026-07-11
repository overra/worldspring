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
// rebuilds the world from the effective seed + the stored snapshot.

import { DurableObject } from "cloudflare:workers";
import {
  SIZE_TIERS,
  parseWorldFingerprint,
  resolveServerConfig,
  summarizeRules,
  tierParamsOf,
  wipeEpochOf,
  worldFingerprintOf,
  worldParamsOf,
} from "@worldspring/shared/config";
import type {
  ResolvedConfig,
  ServerConfig,
} from "@worldspring/shared/config";
import {
  AIRDROP_SMOKE_S,
  CHAT_COOLDOWN_S,
  CHAT_MAX_LENGTH,
  CHAT_RADIUS,
  DECAY_SWEEP_INTERVAL_S,
  INPUT_BUDGET_CAP_S,
  INTEREST_RADIUS,
  LOOT_INTEREST_RADIUS,
  MAX_MOTD_LENGTH,
  MAX_PLAYERS,
  MAX_SERVER_NAME_LENGTH,
  TICK_MS,
  WORLD_SAVE_INTERVAL_S,
} from "@worldspring/shared/constants";
import { encodeExplored } from "@worldspring/shared/fog";
import { distSq2D } from "@worldspring/shared/math";
import {
  SERVER_INFO_SCHEMA_VERSION,
  type ServerInfo,
} from "@worldspring/shared/serverInfo";
import { GAME_VERSION } from "@worldspring/shared/version";
import {
  ANIM_ATTACKING,
  ANIM_MOVING,
  ANIM_SPRINTING,
  PROTOCOL_VERSION,
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
  type WireBody,
  type WirePortal,
  type WireZombie,
  type YouState,
} from "@worldspring/shared/protocol";
import { createWorld } from "@worldspring/shared/world";
import {
  appendLeaderboard,
  captureBookmark,
  clearPendingRecap,
  initSchema,
  lastSeenMs,
  loadCharacter,
  loadWorld,
  markCharacterDead,
  pruneStaleCharacters,
  saveCharacter,
  saveWorld,
  topLeaderboard,
} from "./persistence";
import type { SaveWorldStats, SchemaBootContext } from "./persistence";
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
  craftItem,
  createPlayer,
  dropSlot,
  equipSlot,
  markExploration,
  pickupLoot,
  queueInput,
  respawnPlayer,
  restorePlayer,
  sanitizeName,
  startUse,
  stepPortals,
  STRIP_TEXT_RE,
  tickActiveActions,
  unwearItem,
  wearItem,
  wornWire,
} from "./systems/players";
import {
  capturePosHistory,
  createGameState,
  sendTo,
  type GameState,
  type ServerPlayer,
} from "./systems/state";
import {
  handleContainerMove,
  handleContainerOpen,
  handleDemolish,
  handleDoor,
  handlePlace,
  handleSetCode,
  handleTryCode,
  structuresFullMsgs,
  sweepDecay,
  tickStructures,
} from "./systems/structures";
import { DirectoryHeartbeat, directoryChallengeFor, warmDirectoryChallenge } from "./heartbeat";
import { resolveScenario } from "./systems/scenarios";
import { isTestbedEnabled, provisionTestbed } from "./systems/testbed";
import { loadRapier } from "./physics/loader";
import { spawnInitialProps } from "./systems/props";
import {
  driveInput,
  enterVehicle,
  exitVehicle,
  refuelVehicle,
  seatPlayerIds,
  spawnInitialVehicles,
  stepVehicles,
  tickVehicles,
  vacateSeat,
} from "./systems/vehicles";
import { killPlayer, setDeathSink, tickFires, tickSurvival } from "./systems/survival";
import { toPlantedRecord } from "@worldspring/shared/trees";
import { tickAmbientSeeds, tickTreeGrowth, tickTrunks } from "./systems/trees";
import { tickWeather } from "./systems/weather";
import { spawnInitialDeer, tickDeerRespawns, tickWildlife } from "./systems/wildlife";
import { spawnInitialZombies, tickZombieRespawns, tickZombies } from "./systems/zombies";

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Sanitize an operator-set server name/MOTD for ServerInfo: strip controls/
 * zero-width/bidi (the shared STRIP_TEXT_RE class) and cap by CODE POINTS (the
 * spread never splits a surrogate pair), trimming both edges. Unlike
 * sanitizeName this keeps an empty string empty (no "Survivor" default) and
 * does NOT dedup against players — a name/MOTD is neither. It deliberately does
 * NOT touch `<` `>` `&` or quotes: render-as-text is the consumer's job (doc 03
 * §10 rule 8).
 */
function sanitizeServerText(raw: string, maxCodePoints: number): string {
  return [...raw.replace(STRIP_TEXT_RE, "").trim()].slice(0, maxCodePoints).join("").trim();
}

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

// --- Tick instrumentation (surfaced via /api/health) ---
/** EMA smoothing factor for the per-tick wall-clock cost. */
const TICK_EMA_ALPHA = 0.1;
/** Ticks costing more than this log a "tick overrun" warning. */
const TICK_OVERRUN_WARN_MS = 40;
/** tickMsMax decays by rotating two max-windows of this length (~5s memory). */
const TICK_MAX_WINDOW_MS = 5_000;

interface RateWindow {
  windowStart: number;
  count: number;
}

export class GameRoom extends DurableObject<Env> {
  private game: GameState | null = null;
  /** The full resolve result (warnings/varAbsent/worldTainted) — M2 feeds the
   * flags into the fail-closed wipe decision; M1 only logs the warnings. */
  private resolved: ResolvedConfig;
  /** Resolved deploy-time config. Seeds worldgen, the welcome message, server-
   * info badges, and (in M3+) every system's tuning. */
  private config: ServerConfig;
  /** Connection state lives in memory, keyed by WebSocket (see header note). */
  private playerBySocket = new Map<WebSocket, string>();
  private socketByPlayer = new Map<string, WebSocket>();
  private rateBySocket = new Map<WebSocket, RateWindow>();
  /** Last inbound message per socket — dirty disconnects are closed by the
   * tick once silent past LIVENESS_TIMEOUT_MS, which starts their linger. */
  private lastMsgAt = new Map<WebSocket, number>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock ms when the current occupied session began (startTicking);
   * 0 while idle. Drives ServerInfo.uptimeS (doc 03 §2). */
  private activeSince = 0;
  /** Canonical https origin of this server, captured from the first request's
   * URL and mirrored to/restored from the `meta.origin` row. Feeds
   * ServerInfo.joinUrl in request-less contexts (heartbeats, M3). null until
   * the first request is seen on a cold-started object (doc 03 §2). */
  private publicOrigin: string | null = null;
  /** Game time of the last periodic world+character save. */
  private lastSaveTime = 0;
  // Tick timing stats (read by the /api/health route; see timedTick).
  private tickMsEma = 0;
  private tickCount = 0;
  private tickMsWindowMax = 0;
  private tickMsPrevWindowMax = 0;
  private tickMsWindowStart = 0;
  // Per-phase tick cost (additive /api/health `tickPhases`): EMA + rotating
  // window max per labelled call group in tick(), same alpha and window as the
  // whole-tick numbers above so the phase breakdown sums to ~tickMsEma. A gap
  // between the sum and tickMsEma is time OUTSIDE the buckets (GC pauses,
  // workerd stalls) — that gap is itself a diagnostic signal.
  private tickPhaseEma = new Map<string, number>();
  private tickPhaseWindowMax = new Map<string, number>();
  private tickPhasePrevWindowMax = new Map<string, number>();
  /** Monotonic count of inbound WS messages received — exposed via /api/health
   * for external inbound-rate monitoring (Δ inMsgCount / Δ now); used by the
   * load-test harness to tell server CPU load apart from undelivered load. */
  private inMsgCount = 0;
  /** Instrumentation for the most recent persistAll (additive /api/health
   * field `lastSave`): wall-clock per-phase ms + bytes for the split-row save
   * (doc 06 M8 follow-up). null until the first save of this object's life. */
  private lastSave: {
    at: number;
    ms: number;
    snapshotMs: number;
    treesMs: number;
    structuresMs: number;
    charactersMs: number;
    dirtyBuckets: number;
    snapshotBytes: number;
    treesBytes: number;
    structuresBytes: number;
    characters: number;
  } | null = null;

  /** doc 10 M1: preview-only testbed provisioning gate (env.TESTBED === "1").
   * Set once from the deploy-time var; undefined in prod → false → never seeds. */
  private readonly testbed: boolean;

  /** doc 03 M3: directory heartbeat sender. Inert unless BOTH
   * env.DIRECTORY_URL and env.DIRECTORY_TOKEN are set (zero-config CLI
   * deploys stay request-free); all state is in-memory — a DO restart
   * re-arms a 401-disarmed sender by design. */
  private readonly heartbeat: DirectoryHeartbeat;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Resolve deploy-time config BEFORE schema init. resolveServerConfig never
    // throws (a throwing DO constructor crash-loops the object), so it is safe
    // here even with hostile env input. The resolved {varAbsent, worldTainted}
    // flags + the world fingerprint feed initSchema's fail-closed wipe decision
    // (below); the warnings are logged here.
    this.resolved = resolveServerConfig(env.GAME_CONFIG);
    this.config = this.resolved.config;
    this.testbed = isTestbedEnabled(env);
    // Heartbeat sender (doc 03 M3): beats reuse buildServerInfo's request-less
    // path (joinUrl from the captured publicOrigin / meta.origin).
    this.heartbeat = new DirectoryHeartbeat({
      directoryUrl: env.DIRECTORY_URL,
      directoryToken: env.DIRECTORY_TOKEN,
      buildInfo: () => this.buildServerInfo(),
    });
    for (const w of this.resolved.warnings) {
      console.warn(`[config] ${w}`);
    }
    void ctx.blockConcurrencyWhile(async () => {
      // Settle the directory-challenge digest BEFORE any request is delivered:
      // a synchronous /api/server-info on a cold object would otherwise
      // publish directoryChallenge: null (and the worker micro-cache would pin
      // it for 15 s) — the prober reads that as challenge-mismatch and walks
      // healthy idle servers to 'unreachable'. Token-only deploys (no
      // DIRECTORY_URL) are covered too: probes need the challenge even with
      // the heartbeat sender inert.
      await warmDirectoryChallenge(env.DIRECTORY_TOKEN);
      // Capture a PITR bookmark BEFORE the wipe decision (or "unavailable" in
      // local dev), then run the fail-closed world-wipe check. initSchema returns
      // the world the DO must actually generate — the running config's world, or,
      // on the fail-closed refusal path, the persisted world the characters live
      // in. Apply it so worldgen, the welcome message, and clients all agree.
      const boot: SchemaBootContext = {
        fingerprint: worldFingerprintOf(this.config.world),
        seed: this.config.world.seed,
        wipeSchedule: this.config.session.wipeSchedule,
        wipeEpoch: wipeEpochOf(this.config.session.wipeSchedule, Date.now()),
        configJson: JSON.stringify(this.config),
        varAbsent: this.resolved.varAbsent,
        worldTainted: this.resolved.worldTainted,
        bookmark: await captureBookmark(ctx.storage),
      };
      // initSchema returns the effective world fingerprint (the running one, or
      // the persisted one on a fail-closed refusal); parse it back so worldgen,
      // the welcome message, and clients all agree on the world.
      const effective = parseWorldFingerprint(initSchema(ctx.storage.sql, boot));
      if (effective) this.config.world = effective;
      pruneStaleCharacters(ctx.storage.sql);
    });
    // killPlayer reports every finished life here (see survival.ts).
    setDeathSink((victim, recap) => this.handleDeath(victim, recap));
  }

  override fetch(request: Request): Response {
    const url = new URL(request.url);
    // Capture the public origin once per object lifetime — every request the DO
    // sees (WS upgrades and /api/server-info alike) is a valid source. Mirror it
    // to meta.origin so a request-less heartbeat (M3) and a cold-started object
    // can recover it. Restore from meta.origin if a cold start hasn't seen a
    // request yet (doc 03 §2 joinUrl sourcing).
    if (this.publicOrigin === null) {
      this.publicOrigin = url.origin;
      this.saveOrigin(url.origin);
    }
    if (url.pathname === "/api/server-info") {
      return new Response(JSON.stringify(this.buildServerInfo(request)), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=15, stale-while-revalidate=30",
        },
      });
    }
    if (url.pathname === "/api/leaderboard") {
      return new Response(JSON.stringify(topLeaderboard(this.ctx.storage.sql, 10)), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
    // Read-only room stats (no auth — nothing sensitive, used by loadtest).
    // Counts are 0 while the room is idle; we never wake the sim to answer.
    if (url.pathname === "/api/health") {
      const game = this.game;
      return new Response(
        JSON.stringify({
          players: game?.players.size ?? 0,
          zombies: game?.zombies.size ?? 0,
          animals: game?.animals.size ?? 0,
          drops: game?.drops.size ?? 0,
          corpses: game?.corpses.size ?? 0,
          loot: game?.loot.size ?? 0,
          tickMsEma: round2(this.tickMsEma),
          tickMsMax: round2(Math.max(this.tickMsWindowMax, this.tickMsPrevWindowMax)),
          tick: game?.tick ?? 0,
          uptime: round2(game?.time ?? 0),
          // Observability: an independent wall clock + a monotonic inbound count
          // let an external monitor derive the TRUE sustained tick rate
          // (Δtick / Δnow) and inbound load without trusting the in-DO
          // performance.now() (which under-reports pure-CPU ticks on workerd).
          now: Date.now(),
          inMsgCount: this.inMsgCount,
          // Additive: per-phase cost of the most recent periodic save (the
          // split-row persist, doc 06 M8 follow-up). Read by build-loadtest.
          lastSave: this.lastSave,
          // Additive: per-phase tick cost breakdown — { label: { ema, max } },
          // same EMA alpha / max-window semantics as tickMsEma / tickMsMax.
          // Sum of emas ≈ tickMsEma; the shortfall is un-bucketed stall time
          // (GC / workerd), which is the point of comparing them.
          tickPhases: Object.fromEntries(
            [...this.tickPhaseEma].map(([label, ema]) => [
              label,
              {
                ema: round2(ema),
                max: round2(
                  Math.max(
                    this.tickPhaseWindowMax.get(label) ?? 0,
                    this.tickPhasePrevWindowMax.get(label) ?? 0,
                  ),
                ),
              },
            ]),
          ),
        }),
        {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        },
      );
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= this.effectiveMaxPlayers) {
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

  /** Hard player cap: the configured soft cap (session.maxPlayers) clamped to
   * the verified perf envelope MAX_PLAYERS. */
  private get effectiveMaxPlayers(): number {
    return Math.min(MAX_PLAYERS, this.config.session.maxPlayers);
  }

  /**
   * Build the public ServerInfo document (doc 03 §2). IDLE-SAFE by contract:
   * MUST NOT call ensureGame()/startTicking() — same discipline as /api/health.
   * Everything is in-memory except worldAgeS, which on the idle path costs at
   * most ONE synchronous SQLite read (snapshot row). Bills 1:1 on a cold start,
   * never wakes the sim. `request` is present for the GET route and absent for
   * the request-less heartbeat sender (M3).
   */
  private buildServerInfo(request?: Request): ServerInfo {
    const game = this.game;

    // Connected players only (excludes offline lingering bodies) — the
    // handleJoin capacity-count semantics, 0 when game === null.
    let players = 0;
    if (game) {
      for (const p of game.players.values()) {
        if (!p.offline) players++;
      }
    }

    const occupied = this.tickHandle !== null;

    // worldAgeS: live game time if the sim is loaded, else read the persisted
    // snapshot's `time`. NOTE doc-drift: doc §2/§3 say "meta.game_time", but
    // that row does NOT exist — after the #9 single-row persist fix game time
    // lives in the world_state 'snapshot' JSON (persistence.saveWorld), and the
    // only meta rows are schema_version + world_seed. Degrades to 0 on a fresh
    // or corrupt DB, never throws.
    const worldAgeS = game?.time ?? this.loadPersistedGameTime();

    // joinUrl: the live request's origin when we have one, else the captured
    // field, else the persisted meta.origin (one cheap read on a request-less
    // cold start), else "" — required field always present (§10 rule 3).
    const joinUrl = request
      ? new URL(request.url).origin
      : (this.publicOrigin ?? this.loadOrigin() ?? "");

    return {
      schemaVersion: SERVER_INFO_SCHEMA_VERSION,
      gameVersion: GAME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      worldSeed: game?.world.seed ?? this.config.world.seed,
      // Untrusted operator-set vars with code defaults. Strip controls/zero-
      // width/bidi and cap by code points (doc 03 §2). Deliberately NOT
      // sanitizeName: that forces a non-empty "Survivor" default and dedups
      // against live players — both wrong for a server name/MOTD. STRIP_TEXT_RE
      // does NOT escape < > & or quotes; rendering as text is the consumer's
      // job (§10 rule 8), so no HTML-escaping here.
      // The contract requires name to be 1..MAX_SERVER_NAME_LENGTH: a
      // whitespace/control-only SERVER_NAME sanitizes to "", so fall back to
      // the clean default here (motd, below, may legitimately stay empty).
      name:
        sanitizeServerText(this.env.SERVER_NAME ?? "Worldspring", MAX_SERVER_NAME_LENGTH) ||
        "Worldspring",
      motd: sanitizeServerText(this.env.SERVER_MOTD ?? "", MAX_MOTD_LENGTH),
      rules: summarizeRules(this.config),
      players,
      maxPlayers: this.effectiveMaxPlayers,
      status: occupied ? "occupied" : "idle",
      uptimeS: occupied ? Math.floor((Date.now() - this.activeSince) / 1000) : 0,
      worldAgeS,
      // colo is the M4 cdn-cgi/trace spike, present-but-null per the
      // forward-compat rule 3 (required fields always emitted).
      colo: null,
      joinUrl,
      // sha256("worldspring-directory-challenge:" + DIRECTORY_TOKEN), cached
      // module-level; null when the token is unset (doc 03 §2) or for the
      // first responses on a cold start while the digest settles.
      directoryChallenge: directoryChallengeFor(this.env.DIRECTORY_TOKEN),
    };
  }

  // --- meta.origin + persisted game-time reads (doc 03 §2) ---
  // Kept as private DO helpers (not in persistence.ts, which is off-limits for
  // this milestone): each is a single additive row read/write over tables
  // initSchema/saveWorld already own — no schema change, no SCHEMA_VERSION bump.

  /** Mirror the captured public origin to the `meta.origin` row. */
  private saveOrigin(origin: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('origin', ?)",
      origin,
    );
  }

  /** The last persisted public origin, or null if none has been written. */
  private loadOrigin(): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'origin'")
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  /**
   * Persisted world game-time seconds, read from the single `snapshot` row's
   * JSON `time` (the #9 single-row layout). 0 when absent or corrupt — the same
   * corrupt-guard posture as loadWorld; an idle worldAgeS must never throw.
   */
  private loadPersistedGameTime(): number {
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM world_state WHERE kind = 'snapshot'")
      .toArray();
    if (rows.length === 0) return 0;
    try {
      const snap = JSON.parse(rows[0].payload) as { time?: unknown };
      return typeof snap.time === "number" && Number.isFinite(snap.time) ? snap.time : 0;
    } catch {
      // Corrupt snapshot: degrade to 0 rather than brick the public endpoint.
      return 0;
    }
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
    this.inMsgCount++;
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
    // Re-arm the tick on every non-ping message. After a platform DO recycle the
    // surviving socket's next message lands HERE, not in fetch() (the only other
    // startTicking caller), so without this the tick stays stopped and a
    // rehydrated survivor freezes — it gets the welcome but no snapshots and no
    // liveness sweep (both live only inside tick()). Idempotent (guarded by
    // tickHandle), so calling it unconditionally per message is safe & cheap.
    this.startTicking();
    if (msg.t === "join") {
      await this.handleJoin(ws, game, msg.name, msg.token, msg.proto, msg.scenario);
      this.flushOutbox(game);
      return;
    }

    let playerId = this.playerBySocket.get(ws);
    if (playerId === undefined) {
      // A socket that survived a DO recycle: the platform evicted + recreated
      // the object (keeping the hibernatable WebSocket and its attachment, but
      // wiping the in-memory maps). Re-associate it with its character from the
      // attachment instead of ignoring it — otherwise it gets no snapshots and
      // the liveness sweep eventually closes it, dropping the player.
      playerId = this.rehydrateSocket(ws, game);
      if (playerId === undefined) return; // not resumable -> client must re-join
    }
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
        // Lag comp: game-time the shooter's screen showed when they fired
        // (parse-validated number or absent). Not trusted as-is — combat
        // clamps it to at most LAG_COMP_MAX_REWIND_S in the past, so a
        // malicious timestamp gains no more than the ~350ms rewind any
        // laggy-but-honest client gets; future values clamp to now.
        player.wantsAttackAt = msg.at ?? null;
        break;
      case "use":
        // {t:"use"} now STARTS a channeled action (doc 11) instead of resolving
        // inline: startUse opens a timed cast (or runs the instant path for the
        // still-instant water/fishing/tool items). Completion lands on the tick.
        startUse(game, player, msg.slot);
        break;
      case "craft":
        craftItem(game, player, msg.recipe);
        break;
      case "wear":
        wearItem(game, player, msg.slot);
        break;
      case "unwear":
        unwearItem(game, player, msg.ws);
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
      case "place":
        handlePlace(game, player, msg);
        break;
      case "demolish":
        handleDemolish(game, player, msg.id);
        break;
      case "door":
        handleDoor(game, player, msg.id);
        break;
      case "setCode":
        handleSetCode(game, player, msg.id, msg.code);
        break;
      case "tryCode":
        handleTryCode(game, player, msg.id, msg.code);
        break;
      case "cOpen":
        handleContainerOpen(game, player, msg.id);
        break;
      case "cMove":
        handleContainerMove(game, player, msg);
        break;
      case "enterVehicle":
        enterVehicle(game, player, msg.id, msg.seat);
        break;
      case "exitVehicle":
        exitVehicle(game, player);
        break;
      case "drive":
        driveInput(game, player, msg.throttle, msg.steer, msg.brake);
        break;
      case "refuel":
        refuelVehicle(game, player, msg.id);
        break;
      case "respawn":
        // doc 06 griefing policy: "respawn is always available" is layer 2 of
        // the walling-in mitigation. Until structure damage lands (milestone
        // 7's FIST_STRUCT_DMG), a respawn request from a LIVING player is a
        // give-up: die in place (body + inventory stay), then the normal
        // death→respawn flow applies. Without this, a walled-in player's only
        // exit is waiting out starvation.
        if (player.alive) {
          killPlayer(game, player, "gave up");
          this.persistAll(game);
          break;
        }
        if (!player.alive && game.time - player.diedAt >= this.config.session.respawnDelayS) {
          respawnPlayer(game, player);
          // Persist the new life right away (atomically with the world):
          // overwrites the dead row and clears any stale pending recap.
          this.persistAll(game);
        }
        break;
      case "chat":
        this.handleChat(game, player, msg.text);
        break;
    }
    this.flushOutbox(game);
  }

  /**
   * Proximity text chat: sanitize, rate-limit per player (CHAT_COOLDOWN_S of
   * game time), then queue the line for every ONLINE player within
   * CHAT_RADIUS (2D) of the sender — including the sender, whose echo
   * confirms delivery. Lingering offline bodies never receive (no socket)
   * and never send (their socket is gone, but the guard is explicit).
   */
  private handleChat(game: GameState, sender: ServerPlayer, raw: string): void {
    if (!sender.alive || sender.offline) return;
    if (game.time - sender.lastChatAt < CHAT_COOLDOWN_S) return;
    // Strip control/zero-width/bidi chars to spaces (shared class with name
    // sanitization), collapse whitespace runs, trim, then cap by code points
    // (never splits a surrogate pair) and re-trim the cut edge.
    const text = [
      ...raw
        .replace(STRIP_TEXT_RE, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ]
      .slice(0, CHAT_MAX_LENGTH)
      .join("")
      .trim();
    if (text.length === 0) return;
    sender.lastChatAt = game.time;
    const radiusSq = CHAT_RADIUS * CHAT_RADIUS;
    for (const other of game.players.values()) {
      if (other.offline) continue;
      if (distSq2D(sender.core.x, sender.core.z, other.core.x, other.core.z) > radiusSq) continue;
      sendTo(game, other.id, { t: "chat", name: sender.name, text });
    }
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
    // doc 07 M2: createWorld takes the full WorldGenParams (seed + tier-derived
    // size/counts). The fail-closed fingerprint gate in initSchema, not
    // coercion, guards persisted state against a world (seed OR tier) change.
    const world = createWorld(worldParamsOf(this.config.world));
    // Boot determinism checks: the generated world's seed/size MUST match the
    // config they were derived from. Log + coerce, NEVER throw — a throwing
    // constructor/boot crash-loops the DO.
    if (world.seed !== this.config.world.seed) {
      console.error(
        `[config] world seed ${world.seed} != config seed ${this.config.world.seed}; coercing config to match the generated world`,
      );
      this.config.world.seed = world.seed;
    }
    if (world.size !== tierParamsOf(this.config.world.sizeTier).size) {
      console.error(
        `[config] world size ${world.size} != tier "${this.config.world.sizeTier}" size ` +
          `${tierParamsOf(this.config.world.sizeTier).size}; coercing config to match the generated world`,
      );
      // Iterate SIZE_TIERS (not a literal list) so a future tier addition or
      // rename keeps this reverse lookup self-updating.
      const match = SIZE_TIERS.find((t) => tierParamsOf(t).size === world.size);
      if (match) this.config.world.sizeTier = match;
    }
    const game = createGameState(world, this.config);
    // loadWorld hydrates loot/corpses/fires/respawn timers and restores
    // game.time/tick from meta; a fresh database stocks the world instead.
    if (!loadWorld(this.ctx.storage.sql, game)) {
      stockInitialLoot(game);
      // doc 13 M3 — fresh world only: spawn the deterministic barrels (buffer
      // in PhysicsSystem until the async engine attach materializes them). A
      // RESTORED world rebuilds barrels from the persisted `bodies` snapshot
      // instead, so this never double-spawns (the stockInitialLoot precedent).
      spawnInitialProps(game);
      // doc 13 M4 — fresh world only: spawn the deterministic vehicles (buffer
      // in PhysicsSystem until attach). A restored world rebuilds them from the
      // `bodies` + `vehicles` snapshots instead, so this never double-spawns.
      spawnInitialVehicles(game);
    }
    // Zombies and deer are never persisted — they always spawn fresh.
    spawnInitialZombies(game);
    spawnInitialDeer(game);
    // doc 06 M7 — boot decay sweep: an abandoned base disappears the first
    // time anyone wakes the room past the window (idle-server gaps). Runs
    // AFTER loadWorld restored the pieces; the tick's tickStructures owns the
    // 5-game-minute cadence from here.
    sweepDecay(game, (hash) => lastSeenMs(this.ctx.storage.sql, hash));
    game.decayNextAt = game.time + DECAY_SWEEP_INTERVAL_S;
    this.game = game;
    this.lastSaveTime = game.time;
    // doc 13 — attach the physics engine asynchronously (wasm init). Ticks
    // before it resolves skip stepping; restored bodies buffer in the system.
    // The catch keeps an engine-load failure from becoming an unhandled
    // rejection: the room runs physics-less (spawnBody buffers, saves pass
    // the buffer through), which is degraded but never fatal.
    if (this.config.physics.enabled) {
      loadRapier()
        .then((rapier) => this.game?.physics.attachEngine(rapier, TICK_MS / 1000))
        .catch((err) => console.error("[physics] engine load failed — running physics-less", err));
    }
    return game;
  }

  private startTicking(): void {
    if (this.tickHandle !== null) return;
    // Mark the start of an occupied session — ServerInfo.uptimeS measures from
    // here (doc 03 §2). Set after the guard so a redundant call can't reset it.
    this.activeSince = Date.now();
    this.tickHandle = setInterval(() => this.timedTick(), TICK_MS);
    // Directory beat: the idle→occupied transition (doc 03 §6 "boot").
    this.heartbeat.onBoot();
  }

  private stopTicking(): void {
    if (this.tickHandle === null) return;
    clearInterval(this.tickHandle);
    this.tickHandle = null;
    // Session over: idle uptime is 0 (doc 03 §2).
    this.activeSince = 0;
  }

  /**
   * Timing wrapper around the tick body — wall-clocks every tick for the
   * /api/health stats: an EMA (alpha TICK_EMA_ALPHA), a windowed max (max of
   * the current and previous TICK_MAX_WINDOW_MS windows, so spikes age out
   * after ~5-10s), and a total tick count. Note: deployed workerd only
   * advances timers at I/O boundaries, so pure-CPU ticks can read low there;
   * local dev (and any tick touching storage) reports real numbers.
   */
  private timedTick(): void {
    const start = performance.now();
    try {
      this.tick();
    } catch (err) {
      // Defense-in-depth: a bug in a single tick must never escape the
      // setInterval callback uncaught — that crashes the isolate, forcing the
      // platform to evict + recreate the DO and drop every connected player
      // (see rehydrateSocket). Log and skip; state holds at the last good tick.
      console.error(`[tick] error at tick ${this.game?.tick ?? 0}, skipping:`, err);
      // A throw partway through tick() skips the end-of-tick game.events clear,
      // so drop the partial batch here — otherwise a deterministic per-tick throw
      // would accumulate events unbounded (and broadcast stale half-state).
      if (this.game) this.game.events.length = 0;
    }
    const ms = performance.now() - start;
    this.tickCount++;
    this.tickMsEma =
      this.tickCount === 1 ? ms : this.tickMsEma + TICK_EMA_ALPHA * (ms - this.tickMsEma);
    const nowMs = Date.now();
    if (nowMs - this.tickMsWindowStart >= TICK_MAX_WINDOW_MS) {
      this.tickMsPrevWindowMax = this.tickMsWindowMax;
      this.tickMsWindowMax = 0;
      this.tickMsWindowStart = nowMs;
      this.tickPhasePrevWindowMax = this.tickPhaseWindowMax;
      this.tickPhaseWindowMax = new Map();
    }
    if (ms > this.tickMsWindowMax) this.tickMsWindowMax = ms;
    if (ms > TICK_OVERRUN_WARN_MS) {
      console.warn(
        `tick overrun: ${ms.toFixed(1)}ms at tick ${this.game?.tick ?? 0} (ema ${this.tickMsEma.toFixed(1)}ms)`,
      );
    }
  }

  private async handleJoin(
    ws: WebSocket,
    game: GameState,
    rawName: string,
    token: string,
    proto: number | undefined,
    scenario: string | undefined,
  ): Promise<void> {
    if (this.playerBySocket.has(ws)) return; // already joined
    // Server-side half of the two-sided protocol gate (doc 03 §1) — the ONLY
    // enforcement that binds clients we don't ship. Checked FIRST: before the
    // token hash, before any character create/restore or persist, before any
    // "joined" broadcast — so a refused client never makes a character row and
    // never leaves a defenseless lingering body. An ABSENT proto is accepted
    // only while PROTOCOL_VERSION === 1 (pre-gate clients are sim-compatible
    // with v1 by definition); once it bumps, absent is rejected like any other
    // mismatch — those clients carry no gate code, so this is the only closure.
    if (proto !== PROTOCOL_VERSION && !(proto === undefined && PROTOCOL_VERSION === 1)) {
      this.send(ws, { t: "error", msg: "incompatible version" });
      try {
        ws.close(1008, "incompatible version");
      } catch {
        // Already closed.
      }
      return;
    }
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
      existing.wantsAttackAt = null;
      existing.inputBudget = INPUT_BUDGET_CAP_S;
      existing.lastAck = 0;
      this.bindSocket(ws, existing);
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
      // Join path 1 (adopt/takeover): connected count may have changed
      // (offline body reclaimed) — directory edge beat (doc 03 §6).
      this.heartbeat.onEdge();
      return;
    }

    let connected = 0;
    for (const p of game.players.values()) {
      if (!p.offline) connected++;
    }
    if (connected >= this.effectiveMaxPlayers) {
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
      this.bindSocket(ws, player);
      this.sendWelcome(ws, game, player, true, null);
      this.persistAll(game);
      this.broadcastMsg({ t: "notice", msg: `${player.name} joined` });
      // Join path 2 (resume saved character): directory edge beat.
      this.heartbeat.onEdge();
      return;
    }

    // (3) Dead row or no row: a brand-new life. If the previous life ended
    // while its owner was offline, deliver the stored recap exactly once.
    const name = sanitizeName(rawName, game);
    const id = crypto.randomUUID().slice(0, 8);
    const player = createPlayer(game, id, name, tokenHash);
    // Keep-inventory (pvp.fullLoot=false): a player who closed the tab on the
    // death screen rejoins into their DEAD row here — restore the inventory held
    // at death (createPlayer started them empty) rather than destroying it. The
    // persistAll below immediately rewrites the dead row as this living life, so
    // a second rejoin takes path 1/2 and never this branch (restore-once).
    if (!game.config.pvp.fullLoot && saved?.alive === false) {
      player.inventory = saved.state.inventory.map((stack) => (stack ? { ...stack } : null));
      // doc 05 M6 — keep-inventory keeps worn symmetrically: the dead row was
      // saved with worn intact (spawnPlayerCorpse strips it only under
      // fullLoot), and a 12-length pack-extended inventory needs its worn.back.
      player.worn = {
        body: saved.state.worn?.body ? { ...saved.state.worn.body } : null,
        back: saved.state.worn?.back ? { ...saved.state.worn.back } : null,
      };
      player.selectedSlot = saved.state.selectedSlot;
    }
    // doc 10 M1: on a preview only (env.TESTBED), seed this fresh life so a
    // tester lands ready. After the keep-inventory restore (so it isn't
    // clobbered) and before sendWelcome (so the welcome carries it). No-op in prod.
    // doc 10 M3: pick the set per-join (gated). The join field is validated on
    // the wire but only consulted here under this.testbed; env.SCENARIO is the
    // deploy-time default; resolveScenario falls back to the universal set.
    if (this.testbed) provisionTestbed(game, player, resolveScenario(scenario ?? this.env.SCENARIO));
    const recap = saved ? saved.pendingRecap : null;
    if (recap) clearPendingRecap(sql, tokenHash);
    this.bindSocket(ws, player);
    this.sendWelcome(ws, game, player, false, recap);
    this.persistAll(game);
    this.broadcastMsg({ t: "notice", msg: `${name} joined` });
    // Join path 3 (new life): directory edge beat.
    this.heartbeat.onEdge();
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
      proto: PROTOCOL_VERSION,
      time: game.time,
      you: this.youState(player),
      inv: player.inventory.map((stack) => (stack ? { ...stack } : null)),
      selected: player.selectedSlot,
      // doc 05 M6 — worn equipment mirrors inv.worn: no inv message follows a
      // join, so a rejoining client needs it here or EQUIPMENT renders empty
      // until the first inventory mutation. Additive optional (no extra bump —
      // the wear/unwear messages already took 7 → 8).
      worn: wornWire(player),
      resumed,
      recap,
      // Additive optional field (doc 04 §4): the whole resolved config. The
      // client clamps it (clampConfig) and never stores the raw object.
      config: this.config,
      // doc 12 — the full explored set, only on fog servers (additive optional).
      explored:
        this.config.map.reveal === "explored" ? encodeExplored(player.explored) : undefined,
      // doc 13 M2 — every felled tree so far, so the client hides them from the
      // static forest on join. Omitted while none are felled (additive optional).
      felled: game.felledTrees.size > 0 ? [...game.felledTrees] : undefined,
      // Tree lifecycle — the full player-planted collection (separate from the
      // fingerprint-coupled natural forest). Omitted while empty. Stage is the
      // server's current wall-clock re-derivation (loadWorld / growth scan).
      planted:
        game.world.plantedTrees.trees.size > 0
          ? [...game.world.plantedTrees.trees.values()].map(toPlantedRecord)
          : undefined,
    });
    // doc 06 — the FULL structure set, synchronously after welcome on the
    // same socket (socket ordering ⇒ it precedes any tick snapshot or delta).
    // Every welcome path needs this: the client rebuilds its world (and an
    // empty structure index) from scratch on every welcome.
    for (const msg of structuresFullMsgs(game)) this.send(ws, msg);
  }

  private dropSocket(ws: WebSocket): void {
    const playerId = this.playerBySocket.get(ws);
    this.playerBySocket.delete(ws);
    this.rateBySocket.delete(ws);
    this.lastMsgAt.delete(ws);
    // A dropped socket carries no resumable identity — clear its hibernation
    // attachment so a late buffered message can't re-enter rehydrateSocket and
    // bounce the live socket via the adopt path. Best-effort (already closing).
    try {
      ws.serializeAttachment(null);
    } catch {
      // Already closed.
    }
    if (playerId !== undefined) {
      this.socketByPlayer.delete(playerId);
      const game = this.game;
      if (game) {
        const player = game.players.get(playerId);
        if (player) {
          // doc 13 M4 — free any seat first (a disconnecting player can't drive,
          // and an offline body lingering "in" a vehicle would freeze its seat).
          vacateSeat(game, player);
          if (player.alive && this.config.session.logoutLingerS > 0) {
            // Combat-log deterrent: the body lingers in the world, defenseless,
            // for session.logoutLingerS (it drops a real corpse only if
            // something kills it). Replaces the old instant death bag.
            player.offline = true;
            player.offlineSince = game.time;
            player.cmdQueue.length = 0;
            player.wantsAttack = false;
            player.wantsAttackAt = null;
            this.persistAll(game);
          } else if (player.alive) {
            // logoutLingerS = 0: no combat-log window — save the living body and
            // remove it immediately (saveCharacter first so the life persists,
            // then persistAll keeps the world coherent after removal).
            saveCharacter(this.ctx.storage.sql, player, game.time);
            game.players.delete(playerId);
            this.persistAll(game);
          } else {
            // Dead characters were already marked dead in storage at kill
            // time; nothing lingers.
            game.players.delete(playerId);
          }
          this.broadcastMsg({ t: "notice", msg: `${player.name} left` });
          // Connected count dropped on EVERY branch above (alive-leaver
          // lingered/saved, dead row deleted) — directory edge beat. Linger
          // EXPIRY is deliberately not a trigger (doc 03 §6): it never
          // changes the connected count.
          this.heartbeat.onEdge();
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

  /**
   * Bind a socket to a player AND mirror the binding into the socket's
   * hibernation attachment. A DO recycle (platform eviction + recreate)
   * preserves the hibernatable WebSocket but wipes the in-memory maps; the
   * attachment is what lets `rehydrateSocket` re-associate them on wake. Used
   * by every join path so the binding is durable everywhere.
   */
  private bindSocket(ws: WebSocket, player: ServerPlayer): void {
    this.playerBySocket.set(ws, player.id);
    this.socketByPlayer.set(player.id, ws);
    this.lastMsgAt.set(ws, Date.now());
    try {
      ws.serializeAttachment({ id: player.id, tokenHash: player.tokenHash });
    } catch {
      // Best-effort resilience aid only — never fail a join if it throws.
    }
  }

  /**
   * Re-associate a socket that survived a DO recycle with its character. The
   * platform can evict and recreate a busy Durable Object: the hibernatable
   * WebSocket (and its attachment) survive, but the in-memory socket maps and
   * the live GameState do not. Without this, the restored socket is unmapped —
   * it gets no snapshots and the liveness sweep eventually closes it, dropping
   * the player. Rebuild the binding from the attachment + persisted character.
   * Returns the player id, or undefined if the socket carries no resumable
   * identity (never joined, or the character died/vanished since the last save)
   * — those fall back to a clean re-join.
   *
   * ACCEPTED LIMITATIONS of a recycle (bounded; platform recycles are infrequent):
   *  - Offline combat-log lingers are NOT restored: CharacterState has no offline
   *    field and loadWorld restores no players, so a recycle ends an in-progress
   *    linger early (a free combat-log escape that round).
   *  - A player sitting on the death screen at recycle is hard-dropped to the
   *    menu (closed 1012 below; the client's close handler ignores the code and
   *    has no auto-reconnect) rather than re-shown the death/recap screen.
   *
   * No-await ATOMICITY is load-bearing: there is no await between the game.players
   * scan and restorePlayer, so under the DO input gate (JS run-to-completion) two
   * surviving sockets for one character cannot both restore — the second finds the
   * player already in game.players and adopts. Do NOT insert an await between them.
   */
  private rehydrateSocket(ws: WebSocket, game: GameState): string | undefined {
    let att: unknown;
    try {
      att = ws.deserializeAttachment();
    } catch {
      return undefined;
    }
    const tokenHash =
      att !== null &&
      typeof att === "object" &&
      typeof (att as { tokenHash?: unknown }).tokenHash === "string"
        ? (att as { tokenHash: string }).tokenHash
        : undefined;
    if (tokenHash === undefined) return undefined;

    // Already rebuilt in this isolate (a second socket for the same character,
    // or an offline-lingering body) — adopt it and take the session over,
    // mirroring handleJoin's reconnect path. Prevents a duplicate player.
    for (const existing of game.players.values()) {
      if (existing.tokenHash !== tokenHash) continue;
      const oldWs = this.socketByPlayer.get(existing.id);
      if (oldWs && oldWs !== ws) {
        this.playerBySocket.delete(oldWs);
        this.rateBySocket.delete(oldWs);
        this.lastMsgAt.delete(oldWs);
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
      existing.wantsAttackAt = null;
      existing.inputBudget = INPUT_BUDGET_CAP_S;
      existing.lastAck = 0;
      this.bindSocket(ws, existing);
      this.sendWelcome(ws, game, existing, true, null);
      return existing.id;
    }

    const saved = loadCharacter(this.ctx.storage.sql, tokenHash);
    if (!saved || !saved.alive) {
      // Died or vanished since the last periodic save: cannot resume a living
      // session. Close so the client re-joins cleanly (death screen / new life).
      // No persistAll here: 64 survivors rehydrating at once must not each fire
      // a full world+characters transaction — the periodic save covers them.
      try {
        ws.close(1012, "server restarted");
      } catch {
        // Already closing.
      }
      return undefined;
    }
    const player = restorePlayer(game, saved.id, saved.name, tokenHash, saved.state);
    this.bindSocket(ws, player);
    this.sendWelcome(ws, game, player, true, null);
    return player.id;
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
   * an unclean restart, so this is the only way anything gets saved.
   * saveWorld skips clean world rows (trees / structure buckets — doc 06 M8
   * follow-up); their dirty flags are cleared HERE, after the transaction
   * commits, so a rollback can never clear flags for rows it never wrote. */
  private persistAll(game: GameState): void {
    const storage = this.ctx.storage;
    const t0 = performance.now();
    let world: SaveWorldStats | null = null;
    let charactersMs = 0;
    let characters = 0;
    storage.transactionSync(() => {
      world = saveWorld(storage, storage.sql, game);
      const c0 = performance.now();
      for (const player of game.players.values()) {
        saveCharacter(storage.sql, player, game.time);
        characters++;
      }
      charactersMs = performance.now() - c0;
    });
    // Committed: disk now matches memory for every dirty row.
    game.dirtyStructureBuckets.clear();
    game.treesDirty = false;
    if (world !== null) {
      const w: SaveWorldStats = world;
      this.lastSave = {
        at: Date.now(),
        ms: round2(performance.now() - t0),
        snapshotMs: round2(w.snapshotMs),
        treesMs: round2(w.treesMs),
        structuresMs: round2(w.structuresMs),
        charactersMs: round2(charactersMs),
        dirtyBuckets: w.dirtyBuckets,
        snapshotBytes: w.snapshotBytes,
        treesBytes: w.treesBytes,
        structuresBytes: w.structuresBytes,
        characters,
      };
    }
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
    // Directory beat: the occupied→idle transition (doc 03 §6 "quiet") —
    // AFTER stopTicking so the body derives players: 0, status: "idle",
    // uptimeS: 0. Fire-and-forget; the in-flight fetch briefly holds the DO
    // (sub-second, accepted). After this, silence is normal and indefinite.
    this.heartbeat.onQuiet();
  }

  // --- Tick ---

  /** Stamp the cost since the previous stamp into the named phase bucket
   * (EMA + window max — see the tickPhase* fields). tick() calls this at each
   * call-group boundary; the labels are the /api/health `tickPhases` keys. */
  private phaseTimer(): (label: string) => void {
    let last = performance.now();
    return (label) => {
      const now = performance.now();
      const d = now - last;
      last = now;
      const prev = this.tickPhaseEma.get(label);
      this.tickPhaseEma.set(label, prev === undefined ? d : prev + TICK_EMA_ALPHA * (d - prev));
      if (d > (this.tickPhaseWindowMax.get(label) ?? 0)) this.tickPhaseWindowMax.set(label, d);
    };
  }

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
    const phase = this.phaseTimer();

    // Logged-out bodies past the linger window are saved and removed —
    // no corpse, no notice; they simply fade from the world. The save is a
    // full persistAll AFTER removal so world + characters stay coherent
    // (the character row was already saved when the linger began; vitals
    // drift during the linger is persisted by the same persistAll).
    let lingersExpired = false;
    for (const player of game.players.values()) {
      if (!player.offline) continue;
      if (game.time - player.offlineSince < this.config.session.logoutLingerS) continue;
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
    phase("upkeep");

    applyQueuedInputs(game, dt);
    phase("inputs");
    // Fog-of-war: reveal cells around each player's just-updated position
    // (no-op unless map.reveal === "explored").
    markExploration(game);
    // doc 06 M7 — stamp owner presence (the offline-shield grace window reads
    // it) BEFORE attacks resolve, and run the decay sweep on its cadence.
    tickStructures(game, (hash) => lastSeenMs(this.ctx.storage.sql, hash));
    phase("structures");
    // Channeled actions (doc 11) advance HERE — load-bearing ordering: this MUST
    // run AFTER applyQueuedInputs (so it reads THIS tick's freshly-computed
    // movedThisTick for the move-cancel rule, which applyQueuedInputs resets to
    // false then recomputes) and BEFORE attack resolution. Moving it ahead of
    // applyQueuedInputs would silently break move-cancel; do not reorder.
    tickActiveActions(game, dt);
    // Attacks resolve after this tick's movement so aim is current; the
    // client-reported aim time rides along for target rewind (lag comp).
    for (const player of game.players.values()) {
      if (player.wantsAttack) {
        player.wantsAttack = false;
        const aimTime = player.wantsAttackAt ?? undefined;
        player.wantsAttackAt = null;
        if (player.alive) performAttack(game, player, aimTime);
      }
    }
    // Portal crossings resolve against this tick's post-movement positions.
    stepPortals(game);
    phase("actions");
    // doc 13 M4 — apply each driven vehicle's control to its hull BEFORE the
    // physics step, so the impulses ride this tick's substeps.
    stepVehicles(game, dt);
    // doc 13 — server-auth physics step (no-op until the engine attaches).
    game.physics.step(dt, game.time);
    // doc 13 M4 — POST-step: crash + ram damage, wreck handling, and seated
    // riders follow the hull (kinematic — their walking was short-circuited).
    tickVehicles(game, dt);
    phase("physics");
    // doc 13 M2 — settled felled trunks despawn to wood loot after their TTL.
    tickTrunks(game);
    // Tree lifecycle — budgeted ambient seed rain (per-player, game-time
    // cadence) + the wall-clock growth-stage scan (coarse, planted-cap bounded).
    tickAmbientSeeds(game);
    tickTreeGrowth(game);
    phase("trees");
    tickZombies(game, dt);
    tickZombieRespawns(game, dt);
    phase("zombies");
    tickSurvival(game, dt);
    tickWeather(game, dt);
    tickAirdrops(game, dt);
    phase("survival");
    tickWildlife(game, dt);
    tickDeerRespawns(game, dt);
    phase("wildlife");
    tickFires(game, dt);
    tickLootRespawns(game, dt);
    tickCorpses(game, dt);
    tickDroppedLoot(game, dt);
    phase("world");
    game.time += dt;
    game.tick++;

    // Lag-comp history: end-of-tick positions stamped with the same game.time
    // the snapshots below carry, so client aim times and history frames share
    // one clock. capturePosHistory prunes frames past the rewind window — the
    // buffer stays bounded at ~9 tiny frames at 15Hz.
    capturePosHistory(game);
    phase("lagComp");

    // Periodic durable snapshot of the world + every character.
    if (game.time - this.lastSaveTime >= WORLD_SAVE_INTERVAL_S) {
      this.lastSaveTime = game.time;
      this.persistAll(game);
    }
    phase("persist");

    this.flushOutbox(game);
    phase("flush");
    this.broadcastSnapshots(game);
    phase("broadcast");
    game.events.length = 0;
    // Felled-tree delta was serialized into every snapshot above (doc 13 M2).
    // A tick that threw before sending re-broadcasts it next tick — harmless,
    // the client-side fold-in is a Set add (idempotent).
    game.felledDelta.length = 0;
    // Planted-tree delta (plant/grow/remove) rides the same snapshots; clear it
    // the same way. Upserts are idempotent by id, removes tolerate a missing id,
    // so a re-broadcast after a throw is harmless.
    game.plantedTreeDelta.length = 0;

    // Directory beats ride the already-running tick — never a timer/alarm of
    // their own (doc 03 §5). Flushes a debounced edge or a due periodic beat.
    this.heartbeat.onTick();
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
      // The snapshot carried this tick's newly-explored cells (by reference, but
      // send() already serialized them) — reset for the next tick.
      player.fogDelta.length = 0;
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

    // Portals: only those in the player's own realm, within interest range.
    const portals: WirePortal[] = [];
    for (const portal of game.portals) {
      if (portal.realm !== player.realm) continue;
      if (distSq2D(px, pz, portal.x, portal.z) > interestSq) continue;
      portals.push({ id: portal.id, x: round2(portal.x), y: round2(portal.y), z: round2(portal.z), to: portal.toRealm });
    }

    // doc 13 — dynamic bodies: overworld-only (they exist in the overworld;
    // red-realm players get an empty array), interest-filtered like portals.
    const bodies: WireBody[] = [];
    if (player.realm === "overworld") {
      for (const b of game.physics.poses()) {
        if (distSq2D(px, pz, b.x, b.z) > interestSq) continue;
        const wire: WireBody = {
          id: b.id,
          kind: b.kind,
          x: round2(b.x),
          y: round2(b.y),
          z: round2(b.z),
          q: [round2(b.q[0]), round2(b.q[1]), round2(b.q[2]), round2(b.q[3])],
          // doc 13 M2 — per-instance half-extents (trunks); omitted otherwise.
          ...(b.dims ? { dims: [round2(b.dims[0]), round2(b.dims[1]), round2(b.dims[2])] as [number, number, number] } : {}),
          ...(b.asleep ? { asleep: true as const } : {}),
        };
        // doc 13 M4 — a vehicle carries who's seated (WirePlayer ids, so clients
        // hide riders' walking avatars) and its wreck flag (rendered as a hulk).
        if (b.kind === "vehicle") {
          const meta = game.vehicleMeta.get(b.id);
          if (meta) {
            wire.seats = seatPlayerIds(game, meta);
            if (meta.wrecked) wire.wrecked = true;
          }
        }
        bodies.push(wire);
      }
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
      portals,
      bodies,
      drops,
      animals,
      weather: round2(game.weather),
      events,
      count,
      // doc 12 — newly-explored cells this tick; omitted when empty (fog only).
      fog: player.fogDelta.length > 0 ? player.fogDelta : undefined,
      // doc 13 M2 — trees felled this tick (global one-shot delta; the full set
      // rode in welcome). Cleared at end of tick like events; omitted when empty.
      felled: game.felledDelta.length > 0 ? game.felledDelta : undefined,
      // Tree lifecycle — planted upserts/removes this tick (plant/grow/fell).
      // Same one-shot posture as felled; the full set rode in welcome.
      planted: game.plantedTreeDelta.length > 0 ? game.plantedTreeDelta : undefined,
    };
  }

  private youState(player: ServerPlayer): YouState {
    const c = player.core;
    const v = player.vitals;
    const a = player.action;
    // doc 13 M4 — seat readout for YOUR HUD + client input routing (drive vs
    // walk). Only present while seated; fuel/hp/speed are round2'd like x/y/z.
    let seat: YouState["seat"];
    if (player.seatedVehicle !== null && this.game) {
      const meta = this.game.vehicleMeta.get(player.seatedVehicle);
      if (meta) {
        const s = this.game.physics.vehicleSensors(player.seatedVehicle);
        seat = {
          id: player.seatedVehicle,
          index: player.seatIndex,
          fuel: round2(meta.fuel),
          hp: round2(meta.hp),
          speed: round2(s?.speed ?? 0),
        };
      }
    }
    return {
      x: round2(c.x),
      y: round2(c.y),
      z: round2(c.z),
      vy: c.vy,
      grounded: c.grounded,
      realm: player.realm,
      hp: v.hp,
      food: v.food,
      water: v.water,
      temp: v.temp,
      // doc 11 M2: cast-progress for the HUD bar; round2'd like x/y/z. Omitted
      // (undefined) when not channeling, so the field is absent on the wire.
      ...(a
        ? { action: { kind: a.kind, remainingS: round2(a.remainingS), totalS: round2(a.totalS) } }
        : {}),
      ...(seat ? { seat } : {}),
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
