// Wire protocol between client and the GameRoom Durable Object.
// JSON for v1 — readable and fast enough at this scale. All messages are
// discriminated unions on `t`.

import type { ServerConfig } from "./config";
import type { ItemStack, ItemType } from "./items";

// --- Protocol version: the two-sided join gate ---

/**
 * Wire + sim compatibility version. A client and server with EQUAL values can
 * play together: messages parse, and the shared deterministic sim
 * (movement.ts / world.ts) produces identical results on both ends. Carried in
 * both `join.proto` (client->server) and `welcome.proto` (server->client) as a
 * TWO-SIDED hard join gate — the server refuses mismatched clients before
 * touching any character state, the client refuses older servers before
 * building the world. See docs/plans/03-server-info-contract.md §1.
 *
 * Bump on ANY breaking change to ClientMsg/ServerMsg shapes or semantics, or to
 * the movement.ts / world.ts behavior the client predicts. While this is `1` an
 * ABSENT `join.proto` is accepted (pre-gate clients are sim-compatible with v1
 * by definition); the moment it bumps to `2+` the server rejects absent `proto`
 * like any other mismatch.
 *
 * ItemType wire-enum GROWTH is additive-safe and does NOT force a bump (doc 12
 * Open Q1): every client `ITEM_DEFS[type]` lookup goes through `?? UNKNOWN_DEF`
 * (items.ts), so a client that receives an item type it has never heard of
 * renders it as a generic item rather than crashing. A new ItemType only needs a
 * bump if it also changes a predicted-sim behavior or a message shape. (Removing
 * or RETYPING an existing ItemType is still breaking — bump for those.)
 *
 * Typed `number`, not the literal `1`, deliberately: the gate compares against
 * it at runtime, so the comparison must keep compiling — and flip its
 * absent-proto handling — the instant this value bumps.
 */
// doc 05 M2: new `craft` ClientMsg shape grows the wire vocabulary (doc 03's
// bump rule covers any ClientMsg/ServerMsg shape change), so 2 → 3.
// doc 11 M2: BOTH of doc 03's bump clauses fire — `you.action` is an additive
// ServerMsg SHAPE change (YouState gains the cast-progress field), and `{t:"use"}`
// now STARTS a server-driven cast instead of resolving instantly, a message
// SEMANTICS change (an old client expecting an instant inventory delta would
// mis-render a multi-tick channel). So 3 → 4.
// red realm: YouState gains `realm` and snapshots gain a `portals` array — both
// additive ServerMsg SHAPE changes (doc 03's shape clause), so 4 → 5.
// doc 13 M1: snapshots gain a `bodies` array (server-authoritative physics) —
// an additive ServerMsg SHAPE change (doc 03's shape clause), so 5 → 6.
// doc 11 M3: ranged fire becomes MAGAZINE-gated — `{t:"attack"}` on a ranged
// weapon consumes from the loaded mag (`ItemStack.mag`) instead of raw
// inventory ammo, an empty mag fires nothing, and `{t:"use"}` on an equipped
// ranged weapon now STARTS the reload channel instead of no-oping. Both are
// message SEMANTICS changes (the exact clause that forced 3 → 4): an old
// client holding inventory ammo pulls the trigger and gets silence from an
// empty mag it cannot see. The `mag` field on `inv` stacks is additive-only
// (fog/felled posture) — the bump fires on the semantics clause. So 6 → 7.
export const PROTOCOL_VERSION: number = 7;

/**
 * The kinds of server-authoritative channeled (timed) action (doc 11). A
 * channel STARTS instantly on the verb that used to resolve it, ticks its
 * `remainingS` down in game-time, interrupts with no effect on move / damage /
 * slot-swap / death (and, for cook, on leaving fire range), and runs the same
 * completion path on success. Shared so both the server's `ActiveAction`
 * (apps/.../systems/state.ts) and `YouState`'s `action` cast-progress field (M2)
 * reference ONE definition.
 */
export type ChannelKind = "cook" | "use" | "reload" | "craft" | "fish";

/**
 * Which realm a player is standing in. "overworld" is the normal island;
 * "red" is the alternate realm reached through a red portal — same world
 * geometry (the deterministic sim is unchanged) but the client re-themes the
 * terrain, sky and props. Carried per-player in YouState and per-entity on
 * WirePortal (the realm a portal leads to).
 */
export type Realm = "overworld" | "red";

// --- Sim state shared by prediction (client) and authority (server) ---

export interface PlayerCore {
  x: number;
  y: number;
  z: number;
  vy: number;
  yaw: number;
  pitch: number;
  grounded: boolean;
}

export interface InputCmd {
  seq: number;
  dt: number; // seconds, clamped server-side
  mx: number; // strafe: -1 left .. 1 right (local space)
  mz: number; // -1 forward .. 1 back (local space)
  yaw: number;
  pitch: number;
  sprint: boolean;
  jump: boolean;
}

