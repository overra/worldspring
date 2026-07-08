// Pure directory-core logic shared by apps/web (registration, heartbeat
// intake, browse) and apps/prober (cron sweep): server-token format + hashing,
// URL validation, heartbeat body validation, the SSRF-guarded probe client,
// and the ranking formula. Everything here is Workers+Node portable (webcrypto
// only, injectable fetch) so vitest covers it without a workerd harness.
// Sources: docs/plans/02-server-directory.md §2/§3/§7/§8, doc 03 §6/§9.

import type { HeartbeatBody, HeartbeatEvent, ServerInfo } from "./serverInfo";

// --- Token format (doc 02 §2, binding) -------------------------------------
// `dcd1.<serverId>.<secretHex>` — serverId is a 26-char ULID (public listing
// handle, also the servers.id PK); secretHex is 32 random bytes as hex.
// Self-contained: one secret to set, no separate ID var.

export const TOKEN_PREFIX = "dcd1";
/** Domain-separation prefix for the URL-control challenge (doc 02 §2). */
export const DIRECTORY_CHALLENGE_PREFIX = "worldspring-directory-challenge:";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

/** 26-char Crockford-base32 ULID: 48-bit ms timestamp + 80 random bits. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ULID_ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let out = time.join("");
  for (let i = 0; i < 16; i++) out += ULID_ALPHABET[rand[i] % 32];
  return out;
}

/** SHA-256 as lowercase hex (webcrypto: identical in workerd and Node). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export interface ParsedServerToken {
  serverId: string;
  secretHex: string;
}

/** Parse `dcd1.<serverId>.<secretHex>`; null on any malformation. */
export function parseServerToken(token: string): ParsedServerToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, serverId, secretHex] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (!ULID_RE.test(serverId)) return null;
  if (!SECRET_HEX_RE.test(secretHex)) return null;
  return { serverId, secretHex };
}

export interface MintedServerToken {
  serverId: string;
  /** Full plaintext token — returned to the owner EXACTLY ONCE, never stored. */
  token: string;
  /** sha256hex(secretHex) — heartbeat/DELETE bearer auth (doc 02 §2). */
  tokenHash: string;
  /** sha256hex(prefix + full token) — precomputed at mint because it is
   * UNDERIVABLE from tokenHash once the plaintext is discarded (doc 02 §2). */
  challengeHash: string;
}

/** Mint a registration: ULID + 32-byte secret + BOTH hashes (doc 02 §2). */
export async function mintServerToken(now: number = Date.now()): Promise<MintedServerToken> {
  const serverId = ulid(now);
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  let secretHex = "";
  for (const byte of secret) secretHex += byte.toString(16).padStart(2, "0");
  const token = `${TOKEN_PREFIX}.${serverId}.${secretHex}`;
  return {
    serverId,
    token,
    tokenHash: await sha256Hex(secretHex),
    challengeHash: await challengeHashOfToken(token),
  };
}

/** The value a server publishes in ServerInfo.directoryChallenge (doc 03 §2):
 * sha256hex("worldspring-directory-challenge:" + full token). */
export function challengeHashOfToken(token: string): Promise<string> {
  return sha256Hex(DIRECTORY_CHALLENGE_PREFIX + token);
}

// --- URL rules (doc 02 §7, registration + every probe) ----------------------

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validate + normalize a submitted server URL to a bare https origin.
 * `https:` only, default port only, hostname regex above, ≤253 chars, no IP
 * literals, no `xn--` labels (punycode lookalikes rejected in v1). Returns the
 * normalized origin or null.
 */
export function normalizeServerUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port !== "") return null; // non-default port
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host.length > 253) return null;
  if (!HOSTNAME_RE.test(host)) return null;
  const labels = host.split(".");
  if (labels.some((l) => l.startsWith("xn--"))) return null;
  // HOSTNAME_RE requires ≥2 labels and rejects ':' so IPv6 is already out;
  // reject dotted-quad IPv4 explicitly.
  if (labels.length === 4 && labels.every((l) => /^\d+$/.test(l))) return null;
  return `https://${host}`;
}

// --- Heartbeat body validation (doc 03 §6, unknown-field tolerant) ----------

const HEARTBEAT_EVENTS: readonly HeartbeatEvent[] = ["boot", "edge", "periodic", "quiet"];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Strict-on-what-we-read, tolerant-of-unknown-fields validation (doc 03 §10
 * rule 2) of the fields the directory actually consumes out of a beat/probe
 * body. Returns null on a bad shape. Keys on shape, NOT a `game` discriminator
 * (doc 02 §2).
 */
export function parseServerInfoForDirectory(v: unknown): ServerInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isFiniteNumber(o.schemaVersion)) return null;
  if (typeof o.gameVersion !== "string") return null;
  if (!isFiniteNumber(o.protocolVersion)) return null;
  if (typeof o.name !== "string") return null;
  if (typeof o.motd !== "string") return null;
  if (!isFiniteNumber(o.players) || !isFiniteNumber(o.maxPlayers)) return null;
  if (!isFiniteNumber(o.uptimeS)) return null;
  if (o.status !== "occupied" && o.status !== "idle") return null;
  if (typeof o.joinUrl !== "string") return null;
  if (o.directoryChallenge !== null && typeof o.directoryChallenge !== "string") return null;
  const rules = o.rules;
  if (typeof rules !== "object" || rules === null) return null;
  if (typeof (rules as Record<string, unknown>).preset !== "string") return null;
  if (o.colo !== null && o.colo !== undefined && typeof o.colo !== "string") return null;
  return v as ServerInfo;
}

