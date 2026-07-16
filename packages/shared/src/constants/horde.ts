// Horde mode tunables (docs/plans/00 — the third GameMode). Kept physically apart
// from ./survival.ts and ./arena.ts because they are a DIFFERENT game's numbers: a
// cooperative wave-defense, not the survival island or the frag deathmatch.
// Server-side today (the horde mode reads them); exposed through the shared
// constants barrel so a future wave-state HUD can read the curve too.
//
// Derived curve (P=1, from the formulae below): quota per wave (W1–8)
// 6·10·14·18·22·26·30·34; hpScale 1.00→1.84; milFrac 0·0·.08·.16·.24·.32·.40·.40;
// normal-zombie HP 60→110; brute HP ≈149 @W3 → 221 @W8; boss 280 @W5, 340 @W10;
// spawn batch 3 (W1–3), 4 (W4–7), 5 (W8–11).

// --- Phase timers (game-seconds) ---
/** Warm-up before wave 1 AND the breather between waves. Drains only while ≥1
 *  player is online (an empty room freezes the clock). */
export const HORDE_INTERMISSION_S = 10;
/** Overrun hold after a squad wipe before the run restarts at wave 1. */
export const HORDE_DEFEAT_S = 12;

// --- Wave size ---
// quota(N,P) = round((BASE + GROWTH*(N-1)) * (0.7 + PLAYER_SCALE*P))
/** Wave-1 quota before the player-count scale. */
export const HORDE_BASE_COUNT = 6;
/** Added to the quota each wave (linear escalation). */
export const HORDE_COUNT_GROWTH = 4;
/** Player-count scale: quota *= (0.7 + 0.3 * onlineCountAtWaveStart). */
export const HORDE_PLAYER_COUNT_SCALE = 0.3;
/** Alive-zombie ceiling — MUST stay < ZOMBIE_MAX (60), the client render pool.
 *  Total wave size can exceed this; the drip delivers it under this cap. */
export const HORDE_MAX_CONCURRENT = 56;

// --- Drip (sustained arrival, not a single burst) ---
// batch(N) = SPAWN_BATCH_BASE + floor(N/4)
/** Seconds between drip batches. */
export const HORDE_SPAWN_INTERVAL_S = 2.5;
/** Base units per drip batch (W1-3:3, W4-7:4, W8-11:5, …). */
export const HORDE_SPAWN_BATCH_BASE = 3;

// --- Spawn placement — a ring around a random ALIVE player ---
/** Ring inner radius. Both radii are < ZOMBIE_AGGRO_RADIUS (28), so the anchor
 *  player is always in aggro range → the wave descends and is clearable without
 *  the squad hunting stragglers. */
export const HORDE_SPAWN_RING_MIN = 16;
/** Ring outer radius. */
export const HORDE_SPAWN_RING_MAX = 26;
/** Dry-land floor for a ring point (mirrors zombies.ts SPAWN_MIN_TERRAIN_H). */
export const HORDE_SPAWN_MIN_H = 0.3;

// --- Per-unit lethality ---
/** hpScale(N) = 1 + HP_GROWTH*(N-1) — multiplies each spawned zombie's base hp. */
export const HORDE_HP_GROWTH = 0.12;
/** First wave that fields military brutes (milFrac uses N-2 so W1/W2 are 0). */
export const HORDE_MILITARY_START_WAVE = 3;
/** milFrac(N) = clamp(MILITARY_STEP*(N-2), 0, MILITARY_MAX_FRAC). */
export const HORDE_MILITARY_STEP = 0.08;
/** Ceiling on the military fraction of a wave. */
export const HORDE_MILITARY_MAX_FRAC = 0.4;

// --- Boss — every 5th wave (W5, W10, …); the FINAL drip unit of that wave ---
/** Boss cadence in waves. */
export const HORDE_BOSS_EVERY = 5;
/** bossHp(N) = BOSS_HP_BASE + BOSS_HP_PER_TIER*(floor(N/5)-1) → W5 280, W10 340. */
export const HORDE_BOSS_HP_BASE = 280;
export const HORDE_BOSS_HP_PER_TIER = 60;

// --- Scoring (a single shared team score) ---
/** Flat points per zombie down, any variant. */
export const HORDE_KILL_POINTS = 10;
/** Bonus on top of the flat kill when the boss goes down. */
export const HORDE_BOSS_SCORE = 200;
/** Wave-clear bonus, multiplied by the wave number. */
export const HORDE_WAVE_CLEAR_BONUS = 50;

// --- Loadout + co-op economy ---
/** 9mm the squad spawns with (two full 30-round stacks; the ARENA_AMMO precedent). */
export const HORDE_START_AMMO_9MM = 60;
/** Bandages the squad spawns with. */
export const HORDE_START_BANDAGES = 3;
/** 9mm added to each SURVIVING player on wave clear (the fallen return kitted). */
export const HORDE_AMMO_PER_WAVE = 24;
/** Bandages added to each SURVIVING player on wave clear. */
export const HORDE_BANDAGE_PER_WAVE = 1;
