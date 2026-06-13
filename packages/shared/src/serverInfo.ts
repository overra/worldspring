// The public server-info contract. Versioned and boring-stable: community
// servers update on their own schedule, so this file changes by ADDITION only
// within a schema version (no field removal/rename/retype/resemantic — those
// require a SERVER_INFO_SCHEMA_VERSION bump). See
// docs/plans/03-server-info-contract.md (§2 for ServerInfo/RulesSummary, §6 for
// HeartbeatBody, §10 for the forward-compat rules these types encode).

import type { WorldSizeTier, WipeSchedule } from "./config";

/** Bump ONLY on breaking changes (field removal/rename/retype/resemantic). */
export const SERVER_INFO_SCHEMA_VERSION = 1;

/**
 * Compact, render-ready rules summary. Derived from ServerConfig by
 * summarizeRules() in packages/shared/src/config.ts — the directory renders
 * these as badges and MUST NOT need to understand the full ServerConfig. The
 * FIELD SET is owned by doc 04 §6 (which specs the banding thresholds, the
 * closed preset union, and the directory-side ingest whitelist rules).
 */
export interface RulesSummary {
  /** Closed union over the shipped PRESETS keys, or "custom" — never free text. */
  preset:
    | "deadcoast"
    | "driftwood"
    | "ironcoast"
    | "warpath"
    | "homestead"
    | "nightfall"
    | "custom";
  zombies: "off" | "sparse" | "normal" | "horde";
  pvp: boolean;
  fullLoot: boolean;
  loot: "scarce" | "normal" | "plentiful";
  vitals: "gentle" | "normal" | "harsh";
  night: "cycle" | "always" | "never";
  dayLengthMin: number;
  worldSize: WorldSizeTier; // type-only import from packages/shared/src/config.ts
  maxPlayers: number;
  wipe: WipeSchedule; // type-only import from packages/shared/src/config.ts
}

export type ServerStatus = "occupied" | "idle";

export interface ServerInfo {
  /** SERVER_INFO_SCHEMA_VERSION of the responding server. */
  schemaVersion: number;
  /** GAME_VERSION (semver string). Display only — never gate on it. */
  gameVersion: string;
  /** PROTOCOL_VERSION. Equality with the client's value is a hard join gate. */
  protocolVersion: number;
  /** World seed (already public — every welcome message carries it). */
  worldSeed: number;
  /**
   * Server display name, 1..MAX_SERVER_NAME_LENGTH code points. UNTRUSTED
   * operator-controlled text: sanitization strips controls/zero-width/bidi
   * only, NOT HTML metacharacters. Render as text, never HTML (§10 rule 8).
   */
  name: string;
  /**
   * Message of the day, 0..MAX_MOTD_LENGTH code points. Same trust posture
   * as `name`: untrusted text, render-as-text only (§10 rule 8).
   */
  motd: string;
  /** Rules badges (see RulesSummary). */
  rules: RulesSummary;
  /** CONNECTED players (excludes offline lingering bodies). 0 while idle. */
  players: number;
  /** MAX_PLAYERS of this build/config. */
  maxPlayers: number;
  /** "occupied" while the tick interval is running, else "idle". */
  status: ServerStatus;
  /** Wall-clock seconds since the current occupied session began; 0 if idle. */
  uptimeS: number;
  /** Total game-time seconds of this world (persists across restarts). */
  worldAgeS: number;
  /**
   * Cloudflare colo hint (IATA code, e.g. "DFW") for where the Durable
   * Object lives — a coarse region hint, NOT a latency promise. null when
   * unknown. Consumers must treat latency as client-measured (CORS is open
   * for exactly that reason).
   */
  colo: string | null;
  /**
   * Canonical https origin of this server's playable client, e.g.
   * "https://my-server.someone.workers.dev". The WebSocket endpoint is
   * always `wss://<host>/ws`. The directory pins the origin at registration
   * and IGNORES this field from BOTH channels — heartbeat values and probe
   * bodies alike (anti-redirect, §7/§9); only re-registration moves it.
   * Everyone else gets no such protection: UNTRUSTED like every string here.
   * Consumers MUST parse it, require protocol "https:" and a plausible
   * hostname, and discard it otherwise — never interpolate it into an href
   * unvalidated (§10 rule 8).
   */
  joinUrl: string;
  /**
   * Doc 02's URL-control proof: sha256hex("worldspring-directory-challenge:" +
   * DIRECTORY_TOKEN), computed once and cached module-level; null when
   * DIRECTORY_TOKEN is unset. Publishing it leaks nothing (preimage
   * resistance over a 256-bit secret) and grants nothing — heartbeat auth
   * requires the full token. The directory compares it against the
   * challenge_hash stored at mint (doc 02 §2/§5).
   */
  directoryChallenge: string | null;
}

export type HeartbeatEvent = "boot" | "edge" | "periodic" | "quiet";

export interface HeartbeatBody {
  /** SERVER_INFO_SCHEMA_VERSION of the sender. */
  schemaVersion: number;
  /** Why this beat was sent (directory uses it for staleness bookkeeping). */
  event: HeartbeatEvent;
  /** Sender wall clock, epoch ms. Directory rejects beats older than 5 min
   *  or older than the newest beat it has accepted for this listing. */
  sentAt: number;
  /** Same document /api/server-info serves. joinUrl comes from the captured
   *  origin (`this.publicOrigin`, §2 sourcing table — beats have no Request
   *  in scope). joinUrl and colo are advisory: the directory pins origin at
   *  registration and may override colo with what it observes. */
  info: ServerInfo;
}
