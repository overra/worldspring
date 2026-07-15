// Horde — the third GameMode (docs/plans/00): cooperative wave defense. The squad
// spawns together at a muster point, fights escalating drip-fed waves of zombies,
// builds one shared score, and the run ends when the whole online squad is down at
// once — then it restarts at wave 1. Endless; the achievement is the high-water
// wave. Feedback is broadcast `notice` messages only (a wave-state HUD + protocol
// message are a deferred follow-up, exactly as arena deferred its round UI).
//
// What makes it a different game is entirely in these hooks. The per-tick sim runs
// the combat channels + attack resolution and the wave FSM before physics, and the
// zombie chase/attack AI + corpse cleanup after it — NONE of survival's world
// (vitals, trees, wildlife, weather, loot, building, portals) ticks, and it never
// runs tickZombieRespawns (survival's ambient respawn — horde owns spawning via
// waves). onWorldReady seeds nothing; the FSM boots in intermission and arms wave 1
// when the first player joins.
//
// Wave/score state lives in this factory's closure — one instance per room, created
// by mode/registry.ts. Transient by design: a DO restart resets the run, which is
// right for an ephemeral co-op match (horde, like arena, persists nothing).
import type { GameMode, PhaseTimer } from "./GameMode";
import type { GameState, ServerPlayer } from "../systems/state";
import {
  HORDE_AMMO_PER_WAVE,
  HORDE_BANDAGE_PER_WAVE,
  HORDE_BASE_COUNT,
  HORDE_BOSS_EVERY,
  HORDE_BOSS_HP_BASE,
  HORDE_BOSS_HP_PER_TIER,
  HORDE_BOSS_SCORE,
  HORDE_COUNT_GROWTH,
  HORDE_DEFEAT_S,
  HORDE_HP_GROWTH,
  HORDE_INTERMISSION_S,
  HORDE_KILL_POINTS,
  HORDE_MAX_CONCURRENT,
  HORDE_MILITARY_MAX_FRAC,
  HORDE_MILITARY_STEP,
  HORDE_PLAYER_COUNT_SCALE,
  HORDE_SPAWN_BATCH_BASE,
  HORDE_SPAWN_INTERVAL_S,
  HORDE_SPAWN_MIN_H,
  HORDE_SPAWN_RING_MAX,
  HORDE_SPAWN_RING_MIN,
  HORDE_START_AMMO_9MM,
  HORDE_START_BANDAGES,
  HORDE_WAVE_CLEAR_BONUS,
  INVENTORY_SLOTS,
  MAX_FOOD,
  MAX_HP,
  MAX_WATER,
  MILITARY_ZOMBIE_HP,
  TEMP_NORMAL,
  ZOMBIE_HP,
} from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import { performAttack } from "../systems/combat";
import { addToInventory, createPlayer, respawnPlayer, sendInventory, tickActiveActions } from "../systems/players";
import { tickCorpses } from "../systems/loot";
import { spawnZombie, tickZombies } from "../systems/zombies";
import { broadcast } from "../systems/state";

/** The three FSM phases: warm-up/between-wave breather, a wave in progress, and
 *  the overrun hold before a run restart. */
type HordePhase = "intermission" | "active" | "defeat";

