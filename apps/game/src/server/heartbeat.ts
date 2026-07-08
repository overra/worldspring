// Directory heartbeat sender (doc 03 §6, M3). Beats fire ONLY from inside the
// already-running tick or its lifecycle hooks — no timers, no alarms, nothing
// that can keep an idle room billable (doc 03 §5; alarms rejected §4). Idle
// rooms send nothing by design; the directory's prober covers them. Every
// fetch is fire-and-forget: never awaited, never throws into the tick.
//
// Cadence contract (doc 03 §6, binding):
//   boot     — startTicking() idle→occupied transition.
//   edge     — connected-count change (all join paths + every dropSocket that
//              removed/lingered a player). Debounced trailing-edge: a dirty
//              flag, at most one beat per HEARTBEAT_EDGE_DEBOUNCE_S between
//              ANY two beats.
//   periodic — tick checks now >= nextBeatAt; HEARTBEAT_INTERVAL_S ± uniform
//              HEARTBEAT_JITTER_S (Math.random — NEVER the seeded sim streams).
//   quiet    — last line of stopAndPersist, after stopTicking, so the body
//              naturally reads players: 0, status: "idle", uptimeS: 0.
// EVERY sent beat of any type reschedules nextBeatAt — the directory's intake
// bucket sizing (doc 03 §9) is arithmetically true only under this rule.
//
// Failure policy (doc 03 §6 + Open decision #5): network/5xx/404 → exponential
// backoff 60 s → 120 s → … cap 15 min on the periodic cadence, edge beats
// suppressed while backing off, reset on success (404 backs off rather than
// disarming: plausibly a directory mid-deploy). 429 → honor Retry-After.
// 401/410 → log loudly and DISARM until the next DO restart (unlisted/revoked;
// retrying is noise). One console.warn per state change, not per beat.

import {
  HEARTBEAT_EDGE_DEBOUNCE_S,
  HEARTBEAT_INTERVAL_S,
  HEARTBEAT_JITTER_S,
} from "@worldspring/shared/constants";
import {
  SERVER_INFO_SCHEMA_VERSION,
  type HeartbeatBody,
  type HeartbeatEvent,
  type ServerInfo,
} from "@worldspring/shared/serverInfo";
import { challengeHashOfToken } from "@worldspring/shared/directory";

/** Per-request timeout: beats are advisory, never worth a long-held socket. */
const HEARTBEAT_FETCH_TIMEOUT_MS = 10_000;
const BACKOFF_START_S = 60;
const BACKOFF_CAP_S = 15 * 60;

// The URL-control challenge published in /api/server-info (doc 02 §2):
// sha256("worldspring-directory-challenge:" + DIRECTORY_TOKEN), computed once
// per isolate and cached module-level (doc 03 §2).
let cachedChallenge: { token: string; hash: string | null } | null = null;
let challengeInFlight: Promise<void> | null = null;

/**
 * Synchronous accessor for buildServerInfo (which cannot await): returns the
 * cached challenge, kicking off the one-time digest on first call. Cold
 * starts must NOT serve /api/server-info before the digest settles — the
 * GameRoom constructor awaits warmDirectoryChallenge inside its
 * blockConcurrencyWhile, so requests never observe the null window.
 */
export function directoryChallengeFor(token: string | undefined): string | null {
  if (!token) return null;
  if (cachedChallenge?.token === token) return cachedChallenge.hash;
  if (!challengeInFlight) {
    challengeInFlight = challengeHashOfToken(token)
      .then((hash) => {
        cachedChallenge = { token, hash };
      })
      .catch(() => {
        cachedChallenge = { token, hash: null };
      })
      .finally(() => {
        challengeInFlight = null;
      });
  }
  return null;
}

/**
 * Await the one-time challenge digest (call from the DO constructor's
 * blockConcurrencyWhile) so a cold object's FIRST /api/server-info response
 * never publishes `directoryChallenge: null`: the prober counts a mismatch
 * toward consecutive_failures, and the worker micro-cache would pin the
 * null-challenge body for its 15 s TTL — enough to deterministically fail
 * every quiet-suspension probe (a 6 h-idle isolate is always cold) and walk a
 * healthy idle server to 'unreachable'. Token-only deploys (DIRECTORY_URL
 * unset → heartbeat sender inert) still need this: the register wizard only
 * instructs operators to set DIRECTORY_TOKEN, and verification probes require
 * the challenge regardless of heartbeats.
 */
export function warmDirectoryChallenge(token: string | undefined): Promise<void> {
  if (!token) return Promise.resolve();
  directoryChallengeFor(token); // kicks off the digest (no-op if cached)
  return challengeInFlight ?? Promise.resolve();
}

export interface HeartbeatDeps {
  /** Both optional (doc 03 §2): either unset → the subsystem is completely
   * inert — zero outbound requests, zero state. */
  directoryUrl: string | undefined;
  directoryToken: string | undefined;
  /** Builds the same document /api/server-info serves (request-less path). */
  buildInfo: () => ServerInfo;
  // Injectable for the cadence harness (scripts/heartbeat-cadence.mjs):
  fetchFn?: typeof fetch;
  now?: () => number;
  random?: () => number;
  warn?: (msg: string) => void;
}

