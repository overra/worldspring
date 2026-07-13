// Single source of truth for all gameplay tuning. Client and server import these;
// changing a value here changes both sides consistently.

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
/** Bonus wood dropped where a trunk is broken (axe) or cap-evicted. */
export const TRUNK_WOOD_BONUS = 2;
/** Axe hits to break a resting felled trunk into its wood bonus. Trunks are
 * PERSISTENT (no despawn timer): they lie where they fell until a player
 * breaks them or bodyCap eviction reaps the oldest settled body. */
export const TRUNK_HITS_TO_BREAK = 3;
/** Axe hits to clear a planted-tree stump (frees its planted-cap slot). */
export const STUMP_HITS_TO_CLEAR = 2;
/** Wood salvaged from clearing a stump. */
export const STUMP_WOOD = 1;
/** Matching seed dropped as loose loot when a tree is felled. */
export const TREE_FELL_SEED_CHANCE = 0.4;
/** Budget for loose pine cones + acorns across the world. */
export const TREE_SEED_LOOSE_CAP = 96;
/** Mature trees near a player get one budgeted seed-roll on this cadence. */
export const TREE_SEED_DROP_INTERVAL_S = 180;
/** Planting happens this far in front of the player. */
export const TREE_PLANT_DIST = 2.2;
/** Empty horizontal radius required around a new sapling. */
export const TREE_PLANT_CLEARANCE = 1.4;
/** Hard cap protects persistence, render instances and collision queries. */
export const PLANTED_TREE_CAP = 512;
// Growth-stage durations (TREE_YOUNG_AT_MS / TREE_MATURE_AT_MS) live in
// trees.ts, co-located with treeStageAt: keeping that module free of relative
// VALUE imports lets it (and persistence.ts through it) load under Node's
// --experimental-strip-types in the .mjs probes.

// --- Base building (doc 06) ---
// Geometry details (skirts, door gap, sill/head) live in structures.ts with
// pieceAabbs; these are the gameplay tunables per house rules.
/** Global build grid pitch, meters. */
export const BUILD_CELL = 3;
/** Max distance from the player to a piece's center for place/demolish/door. */
export const BUILD_RANGE = 6;
/** Wall-class piece height above floorY — above the jump apex (~0.85 m). */
export const BUILD_WALL_HEIGHT = 2.6;
export const BUILD_WALL_THICKNESS = 0.25;
/** Max corner-height spread for a foundation cell. */
export const BUILD_FOUNDATION_MAX_SLOPE = 1.1;
/** Every foundation corner must sit above this terrain height (no sea bases). */
export const BUILD_MIN_TERRAIN_H = 0.5;
export const NO_BUILD_TOWN_MARGIN = 12;
export const NO_BUILD_MILITARY_MARGIN = 16;
export const NO_BUILD_BUILDING_MARGIN = 6;
export const NO_BUILD_SPAWN_RADIUS = 24;
/** Hard world-wide piece cap — the only limit a Sybil can't mint around. */
export const WORLD_PIECE_CAP = 3000;
export const BUILD_DENSITY_RADIUS = 12;
/** Max pieces within BUILD_DENSITY_RADIUS of a new piece's center. */
export const BUILD_DENSITY_CAP = 120;
/** Storage crate slot count (doc 06 M6) — fixed-length contents array; slot
 * indices are stable identifiers (removal nulls, never compacts). */
export const CRATE_SLOTS = 12;
/** Bare-fist structure damage (doc 06 M7) — the FIST_DMG precedent: the
 * fallback when the equipped ItemDef has no structDmg. Guarantees nothing is
 * inescapable (a naked trapped player can punch through a wood wall). */
export const FIST_STRUCT_DMG = 1;
/** Offline shield grace: seconds after the owner's LAST game.players entry
 * left before offlineRaidMult kicks in — combat-logging buys nothing inside
 * an active raid window (doc 06 §Offline protection). */
export const RAID_OFFLINE_GRACE_S = 300;
/** Per-identity tryCode cooldown — UX anti-mash ONLY, never a security
 * control (identities are free to mint; see the per-door backoff below). */
export const DOOR_CODE_TRY_COOLDOWN_S = 1;
/** Per-DOOR (never per-identity) brute-force budget: after this many failed
 * tryCodes on one door FROM ANY IDENTITY COMBINED, the door locks out. */
export const DOOR_CODE_FAILS_PER_LOCKOUT = 5;
/** First lockout duration; doubles per subsequent lockout. */
export const DOOR_CODE_BACKOFF_BASE_S = 30;
/** Backoff ceiling (1h) — ~weeks of continuous hammering to span 10^4 codes. */
export const DOOR_CODE_BACKOFF_MAX_S = 3600;
/** Decay sweep cadence (game-seconds): every 5 game-minutes plus once at boot
 * (the boot sweep covers idle-server gaps). Decay itself is WALL-clock
 * (characters.updated_at vs decayHours). */
export const DECAY_SWEEP_INTERVAL_S = 300;

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

