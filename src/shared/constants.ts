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

// --- Campfire ---
export const CAMPFIRE_BURN_S = 8 * 60;
export const CAMPFIRE_PLACE_DIST = 1.6; // placed this far in front of player
export const MAX_CAMPFIRES = 32; // world-wide; placing past this snuffs the oldest

// --- Dropped loot ---
export const DROPPED_LOOT_TTL_S = 600; // player-dropped items despawn after this

// --- Respawn ---
export const RESPAWN_DELAY_S = 4;