export interface Vitals {
  hp: number;
  food: number;
  water: number;
  temp: number;
}

// Anim bit flags carried in player snapshots.
export const ANIM_MOVING = 1;
export const ANIM_SPRINTING = 2;
export const ANIM_ATTACKING = 4;

// --- Client -> Server ---

export type ClientMsg =
  /** `proto` = the client's PROTOCOL_VERSION (two-sided join gate, doc 03 §1).
   * Optional on the wire: pre-gate clients omit it and are accepted only while
   * PROTOCOL_VERSION === 1. The server gates on it at the top of handleJoin.
   * `scenario` (doc 10 M3) = a preview-only testbed set name. Additive-optional
   * (no PROTOCOL_VERSION bump); validated below, and CONSULTED by the server only
   * when env.TESTBED is on — parsed-and-ignored in prod. */
  | { t: "join"; name: string; token: string; proto?: number; scenario?: string }
  | { t: "input"; cmds: InputCmd[] }
  /** `at` = game-time the shooter's screen was rendering (interpolation runs
   * INTERP_DELAY_MS behind). The server rewinds targets to it, clamped to
   * LAG_COMP_MAX_REWIND_S — omitted/invalid means "no rewind". */
  | { t: "attack"; at?: number } // server resolves melee vs ranged
  | { t: "use"; slot: number }
  /** Craft RECIPES[recipe] — server validates inputs/tool/station (doc 05 M2). */
  | { t: "craft"; recipe: number }
  | { t: "equip"; slot: number }
  | { t: "pickup"; id: number }
  | { t: "drop"; slot: number }
  | { t: "respawn" }
  | { t: "chat"; text: string }
  | { t: "ping"; ts: number };

// --- Server -> Client ---

export interface WirePlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  item: ItemType | null; // currently held item (for rendering)
  anim: number; // ANIM_* bit flags
}

export type ZombieState = "idle" | "wander" | "chase" | "attack";

export interface WireZombie {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: ZombieState;
  /** True for the tougher military variant (renders darker/armored). */
  mil: boolean;
}

export interface WireLoot {
  id: number;
  type: ItemType;
  count: number;
  x: number;
  y: number;
  z: number;
}

/**
 * A body left behind by a dead player or zombie. Scavenge with the pickup
 * message (corpses share the entity id space with loot). The body persists
 * until its TTL even after being emptied.
 */
export interface WireCorpse {
  id: number;
  kind: "player" | "zombie";
  /** Player name for the scavenge prompt; null for zombies. */
  name: string | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Number of item stacks still on the body (0 = picked clean). */
  items: number;
}

export interface WireFire {
  id: number;
  x: number;
  y: number;
  z: number;
}

/** A placed red portal. Interest- AND realm-filtered server-side (a client
 * only ever receives the portals standing in its own realm). `to` is the realm
 * this portal leads to — the client tints the outbound (→red) and return
 * (→overworld) gateways differently. */
export interface WirePortal {
  id: number;
  x: number;
  y: number;
  z: number;
  to: Realm;
}

/** Kinds of server-auth dynamic physics body (doc 13). Wire-enum GROWTH is
 * additive-safe (clients render unknown kinds as the fallback crate mesh).
 * "trunk" (doc 13 M2) is a felled tree — additive growth, no version bump. */
export type BodyKind = "crate" | "trunk";

/**
 * A dynamic physics body pose (doc 13 M1). Server-authoritative — clients
 * NEVER step physics, they interpolate these poses like remote players.
 * Position round2'd like everything else; the quaternion is round2'd too
 * (~1–2° angular resolution — fine for crates; bit-packing is a later
 * optimization, doc 13 Open Q5). `asleep` flags settled bodies so the client
 * can skip interpolation churn for them.
 */
export interface WireBody {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  z: number;
  /** Quaternion [x, y, z, w], round2-quantized. */
  q: [number, number, number, number];
  /** Collider half-extents [hx, hy, hz], round2'd — sent only for kinds whose
   * size varies per instance (trunks: tree heights differ). Absent for crates
   * (fixed size). ADDITIVE optional field (doc 03's shape clause does not fire
   * for optional growth — the explored/fog precedent), so no version bump;
   * clients without it render the fallback crate mesh. */
  dims?: [number, number, number];
  asleep?: true;
}

/** An airdrop crate. Sent in EVERY snapshot regardless of distance — the
 * smoke column must be visible across the whole island. */
export interface WireDrop {
  id: number;
  x: number;
  y: number;
  z: number;
  /** False once the crate has landed long enough for the smoke to die. */
  smoke: boolean;
  /** True while still falling (render the chute, no pickup yet). */
  falling: boolean;
}

export type AnimalState = "idle" | "wander" | "flee";

