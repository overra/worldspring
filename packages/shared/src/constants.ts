// Single source of truth for all gameplay tuning. Client and server import these;
// changing a value here changes both sides consistently.

export const WORLD_SEED = 1337;

// --- World ---
export const WORLD_SIZE = 800; // meters, square, centered on origin
export const WATER_LEVEL = 0; // world y of the ocean plane
export const WATER_WALK_MIN = -0.55; // terrain height below this blocks walking (deep water)
export const TERRAIN_MAX_HEIGHT = 22;
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
// Server-side anti-speedhack: each player's input time accrues at wall-clock
// rate with a small burst allowance for network/frame hiccups. Sustained
// movement rate is therefore capped at exactly 1x real time.
export const INPUT_BUDGET_CAP_S = 0.4;
// Client-side: a long frame is split into sub-cmds of MAX_INPUT_DT, at most
// this many per frame (matches the server burst allowance: 6 x 0.05 = 0.3).
export const MAX_CMDS_PER_FRAME = 6;
export const MAX_NAME_LENGTH = 16;
export const MAX_PLAYERS = 24;

// --- Player movement ---
export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;
export const WALK_SPEED = 4.2; // m/s
export const SPRINT_SPEED = 6.8;
export const JUMP_VELOCITY = 4.6;
export const GRAVITY = 12.5;
export const STEP_UP_MAX = 0.6; // max ground rise we snap up while grounded

// --- Vitals ---
export const MAX_HP = 100;
export const MAX_FOOD = 100;
export const MAX_WATER = 100;
export const FOOD_DECAY_PER_S = 100 / (25 * 60); // empty in ~25 min
export const WATER_DECAY_PER_S = 100 / (18 * 60); // empty in ~18 min
export const SPRINT_FOOD_MULT = 2.2; // food/water decay multiplier while sprinting
export const STARVE_HP_PER_S = 1.0; // hp drain when food or water is 0
export const REGEN_HP_PER_S = 1.0; // hp regen when food > 60 and water > 60
export const REGEN_FOOD_MIN = 60;
export const REGEN_WATER_MIN = 60;

// --- Temperature (degrees C, body temp) ---
export const TEMP_NORMAL = 37;
export const TEMP_SHIVER = 35; // below this: shivering + hp drain
export const TEMP_MIN = 32;
export const FREEZE_HP_PER_S = 0.6;
export const TEMP_FALL_PER_S = 0.012; // exposed at night
export const TEMP_RISE_PER_S = 0.05; // near fire or warm daytime
export const AMBIENT_WARM_HOUR_START = 7; // hours when ambient keeps you warm
export const AMBIENT_WARM_HOUR_END = 20;
export const FIRE_WARMTH_RADIUS = 5;

// --- Day/night ---
export const DAY_DURATION_S = 16 * 60; // one full 24h cycle in real seconds
export const NIGHT_START_HOUR = 21;
export const NIGHT_END_HOUR = 5;
export const START_HOUR = 9; // world clock at server boot

// --- Zombies ---
export const ZOMBIE_MAX = 60;
export const ZOMBIES_PER_TOWN = 8;
export const ZOMBIE_ROAMERS = 16;
export const ZOMBIE_HP = 60;
export const ZOMBIE_DMG = 12;
export const ZOMBIE_ATTACK_RANGE = 1.7;
export const ZOMBIE_ATTACK_COOLDOWN_S = 1.2;
export const ZOMBIE_AGGRO_RADIUS = 28;
export const ZOMBIE_DEAGGRO_RADIUS = 55;
export const ZOMBIE_CHASE_SPEED = 5.4;
export const ZOMBIE_WANDER_SPEED = 0.9;
export const ZOMBIE_RADIUS = 0.45;
export const ZOMBIE_RESPAWN_S = 30;
export const ZOMBIE_SPAWN_MIN_PLAYER_DIST = 45;

// --- Military zone ---
export const MILITARY_ZOMBIES = 14; // inside the compound at boot
export const MILITARY_ZOMBIE_HP = 120;
export const MILITARY_ZOMBIE_DMG = 20;
export const MILITARY_ZOMBIE_SPEED = 5.6; // chase, vs 5.4 normal
export const MILITARY_RESPAWN_MIN_PLAYER_DIST = 60;

// --- Combat ---
export const MELEE_RANGE = 2.3;
export const MELEE_HALF_ANGLE_RAD = Math.PI / 3.2; // generous cone
export const FIST_DMG = 12;
export const ATTACK_COOLDOWN_S = 0.7;
export const PISTOL_COOLDOWN_S = 0.35;
export const PISTOL_RANGE = 90;
export const HIT_CAPSULE_RADIUS = 0.55;

// --- Loot ---
export const LOOT_RESPAWN_MIN_S = 240;
export const LOOT_RESPAWN_MAX_S = 400;
// Don't respawn in plain sight — but a small radius, so someone looting one
// building doesn't freeze refills for the whole town.
export const LOOT_RESPAWN_MIN_PLAYER_DIST = 25;
// Camping can't starve a town forever: once a respawn is this overdue it
// fires even with a player standing on the spawn point.
export const LOOT_RESPAWN_FORCE_OVERDUE_S = 180;
export const PICKUP_RANGE = 2.6;
export const INVENTORY_SLOTS = 8;

