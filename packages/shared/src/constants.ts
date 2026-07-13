// Engine + shared tuning: net, movement, worldgen, physics, persistence, chat,
// map, directory. Client and server import these; changing a value here changes
// both sides consistently. The flagship survival mode's gameplay tunables were
// split into ./constants/survival.ts (docs/plans/00, engine⟷game seam) and are
// re-exported below, so `@worldspring/shared/constants` still exposes everything
// — a pure reorg, values byte-identical.
export * from "./constants/survival.ts";

export const WORLD_SEED = 1337;

// --- World ---
export const WORLD_SIZE = 800; // meters, square, centered on origin (standard tier)
/**
 * Worldgen FORMULA version (doc 07 M1). Compile-time on both sides, never on
 * the wire. Bump ONLY when a formula change alters createWorld output from an
 * identical config (e.g. doc 07 M5 water carving) — a bump is WIPE-class (it
 * enters worldFingerprintOf as `gen:`) and per doc 03's criteria each bump
 * also demands a PROTOCOL_VERSION bump (old clients would predict against
 * divergent geometry).
 */
export const WORLDGEN_VERSION = 1;
export const WATER_LEVEL = 0; // world y of the ocean plane
export const WATER_WALK_MIN = -0.55; // terrain height below this blocks walking (deep water)
export const TERRAIN_MAX_HEIGHT = 22;

// --- Fresh water: rivers + ponds (doc 07 §5, gated on world.waterFeatures) ---
// The carve LOWERS heightAt near rivers/ponds, so these are worldgen-shaping and
// only ever active on a water world (waterFeatures:true → its own fingerprint).
// FORD/POOL depths are load-bearing: a ford (0.45) sits under the M7 wade limit
// (0.55) so rivers stay crossable ~every 100m; a pool (1.4) blocks + is fishable.
export const RIVER_FORD_DEPTH = 0.45;
export const RIVER_POOL_DEPTH = 1.4;
/** River half-width lerps min→max from source to mouth (width grows downstream). */
export const RIVER_HALFW_MIN = 1.5;
export const RIVER_HALFW_MAX = 4.0;
/** Pond stamp radius / centre depth ranges (uniform-sampled per pond). */
export const POND_RADIUS_MIN = 7;
export const POND_RADIUS_MAX = 16;
export const POND_DEPTH_MIN = 0.9;
export const POND_DEPTH_MAX = 1.6;
/** Cell pitch (m) of the water spatial index heightAt prepends one Map.get to. */
export const WATER_GRID_CELL = 32;
export const TOWN_COUNT = 4;
export const CABIN_COUNT = 6;
export const TREE_COUNT = 700;

// --- Net ---
export const TICK_RATE = 15; // server simulation + snapshot Hz
export const TICK_MS = 1000 / TICK_RATE;
export const INPUT_SEND_MS = 50; // client batches input cmds at this interval
export const INTERP_DELAY_MS = 120; // remote entity render delay (interpolation buffer)
export const INTEREST_RADIUS = 220; // entities beyond this are not sent to a client
export const LOOT_INTEREST_RADIUS = 120;
export const MAX_INPUT_DT = 0.05; // clamp for a single input cmd dt (seconds)
// Client emits input cmds at (at most) this fixed cadence instead of once per
// rendered frame, so cmd count tracks simulated time, not display refresh: a
// 240Hz monitor sends ~60 cmds/s, not 240. Fewer cmds = a smaller client
// reconcile replay set AND fewer per-cmd stepPlayer/resolveStatics calls
// server-side, for identical movement. Displays at/below this rate are
// unaffected (they still emit every frame). Kept <= MAX_INPUT_DT so an emitted
// dt is never clamped by the server. Purely client-side pacing — the InputCmd
// wire shape is unchanged, so no PROTOCOL_VERSION bump.
export const INPUT_TICK_HZ = 60;
export const FIXED_INPUT_DT = 1 / INPUT_TICK_HZ;
// Server-side anti-speedhack: each player's input time accrues at wall-clock
// rate with a small burst allowance for network/frame hiccups. Sustained
// movement rate is therefore capped at exactly 1x real time.
export const INPUT_BUDGET_CAP_S = 0.4;
// Client-side: a long frame is split into sub-cmds of MAX_INPUT_DT, at most
// this many per frame (matches the server burst allowance: 6 x 0.05 = 0.3).
export const MAX_CMDS_PER_FRAME = 6;
export const MAX_NAME_LENGTH = 16;
// The verified perf envelope for one room. Raising this only presses the
// snapshot broadcast, the sole O(players²) cost (each client gets its own
// interest-filtered snapshot built + JSON.stringify'd every tick). At 40 that
// phase is ~6.6 ms vs the 66.7 ms 15 Hz budget — ~10× headroom; the sim itself
// has ~130×. Chasing hundreds needs a spatial index + binary/delta wire first.
export const MAX_PLAYERS = 40;