/** Validate a HeartbeatBody envelope (doc 03 §6). Null on bad shape. */
export function parseHeartbeatBody(v: unknown): HeartbeatBody | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isFiniteNumber(o.schemaVersion)) return null;
  if (!HEARTBEAT_EVENTS.includes(o.event as HeartbeatEvent)) return null;
  if (!isFiniteNumber(o.sentAt)) return null;
  const info = parseServerInfoForDirectory(o.info);
  if (!info) return null;
  return v as HeartbeatBody;
}

// --- Probe client (doc 02 §7 SSRF guard; shared by web verify + prober) -----

export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_MAX_BYTES = 16 * 1024;

export type ProbeError = "timeout" | "bad-status" | "bad-shape" | "challenge-mismatch";

/**
 * Read a response body as UTF-8 text, aborting the moment cumulative bytes
 * exceed `maxBytes` (returns null and cancels the stream). This is the ONLY
 * safe way to cap an untrusted body: content-length may be absent (chunked)
 * or lie about the post-decompression size.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.body;
  if (!body) return ""; // no body → JSON.parse("") fails → bad-shape upstream
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed.
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export interface ProbeResult {
  ok: boolean;
  rttMs: number;
  info: ServerInfo | null;
  error: ProbeError | null;
}

export interface ProbeOptions {
  /** Stored challenge hash(es) — token_hash rotation means up to two are
   * valid mid-window (doc 01 §7). Empty array = shape-only probe (used at
   * registration, before the owner has set the token). */
  expectedChallenges?: readonly string[];
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * SSRF-guarded verification/liveness probe (doc 02 §6/§7): only ever GETs
 * `<stored-origin>/api/server-info`; `redirect: "manual"` (any redirect =
 * fail); 5 s AbortSignal.timeout; response read capped at 16 KB; must be
 * `content-type: application/json`; body must be doc-03-shaped; when
 * expectedChallenges is non-empty, `directoryChallenge` must equal one of
 * them (vanished or mismatched = `challenge-mismatch`, catching domain
 * transfers, secret rotation, and origin takeovers). Never throws.
 */
export async function probeServerInfo(origin: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const start = Date.now();
  const fail = (error: ProbeError): ProbeResult => ({
    ok: false,
    rttMs: Date.now() - start,
    info: null,
    error,
  });
  let res: Response;
  try {
    res = await fetchFn(`${origin}/api/server-info`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    return fail("timeout"); // abort, DNS, TLS, refused — all "didn't answer"
  }
  if (res.status !== 200) {
    try {
      await res.body?.cancel(); // free the connection (6-connection cap)
    } catch {
      // Already closed.
    }
    return fail("bad-status");
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    try {
      await res.body?.cancel();
    } catch {
      // Already closed.
    }
    return fail("bad-shape");
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > PROBE_MAX_BYTES) {
    try {
      await res.body?.cancel();
    } catch {
      // Already closed.
    }
    return fail("bad-shape");
  }
  // STREAMED read with the cap enforced per chunk — never `res.text()`, which
  // buffers the whole body first: a hostile origin serving a chunked (or
  // gzipped, content-length is pre-decompression) stream could otherwise pump
  // tens of MB into memory inside the timeout window and OOM the isolate,
  // killing an entire prober sweep (whose writeback is one final batch).
  let text: string | null;
  try {
    text = await readBodyCapped(res, PROBE_MAX_BYTES);
  } catch {
    return fail("timeout");
  }
  if (text === null) return fail("bad-shape");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("bad-shape");
  }
  const info = parseServerInfoForDirectory(parsed);
  if (!info) return fail("bad-shape");
  const rttMs = Date.now() - start;
  const expected = opts.expectedChallenges ?? [];
  if (expected.length > 0) {
    if (info.directoryChallenge === null || !expected.includes(info.directoryChallenge)) {
      return { ok: false, rttMs, info, error: "challenge-mismatch" };
    }
  }
  return { ok: true, rttMs, info, error: null };
}

// --- Ranking (doc 02 §8, binding formula) ------------------------------------

export interface ScorableServerRow {
  players: number;
  players_max: number;
  protocol: number | null;
  /** Epoch MILLISECONDS (doc 02 §3 — seconds silently zero the age term). */
  created_at: number;
  /** 0..1 from 20 days of probe history. */
  uptimeRatio20d: number;
}

/** The exact doc 02 §8 score. No votes, no paid placement, no raw-player-count
 * default sort; client-measured ping never enters the stored score. */
export function score(s: ScorableServerRow, latestProtocol: number, now: number): number {
  const players = Math.min(s.players, 24); // cap = official MAX_PLAYERS
  const uptime = s.uptimeRatio20d * 8; // 0..8, from probes
  const age = Math.min((now - s.created_at) / (30 * 86400_000), 6); // 0..6
  const absurdCapacity = s.players_max > 32 ? -8 : 0;
  const outdated = s.protocol !== null && s.protocol < latestProtocol ? -4 : 0;
  return players + uptime + age + absurdCapacity + outdated;
}

// --- Directory intake sizing (doc 03 §9, binding) ----------------------------

/** Heartbeat intake token bucket: capacity 3, refill 1 per 15 s (sustained
 * 4/min) — sized against the sender's every-beat-reschedules rule (legal
 * sustained rate = 1 beat / HEARTBEAT_EDGE_DEBOUNCE_S = 3/min); the burst
 * absorbs a quiet→boot bounce. A fixed "1 per 20 s" floor would 429 legal
 * sequences. */
export const HEARTBEAT_BUCKET_CAPACITY = 3;
export const HEARTBEAT_BUCKET_REFILL_MS = 15_000;
/** Reject beats whose sentAt is older than this (doc 03 §6). */
export const HEARTBEAT_MAX_AGE_MS = 5 * 60_000;
/** Probe history retention (doc 02 §6 housekeeping). */
export const PROBE_HISTORY_DAYS = 20;
