// Arena mode tunables (docs/plans/00 — the first non-survival GameMode). Kept
// physically apart from ./survival.ts because they are a DIFFERENT game's
// numbers: a round-based frag deathmatch, not the survival island. Server-side
// today (systems + the arena mode read them); exposed through the shared
// constants barrel so the round/scoreboard HUD can read the frag limit too.

/** Kills that end a round — first player to reach it wins. */
export const ARENA_FRAG_LIMIT = 15;
/** Game-seconds of intermission between a round win and the next round start. */
export const ARENA_ROUND_INTERMISSION_S = 10;
/** Game-seconds a dead player waits before the mode auto-respawns them (arena
 *  never sits on a death screen — the fight goes on). Mirrors the operator-tuned
 *  config.session.respawnDelayS default so the arena preset can override it. */
export const ARENA_RESPAWN_DELAY_S = 3;