export function createHordeMode(): GameMode {
  // --- Closure run state (one instance per room; transient — arena's posture) ---
  let phase: HordePhase = "intermission";
  let wave = 0; // startWave → 1
  let teamScore = 0;
  // Absolute game.time the current phase ends. Armed for real in onWorldReady
  // against the (possibly restored) clock — this init is a placeholder that is
  // always overwritten before the first tick. It must NOT be a bare literal like
  // HORDE_INTERMISSION_S: game.time restores to a large value on a DO recycle,
  // and a literal 10 would then read as already-elapsed and drop wave 1 on the
  // squad with no warm-up.
  let nextPhaseAt = 0;
  let waveQuota = 0;
  let waveSpawned = 0; // total units emitted this wave (moves with a spawn)
  let killsCounted = 0; // kill-scoring accumulator, reset each wave
  let milRemaining = 0; // deterministic brute budget, reset each wave
  let spawnTimer = 0; // drip countdown
  let bossId: number | null = null;

  // --- Pure helpers (read the tunables) -------------------------------------
  const onlineCount = (game: GameState): number => {
    let n = 0;
    for (const p of game.players.values()) if (!p.offline) n++;
    return n;
  };
  const aliveCount = (game: GameState): number => {
    let n = 0;
    for (const p of game.players.values()) if (!p.offline && p.alive) n++;
    return n;
  };
  const hpScale = (n: number): number => 1 + HORDE_HP_GROWTH * (n - 1);
  const milFrac = (n: number): number =>
    Math.min(Math.max(HORDE_MILITARY_STEP * (n - 2), 0), HORDE_MILITARY_MAX_FRAC);
  const isBossWave = (n: number): boolean => n % HORDE_BOSS_EVERY === 0;
  const bossHp = (n: number): number =>
    HORDE_BOSS_HP_BASE + HORDE_BOSS_HP_PER_TIER * (Math.floor(n / HORDE_BOSS_EVERY) - 1);
  const batch = (n: number): number => HORDE_SPAWN_BATCH_BASE + Math.floor(n / 4);
  const quota = (n: number, p: number): number =>
    Math.round((HORDE_BASE_COUNT + HORDE_COUNT_GROWTH * (n - 1)) * (0.7 + HORDE_PLAYER_COUNT_SCALE * p));

  // --- Player placement + kit -----------------------------------------------

  /** Centroid of the living, online squad (excluding the joiner). Effect: the
   *  first spawner and a fresh-run revive land at spawnPoints[0]; mid-run joiners
   *  and single revives land ON the living squad — co-op mustering, not arena's
   *  scatter.
   *
   *  A spread squad (e.g. two players either side of a lake) has a centroid that
   *  can fall in WATER, which would place the joiner on the seabed. So the centroid
   *  is only used when it is dry land; otherwise we muster onto a living squadmate's
   *  own tile — they are by definition standing somewhere valid. */
  function musterPoint(game: GameState, joiner: ServerPlayer): { x: number; z: number } {
    let sx = 0;
    let sz = 0;
    let n = 0;
    let anchor: { x: number; z: number } | null = null;
    for (const p of game.players.values()) {
      if (p.offline || !p.alive || p.id === joiner.id) continue;
      sx += p.core.x;
      sz += p.core.z;
      n++;
      anchor ??= { x: p.core.x, z: p.core.z };
    }
    if (n === 0 || anchor === null) return game.world.spawnPoints[0];
    const cx = sx / n;
    const cz = sz / n;
    if (game.world.heightAt(cx, cz) >= HORDE_SPAWN_MIN_H) return { x: cx, z: cz };
    return anchor; // centroid landed in water — muster on a squadmate instead
  }

  /** Place a fighter at the muster point with full health and the co-op loadout,
   *  overwriting whatever spawn state a reused players.ts helper set. */
  function equip(game: GameState, player: ServerPlayer): void {
    const { x, z } = musterPoint(game, player);
    player.core = {
      x,
      y: game.world.groundHeight(x, z),
      z,
      vy: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
    };
    player.vitals = { hp: MAX_HP, food: MAX_FOOD, water: MAX_WATER, temp: TEMP_NORMAL };
    const inv: (ItemStack | null)[] = Array.from({ length: INVENTORY_SLOTS }, () => null);
    // A fresh pistol carries no `mag` field → reads as a full magazine. Order fills
    // slot0 pistol, slot1 axe, slots 2-3 ammo (two 30-stacks), slot4 bandages.
    addToInventory(inv, "pistol", 1);
    addToInventory(inv, "axe", 1);
    addToInventory(inv, "ammo_9mm", HORDE_START_AMMO_9MM);
    addToInventory(inv, "bandage", HORDE_START_BANDAGES);
    player.inventory = inv;
    player.worn = { body: null, back: null };
    player.selectedSlot = 0;
    sendInventory(game, player);
  }

  /** Revive + re-kit a player: reuse survival's transient-state reset then override
   *  the spawn/loadout to horde's (equip overwrites the keep-inventory result, so
   *  pvp.fullLoot:false is harmless — the arena precedent). */
  function reset(game: GameState, player: ServerPlayer): void {
    respawnPlayer(game, player);
    equip(game, player);
  }

  // --- Wave FSM -------------------------------------------------------------

  /** A random living, online player to anchor a spawn ring on. Non-null whenever
   *  aliveCount > 0 (guaranteed while dripping — the game-over check gates it). */
  function pickAnchor(game: GameState): ServerPlayer | null {
    const alive: ServerPlayer[] = [];
    for (const p of game.players.values()) if (!p.offline && p.alive) alive.push(p);
    if (alive.length === 0) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  /** A dry-land ring point [RING_MIN, RING_MAX] around the anchor; falls back to
   *  the anchor's own tile if no ring point lands on land within the attempts. */
  function pickRing(game: GameState, anchor: ServerPlayer): { x: number; z: number } {
    for (let i = 0; i < 16; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = HORDE_SPAWN_RING_MIN + Math.random() * (HORDE_SPAWN_RING_MAX - HORDE_SPAWN_RING_MIN);
      const x = anchor.core.x + Math.cos(ang) * r;
      const z = anchor.core.z + Math.sin(ang) * r;
      if (game.world.heightAt(x, z) >= HORDE_SPAWN_MIN_H) return { x, z };
    }
    return { x: anchor.core.x, z: anchor.core.z };
  }

  /** Emit one drip batch: up to batch(wave) units under the concurrent cap, each
   *  ring-placed on a random alive anchor, with the wave's deterministic brute mix
   *  and (on a boss wave) the boss as the wave's FINAL unit. */
  function spawnBatch(game: GameState): void {
    const room = Math.min(
      batch(wave),
      waveQuota - waveSpawned,
      HORDE_MAX_CONCURRENT - game.zombies.size,
    );
    for (let i = 0; i < room; i++) {
      const anchor = pickAnchor(game);
      if (anchor === null) return; // no alive anchor — defensive; active guarantees ≥1
      const pos = pickRing(game, anchor);
      // Boss is the wave's final unit → the tension crests to it.
      const isBossUnit = isBossWave(wave) && waveSpawned === waveQuota - 1;
      if (isBossUnit) {
        const z = spawnZombie(game, pos.x, pos.z, true);
        z.hp = bossHp(wave);
        bossId = z.id;
        broadcast(game, { t: "notice", msg: "A BRUTE emerges!" });
      } else {
        const mil = milRemaining > 0;
        if (mil) milRemaining--;
        const z = spawnZombie(game, pos.x, pos.z, mil);
        z.hp = Math.round((mil ? MILITARY_ZOMBIE_HP : ZOMBIE_HP) * hpScale(wave));
      }
      waveSpawned++;
    }
  }

  function startWave(game: GameState): void {
    wave++;
    const p = onlineCount(game);
    waveQuota = quota(wave, p);
    waveSpawned = 0;
    killsCounted = 0;
    spawnTimer = 0;
    bossId = null;
    milRemaining = Math.floor(waveQuota * milFrac(wave));
    phase = "active";
    const tail = isBossWave(wave) ? " — a Brute is coming." : "";
    broadcast(game, { t: "notice", msg: `Wave ${wave} — hold the line!${tail}` });
  }

  function clearWave(game: GameState): void {
    teamScore += HORDE_WAVE_CLEAR_BONUS * wave;
    // Revive the fallen at the breather (regroup during the lull); survivors keep
    // their inventory and get resupplied — NOT auto-healed (the bandage economy
    // stays load-bearing).
    for (const player of game.players.values()) {
      if (player.offline) continue;
      if (!player.alive) {
        reset(game, player);
      } else {
        addToInventory(player.inventory, "ammo_9mm", HORDE_AMMO_PER_WAVE);
        addToInventory(player.inventory, "bandage", HORDE_BANDAGE_PER_WAVE);
        sendInventory(game, player);
      }
    }
    nextPhaseAt = game.time + HORDE_INTERMISSION_S;
    phase = "intermission";
    broadcast(game, {
      t: "notice",
      msg: `Wave ${wave} cleared!  +${HORDE_WAVE_CLEAR_BONUS * wave}   Score ${teamScore}   ·   Wave ${wave + 1} in ${HORDE_INTERMISSION_S}s`,
    });
  }

  function restartRun(game: GameState): void {
    game.zombies.clear();
    game.zombieRespawns.length = 0;
    wave = 0;
    teamScore = 0;
    waveSpawned = 0;
    killsCounted = 0;
    bossId = null;
    for (const player of game.players.values()) {
      if (!player.offline) reset(game, player);
    }
    nextPhaseAt = game.time + HORDE_INTERMISSION_S;
    phase = "intermission";
    broadcast(game, { t: "notice", msg: "New run — hold the line!" });
  }

  /** The whole gameplay loop, run in simBeforePhysics after the attack loop so it
   *  reads this tick's settled zombies.size. */
  function tickWave(game: GameState, dt: number): void {
    // killZombie (combat, earlier this tick) pushes an ambient-respawn entry; horde
    // never runs tickZombieRespawns, so drain the queue every tick or it grows
    // unbounded. Unconditional — must happen in every phase.
    game.zombieRespawns.length = 0;

    // 0-player freeze: an empty room neither drains a wave, spawns, scores, nor
    // loses; a rejoin resumes in place.
    if (onlineCount(game) === 0) {
      if (phase === "intermission") nextPhaseAt = game.time + HORDE_INTERMISSION_S;
      else if (phase === "defeat") nextPhaseAt = game.time + HORDE_DEFEAT_S;
      return;
    }

    if (phase === "intermission") {
      if (game.time < nextPhaseAt) return;
      startWave(game); // → active; falls through to run the wave's first drip this tick
    } else if (phase === "defeat") {
      if (game.time >= nextPhaseAt) restartRun(game);
      return;
    }

    if (phase !== "active") return;

    // 1. Score kills. dead = waveSpawned − zombies.size is invariant to spawning
    //    (both move together on a drip), so it only rises on a kill.
    const dead = waveSpawned - game.zombies.size;
    const award = dead - killsCounted;
    if (award > 0) {
      teamScore += award * HORDE_KILL_POINTS;
      killsCounted = dead;
    }
    // 2. Boss down.
    if (bossId !== null && !game.zombies.has(bossId)) {
      teamScore += HORDE_BOSS_SCORE;
      broadcast(game, { t: "notice", msg: `Brute down!  +${HORDE_BOSS_SCORE}` });
      bossId = null;
    }
    // 3. Game over — BEFORE the clear check: a simultaneous last-death + wave-empty
    //    is a loss, not a win.
    if (aliveCount(game) === 0) {
      broadcast(game, {
        t: "notice",
        msg: `Overrun on wave ${wave} — final score ${teamScore}. Restarting in ${HORDE_DEFEAT_S}s`,
      });
      nextPhaseAt = game.time + HORDE_DEFEAT_S;
      phase = "defeat";
      return;
    }
    // 4. Cleared.
    if (waveSpawned >= waveQuota && game.zombies.size === 0) {
      clearWave(game);
      return;
    }
    // 5. Drip.
    spawnTimer -= dt;
    if (waveSpawned < waveQuota && spawnTimer <= 0 && game.zombies.size < HORDE_MAX_CONCURRENT) {
      spawnBatch(game);
      spawnTimer = HORDE_SPAWN_INTERVAL_S;
    }
  }

  return {
    id: "horde",

    simBeforePhysics(game: GameState, dt: number, phaseTimer: PhaseTimer): void {
      // Combat-relevant gameplay first — reload/use channels then attack resolution
      // (the same order survival + arena run them in), then the wave FSM, which
      // reads the settled zombies.size from the attacks this same tick.
      tickActiveActions(game, dt);
      for (const player of game.players.values()) {
        if (player.wantsAttack) {
          player.wantsAttack = false;
          const aimTime = player.wantsAttackAt ?? undefined;
          player.wantsAttackAt = null;
          if (player.alive) performAttack(game, player, aimTime);
        }
      }
      phaseTimer("actions");

      tickWave(game, dt);
      phaseTimer("horde");
    },

    simAfterPhysics(game: GameState, dt: number, phaseTimer: PhaseTimer): void {
      // Zombie chase/attack AI + separation, then corpse cleanup (dozens of zombie
      // corpses per wave, plus the empty player husks a death drops). NOT
      // tickZombieRespawns — the wave FSM owns spawning.
      tickZombies(game, dt);
      phaseTimer("zombies");
      tickCorpses(game, dt);
      phaseTimer("world");
    },

    // Nothing to seed — the terrain is the engine's. But the warm-up clock must
    // be armed against the clock we actually booted with: onWorldReady runs after
    // loadWorld has restored game.time (GameRoom ensureGame), so a fresh boot arms
    // 0 + 10 and a recycle arms T + 10 — either way a real intermission before
    // wave 1, instead of a boot-zero literal that a restart would skip past.
    onWorldReady(game: GameState): void {
      nextPhaseAt = game.time + HORDE_INTERMISSION_S;
    },

    createPlayer(game: GameState, id: string, name: string, tokenHash: string): ServerPlayer {
      const player = createPlayer(game, id, name, tokenHash);
      equip(game, player);
      return player;
    },

    respawnPlayer(game: GameState, player: ServerPlayer): void {
      reset(game, player);
    },

    // The client-driven respawn (GameRoom's respawn handler) is honored only during
    // the breather (0s); during a wave OR the overrun hold Infinity refuses it (the
    // gate is `game.time - diedAt >= Infinity`, always false) — being down is a real
    // cost, and the fallen return at the next wave clear.
    respawnDelayS(): number {
      return phase === "intermission" ? 0 : Infinity;
    },

    // PvP is off, so combat never reports a zombie kill through this hook — the seam
    // guarantees it. Scoring is the shared teamScore, driven by the wave FSM.
    onKill(): void {},
  };
}
