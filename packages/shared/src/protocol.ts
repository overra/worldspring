// Wire protocol between client and the GameRoom Durable Object.
// JSON for v1 — readable and fast enough at this scale. All messages are
// discriminated unions on `t`.

import type { ServerConfig } from "./config";
import type { ItemStack, ItemType } from "./items";
import type { PieceKind, PieceTier, StructurePiece } from "./structures";
import type { PlantedTreeDelta, PlantedTreeRecord, TreeSpecies } from "./trees";

/**
 * doc 06 — parse-time whitelist of placeable piece kinds. A LITERAL mirror of
 * structures.ts `PLACEABLE_KINDS`, duplicated deliberately: protocol.ts must
 * stay value-import-free of non-leaf shared modules so the node strip-types
 * test harnesses (wear-slots.mjs etc.) can import it directly. The
 * structures.mjs harness asserts the two lists stay identical.
 */
const PLACE_KIND_WHITELIST: readonly PieceKind[] = [
  "foundation",
  "wall",
  "doorway",
  "window",
  "door",
  "gate",
  "crate",
];

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
// doc 05 M6: NEW ClientMsg shapes `{t:"wear"}` / `{t:"unwear"}` grow the wire
// vocabulary (doc 03's shape clause — the exact rule that forced 2 → 3 for
// `craft`). The additive `worn?` field on inv/welcome would NOT bump on its
// own (fog/felled posture); the new messages do. So 7 → 8.
// doc 06 core build loop: NEW ClientMsg shapes `place`/`demolish`/`door` grow
// the wire vocabulary (doc 03's shape clause), AND placed structures change
// PREDICTED COLLISION semantics — the shared World's queryStatics/groundHeight/
// raycastStatics now include a mutable StructureIndex fed by the new
// sFull/sAdd/sRemove/sState server messages. An old client would never build
// the index and would mispredict every step inside a base — the exact
// divergence the two-sided gate exists to stop. So 8 → 9.
// doc 06 M5–M7 (locks, crates, raiding): NEW ClientMsg shapes `setCode`/
// `tryCode`/`cOpen`/`cMove` grow the wire vocabulary (doc 03's shape clause —
// the rule that forced 2 → 3 for `craft`), plus `place` gains crate x/z and a
// new `cont` ServerMsg. The additive `locked`/`hp` fields on sState/WirePiece
// would NOT bump on their own (fog/felled posture); the new messages do.
// So 9 → 10.
// doc 13 M4 (vehicles v1): NEW ClientMsg shapes `enterVehicle`/`exitVehicle`/
// `drive`/`refuel` grow the wire vocabulary (doc 03's shape clause — the rule
// that forced 2 → 3 for `craft`). This is the doc's PLANNED second bump (M1
// bodies was the first; doc 13 §Migration "two bumps total"). The additive
// growth alongside it — a new "vehicle" BodyKind value, WireBody `seats`/
// `wrecked`, and YouState `seat` — would NOT bump on its own (the trunk/barrel
// BodyKind precedent + the fog/felled optional-field posture); the new
// messages do. So 10 → 11.
// Tree lifecycle: planted-tree state changes predicted collision, so clients
// must understand the new welcome/snapshot fields. 11 -> 12.
// Stumps + persistent trunks: the planted stage vocabulary grows ("stump" — a
// terminal, event-driven stage riding the same welcome/snap records), and its
// collision semantics (stub footprint stays solid where a remove used to clear
// it) must be shared by prediction. The additive `break` kind "trunk" and the
// first-emitted treeCut events would NOT bump on their own (BodyKind/event
// posture); the stage semantics do. So 12 -> 13.
// Binary snapshot wire: the per-tick `snap` message now ships as a quantized
// binary frame (packages/shared/src/snapCodec.ts) instead of JSON — the framing
// itself changes, so old clients cannot parse a new server's snapshots (and
// vice-versa). Every OTHER message stays JSON; the entity SHAPES are unchanged
// (decodeSnap reconstructs the identical SnapMsg). So 13 -> 14.
export const PROTOCOL_VERSION: number = 14;

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

/** The two wearable-equipment slots (doc 05 M6): body (jacket — insulation)
 * and back (backpack — extra inventory slots). Shared so the server's
 * `ServerPlayer.worn`, the wire (`inv.worn` / `welcome.worn` / `{t:"unwear"}`)
 * and the client store all reference ONE definition. */
export type WearSlot = "body" | "back";

/** Worn-equipment state carried on inv/welcome (doc 05 M6). Additive optional
 * on both messages — absent reads as nothing worn. */