// --- Corpses ---
export const PLAYER_CORPSE_TTL_S = 300;
export const ZOMBIE_CORPSE_TTL_S = 120;
export const ZOMBIE_LOOT_CHANCE = 0.55; // chance a zombie corpse carries anything

// --- Channeled actions (doc 11) ---
// Durations for the server-authoritative channeled-action primitive. House
// rule: channel durations live here, not as system-local tunables (the
// FIRE_WARMTH_RADIUS / ATTACK_COOLDOWN_S precedent above). Placeholders pending
// the M5 playtest tuning pass; per-action numbers owned by another doc (craft
// times, reload, fishing window) live in THAT owner's table, not here.
/** Cook a raw item over a fire (the headline channel — only progresses while nearFire). */
export const COOK_CHANNEL_S = 3;
/** Eat / drink / heal a consumable (bandage-style heals may want longer later). */
export const USE_CHANNEL_S = 1.2;
/** Place a campfire (and other placeables). */
export const PLACEABLE_CHANNEL_S = 1.5;

// --- Campfire ---
export const CAMPFIRE_BURN_S = 8 * 60;
export const CAMPFIRE_PLACE_DIST = 1.6; // placed this far in front of player
export const MAX_CAMPFIRES = 32; // world-wide; placing past this snuffs the oldest

// --- Red portals ---
/** Placed this far in front of the player — a bit beyond a campfire so you walk
 * forward INTO the portal you just opened. */
export const PORTAL_PLACE_DIST = 2.6;
/** Step within this 2D radius of a portal to cross to its destination realm. */
export const PORTAL_RADIUS = 1.5;
/** World-wide cap (counts BOTH ends of each pair); placing past it removes the
 * oldest portal. Portals do not burn down — the point is to return through them. */
export const MAX_PORTALS = 16;

// --- Dropped loot ---
export const DROPPED_LOOT_TTL_S = 600; // player-dropped items despawn after this

// --- Tree chopping / falling trees (doc 13 M2) ---
// Axe swings against a trunk are the wood faucet (doc 05's gather-node design,
// superseded by felling: the FINAL chop brings the whole tree down as a
// dynamic "trunk" body instead of starting a per-tree cooldown).
/** Axe hits to fell a tree; each hit grants wood, the last one topples it. */
export const TREE_CHOPS_TO_FELL = 3;
/** Wood granted per landed chop (inventory overflow drops at the feet). */
export const TREE_WOOD_PER_CHOP = 1;
/** Bonus wood dropped where the felled trunk comes to REST and despawns. */
export const TRUNK_WOOD_BONUS = 2;
/** Seconds a settled (sleeping) trunk lies around before despawning to loot. */
export const TRUNK_SETTLE_TTL_S = 30;

// --- Respawn ---
export const RESPAWN_DELAY_S = 4;

// --- Airdrops ---
export const AIRDROP_INTERVAL_MIN_S = 15 * 60; // game-seconds between drops
export const AIRDROP_INTERVAL_MAX_S = 25 * 60;
export const AIRDROP_FALL_DELAY_S = 30; // announce -> crate lands
export const AIRDROP_TTL_S = 10 * 60; // crate despawns (smoke stops earlier)
export const AIRDROP_SMOKE_S = 5 * 60; // smoke column duration after landing
export const AIRDROP_MIN_TERRAIN_H = 3; // inland only

// --- Weather ---
export const WEATHER_CLEAR_MIN_S = 4 * 60; // clear spell between fronts
export const WEATHER_CLEAR_MAX_S = 9 * 60;
export const WEATHER_RAIN_MIN_S = 2 * 60; // rain duration
export const WEATHER_RAIN_MAX_S = 4 * 60;
export const WEATHER_RAMP_S = 20; // seconds to fade in/out
/** While raining, exposed players cool even during warm hours. Sheltered =
 * inside a building footprint or near a campfire. */
export const RAIN_TEMP_FALL_PER_S = 0.02;

// --- Wildlife ---
export const DEER_COUNT = 10;
export const DEER_HP = 25;
export const DEER_FLEE_RADIUS = 22;
export const DEER_FLEE_SPEED = 8.5; // faster than sprint — you need a gun
export const DEER_WANDER_SPEED = 1.2;
export const DEER_RESPAWN_S = 120;
export const VENISON_PER_DEER_MIN = 2;
export const VENISON_PER_DEER_MAX = 3;
export const DEER_CORPSE_TTL_S = 180;

// --- Fishing (interim mechanic — doc 05 M1; superseded by doc 07 M12) ---
/** Distance ahead (along player yaw) where water is tested for fishing/filling. */
export const WATER_SAMPLE_DIST = 2.5;
/** Chance of catching a fish per cast (0..1). */
export const FISH_CHANCE = 0.45;
/** Cooldown between fishing casts (seconds). */
export const FISHING_COOLDOWN_S = 8;

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