export interface WireAnimal {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: AnimalState;
}

/** How a finished life went — shown on the death screen and in welcome
 * messages when the character died while its owner was offline. */
export interface DeathRecap {
  by: string;
  /** Game-seconds survived (divide by DAY_DURATION_S for in-game days). */
  survivedS: number;
  kills: number;
  zombieKills: number;
  distanceM: number;
}

/** One longest-lives leaderboard row (served over /api/leaderboard). */
export interface LeaderboardEntry {
  name: string;
  survivedS: number;
  kills: number;
  zombieKills: number;
  distanceM: number;
  by: string;
  /** Epoch ms when the life ended. */
  endedAt: number;
}

/** Authoritative state of YOUR player inside a snapshot (drives reconciliation). */
export interface YouState extends Vitals {
  x: number;
  y: number;
  z: number;
  vy: number;
  grounded: boolean;
  /**
   * In-progress channeled (timed) action, for the HUD cast bar (doc 11 M2).
   * Render-only — prediction (reconcile) ignores it. Absent ⇒ not channeling
   * ⇒ the bar hides. `remainingS`/`totalS` are round2'd (like x/y/z) since a
   * bar needs no more precision and gratuitous raw floats on the snapshot are
   * a smell on a project that fingerprints determinism. Bar fill =
   * (totalS - remainingS) / totalS.
   */
  action?: { kind: ChannelKind; remainingS: number; totalS: number };
  /** Which realm you are in — drives the client's terrain/sky theming. */
  realm: Realm;
}

export type GameEvent =
  | {
      e: "shot";
      /** Which weapon fired — picks the sound and tracer style. */
      w: "pistol" | "rifle" | "shotgun";
      sx: number;
      sy: number;
      sz: number;
      tx: number;
      ty: number;
      tz: number;
    }
  | { e: "swing"; id: string } // player id swung a melee weapon
  | { e: "hit"; x: number; y: number; z: number } // impact effect
  | { e: "zdie"; x: number; y: number; z: number }
  | { e: "hurt" }; // YOU took damage (vignette flash); only sent to the victim

export type ServerMsg =
  | {
      t: "welcome";
      id: string;
      seed: number;
      /** The server's PROTOCOL_VERSION (two-sided join gate, doc 03 §1). The
       * client refuses a server whose value differs from its own — treating an
       * absent value (an older server that predates this field) as a mismatch
       * — before building the world. Additive: older clients destructure named
       * fields and ignore it, so adding it does not itself bump the version. */
      proto: number;
      time: number; // server game time in seconds since boot
      you: YouState;
      inv: (ItemStack | null)[];
      selected: number;
      /** True when this join restored a persisted living character. */
      resumed: boolean;
      /** Set when the character died while its owner was offline. */
      recap: DeathRecap | null;
      /** The server's resolved ServerConfig. Additive optional field (doc 04
       * §4): older clients destructure named fields and ignore it, so adding it
       * does NOT bump PROTOCOL_VERSION. The client clamps it (clampConfig) and
       * never stores the raw object; absent → the client's DEFAULT_CONFIG. */
      config?: ServerConfig;
      /** doc 12 — base64 fog-of-war explored bitset, sent only when the server
       * runs map.reveal === "explored". Additive optional (older clients ignore
       * it), so no PROTOCOL_VERSION bump. */
      explored?: string;
      /** doc 13 M2 — indices (into the seed-derived world.trees) of every tree
       * felled so far, so a joining client hides them from the static forest.
       * Omitted when none are felled. Additive optional (the explored-field
       * precedent) → no PROTOCOL_VERSION bump; an older client renders felled
       * trees standing, a render-only divergence with no sim impact (felled
       * trees stay kinematic-solid for movement on BOTH ends — see doc 13 M2). */
      felled?: number[];
    }
  | {
      t: "snap";
      tick: number;
      time: number; // game time seconds; client derives time-of-day
      ack: number; // last input seq applied for YOU
      you: YouState;
      players: WirePlayer[]; // includes you (renderers skip own id)
      zombies: WireZombie[];
      loot: WireLoot[];
      corpses: WireCorpse[];
      fires: WireFire[];
      /** Red portals in YOUR realm within interest range. */
      portals: WirePortal[];
      /** Dynamic physics bodies within interest range (doc 13 — overworld
       * only; empty for red-realm players). Server-auth, client-interpolated. */
      bodies: WireBody[];
      /** All active airdrops, never interest-filtered (island-wide smoke). */
      drops: WireDrop[];
      animals: WireAnimal[];
      /** Rain intensity 0..1 (server weather machine; ramped, not stepped). */
      weather: number;
      events: GameEvent[];
      count: number; // players online
      /** doc 12 — cell indices newly explored this tick (fog servers only).
       * Omitted when empty. Additive optional → no PROTOCOL_VERSION bump. */
      fog?: number[];
      /** doc 13 M2 — tree indices felled THIS tick (a global one-shot delta,
       * same posture as `fog`; the full set rides in welcome). Omitted when
       * empty. Additive optional → no PROTOCOL_VERSION bump. */
      felled?: number[];
    }
  | { t: "inv"; slots: (ItemStack | null)[]; selected: number }
  /** Proximity chat line — delivered only to players within CHAT_RADIUS. */
  | { t: "chat"; name: string; text: string }
  | { t: "death"; by: string; recap: DeathRecap }
  | { t: "notice"; msg: string }
  | { t: "pong"; ts: number }
  | { t: "error"; msg: string };