export interface WornState {
  body: ItemStack | null;
  back: ItemStack | null;
}

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
  /** Wear the `kind:"wear"` item in inventory `slot` (doc 05 M6): swaps with
   * the current occupant of its wear slot. Server validates kind/bounds. */
  | { t: "wear"; slot: number }
  /** Remove the worn item in `ws` back into the inventory (doc 05 M6);
   * rejected with a notice when nothing fits — never silently dropped. */
  | { t: "unwear"; ws: WearSlot }
  | { t: "equip"; slot: number }
  | { t: "pickup"; id: number }
  | { t: "drop"; slot: number }
  /** doc 06 — place a structure piece at a snapped grid address. Server-side
   * validation is the shared canPlace + hammer/cost/cap checks; the parser
   * whitelists PLACEABLE_KINDS and clamps gx/gz to the max-tier bound only
   * (the real bounds check reads World.size, which the parser cannot).
   * `x`/`z` = a crate's free position inside its cell (crates only). */
  | { t: "place"; kind: PieceKind; tier: PieceTier; gx: number; gz: number; edge?: 0 | 2; x?: number; z?: number }
  /** doc 06 — owner-only removal (hold-X client-side). No refund. */
  | { t: "demolish"; id: number }
  /** doc 06 M5 — toggle a door/gate open/closed. Opens iff the piece is
   * unlocked OR the sender's tokenHash is owner/authorized (server-checked). */
  | { t: "door"; id: number }
  /** doc 06 M5 — owner-only: set/change a door/gate's 4-digit code (clears
   * the authorized list — changing the code revokes everyone). An EMPTY code
   * removes the lock (the owner unlock affordance). */
  | { t: "setCode"; id: number; code: string }
  /** doc 06 M5 — try a 4-digit code on a locked door/gate. Correct appends
   * the sender to the authorized list and opens; failures burn the PER-DOOR
   * global backoff budget (never per-identity — identities are free). */
  | { t: "tryCode"; id: number; code: string }
  /** doc 06 M6 — request a container view (server replies `cont`). */
  | { t: "cOpen"; id: number }
  /** doc 06 M6 — move ONE whole stack between player inventory slot `from`
   * and container slot `to` (dir "in"), or container slot `from` to inventory
   * slot `to` (dir "out"). Range re-validated per message; the reply is an
   * authoritative `cont` + full `inv`. */
  | { t: "cMove"; id: number; from: number; to: number; dir: "in" | "out" }
  /** doc 13 M4 — board vehicle `id` at seat `seat` (0 = driver, 1 = passenger).
   * Server validates range + an empty seat + alive/overworld/on-foot. */
  | { t: "enterVehicle"; id: number; seat: number }
  /** doc 13 M4 — leave whatever seat you're in (the server knows which); it
   * places you on valid ground beside the vehicle. */
  | { t: "exitVehicle" }
  /** doc 13 M4 — driver control, applied by the server each tick to the vehicle
   * body. `throttle`/`steer` clamped finite [-1,1], `brake` clamped [0,1].
   * Ignored unless the sender is the DRIVER (seat 0) of a vehicle. */
  | { t: "drive"; throttle: number; steer: number; brake: number }
  /** doc 13 M4 — top up vehicle `id`'s fuel from a fuel item in inventory
   * (server consumes one, adds FUEL_PER_CAN). Requires range. */
  | { t: "refuel"; id: number }
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
 * "trunk" (doc 13 M2) is a felled tree; "barrel" (doc 13 M3) is a spawnable,
 * shovable loot prop; "vehicle" (doc 13 M4) is the drivable ground buggy — each
 * an additive growth. A new BodyKind value ALONE never bumps PROTOCOL_VERSION
 * (the trunk/barrel precedent); doc 13 M4's bump is forced by its new ClientMsg
 * shapes, not by this value. */
export type BodyKind = "crate" | "trunk" | "barrel" | "vehicle";

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
  /** doc 13 M4 — vehicle seats: WirePlayer ids per seat index (0 = driver,
   * 1 = passenger), null for an empty seat. Present ONLY on "vehicle" bodies;
   * lets clients hide a seated player's walking avatar (they ride the hull) and
   * render riders. ADDITIVE optional (the dims precedent) — never on crates/
   * trunks/barrels. */
  seats?: (string | null)[];
  /** doc 13 M4 — a wrecked (hp<=0) vehicle: undriveable, rendered as a hulk.
   * ADDITIVE optional; absent = intact. */
  wrecked?: true;
}