// --- Physics props: barrels (doc 13 M3) ---
// Barrels are a FIXED-size dynamic BodyKind ("barrel") — a spawnable loot prop
// you shove and eventually break. Half-extents drive both the server collider
// and the client mesh; PhysicsSystem.ts keeps a LOCAL mirror of these two (the
// CRATE_HALF↔CRATE_SIZE precedent — it stays value-import-free for the
// strip-types replay harness), so the two constants below are the shared truth
// the mirror must equal.
/** Barrel collider half-extent on X/Z (a ~0.6 m-wide upright drum). */
export const BARREL_HALF_XZ = 0.3;
/** Barrel collider half-extent on Y (a ~1.0 m-tall drum). */
export const BARREL_HALF_Y = 0.5;
/** Melee swings on a barrel before it breaks open (each swing also shoves it —
 *  the doc 13 M3 marquee interaction). Transient like tree chops. */
export const BARREL_HITS_TO_BREAK = 3;

// --- Vehicles: a rugged ground buggy (doc 13 M4) ---
// A single fixed-size "vehicle" dynamic BodyKind: one driver + one passenger,
// server-authoritative driving (no client prediction), fuel-gated, damaged by
// hard collisions, rammed into zombies/players. Half-extents drive the server
// hull collider AND the client mesh; PhysicsSystem.ts keeps a LOCAL mirror of
// them (the BARREL_HALF precedent — it stays value-import-free for the strip-
// types replay harness), so the three constants below are the shared truth the
// mirror must equal. Local FORWARD is -Z (matching the player yaw convention,
// yaw 0 faces -Z), so the hull is longer on Z than wide on X.
/** Hull collider half-extent on X (half-width). */
export const VEHICLE_HALF_X = 0.75;
/** Hull collider half-extent on Y (half-height). */
export const VEHICLE_HALF_Y = 0.55;
/** Hull collider half-extent on Z (half-length; local -Z is forward). */
export const VEHICLE_HALF_Z = 1.25;
/** Seats: index 0 = driver, index 1 = passenger. */
export const VEHICLE_SEATS = 2;
/** Deterministic worldgen-derived spawn cap per island (well under
 *  PHYSICS_BODY_CAP; vehicles are cap-EXEMPT — they never evict and are never
 *  evicted, being the endgame retention feature — so this is the real ceiling). */
export const MAX_VEHICLES = 3;
/** Hull hit points; a hard crash chips these, hp<=0 wrecks the vehicle. */
export const VEHICLE_HP_MAX = 240;
/** Fuel tank capacity (abstract units — a full tank). */
export const VEHICLE_FUEL_MAX = 100;
/** Fuel burned per second at full throttle (≈ 60 s of hard driving on empty). */
export const VEHICLE_FUEL_BURN_PER_S = 1.6;
/** Fuel units one jerry can restores on a refuel interaction. */
export const FUEL_PER_CAN = 40;
/** 2D distance within which a player may board / refuel a vehicle. */
export const VEHICLE_ENTER_RANGE = 3.2;
/** Below this speed (m/s) a moving vehicle deals no ram damage. */
export const VEHICLE_RAM_MIN_SPEED = 4;
/** 2D reach from the hull center for a ram hit (hull half-length + a little). */
export const VEHICLE_RAM_RADIUS = 2.4;
/** Ram damage per (m/s over the min) landed on a struck entity. */
export const VEHICLE_RAM_DMG_PER_SPEED = 7;
/** Ram damage ceiling per hit (a full-speed T-bone still isn't instakill on mil). */
export const VEHICLE_RAM_MAX_DMG = 140;
/** Minimum seconds between a vehicle's ram hits (bounds the damage rate so a
 *  slow grind can't machine-gun a target every tick). */
export const VEHICLE_RAM_COOLDOWN_S = 0.5;
/** Forward-speed drop (m/s) in a single tick above which it counts as a CRASH
 *  (a wall stops the hull far faster than the bounded brake decel ever can). */
export const VEHICLE_CRASH_MIN_DROP = 3.5;
/** Hull damage per (m/s of crash drop over the min). */
export const VEHICLE_CRASH_DMG_PER_MS = 9;
/** Lateral (sideways) speed (m/s) at/above which a forward-speed drop is read as
 *  a DRIFT (hard cornering), NOT an impact — so donuts don't self-wreck the hull.
 *  A real head-on wall crash has the velocity aligned with the facing (lateral
 *  ~0); a drift has the velocity swung sideways relative to it (lateral high).
 *  Measured empirically: head-on/angled crashes land ≤0.5 m/s lateral, a
 *  full-steer donut at top speed swings to ~5.6 m/s — 2.5 cleanly separates. */
export const VEHICLE_CRASH_MAX_LATERAL = 2.5;
/** Seconds after a rider leaves a seat during which that hull cannot ram them —
 *  so bailing out of a moving car doesn't roadkill you with your own vehicle
 *  (the exit spot can sit inside VEHICLE_RAM_RADIUS as the hull coasts past). */
export const VEHICLE_EXIT_RAM_GRACE_S = 1.5;
/** Seconds without a fresh `drive` message after which the driver's stored input
 *  goes IDLE — a stalled/backgrounded/dirty-disconnected client can't keep a
 *  driverless-in-practice hull self-driving on stale throttle. The hull then
 *  coasts to a stop instead of ghost-driving until the tank empties. */
export const VEHICLE_INPUT_STALE_S = 0.5;

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