// --- Validation (server-side trust boundary) ---

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Parse and shape-check a raw websocket payload from a client. Returns null
 * for anything malformed. Range clamping (dt, name length…) happens in the
 * server systems; this guards types only.
 */
export function parseClientMsg(data: unknown): ClientMsg | null {
  if (typeof data !== "string" || data.length > 8192) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case "join": {
      if (typeof m.name !== "string") return null;
      // Identity token: 32-64 hex chars, generated and stored client-side.
      if (typeof m.token !== "string" || !/^[0-9a-f]{32,64}$/i.test(m.token)) return null;
      // proto (two-sided join gate, doc 03 §1): optional on the wire. When
      // present it MUST be a finite number; anything else is malformed.
      // The accept/reject decision against PROTOCOL_VERSION lives in handleJoin.
      let proto: number | undefined;
      if (m.proto !== undefined) {
        if (!isFiniteNum(m.proto)) return null;
        proto = m.proto;
      }
      // scenario (doc 10 M3): optional preview-only testbed set name. Validate the
      // SHAPE on the wire (1-100 chars, [a-z0-9_-]) regardless of TESTBED — same
      // discipline as the token regex; the server only CONSULTS it when testbed.
      let scenario: string | undefined;
      if (m.scenario !== undefined) {
        if (typeof m.scenario !== "string" || !/^[a-z0-9_-]{1,100}$/.test(m.scenario)) return null;
        scenario = m.scenario;
      }
      return { t: "join", name: m.name, token: m.token, proto, scenario };
    }
    case "input": {
      if (!Array.isArray(m.cmds)) return null;
      // Truncate oversized batches instead of rejecting wholesale — a reject
      // would stall the ack stream and grow the client's pending queue.
      const rawCmds = (m.cmds as unknown[]).slice(0, 40);
      const cmds: InputCmd[] = [];
      for (const c of rawCmds) {
        if (typeof c !== "object" || c === null) return null;
        const i = c as Record<string, unknown>;
        if (
          !isFiniteNum(i.seq) ||
          !isFiniteNum(i.dt) ||
          !isFiniteNum(i.mx) ||
          !isFiniteNum(i.mz) ||
          !isFiniteNum(i.yaw) ||
          !isFiniteNum(i.pitch)
        ) {
          return null;
        }
        cmds.push({
          seq: i.seq,
          dt: i.dt,
          mx: Math.max(-1, Math.min(1, i.mx)),
          mz: Math.max(-1, Math.min(1, i.mz)),
          yaw: i.yaw,
          pitch: i.pitch,
          sprint: i.sprint === true,
          jump: i.jump === true,
        });
      }
      return { t: "input", cmds };
    }
    case "attack":
      return { t: "attack", at: isFiniteNum(m.at) ? m.at : undefined };
    case "use":
      return isFiniteNum(m.slot) ? { t: "use", slot: m.slot | 0 } : null;
    case "craft":
      // recipe is a RECIPES index; range/identity checked in craftItem.
      return isFiniteNum(m.recipe) ? { t: "craft", recipe: m.recipe | 0 } : null;
    case "equip":
      return isFiniteNum(m.slot) ? { t: "equip", slot: m.slot | 0 } : null;
    case "pickup":
      return isFiniteNum(m.id) ? { t: "pickup", id: m.id | 0 } : null;
    case "drop":
      return isFiniteNum(m.slot) ? { t: "drop", slot: m.slot | 0 } : null;
    case "respawn":
      return { t: "respawn" };
    case "chat":
      // Length is a transport sanity cap; the server trims/sanitizes to
      // CHAT_MAX_LENGTH and rate-limits before delivery.
      if (typeof m.text !== "string" || m.text.length === 0 || m.text.length > 512) return null;
      return { t: "chat", text: m.text };
    case "ping":
      return isFiniteNum(m.ts) ? { t: "ping", ts: m.ts } : null;
    default:
      return null;
  }
}

/** Game-time seconds -> hour of day [0, 24). */
export function gameHours(timeS: number, dayDurationS: number, startHour: number): number {
  return (startHour + (timeS / dayDurationS) * 24) % 24;
}