// --- Player movement ---
export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;
export const WALK_SPEED = 4.2; // m/s
export const SPRINT_SPEED = 6.8;
export const JUMP_VELOCITY = 4.6;
export const GRAVITY = 12.5;
export const STEP_UP_MAX = 0.6; // max ground rise we snap up while grounded

// --- Day/night (world clock; the survival warmth/spawn effects read it) ---
export const DAY_DURATION_S = 16 * 60; // one full 24h cycle in real seconds
export const NIGHT_START_HOUR = 21;
export const NIGHT_END_HOUR = 5;
export const START_HOUR = 9; // world clock at server boot

// --- Respawn ---
export const RESPAWN_DELAY_S = 4;

// --- Lag compensation ---
/** Max seconds the server will rewind target positions for a hitscan. Covers
 * INTERP_DELAY (120ms) + input batching (50ms) + ~150ms network. */
export const LAG_COMP_MAX_REWIND_S = 0.35;

// --- Chat ---
export const CHAT_RADIUS = 40; // meters — proximity text chat delivery
export const CHAT_MAX_LENGTH = 120;
export const CHAT_COOLDOWN_S = 0.8; // min seconds between messages per player

// --- World scatter (set dressing) ---
export const ROCK_COUNT = 70;

// --- Persistence ---
/** A disconnected (alive) body stays in the world this long, defenseless. */
export const LOGOUT_LINGER_S = 60;
/** World + character state is snapshotted to DO storage on this cadence. */
export const WORLD_SAVE_INTERVAL_S = 20;
/** Completed lives kept for the longest-lives leaderboard. */
export const LEADERBOARD_MAX = 50;

// --- Map & cartography (doc 12) ---
/** DEFAULT_CONFIG.map.* — the generous, zero-wire baseline: minimap on, the map
 *  item granted at spawn, the whole island revealed. `as const` narrows them to
 *  the MapAcquire/MapReveal literals without importing config.ts. */
export const MAP_MINIMAP_DEFAULT = true;
export const MAP_ACQUIRE_DEFAULT = "spawn" as const;
export const MAP_REVEAL_DEFAULT = "full" as const;

// --- Physics (doc 13) ---
/** Server-auth dynamic-body cap per room (doc 13 §3): the DO's physics cost
 *  ceiling. Over the cap, oldest-settled bodies evict first. LIVE-class dial
 *  (config.physics.bodyCap); M0 measured <0.3% of tick at this value. */
export const PHYSICS_BODY_CAP = 64;

// --- Server info & directory ---
/** Per-isolate Worker micro-cache TTL for GET /api/server-info (doc 03 §5). */
export const SERVER_INFO_CACHE_TTL_S = 15;
/** ServerInfo.name max length, code points (doc 03 §2/§5). */
export const MAX_SERVER_NAME_LENGTH = 32;
/** ServerInfo.motd max length, code points (doc 03 §2/§5). */
export const MAX_MOTD_LENGTH = 140;
/** Periodic heartbeat cadence while occupied (doc 03 §5/§6). M3 sends them. */
export const HEARTBEAT_INTERVAL_S = 60;
/** ± jitter on the periodic cadence, anti thundering-herd (doc 03 §5/§6). */
export const HEARTBEAT_JITTER_S = 10;
/**
 * The floor between ANY two beats from one sender: edge beats are debounced to
 * one per this window, and every sent beat reschedules the periodic timer
 * (§6) — so this is also the cap on legal sustained send rate (3/min). Must
 * stay above the directory intake refill period (§9: 15s) with headroom — a
 * compliant sender must never be able to trip the directory's rate limit, and
 * §9's sizing arithmetic depends on the reschedule rule.
 */
export const HEARTBEAT_EDGE_DEBOUNCE_S = 20;