/**
 * All sender state lives here, in GameRoom memory — it deliberately does NOT
 * persist: a DO restart re-arms a disarmed sender and resets backoff, which
 * is the doc 03 §6 "disarm until next DO restart" semantic for free.
 */
export class DirectoryHeartbeat {
  private readonly url: string | null;
  private readonly token: string | null;
  private readonly buildInfo: () => ServerInfo;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly warn: (msg: string) => void;

  private nextBeatAt = 0;
  private lastSentAt = 0;
  private edgeDirty = false;
  private backoffS = 0;
  private backoffUntil = 0;
  private disarmed = false;
  /** Last logged failure mode — one console.warn per state CHANGE. */
  private lastWarned: string | null = null;

  constructor(deps: HeartbeatDeps) {
    const enabled = Boolean(deps.directoryUrl) && Boolean(deps.directoryToken);
    this.url = enabled ? `${deps.directoryUrl!.replace(/\/+$/, "")}/api/v1/heartbeat` : null;
    this.token = enabled ? deps.directoryToken! : null;
    this.buildInfo = deps.buildInfo;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.warn = deps.warn ?? ((msg) => console.warn(msg));
    // Warm the module-level challenge cache so /api/server-info publishes it.
    if (enabled) directoryChallengeFor(this.token!);
  }

  private get inert(): boolean {
    return this.url === null || this.disarmed;
  }

  /** startTicking(): the idle→occupied transition. */
  onBoot(): void {
    if (this.inert) return;
    if (this.now() < this.backoffUntil) return;
    this.send("boot");
  }

  /** Connected-count changed (any join path, any leaving dropSocket branch). */
  onEdge(): void {
    if (this.inert) return;
    this.edgeDirty = true; // trailing-edge debounce; the tick flushes it
  }

  /** Called once per tick while occupied. */
  onTick(): void {
    if (this.inert) return;
    const now = this.now();
    if (now < this.backoffUntil) return; // suppresses edge AND periodic
    if (this.edgeDirty && now - this.lastSentAt >= HEARTBEAT_EDGE_DEBOUNCE_S * 1000) {
      this.send("edge");
      return;
    }
    if (now >= this.nextBeatAt) this.send("periodic");
  }

  /** stopAndPersist(): AFTER stopTicking, so the body derives players: 0,
   * status: "idle", uptimeS: 0. The in-flight fetch briefly (sub-second)
   * holds the DO — accepted (doc 03 §6). Quiet ignores the debounce floor:
   * it is the session's final word and the directory's bucket absorbs it. */
  onQuiet(): void {
    if (this.inert) return;
    if (this.now() < this.backoffUntil) return;
    this.send("quiet");
  }

  private send(event: HeartbeatEvent): void {
    const now = this.now();
    // EVERY beat reschedules the periodic timer (binding — intake sizing).
    const jitterS = (this.random() * 2 - 1) * HEARTBEAT_JITTER_S;
    this.nextBeatAt = now + (HEARTBEAT_INTERVAL_S + jitterS) * 1000;
    this.lastSentAt = now;
    this.edgeDirty = false;

    let body: HeartbeatBody;
    try {
      body = {
        schemaVersion: SERVER_INFO_SCHEMA_VERSION,
        event,
        sentAt: now,
        info: this.buildInfo(),
      };
    } catch (err) {
      // buildServerInfo is idle-safe and should never throw; belt-and-braces
      // so a bug here can never escape into the tick.
      this.warnOnce(`[heartbeat] buildInfo failed: ${String(err)}`);
      return;
    }

    // Fire-and-forget (doc 02 §2): never awaited, never throws into the tick.
    void this.fetchFn(this.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token!}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEARTBEAT_FETCH_TIMEOUT_MS),
    })
      .then((res) => this.handleResponse(res))
      .catch(() => this.handleFailure("network"));
  }

  private handleResponse(res: Response): void {
    if (res.ok) {
      // Accepted: clear backoff, quiet the warn latch.
      this.backoffS = 0;
      this.backoffUntil = 0;
      this.lastWarned = null;
      return;
    }
    if (res.status === 401 || res.status === 410) {
      // Unlisted/revoked: retrying is noise. Disarmed until next DO restart.
      this.disarmed = true;
      this.warnOnce(
        `[heartbeat] directory returned ${res.status} — treating as unlisted, disarming until next restart`,
      );
      return;
    }
    if (res.status === 429) {
      const retryAfterS = Number(res.headers.get("retry-after") ?? "60");
      this.backoffUntil =
        this.now() + (Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS : 60) * 1000;
      this.warnOnce(`[heartbeat] rate limited (429), honoring Retry-After`);
      return;
    }
    // 404 (directory mid-deploy) and 5xx: transient — back off, never disarm.
    this.handleFailure(`http-${res.status}`);
  }

  private handleFailure(kind: string): void {
    this.backoffS = Math.min(this.backoffS === 0 ? BACKOFF_START_S : this.backoffS * 2, BACKOFF_CAP_S);
    this.backoffUntil = this.now() + this.backoffS * 1000;
    this.warnOnce(`[heartbeat] beat failed (${kind}), backing off ${this.backoffS}s`);
  }

  private warnOnce(msg: string): void {
    // One warn per state change: identical consecutive messages are dropped
    // (backoff doubling changes the message, which is useful signal).
    if (this.lastWarned === msg) return;
    this.lastWarned = msg;
    this.warn(msg);
  }
}