/**
 * doc 06 — a structure piece on the wire: the shared StructurePiece plus a
 * derived `locked` flag for doors/gates (so the client can prompt for a
 * code). Produced exclusively by the server system's `toWirePiece`, which
 * strips ownerHash/placedAtMs/code/authorized/contents (every server secret)
 * from the server's meta and derives `locked`. Structure deltas are GLOBAL —
 * never interest-filtered, never in snapshots — because prediction needs the
 * complete collision set everywhere (doc 06:172-175).
 */
export type WirePiece = StructurePiece & {
  /** Door/gate only: a code is set. Never carries WHICH hashes are authorized. */
  locked?: boolean;
};

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
  /**
   * doc 13 M4 — set while YOU are seated in a vehicle: which vehicle body (`id`),
   * which seat (`index`; 0 = driver), and the driver-HUD readout (`fuel`/`hp`
   * absolute vs VEHICLE_FUEL_MAX/VEHICLE_HP_MAX, `speed` m/s, all round2'd).
   * Absent ⇒ on foot. Render/HUD + input-routing only (the client sends `drive`
   * instead of `input` while this names the driver seat) — prediction ignores
   * it, exactly like `action`. ADDITIVE optional field.
   */
  seat?: { id: number; index: number; fuel: number; hp: number; speed: number };
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
  | {
      /** Additive cosmetic destruction cue; authoritative removal still rides bodies. */
      e: "break";
      id: number;
      /** "trunk" = a felled trunk axe-broken to wood (tree lifecycle). The
       * additive-kind posture matches BodyKind (new kinds never bump alone). */
      kind: "barrel" | "trunk";
      x: number;
      y: number;
      z: number;
      q: [number, number, number, number];
    }
  | {
      /** Cosmetic only: Three Pinata fractures a sealed proxy, never EZ-Tree. */
      e: "treeCut";
      id: number;
      species: TreeSpecies;
      final: boolean;
      x: number;
      y: number;
      z: number;
    }
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
      /** doc 05 M6 — worn equipment, mirroring `inv.worn`: welcome carries the
       * inventory directly and no inv message follows a join, so without this a
       * rejoining client would render empty EQUIPMENT until the first inventory
       * mutation. Additive optional (absent = nothing worn). */
      worn?: WornState;
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
      /** Full persistent planted-tree collection, separate from natural indices. */
      planted?: PlantedTreeRecord[];
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
      /** Additive planted-tree upserts/removals, applied on the render timeline. */
      planted?: PlantedTreeDelta[];
    }
  /** `worn` (doc 05 M6): the equipped body/back items. Additive optional —
   * `slots` length is INVENTORY_SLOTS, or INVENTORY_SLOTS + extraSlots while
   * a backpack is worn (pack slots render under the Tab panel's PACK divider). */
  | { t: "inv"; slots: (ItemStack | null)[]; selected: number; worn?: WornState }
  /** doc 06 — full structure set on join: batches of ≤500 pieces sent
   * synchronously right after `welcome` (same socket stretch, so they precede
   * any tick snapshot). `done` marks the last batch. */
  | { t: "sFull"; pieces: WirePiece[]; done: boolean }
  /** doc 06 — global structure deltas (never interest-filtered). */
  | { t: "sAdd"; piece: WirePiece }
  | { t: "sRemove"; id: number }
  /** doc 06 — piece state change. `open` is the door/gate toggle; `hp` rides
   * every structure hit (damage-tier rendering, M7); `locked` flips on
   * setCode (lock set/changed/removed, M5). */
  | { t: "sState"; id: number; open?: boolean; hp?: number; locked?: boolean }
  /** doc 06 M6 — authoritative full container state, sent to the requester of
   * a cOpen/cMove. Fixed CRATE_SLOTS-length array; slot indices are stable
   * (removal nulls, never compacts). */
  | { t: "cont"; id: number; slots: (ItemStack | null)[] }
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
    case "wear":
      // slot bounds + kind check live in wearItem (the authority).
      return isFiniteNum(m.slot) ? { t: "wear", slot: m.slot | 0 } : null;
    case "unwear":
      // ws is validated to the two WearSlot literals — anything else is malformed.
      return m.ws === "body" || m.ws === "back" ? { t: "unwear", ws: m.ws } : null;
    case "equip":
      return isFiniteNum(m.slot) ? { t: "equip", slot: m.slot | 0 } : null;
    case "pickup":
      return isFiniteNum(m.id) ? { t: "pickup", id: m.id | 0 } : null;
    case "drop":
      return isFiniteNum(m.slot) ? { t: "drop", slot: m.slot | 0 } : null;
    case "place": {
      // doc 06 — kind whitelist, tier 0|1, integer grid coords with a loose
      // parse-time clamp at the max-tier bound (±534 build cells covers the
      // huge tier's ±533; the authoritative bounds check in canPlace reads
      // World.size).
      if (typeof m.kind !== "string" || !(PLACE_KIND_WHITELIST as readonly string[]).includes(m.kind)) {
        return null;
      }
      if (m.tier !== 0 && m.tier !== 1) return null;
      // Crates are wood-only in v1 (PIECE_DEFS hp [200, 200]) — a scrap-tier
      // crate on the wire is malformed.
      if (m.kind === "crate" && m.tier !== 0) return null;
      if (!isFiniteNum(m.gx) || !isFiniteNum(m.gz)) return null;
      const gx = Math.max(-534, Math.min(534, m.gx | 0));
      const gz = Math.max(-534, Math.min(534, m.gz | 0));
      let edge: 0 | 2 | undefined;
      if (m.edge !== undefined) {
        if (m.edge !== 0 && m.edge !== 2) return null;
        // Cell pieces (foundation/crate) must not carry an edge — it would
        // shift pieceCenter 1.5m and shave every center-based server check
        // (no-build margins, BUILD_RANGE, density). Malformed, reject.
        if (m.kind === "foundation" || m.kind === "crate") return null;
        edge = m.edge;
      }
      // Free position — crates only (doc 06 M6): both coords or neither;
      // cell membership is canPlace's authoritative check. Round2 keeps the
      // wire/persist records tidy (the snapshot round2 convention).
      let x: number | undefined;
      let z: number | undefined;
      if (m.x !== undefined || m.z !== undefined) {
        if (m.kind !== "crate") return null;
        if (!isFiniteNum(m.x) || !isFiniteNum(m.z)) return null;
        x = Math.round(m.x * 100) / 100;
        z = Math.round(m.z * 100) / 100;
        // Re-check: |v| > ~1.79e306 overflows the *100 to Infinity, which
        // would break the parse layer's no-NaN/Infinity contract.
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      }
      return { t: "place", kind: m.kind as PieceKind, tier: m.tier, gx, gz, edge, x, z };
    }
    case "demolish":
      return isFiniteNum(m.id) ? { t: "demolish", id: m.id | 0 } : null;
    case "door":
      return isFiniteNum(m.id) ? { t: "door", id: m.id | 0 } : null;
    case "setCode":
      // doc 06 M5 — 4 digits sets/changes; the EMPTY string removes the lock
      // (owner unlock affordance). Anything else is malformed.
      if (!isFiniteNum(m.id)) return null;
      if (typeof m.code !== "string" || !/^(\d{4})?$/.test(m.code)) return null;
      return { t: "setCode", id: m.id | 0, code: m.code };
    case "tryCode":
      // doc 06 M5 — strictly 4 digits; guessing burns the per-door budget.
      if (!isFiniteNum(m.id)) return null;
      if (typeof m.code !== "string" || !/^\d{4}$/.test(m.code)) return null;
      return { t: "tryCode", id: m.id | 0, code: m.code };
    case "cOpen":
      return isFiniteNum(m.id) ? { t: "cOpen", id: m.id | 0 } : null;
    case "cMove": {
      // doc 06 M6 — slot indices `| 0` (doc wire section); bounds are the
      // server handler's authoritative check.
      if (!isFiniteNum(m.id) || !isFiniteNum(m.from) || !isFiniteNum(m.to)) return null;
      if (m.dir !== "in" && m.dir !== "out") return null;
      return { t: "cMove", id: m.id | 0, from: m.from | 0, to: m.to | 0, dir: m.dir };
    }
    case "enterVehicle":
      // doc 13 M4 — vehicle id integer-checked; seat WHITELISTED to 0|1 (the
      // two seats). Range/occupancy/alive are the server handler's checks.
      if (!isFiniteNum(m.id)) return null;
      if (m.seat !== 0 && m.seat !== 1) return null;
      return { t: "enterVehicle", id: m.id | 0, seat: m.seat };
    case "exitVehicle":
      return { t: "exitVehicle" };
    case "drive": {
      // doc 13 M4 — driver control: NO client float trusted beyond the clamp.
      // throttle/steer clamped to [-1,1], brake to [0,1]; non-finite is
      // malformed (mirrors the input-cmd clamp, which uses Math.max/min inline).
      if (!isFiniteNum(m.throttle) || !isFiniteNum(m.steer) || !isFiniteNum(m.brake)) return null;
      return {
        t: "drive",
        throttle: Math.max(-1, Math.min(1, m.throttle)),
        steer: Math.max(-1, Math.min(1, m.steer)),
        brake: Math.max(0, Math.min(1, m.brake)),
      };
    }
    case "refuel":
      return isFiniteNum(m.id) ? { t: "refuel", id: m.id | 0 } : null;
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
