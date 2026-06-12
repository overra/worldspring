# ServerConfig & Gameplay Presets — "No Zombies On My Server" as a First-Class Choice

Status: design. Companion docs: 01 (deploy-to-your-account — sets the config var),
02 (server directory — renders the badge summary), 03 (`/api/server-info` — carries the
badge summary), 06 (base building — wires the `building` group), 07 (world expansion —
wires `world.sizeTier`/`world.waterFeatures` and the wildlife species densities).
Research grounding: `docs/plans/research/codebase-sim.md`, `docs/plans/research/codebase-server.md`.

## Summary

One new shared file, `src/shared/config.ts`, defines `ServerConfig` — a fully-typed,
manually-validated (zero new deps) config object covering world identity, threats, loot
economy, survival harshness, PvP rules, time, wildlife, building (reserved for doc 06)
and session rules. Constants in `src/shared/constants.ts` stay exactly as they are and
become the DEFAULTS; config values are multipliers and toggles applied at each system's
point of use, so the diff in every system is a handful of lines. The config is chosen at
deploy time via a `GAME_CONFIG` var on the worker (a preset name, or `{preset, overrides}`),
resolved once in the GameRoom constructor, persisted to SQLite meta for change detection,
and sent to every client in the existing `welcome` message — the only worldgen-config
channel that exists (`codebase-sim.md` §3.1); the client re-clamps it on receipt, so a
hostile community server cannot drive client-side allocation sizes or divisors. Worldgen-
affecting fields (seed, size tier, future water features) form a canonical *world
fingerprint* that extends the existing seed-mismatch wipe in `initSchema` — and the wipe
**fails closed**: an absent or unparseable config can never destroy a non-default world
(§4), and every sanctioned wipe records a point-in-time-recovery bookmark first.
Every other field is live-safe across deploys.
Six named presets ship in a `PRESETS` registry: **deadcoast** (the default island),
**driftwood** (peaceful PvE scavenge), **ironcoast** (hardcore), **warpath** (PvP war
server), **homestead** (builder sandbox), **nightfall** (permanent night horror). Admin
v1 is three endpoints, token-gated **in the Worker** so unauthenticated probes never wake
or bill the DO: read the resolved config, live-set a four-field whitelist, and restore
the pre-wipe PITR bookmark.
`/api/server-info` badges ride doc 03's endpoint design (DO cheap-read behind a 15s
Worker micro-cache) via the shared `summarizeRules` derivation (§6). Zombies disabled degrades gracefully on the client today
(verified against `Zombies.tsx`); we additionally skip mounting the renderer to save 60
pooled rigs.

## Goals / Non-goals

**Goals**

- A community server operator picks a personality at deploy time with one var; "no
  zombies" / "no PvP" / "always night" are config, not forks.
- Every config field maps to a real, verified constant or system. No speculative knobs.
- Determinism preserved: worldgen-affecting config reaches client and server through one
  shared pure function, and changing it trips the sanctioned wipe path.
- Constants stay the single source of defaults; systems keep importing them. Config
  multiplies/overrides at the point of use. Small diffs, reviewable per-system.
- Mid-world deploy safety: every field classified live vs wipe, enforced by code — and
  WIPE-class enforcement fails closed: questionable config boots the old world loudly
  instead of wiping it.

**Non-goals**

- A full admin panel / web UI. V1 is `curl` with a bearer token.
- Movement/combat-feel tuning (walk/sprint speed, melee range, lag-comp windows).
  `stepPlayer` is shared prediction code (`movement.ts:1-2`); a server-side multiplier
  that isn't also applied in the client's prediction desyncs every step. It *could* ride
  the welcome message like everything else, but it triples the testing surface for a
  knob nobody asked for. Deferred until someone does.
- Per-item loot table editing. Tier-level multipliers only; custom tables are a future
  `overrides.loot.tables` extension.
- Hot-reloading the full config without a DO restart (admin whitelist excepted).
- A `hostileWildlife` toggle. The only wildlife is passive deer (`wildlife.ts:1-6`);
  shipping a toggle for a system that doesn't exist is a lie in the schema. The
  `threats` group is where it lands when predators exist.

## Current state

What exists today, verified in this worktree:

- **Every tunable is a compile-time constant** in `src/shared/constants.ts` (1-181),
  imported directly by server systems and, for a subset, by the client. There is no
  config object, no env vars, no secrets — `Env` contains exactly the `GAME` DO binding
  (`worker-configuration.d.ts`, `wrangler.jsonc:10-16`).
- **World identity is one number**: `createWorld(seed)` (`world.ts:342`) takes only a
  seed; `WORLD_SIZE`, `TOWN_COUNT`, `CABIN_COUNT`, `TREE_COUNT`, `ROCK_COUNT` are
  module-scope imports consumed inside it (`world.ts:373,486,514,646`). The server calls
  it with `WORLD_SEED` in `ensureGame()` (`GameRoom.ts:354`); the client calls it with
  `msg.seed` from `welcome` (`connection.ts:260`). The welcome message
  (`protocol.ts:194-206`, built at `GameRoom.ts:507-525`) is the only worldgen-config
  transport (`codebase-sim.md` §3.1).
- **Persistence guards world identity**: `initSchema` wipes `characters` + `world_state`
  (keeps `leaderboard`) when meta `schema_version` or `world_seed` mismatch
  (`persistence.ts:107-117`, `SCHEMA_VERSION = 2` at `persistence.ts:34`).
- **Systems that would consume config**, with the exact lines that read constants today:
  - Zombies: spawn counts (`zombies.ts:96-117`), damage applied at `zombies.ts:192`,
    chase speeds at `zombies.ts:196`, respawn cap at `zombies.ts:334`. Never persisted —
    fresh every boot (`GameRoom.ts:359-361`).
  - Survival: food/water decay at `survival.ts:132-133`, temperature falls at
    `survival.ts:144-150`, regen at `survival.ts:163-165`, warm-hours check via
    `gameHours(state.time, DAY_DURATION_S, START_HOUR)` at `survival.ts:122`.
  - Combat: player-vs-player target loops at `combat.ts:239-254` (melee) and
    `combat.ts:377-396` (pellets); PvP damage applied at `combat.ts:279` and
    `combat.ts:429`.
  - Loot: stocking at `loot.ts:65-67`, respawn timers at `loot.ts:70-75`, tier roll at
    `loot.ts:45-47`; tiers assigned at worldgen (`world.ts:499`) but only *consumed*
    server-side at roll time.
  - Airdrops: scheduling at `airdrops.ts:56-62`.
  - Wildlife: `DEER_COUNT` at `wildlife.ts:81-86`.
  - Death/inventory: corpse takes the whole inventory (`loot.ts:111-130`), respawn
    wipes it (`players.ts:188`) — i.e. full-loot is currently hardcoded ON.
  - Session: `MAX_PLAYERS` at `GameRoom.ts:201` and `GameRoom.ts:470`;
    `RESPAWN_DELAY_S` at `GameRoom.ts:296`; `LOGOUT_LINGER_S` at `GameRoom.ts:645`.
- **Client constant consumers that config touches**: day/clock via
  `gameHours(…, DAY_DURATION_S, START_HOUR)` at `connection.ts:275,307` and
  `interpolation.ts:38,85` (which sets `clientWorld.timeOfDay`, the input to
  `SkyAndLighting.tsx`); leaderboard day display divides by `DAY_DURATION_S`
  (`DeathScreen.tsx:13`, `MainMenu.tsx:76`); the zombie render pool is sized
  `ZOMBIE_MAX` at mount (`Zombies.tsx:61`) and the deer pool `DEER_COUNT + 4` at module
  scope (`Animals.tsx:18`).
- **Graceful degradation already exists**: `Zombies.tsx` is a pool driven entirely by
  `clientWorld.zombies` from snapshots — with zero zombies the per-frame loop iterates
  nothing, all rigs stay `visible = false` (`Zombies.tsx:79-132`). A zombie-free server
  renders correctly with **zero** client changes; the only waste is 60 rigs allocated in
  `createPool()` (`Zombies.tsx:57-69`). `Animals.tsx` follows the same pattern.
- **Tick state**: `GameState` (`state.ts:221-254`) flows into every system function —
  the natural carrier for a `config` field. `createGameState(world)` at `state.ts:256`.
- **No wire version field exists** (`codebase-sim.md` §5.3); additive optional fields on
  `welcome` are the established safe evolution. `PROTOCOL_VERSION` is doc 03's milestone;
  this design only *requires* the additive field.

## Design

### 1. The schema — `src/shared/config.ts` (new file)

```ts
// src/shared/config.ts — ServerConfig schema, presets, validation, derivations.
// Shared: the server resolves it from env; the client receives it in `welcome`.
// House rules: strict TS, named exports, no deps. Constants in constants.ts
// are the DEFAULTS; config multiplies/overrides at each system's point of use.

import type { LootTier } from "./items";

export type WorldSizeTier = "standard" | "large" | "huge"; // 800/1,600/3,200 m — value set owned by doc 07 §1/§3
export type WipeSchedule = "never" | "weekly" | "biweekly" | "monthly";

export interface WorldConfig {
  /** Worldgen seed. WIPE-class. Default WORLD_SEED (1337). */
  seed: number;
  /** WIPE-class. Only "standard" is accepted until milestone M6 lands. */
  sizeTier: WorldSizeTier;
  /** WIPE-class. Reserved: forced to `false` until doc 07 wires it — the live
   * world has no fresh water, and a `true` placeholder would bake `water:1`
   * into stored fingerprints of worlds that never had water (doc 07 §1). */
  waterFeatures: boolean;
}

export interface ThreatsConfig {
  /** Master switch: false = no zombies spawn, tick, or respawn. */
  zombies: boolean;
  /** Multiplies ZOMBIE_MAX, ZOMBIES_PER_TOWN, ZOMBIE_ROAMERS, MILITARY_ZOMBIES. */
  zombieDensity: number;     // 0..2
  /** Multiplies ZOMBIE_DMG / MILITARY_ZOMBIE_DMG. */
  zombieDamage: number;      // 0..3
  /** Multiplies ZOMBIE_CHASE_SPEED / MILITARY_ZOMBIE_SPEED (wander unscaled). */
  zombieSpeed: number;       // 0.5..1.3 — 1.3 ≈ 7.0 m/s, just over sprint 6.8
  /** false = no military garrison AND military loot spawns roll the inland
   * table. The compound geometry always generates (worldgen untouched). */
  militaryZone: boolean;
}

export interface LootConfig {
  /** <1: per-spawn stocking probability. >1: multiplies rolled stack counts.
   * Composes with tierDensity (effective = density * tierDensity[tier]). */
  density: number;           // 0.25..3
  tierDensity: Record<LootTier, number>; // each 0.25..3
  /** Divides LOOT_RESPAWN_MIN_S/MAX_S (2 = twice as fast). */
  respawnRate: number;       // 0.25..4
  /** Airdrop frequency multiplier; divides the interval. 0 = no airdrops. */
  airdrops: number;          // 0..3
}

export interface SurvivalConfig {
  hungerRate: number;        // 0..3  multiplies FOOD_DECAY_PER_S
  thirstRate: number;        // 0..3  multiplies WATER_DECAY_PER_S
  /** Multiplies TEMP_FALL_PER_S and RAIN_TEMP_FALL_PER_S. 0 = cold disabled. */
  temperatureSeverity: number; // 0..3
  regenRate: number;         // 0..3  multiplies REGEN_HP_PER_S
}

export interface PvpConfig {
  /** false = players cannot damage players (melee + ranged target loops skip them). */
  enabled: boolean;
  /** Scales player-vs-player damage only (zombies/deer unaffected). */
  damageMult: number;        // 0.25..2
  /** true (default, today's behavior): death drops the whole inventory on the
   * corpse and respawn starts empty. false ("keep inventory"): the corpse
   * spawns visibly but empty, and respawn restores the inventory held at death. */
  fullLoot: boolean;
}

export interface TimeConfig {
  /** Full 24h cycle in real minutes. Default 16 (DAY_DURATION_S / 60). */
  dayLengthMin: number;      // 4..120
  /** World-clock hour at game-time zero. Default START_HOUR (9). */
  startHour: number;         // 0..24
  /** When non-null the clock is frozen at this hour: permanent night (e.g. 1)
   * or eternal noon (12). Drives sky, ambient-warmth and the HUD clock. */
  fixedHour: number | null;  // null | 0..24
}

export interface WildlifeConfig {
  /** Multiplies DEER_COUNT. 0 = no deer (and no venison economy). */
  deerDensity: number;       // 0..3
  // Reserved for doc 07's species (validated 0..3, default 1, NO-OP until
  // doc 07 M8/M9 land): rabbitDensity, boarDensity, wolfPackDensity.
  rabbitDensity: number;     // 0..3
  boarDensity: number;       // 0..3
  wolfPackDensity: number;   // 0..3
}

export interface BuildingConfig {
  // Field set amended per doc 06's Migration section (its decayHours/raid
  // shield design replaced an earlier `decayRate` 0..3 multiplier — the two
  // were semantically incompatible). All reserved for doc 06: validated and
  // carried, NO-OP until doc 06 lands.
  enabled: boolean;
  /** Per-player piece cap (fairness dial, not anti-Sybil — doc 06). */
  pieceCapPerPlayer: number; // 10..500, default 120
  /** Wall-clock hours of owner absence before pieces decay. 0 = no decay. */
  decayHours: number;        // 0..2160, default 168
  /** Structure damage multiplier while the owner is offline. 0 = invulnerable. */
  offlineRaidMult: number;   // 0..1, default 0.25
}

export interface SessionConfig {
  /** Soft cap; hard-clamped to MAX_PLAYERS (24) — the verified perf envelope. */
  maxPlayers: number;        // 2..24
  respawnDelayS: number;     // 0..30   (RESPAWN_DELAY_S default 4)
  /** Combat-log linger for disconnected living bodies. 0 = instant despawn-save. */
  logoutLingerS: number;     // 0..300  (LOGOUT_LINGER_S default 60)
  /** Scheduled character+world wipes (leaderboard always survives). */
  wipeSchedule: WipeSchedule;
}

export interface ServerConfig {
  /** Resolved preset id ("custom" when overrides touch any field). */
  preset: string;
  world: WorldConfig;
  threats: ThreatsConfig;
  loot: LootConfig;
  survival: SurvivalConfig;
  pvp: PvpConfig;
  time: TimeConfig;
  wildlife: WildlifeConfig;
  building: BuildingConfig;
  session: SessionConfig;
}
```

Every numeric is a multiplier against an existing constant except `seed`,
`dayLengthMin`, `startHour`, `fixedHour`, `maxPlayers`, `respawnDelayS`,
`logoutLingerS` — absolutes with documented defaults equal to today's constants.
`DEFAULT_CONFIG` is the **deadcoast** preset: every multiplier `1`, every toggle
matching shipped behavior. A unit test (M1) asserts that field-by-field.

### 2. Validation — manual, total, never throws

```ts
export interface ResolvedConfig {
  config: ServerConfig;
  /** Human-readable notes for every field that was coerced/clamped/defaulted. */
  warnings: string[];
  /** True when the env carried no GAME_CONFIG at all. Resolves cleanly to
   * defaults with zero warnings — which is exactly why it is NOT proof the
   * operator wants a default world: wrangler deletes dashboard-set vars on
   * the next deploy unless keep_vars is set, and doc 01's multipart update
   * replaces bindings wholesale. Absence must never wipe (§4). */
  varAbsent: boolean;
  /** True when any world.* value — or the preset name itself, or the whole
   * GAME_CONFIG payload — failed to parse cleanly and was produced by
   * fallback/coercion. WIPE decisions must fail closed on this (§4); LIVE
   * fields just take the fallback plus a warning. */
  worldTainted: boolean;
}

/** Accepts: undefined (default config), a preset name string, a JSON string,
 * or an object { preset?: string; overrides?: DeepPartial<ServerConfig> }.
 * Unknown keys ignored with a warning; NaN/Infinity/out-of-range clamped to
 * the documented range; wrong types fall back to the preset value. ALWAYS
 * returns a usable config — a typo in wrangler.jsonc must not brick the boot.
 * The inverse guard matters just as much: "never brick the boot" must not
 * become "delete the world instead" — varAbsent/worldTainted exist so §4's
 * wipe path can refuse to act on fallback-derived world identity. */
export function resolveServerConfig(raw: unknown): ResolvedConfig;

/** The pure validate/clamp half of resolveServerConfig (no preset/env
 * resolution): total, never throws, clamps every numeric to its documented
 * range and every enum to a known value. The CLIENT runs this on
 * `welcome.config` before storing it — see the trust note below. */
export function clampConfig(raw: unknown): ServerConfig;
```

Implementation notes (binding for the implementer):

- A `DeepPartial<T>` mapped type + a hand-rolled `mergeConfig(base, partial)` that
  only copies known keys (allowlist walk, not `Object.assign`) — this is also the
  injection guard for the admin endpoint.
- Numbers: `typeof v === "number" && Number.isFinite(v)` then `clamp(min, max)`;
  integers (`seed`, `maxPlayers`) additionally `| 0` / `>>> 0`.
- `world.seed`: until M2's fingerprint machinery lands, any non-default value coerces
  back to `WORLD_SEED` with a warning (and sets `worldTainted`). M1 wires worldgen to
  config while persistence still compares the bare constant
  (`persistence.ts:17,109,116`); honoring a custom seed in that window would hydrate
  stale `world_state` into a different world — or, if the boot check threw, crash-loop
  the DO constructor. M2 lifts the restriction.
- `sizeTier`: until M6, any value other than `"standard"` coerces to `"standard"`
  with a warning. `waterFeatures`: forced `false` until doc 07 wires it, same pattern.
- Unknown preset names fall back to `deadcoast` with a warning AND set `worldTainted`:
  presets may pin world fields in the future, and a binary that doesn't recognize the
  name cannot know that this one wouldn't have.
- **Client-side trust**: the server runs `resolveServerConfig` on untrusted env input;
  the client runs `clampConfig` on `welcome.config` before storing it. An earlier draft
  said the client could trust the resolved object "same trust level as `seed` today" —
  that analogy is false. `seed` is one bounded worldgen input; config drives client-side
  *allocation sizes* (`effectiveZombieMax` sizes the render pool, §5) and *divisors*
  (`dayLengthMin`). Doc 02 explicitly designs for a first-party join path (official
  client + `?server=wss://…`, `02-server-directory.md:45,496`) — the moment that lands,
  `welcome.config` arrives from untrusted, trivially-modified open-source servers. A
  malicious `threats.zombieDensity: 1e9` would make `createPool()` allocate ~6×10¹⁰
  character rigs (`Zombies.tsx:57-69`) — instant tab OOM; `time.dayLengthMin: 0` NaNs
  the sky and clock. `clampConfig` is the already-shared validation half, so the guard
  costs one call (M1) and a fuzz case (M4).

### 3. The PRESETS registry

`PRESETS: Record<string, DeepPartial<ServerConfig>>` — partials merged over
`DEFAULT_CONFIG`, so deadcoast's values are single-sourced. Full effective matrix
(blank = default):

| Field | deadcoast | driftwood | ironcoast | warpath | homestead | nightfall |
|---|---|---|---|---|---|---|
| *tagline* | The island as designed | Peaceful scavenge & explore | You will not be missed | The compound is an objective | Build in peace | The sun never rises |
| threats.zombies | true | **false** | true | true | **false** | true |
| threats.zombieDensity | 1 | — | **1.5** | **0.5** | — | **1.25** |
| threats.zombieDamage | 1 | — | **1.5** | **0.75** | — | **1.25** |
| threats.zombieSpeed | 1 | — | **1.1** | — | — | **1.05** |
| threats.militaryZone | true | true | true | true | **false** | true |
| loot.density | 1 | **1.25** | **0.6** | **1.5** | **1.5** | — |
| loot.tierDensity.military | 1 | — | — | **1.5** | — | — |
| loot.respawnRate | 1 | **1.5** | **0.5** | **2** | **2** | — |
| loot.airdrops | 1 | — | **0.5** | **2.5** | — | **1.5** |
| survival.hungerRate | 1 | **0.75** | **1.5** | **0.5** | **0.25** | — |
| survival.thirstRate | 1 | **0.75** | **1.5** | **0.5** | **0.25** | — |
| survival.temperatureSeverity | 1 | **0.5** | **1.75** | **0.5** | **0** | **0.5** |
| survival.regenRate | 1 | **1.5** | **0.5** | — | **2** | — |
| pvp.enabled | true | **false** | true | true | **false** | true |
| pvp.damageMult | 1 | — | — | — | — | — |
| pvp.fullLoot | true | **false** | true | true | **false** | true |
| time.dayLengthMin | 16 | — | **24** | **12** | **30** | — |
| time.startHour | 9 | — | — | — | — | — |
| time.fixedHour | null | — | — | — | — | **1** |
| wildlife.deerDensity | 1 | **1.5** | — | — | **2** | — |
| building.enabled | true | — | — | — | — | — |
| building.pieceCapPerPlayer | 120 | — | — | — | **200** | — |
| building.decayHours | 168 | — | **72** | — | **0** | — |
| building.offlineRaidMult | 0.25 | **0** | **1** | — | **0** | — |
| session.maxPlayers | 24 | — | — | — | — | — |
| session.respawnDelayS | 4 | **2** | **10** | **2** | **0** | **5** |
| session.logoutLingerS | 60 | **0** | **180** | **120** | **0** | — |
| session.wipeSchedule | never | — | **monthly** | **weekly** | — | — |

Preset design notes:

- **driftwood**: military zone stays ON so the compound remains the exploration prize
  (rifles for deer hunting); with zombies and PvP both off there is no garrison to
  fight anyway — `threats.zombies=false` already suppresses military spawns.
- **ironcoast**: scarcity + slow regen + brutal cold; the 24-minute day makes nights a
  real planning problem. Monthly wipes keep the leaderboard race honest.
- **warpath**: zombies kept at 0.5 density as ambient noise/audio cover; gunfire-loot
  economy turned way up; weekly wipes; vitals softened so the chore loop doesn't
  interrupt fights.
- **homestead**: `militaryZone=false` downgrades compound loot to inland — guns aren't
  the point. `temperatureSeverity=0` means campfires become purely doc-06 ambience.
- **nightfall**: `fixedHour=1` means `gameHours` never enters the warm window
  (`AMBIENT_WARM_HOUR_START..END`, `survival.ts:122-123`), so warmth comes ONLY from
  campfires — severity 0.5 tunes that to "manage your fires" not "die in 4 minutes"
  (fall 0.006 °C/s → ~5.5 min from 37 °C to shiver). Flashlights and muzzle flashes
  carry the mood; flashlights spawn from the coastal and inland tables plus airdrops
  (`items.ts:151,162,110`) — the **military** table has none (`items.ts:164-173`), so
  on nightfall the highest-tier zone is the one place you cannot loot a light source.
  Acceptable for v1 (you bring a light TO the compound); if playtests disagree, the fix
  is a one-line flashlight entry in the military table — an `items.ts` change reviewed
  separately, because it shifts military roll weights for every preset.

### 4. Config flow

```
wrangler.jsonc vars.GAME_CONFIG ──► Env.GAME_CONFIG (unknown)
        │                                  │
        │ (doc 01: deploy API writes       ▼
        │  the same var as a binding)   GameRoom constructor:
        │                               this.resolved = resolveServerConfig(env.GAME_CONFIG)
        │                               initSchema(sql, boot)  ── fail-closed wipe check
        │                                 (may override config.world from stored fingerprint)
        ▼                                  │
   dashboard edit = redeploy               ▼
                                        ensureGame():
                                          createWorld(worldParamsOf(cfg.world))
                                          createGameState(world, cfg)
                                          (admin overrides from meta applied here)
                                           │
                                           ▼
                                        sendWelcome(): { ..., seed, config: cfg }
                                           │
                                           ▼
                                        client onWelcome():
                                          clientWorld.config = clampConfig(msg.config)
                                          createWorld(worldParamsOf(config.world))
```

**Deploy-time mechanism (decision, coordinates with doc 01):** a `GAME_CONFIG` var in
`wrangler.jsonc`. Wrangler vars accept JSON objects; the deploy-API path (doc 01) writes
the same thing as a binding in the multipart metadata. To be robust across both paths
and dashboard edits, `resolveServerConfig` accepts an object **or** a JSON string **or**
a bare preset name:

```jsonc
// wrangler.jsonc — simplest form. keep_vars guards the dashboard-edit path
// this very diagram recommends: without it, the next `wrangler deploy`
// silently deletes dashboard-set vars (verified, workers/wrangler/configuration:
// "If you change your environment variables in the Cloudflare dashboard,
// Wrangler will override them the next time you deploy ... add keep_vars = true").
"keep_vars": true,
"vars": { "GAME_CONFIG": "warpath" }
// or with overrides
"vars": { "GAME_CONFIG": { "preset": "warpath", "overrides": { "threats": { "zombieDensity": 0.75 } } } }
```

`Env` gains `GAME_CONFIG?: unknown` — declared via **interface merging in a new
hand-owned `src/server/env.d.ts`** (a global-scope `interface Env { GAME_CONFIG?: unknown }`
merges into the generated declaration), NOT by typegen and NOT by editing
`worker-configuration.d.ts`. Typegen cannot produce this member: `wrangler types`
derives `Env` from wrangler.jsonc, which deliberately carries no `GAME_CONFIG` (the
official deploy is var-less — Migration §), so regeneration emits nothing and
`env.GAME_CONFIG` would be a strict-TS error; and if a var WERE present, typegen emits
its literal value type (e.g. `"warpath"`), not the `unknown` the never-trust-the-env
validator requires. `worker-configuration.d.ts` stays generated output — hand edits are
clobbered by the next `npm run cf-typegen`. No secret —
the config is public by design (it's in every welcome message and summarized in
`/api/server-info`). Settled (was UNCONFIRMED in cf-deploy.md), with one correction: the
multipart *guide page* (workers/configuration/multipart-upload-metadata) enumerates 16
binding types with no `json` among them, but the Script Upload API schema itself DOES
accept a `{ type: "json", name, json }` binding (cloudflare-typescript
`WorkersBindingKindJson`, generated from the OpenAPI schema). The decision stands on
different grounds: the JSON-**string**/`plain_text` form is
the canonical `GAME_CONFIG` carrier for doc 01's REST deploy path and for operator docs
because it is the one shape valid across all three write paths (wrangler.jsonc vars,
dashboard edits, REST multipart);
the object form is a wrangler.jsonc-only convenience (wrangler serializes object vars
itself), and `resolveServerConfig` accepts a parsed object anyway, so a future switch to
`json` bindings on the REST path costs nothing. Doc 01's **update** flow has
one extra obligation, and it covers MORE than `GAME_CONFIG`: the multipart PUT replaces
bindings wholesale (cf-deploy.md §8.1), so every routine version update must carry ALL
operator-set bindings forward. Concretely: pass `keep_bindings: ["secret_text"]` in the
upload metadata — the API's purpose-built inheritance field, and **mandatory** for
secrets, whose values can never be read back through the settings GET; this is what
preserves §7's `ADMIN_TOKEN` — and re-supply `GAME_CONFIG` explicitly after GETting
current settings. Dropping the var silently reverts a
warpath/ironcoast server to deadcoast rules (the *world* survives that mistake — see the
fail-closed wipe rule below — but the gameplay flip would still confuse every player);
dropping `ADMIN_TOKEN` is worse: per §7's auth rule the admin surface silently turns OFF
(404 — "admin not enabled") after every update, and stale `admin_overrides` persisted in
DO storage can then no longer be cleared through any endpoint.
The deploy-button path (cf-deploy.md §3) is the worst offender: the user's repo copy of
wrangler.jsonc has no `GAME_CONFIG`, so every git-driven deploy strips a dashboard-set
var unless `keep_vars` is in the template.

**Server boot:** the constructor (`GameRoom.ts:153-161`) resolves config before
`initSchema` and logs `resolved.warnings`. `ensureGame()` (`GameRoom.ts:352-365`)
becomes `createWorld(worldParamsOf(this.config.world))` + `createGameState(world,
this.config)`. The boot check `seed === config.world.seed` is `console.error` +
coerce-to-config, **never a throw** — a throwing constructor crash-loops the DO, the
exact bricked-boot failure the never-throw validator exists to prevent.

**Worldgen parameters — determinism contract:** `worldParamsOf(world: WorldConfig)`
is a pure shared function in `config.ts` returning the explicit inputs `createWorld`
needs. In M1–M5 it returns `{ seed }` and `createWorld` is unchanged. In M6 it returns
the full set, derived from a fixed lookup table (integers only, no float math). **The
per-tier values are owned by doc 07 §3** (an earlier provisional table here —
small 560 / standard 800 / large 1120 — is superseded; there is no sub-1x tier):

| tier | worldSize | towns | cabins | trees | rocks |
|---|---|---|---|---|---|
| standard | 800 | 4 | 6 | 700 | 70 |
| large | 1,600 | 10 | 18 | 2,800 | 280 |
| huge | 3,200 | 22 | 44 | 11,200 | 1,120 |

Both sides derive these from the same `ServerConfig` via the same function — the same
guarantee the seed has today, just wider. Existing rng stream draw order is untouched
for `standard` (the constants are identical); other tiers are *different worlds*, which
is exactly what the fingerprint wipe is for.

**Persistence:** additive meta rows (following the weather/airdrop precedent at
`persistence.ts:233-235`):

- `world_fingerprint` — canonical string of WIPE-class fields:
  `v1|seed:1337|size:standard|water:0`. Parseable in both directions:
  `worldFingerprintOf(world)` and `parseWorldFingerprint(fp): WorldConfig | null` live
  together in `config.ts` — the refusal path below boots the world FROM the stored
  string. `initSchema` compares it instead of bare `world_seed`. **Graceful migration**:
  when `world_fingerprint` is absent but the legacy `world_seed` row equals the config
  seed AND the rest of the fingerprint is default, write the fingerprint *without
  wiping* — the deployed official world survives this feature landing.
- `config_json` — the resolved config as of the last boot. Used for change detection,
  and so future tooling can read what a world was running without the env. When a
  live-class field differs on boot: log the diff and persist a `config_changed_at`
  timestamp — do NOT broadcast at boot, that is provably dead code: the comparison runs
  in the constructor, before any socket is accepted (`GameRoom.ts:153-161`),
  `broadcastMsg` iterates `socketByPlayer` which is empty until the first join
  (`GameRoom.ts:883-885`), and clients never auto-reconnect across a deploy
  (close → menu, `connection.ts:180-198`). Delivery is join-side instead: every join
  within 24h of `config_changed_at` gets a `notice` ("server rules changed") queued
  right after `sendWelcome` — the same delivery point §7's admin-POST notice uses.
  The env is authoritative for live-class fields on every boot; SQLite never overrides it.
- `wipe_schedule` + `wipe_epoch` — a pair, see wipe schedule below.
- `pre_wipe_bookmark` — written by the sanctioned wipe path, see below.

**The wipe decision fails closed.** Composing today's wipe path
(`persistence.ts:112-116`) naively with a never-throwing validator would turn a
one-character typo into silent world destruction: malformed `GAME_CONFIG` falls back to
`seed: 1337`, the computed fingerprint mismatches a custom-seed world's stored one, and
the wipe deletes characters + world_state + (via `DELETE FROM meta`,
`persistence.ts:114`) the fingerprint that held the only record of the real seed. The
same hole opens with no typo at all: an *absent* var resolves cleanly to defaults with
zero warnings — and both standard update paths can absently drop it (wrangler deletes
dashboard-set vars without `keep_vars`; doc 01's multipart PUT replaces bindings
wholesale). So the rule, binding for M2 — `initSchema` grows one `boot` parameter
carrying `{ fingerprint, wipeSchedule, wipeEpoch, configJson, varAbsent, worldTainted,
bookmark }` and returns the effective `WorldConfig`:

One rule sits ABOVE the table: a **`schema_version` mismatch wipes unconditionally**
(bookmark captured first), independent of config provenance — today's check wipes on
either version or seed mismatch (`persistence.ts:107-109`) and the version half of that
survives this design untouched. Version bumps are code-driven, not config-driven: the
stored fingerprint and the persisted `world_state`/`characters` JSON may not even parse
under the new code, so the refusal path below ("boot from the STORED fingerprint") must
never be applied to a schema bump — followed literally it would hydrate old-shape rows
into code that cannot read them. The decision table applies only when `schema_version`
matches:

| Fingerprint vs stored | Config provenance | Action |
|---|---|---|
| match | any | boot normally |
| mismatch | `varAbsent` (no `GAME_CONFIG` in env) | **refuse to wipe**: boot from the STORED fingerprint (`parseWorldFingerprint`), overwrite `this.config.world` with it so worldgen, `welcome` and every client agree; `console.error` a config-error and surface it in `GET /api/admin/config` |
| mismatch | `worldTainted` (any world field from fallback/coercion — unparseable JSON, unknown preset, bad world value) | same refusal path |
| mismatch | explicit, cleanly-parsed world config | sanctioned wipe (below) |

A **sanctioned wipe**: the constructor's `blockConcurrencyWhile` closure first awaits
`ctx.storage.getCurrentBookmark()` **inside a try/catch** and passes the result into
`initSchema` (the closure is already async; `initSchema` stays sync). The guard is not
optional: the PITR API is explicitly unsupported in local development ("a durable log
of data changes is not stored locally" — durable-objects/api/storage-api; behavior on
call is unspecified, throw vs no-op), and since the capture runs on EVERY boot — it
must, `initSchema` is sync and makes the wipe decision up front — an unguarded throw
here is the constructor crash-loop this design repeatedly promises to avoid, hitting
every `wrangler dev` boot rather than some edge case. On throw or undefined:
`console.error` and proceed with the bookmark recorded as `"unavailable"` — a missing
safety net must never block the wipe itself. The wipe clears characters + world_state
(leaderboard kept, exactly today's semantics), then rewrites meta **enumerated in
full**: `schema_version`, `world_fingerprint`, `wipe_schedule`, `wipe_epoch`,
`config_json`, and `pre_wipe_bookmark` = the captured bookmark (or `"unavailable"`).
`admin_overrides` (§7)
is deliberately NOT rewritten — a world wipe clears it; overrides tuned for a dead world
are stale. SQLite-backed DOs keep 30 days of point-in-time recovery (verified at
developers.cloudflare.com/durable-objects/api/storage-api), so `pre_wipe_bookmark` makes
even a sanctioned-but-regretted wipe recoverable for a month — **through §7's restore
endpoint, which is the only surface that can exercise it**:
`onNextSessionRestoreBookmark` is an in-DO storage API with no dashboard or REST
equivalent, so without that endpoint the bookmark would be a meta row the operator can
neither read nor act on, and "recoverable" would really mean "recoverable by someone
deploying modified code".

Deliberately reverting a custom world to defaults is therefore an explicit act: set
`GAME_CONFIG` to a concrete value (`"deadcoast"`) — present and cleanly parsed — rather
than deleting the var.

**Field classification (complete):**

| Class | Fields | On mismatch at boot |
|---|---|---|
| **WIPE** | `world.seed`, `world.sizeTier`, `world.waterFeatures` | characters + world_state wiped (leaderboard kept), fingerprint rewritten — same player-facing semantics as today's seed change, but gated by the fail-closed decision table above: only an explicit, cleanly-parsed config can trigger it, and a PITR bookmark is captured first |
| **LIVE** | everything else: all of `threats`, `loot`, `survival`, `pvp`, `time`, `wildlife`, `building`, `session`, `preset` | new value applies immediately; zombies/deer are never persisted (`GameRoom.ts:359-361`) so density/speed changes are clean on the restart a deploy causes; persisted loot/corpses/fires/drops remain valid under any LIVE change |

LIVE caveats, stated honestly: changing `time.dayLengthMin` or `time.startHour`
mid-world jumps the apparent hour (`gameHours` divides persisted `game.time` by the new
length — `protocol.ts:318-320`); purely cosmetic, no migration. Changing `pvp.fullLoot`
affects only deaths after the deploy. Lowering `loot.density` does not despawn existing
loot — it bleeds in through the respawn cycle (which is why the `<1` gate must re-arm
spawn points on a failed roll, §5 — otherwise it permanently kills them instead).
Changing `session.wipeSchedule` is LIVE only because of the re-anchor rule below: the
schedule/epoch pair is rewritten without wiping, and the new cadence starts from the
current period.

**Wipe schedule mechanics:** epoch counter, not a cron. `wipeEpochOf(schedule, nowMs)`
in `config.ts`: `never → 0`; otherwise `floor((nowMs - ANCHOR_MS) / periodMs)` with
`ANCHOR_MS = Date.UTC(2026, 0, 5)` (a Monday) and periods 7/14/30 days. An epoch number
is meaningless without the schedule that produced it, so they persist as a PAIR
(`wipe_schedule` + `wipe_epoch`) and `initSchema` applies:

- rows absent (fresh DB or pre-feature world): write the current pair, **no wipe**;
- stored schedule ≠ config schedule: rewrite the pair to current values, **no wipe** —
  schedule changes re-anchor, never destroy. (A naive bare-epoch comparison would wipe
  on every transition: `weekly → never` compares stored epoch ≈22 — 157 days since the
  anchor / 7 — against `never`'s 0 and nukes the world precisely when the operator asked
  wipes to STOP; `never → weekly` would wipe immediately on deploy instead of at the next
  boundary; `weekly → monthly` is an arbitrary epoch jump.)
- schedules equal and current epoch > stored: the sanctioned wipe path above (bookmark +
  full meta rewrite), exactly once, then store the new epoch. `never` pins epoch 0 and
  can never enter this branch.

Timing, stated honestly: the check runs in `initSchema`, which the GameRoom constructor
executes on ANY wake (`GameRoom.ts:153-161`) — and `worker.ts:16-19` routes
`/api/health` and `/api/leaderboard` into the DO. For any monitored server the wipe
therefore lands at the first DO wake after the room empties past the boundary — a health
poll, a leaderboard fetch, or a join — i.e. effectively AT the boundary (00:00 UTC,
≈ 6–7 PM Central), **not** "at the first player join". For an occupied room it lands on
the next restart after the boundary. (`/api/server-info` is DO-answered behind a 15s
Worker micro-cache — doc 03 §5, §6 — so a cache-miss directory probe is one more wake
class that can land the wipe, alongside health polls.) No alarm needed; no idle DO is ever
woken *just* to wipe. If prime-time wipes prove unacceptable, see open question 7.

**Welcome message (protocol change):** one additive optional field —

```ts
| { t: "welcome"; id: string; seed: number; /* …existing… */ config?: ServerConfig }
```

Decision: send the **whole resolved config**, not a hand-picked subset (~700 bytes of
JSON, once per join). A subset invites drift every time a field is added; the client
ignores what it doesn't read — and clamps what it does read (`clampConfig`, §2). `seed`
stays for old-client compatibility and must equal `config.world.seed` (boot check:
log + coerce, never throw). Old client + new server: unknown field ignored, world built
from `seed` — correct for `standard` tier worlds ONLY. That is why M6 (non-standard
tiers) hard-depends on doc 03's `PROTOCOL_VERSION` join gate: a stale tab reconnecting
to a large/huge world would otherwise build standard-constants geometry from the bare
seed (`connection.ts:260`) and play inside divergent walls/terrain/loot with zero
detection — catastrophic, not benign. New client + old server: `config` undefined →
defaults via `clampConfig(undefined)`. Until M6, both skews are benign and only exist
for tabs left open across a deploy (`codebase-sim.md` §5.3).

### 5. How systems consume config — the refactor pattern

Pattern (binding): **constants stay imported as defaults; config scales at point of
use; gates are early returns at function tops.** `GameState` gains `config:
ServerConfig` (`state.ts:221`, `createGameState(world, config)` at `state.ts:256`).
Shared derivation helpers live in `config.ts` so server caps and client pools agree:

```ts
export function effectiveZombieMax(cfg: ServerConfig): number {
  return cfg.threats.zombies ? Math.round(ZOMBIE_MAX * cfg.threats.zombieDensity) : 0;
}
export function effectiveDeerMax(cfg: ServerConfig): number {
  return Math.round(DEER_COUNT * cfg.wildlife.deerDensity);
}
export function effectiveGameHour(cfg: TimeConfig, gameTimeS: number): number {
  if (cfg.fixedHour !== null) return cfg.fixedHour;
  return gameHours(gameTimeS, cfg.dayLengthMin * 60, cfg.startHour);
}
```

Exhaustive touch-point table (the M3/M4 work list — nothing else changes):

| File | Line(s) today | Change |
|---|---|---|
| `zombies.ts` | 96-117 | `spawnInitialZombies`: early return if `!threats.zombies`; counts `Math.round(N * zombieDensity)`; skip military loop if `!militaryZone`; cap via `effectiveZombieMax` |
| `zombies.ts` | 192 | damage `* threats.zombieDamage` |
| `zombies.ts` | 196 | chase speed `* threats.zombieSpeed` |
| `zombies.ts` | 329-346 | `tickZombieRespawns`: early return if `!zombies`; cap via `effectiveZombieMax` |
| `survival.ts` | 122 | `const hour = effectiveGameHour(state.config.time, state.time)` |
| `survival.ts` | 132-133 | decay `* hungerRate` / `* thirstRate` |
| `survival.ts` | 144-150 | both fall terms `* temperatureSeverity` |
| `survival.ts` | 163-165 | regen `* regenRate` |
| `combat.ts` | 239, 377 | wrap the players loops in `if (state.config.pvp.enabled)` |
| `combat.ts` | 279, 429 | PvP damage `* pvp.damageMult` (zombie/deer damage untouched) |
| `loot.ts` | 49-62 | `spawnLootAt`: effective = `density * tierDensity[tier]`; `>1` → `count = Math.max(1, Math.round(count * eff))`; tier swap `military→inland` when `!threats.militaryZone`. The `<1` stocking gate must NOT live here (next two rows): a silent no-op inside `spawnLootAt` permanently kills the spawn point, because `startLootRespawn` is only ever called from `pickupLoot` (`players.ts:418-421`) and `tickLootRespawns` splices the timer unconditionally after calling `spawnLootAt` (`loot.ts:101-102`) — a failed roll would leave neither entity nor timer, dead forever (and across restarts: `stockInitialLoot` runs only on a fresh DB, `GameRoom.ts:358`). At ironcoast's density 0.6 that is ~40% of all spawn points dead per cycle |
| `loot.ts` | 65-67 | `stockInitialLoot`: when `eff < 1`, roll `Math.random() < eff` per spawn; a PASSED roll → `spawnLootAt`; a FAILED roll → `startLootRespawn(state, spawn.id)` so the point cycles forever at probability `eff` per cycle. Binding invariant for both gate sites: every spawn point always holds exactly one of {stocked entity, pending respawn timer} |
| `loot.ts` | 85-104 | `tickLootRespawns`: same gate on the respawn roll — failed roll → splice + `startLootRespawn` (equivalently: reset `timer.t` to a fresh interval instead of splicing). NEVER splice a timer without either spawning or re-arming |
| `loot.ts` | 70-75 | respawn timer `/ respawnRate` |
| `loot.ts` | 111-130 | `spawnPlayerCorpse`: when `!pvp.fullLoot`, spawn the corpse with empty `contents` and DO NOT clear `player.inventory` (respawn keeps it; the dead character row then also persists it — next two rows) |
| `players.ts` | 185-203 | `respawnPlayer`: when `!pvp.fullLoot`, keep `inventory`/`selectedSlot` instead of `emptyInventory()` — covers the live-socket respawn path only |
| `GameRoom.ts` | 492-505 | `handleJoin` path 3 (dead row → new life): when `!pvp.fullLoot` and `saved?.alive === false`, seed the new life's `inventory`/`selectedSlot` from `saved.state` (deep copy) after `createPlayer`. The dead row keeps `state_json` (`markCharacterDead` updates only flags, `persistence.ts:317-328`), and under keep-inventory that json holds exactly the death inventory. Without this row, anyone who closes the tab on the death screen loses everything — path 3 calls `createPlayer` → `emptyInventory()` (`players.ts:102-135`), silently destroying items on driftwood and homestead (both ship `fullLoot=false`). No double-restore: the join's existing `persistAll` (`GameRoom.ts:503`) immediately overwrites the dead row with the new life |
| `airdrops.ts` | 51-92 | gate ONLY the scheduling block (`airdrops.ts:54-84`) when `airdrops === 0`; intervals `/ airdrops` when `> 0`. Binding: the expiry sweep (`airdrops.ts:88-92`) runs EVERY tick regardless — a top-of-function early return would skip it, and crates are persisted + hydrated across restarts (`persistence.ts:152-154,213-217`) and never interest-filtered (`GameRoom.ts:801-813`), so a world switched to `airdrops: 0` with a live crate would otherwise carry an immortal crate in every snapshot forever. Equally binding: never delete `state.drops` at deploy — destroying lootable items contradicts the LIVE-class promise (§4: persisted drops remain valid under any LIVE change); existing crates age out naturally via `expiresAt` |
| `wildlife.ts` | 81-86, 178-190 | counts via `effectiveDeerMax` (shared with the client pool row below); respawn early-return at 0 |
| `GameRoom.ts` | 201, 470 | `min(MAX_PLAYERS, config.session.maxPlayers)` |
| `GameRoom.ts` | 296 | `config.session.respawnDelayS` |
| `GameRoom.ts` | 527-555, 645 | `config.session.logoutLingerS` (0 → save-and-remove immediately in `dropSocket`) |
| `GameRoom.ts` | 354-364, 507-525 | `ensureGame` world params + state config; `sendWelcome` adds `config` |
| `connection.ts` | 256-285, 275/307 | `clientWorld.config = clampConfig(msg.config)` (never store the raw object — §2 trust note); clock via `effectiveGameHour` |
| `interpolation.ts` | 38, 85 | clock via `effectiveGameHour` (this is what drives `SkyAndLighting`) |
| `runtime.ts` | 137-187 | `clientWorld.config: ServerConfig` (initialized `DEFAULT_CONFIG`) |
| `GameCanvas.tsx` | 59, 62 | `{cfg.threats.zombies && <Zombies />}`, `{cfg.wildlife.deerDensity > 0 && <Animals />}` — pure memory/alloc win; both already render nothing on empty maps |
| `Zombies.tsx` | 57-69, 92-93 | initial pool size `effectiveZombieMax(clientWorld.config)` instead of `ZOMBIE_MAX` — **plus lazy growth**: when `pool.free` is empty, allocate a fresh rig/slot (push to `pool.slots`, add to `pool.root`) instead of today's silent `continue` (`Zombies.tsx:92-93`). Welcome-time config is an allocation hint, never a render cap: the pool is built once at mount (`useMemo(createPool, [])`, `Zombies.tsx:73`) and nothing re-sends config to a connected client, so without growth every zombie above the mount-time effective max is invisible-but-simulated — still chasing and damaging players — which is exactly what §7's live admin density raise would produce on every connected client. Growth is bounded by what the server actually puts on the wire, so a hostile config cannot force allocation beyond real snapshot entities (§2's clamp still bounds the *initial* allocation) |
| `Animals.tsx` | 18 | initial pool size `effectiveDeerMax(clientWorld.config) + 4` (same respawn margin) instead of `DEER_COUNT + 4`, plus the same lazy growth as the zombie row. Today's pool is 14 slots; homestead's `deerDensity: 2` puts 20 deer on the wire and driftwood's 1.5 puts 15 — deer beyond the pool simply never render (pool exhaustion → `continue`), i.e. invisible-but-simulated deer on two shipped presets. Lazy growth removes that trap class entirely instead of re-deriving the right pool size forever |
| `DeathScreen.tsx` / `MainMenu.tsx` | 13 / 76 | day display divides by `config.time.dayLengthMin * 60` when connected; menu (pre-join) keeps the constant |

Two contract-gap upgrades while in there (precedent: `zombies.ts:35`, `airdrops.ts:20`):
no new system-local tunables are introduced by this design; everything lands in
`config.ts` or stays in `constants.ts`.

### 6. `/api/server-info` badge summary (handoff to doc 03)

`config.ts` exports the derivation; doc 03 owns the endpoint and envelope — the type is
doc 03's `RulesSummary` (`src/shared/serverInfo.ts`), carried as `ServerInfo.rules`;
this doc owns the derivation function and the banding semantics (an earlier
`ServerInfoSummary`/`serverInfoSummary` naming here is superseded — doc 02 and doc 03
both reference `RulesSummary`/`summarizeRules`):

```ts
// Type lives in src/shared/serverInfo.ts (doc 03); derivation lives here.
export interface RulesSummary {
  /** Closed union, never free text — `summarizeRules` membership-checks
   * `cfg.preset` (a free-form string in ServerConfig) against the registry
   * and resolves anything unknown or overridden to "custom". */
  preset: "deadcoast" | "driftwood" | "ironcoast" | "warpath"
    | "homestead" | "nightfall" | "custom";
  zombies: "off" | "sparse" | "normal" | "horde";   // off / <0.75 / ≤1.25 / >1.25
  pvp: boolean;
  fullLoot: boolean;
  loot: "scarce" | "normal" | "plentiful";          // <0.75 / ≤1.25 / >1.25 of density
  vitals: "gentle" | "normal" | "harsh";            // max(hunger,thirst,temp) banded same way
  night: "cycle" | "always" | "never";              // fixedHour: null / in [21,5) / else
  dayLengthMin: number;
  worldSize: WorldSizeTier;
  maxPlayers: number;
  wipe: WipeSchedule;
}
export function summarizeRules(cfg: ServerConfig): RulesSummary;
```

**Serving is doc 03 §5's design and this doc defers to it**: the DO answers
`/api/server-info` with a cheap read (no `ensureGame`, no tick — the `/api/health`
discipline) behind a per-isolate 15s micro-cache in `worker.ts`. An earlier draft of
this section prescribed a pure-Worker answer built from
`summarizeRules(resolveServerConfig(env.GAME_CONFIG).config)` on cf-costs.md §5 grounds;
doc 03 §5 weighed exactly that option against the live fields the contract requires
(`players`, `status`, `uptimeS` — DO state the Worker cannot see) and the
client-measured-RTT purpose of the route, and chose DO-answered + micro-cache with the
cost math done. The DO handler calls `summarizeRules(this.config)` — which also
dissolves most of the drift problem the Worker-serving draft created: admin overrides
(§7) are applied to the live `state.config`, so badge inputs that are also whitelisted
override fields (`pvp.enabled`, `zombieDensity`, `maxPlayers`) are stale only up to the
micro-cache TTL (15s), not until restart. The one remaining honest drift: after a
fail-closed refusal (§4) the served `rules` reflect the running (stored-fingerprint)
world while the env claims different world fields — `GET /api/admin/config` shows the
operator the truth.

Trust, stated for doc 02 (the directory): **every badge value is an operator claim, not
a directory-verified fact.** The server is open source and trivially modified — a
malicious operator can advertise driftwood/PvE-safe badges while running warpath rules,
or report player/zombie bands with no relation to the running sim: the classic bait
listing. Probes prove *who* is listing, never *what is true*
(`directory-prior-art.md` §2), and Rust's blacklist exists precisely because servers
lie in these list-response fields (§5). Doc 02 must render badges as claims, never
rank or trust-score on them, and its report/delist policy is the only enforcement —
mirroring the Facepunch "delist for lying in server-info" precedent.

Lying is one threat; **injection is the other**, and the TS types above guarantee
nothing at runtime — the directory ingests this JSON from trivially-modified
third-party servers, and `preset` is this design's one string that gets *rendered* on
official-site badges (open question 1). A malicious server can return markup or
unicode-lookalike text in `preset` and out-of-enum values in every banded field. Hence
the closed union above, and a binding ingest rule for doc 02: **whitelist-validate
every summary field at ingest** — enum membership for
`preset`/`zombies`/`loot`/`vitals`/`night`/`wipe`/`worldSize`, finite-number range
checks for `dayLengthMin`/`maxPlayers`, booleans coerced — and never render a field as
received. Prior art treats this as table stakes: Luanti strips control characters from
free-text list fields and rejects punycode-lookalike domains
(`directory-prior-art.md` §6).

### 7. Admin story v1

Owner-only, token-gated, three endpoints on the existing DO (routed through
`worker.ts:16-19`'s `/api/` chain; SPA navigation swallowing doesn't matter — these are
fetch/curl targets, per `codebase-server.md` §1):

- Auth runs **in `worker.ts`, before `stub.fetch`**: `ADMIN_TOKEN` secret
  (`wrangler secret put ADMIN_TOKEN`), `Env.ADMIN_TOKEN?: string` (declared in the same
  hand-owned `src/server/env.d.ts` as `GAME_CONFIG`, §4) — `env` is in scope at
  the routing layer, and SHA-256 + `crypto.subtle.timingSafeEqual` (a verified
  non-standard Workers extension, length-safe over the digests) run fine in the Worker.
  No secret set → 404 (admin not enabled); wrong/missing bearer → 401 — both answered
  without touching the DO. Rationale: every request that reaches the DO bills a DO
  request and wakes the object; an attacker spamming garbage bearers at ~1.2 req/s
  would exhaust a free-plan server's 100,000/day DO-request cap — the same cap live
  players' WS messages spend from, so past it their messages start failing and the
  liveness sweep drops them (cf-costs.md §1/§3). Honest caveat: `/ws` upgrade spam can
  already burn that cap, so this is cost hygiene and blast-radius reduction, not a new
  shield. Second caveat, scoped wider than the DO: on the free plan the same ~1.2 req/s
  of unauthenticated spam (admin routes included) also exhausts the separate
  100,000/day **Worker** request cap (cf-costs.md §1) — Error 1027 on every `/api/*`
  route and `/ws` upgrade until 00:00 UTC, with only static assets surviving. So on
  free plan, Worker-side auth placement protects billing and the DO, **not
  availability**: route spam takes the server down regardless of where auth runs.
  Paid plan unaffected (requests bill at $0.30/M past included). Only authenticated
  admin requests ever reach the DO.
- `GET /api/admin/config` → `{ config, warnings, adminOverrides, fingerprint,
  wipeEpoch, configError, preWipeBookmark }` — the resolved truth, including what the
  env said vs what admin overrode, `configError` set when the fail-closed path refused
  a wipe and booted from the stored fingerprint (§4), and `preWipeBookmark` echoing the
  `pre_wipe_bookmark` meta row (`null` when none, `"unavailable"` when capture failed)
  so the recovery handle §4 writes is actually visible to the operator who needs it —
  the operator's one self-serve diagnostic.
- `POST /api/admin/config` → body is a deep-partial touching ONLY the live whitelist:
  `ADMIN_LIVE_FIELDS = ["threats.zombieDensity", "loot.respawnRate", "pvp.enabled",
  "session.maxPlayers"]`. Anything else → 400 listing the rejected paths. Accepted
  values are validated/clamped by the same code path as boot, persisted to an
  `admin_overrides` meta row (plain `setMeta` — config is not coupled to the
  item-coherency rule that makes `persistAll` exclusive, `GameRoom.ts:594-606`), and
  applied to the live `state.config` immediately. Broadcast a `notice` ("server rules
  updated") so it's never silent.
- `POST /api/admin/restore` → body `{ "bookmark": string }`, defaulting to the stored
  `pre_wipe_bookmark` when omitted. The handler is ~3 lines: reject empty or
  `"unavailable"` bookmarks with 400, `await
  ctx.storage.onNextSessionRestoreBookmark(bookmark)`, then `ctx.abort()` so the DO
  restarts into the restored state. This endpoint exists because that in-DO call is the
  ONLY way to exercise PITR (no dashboard or REST equivalent) — without it, §4's
  bookmark is a safety property the design writes but no operator can use. **Runbook
  order matters, and doc 01's operator docs must say so**: revert `GAME_CONFIG` to the
  pre-wipe world value FIRST, then POST the restore — otherwise the next boot compares
  the restored (old) fingerprint against the env's still-changed, cleanly-parsed world
  config and §4 sanctions the wipe all over again. Deployed-only: PITR does not exist
  under `wrangler dev` (§4).
- Precedence at boot: `DEFAULT ← preset ← env overrides ← admin_overrides`. Admin
  overrides survive restarts until cleared (`POST` with `{"clear": true}`) — **or until
  a world wipe**: the sanctioned wipe path deliberately clears `admin_overrides` along
  with the rest of meta (§4 enumerates exactly which rows it rewrites; overrides tuned
  for a dead world are stale).
- Live-application semantics, documented not hidden. Zombie respawns are strictly
  one-in-one-out: `killZombie` pushes exactly one respawn entry (`zombies.ts:126`) and
  `tickZombieRespawns` spawns one per entry (`zombies.ts:329-346`), so the population is
  invariant at the boot-time spawn count — raising the cap alone admits ZERO new
  zombies. The POST handler therefore **tops up**: when the new effective cap exceeds
  `zombies.size + pending respawns`, push that many `ZombieRespawn` entries
  (`{ t: ZOMBIE_RESPAWN_S, mil: false }`) so the existing spawn machinery fills the gap
  organically, at normal respawn cadence and positions. Lowering culls nothing — the
  cap bites on respawns (`zombies.ts:334`). **Already-connected clients render the
  top-up** because the render pools grow lazily on exhaustion (§5 Zombies/Animals
  rows, M4): welcome-time config sizes the initial pool only, never caps rendering.
  This dependency is load-bearing — nothing re-sends config to a connected client
  (disconnect returns to menu, no auto-reconnect, `connection.ts:180-198`), so with a
  fixed-size pool every zombie above the old effective cap would be invisible to every
  connected player while still simulated, chasing, and damaging them. `maxPlayers`
  lowering never kicks anyone;
  it gates new joins. `/api/server-info` badges reflect overrides within the 15s
  micro-cache TTL (the DO serves `summarizeRules(state.config)` — §6).

Anything beyond these four fields (plus the restore action) = redeploy with a new
`GAME_CONFIG`. A web panel is explicitly out of scope.

### 8. Client-side variant handling (verified)

- **Zombies off**: server sends empty `zombies` arrays; `Zombies.tsx`'s frame loop
  (`Zombies.tsx:79-132`) iterates nothing and every pooled rig stays
  `visible = false` — confirmed graceful with zero changes. M4 additionally skips the
  mount in `GameCanvas.tsx:59` to avoid allocating `ZOMBIE_MAX` rigs
  (`createPool()`, `Zombies.tsx:57-69`). Audio: zombie sounds are event/proximity
  driven off snapshot entities — no entities, no cues.
- **Deer scaled or off**: `Animals.tsx` follows the zombie pooling pattern but its pool
  is sized `DEER_COUNT + 4 = 14` at module scope (`Animals.tsx:18`) — too small for
  homestead (20 deer) and driftwood (15); overflow deer are simulated but never render.
  Initial pool from `effectiveDeerMax(clientWorld.config) + 4` plus lazy growth on
  exhaustion (§5 table rows — growth is also what keeps §7's live density raises
  visible without a rejoin); at 0, conditional mount, identical to zombies.
- **PvP off**: no render change needed (other players already render). Optional HUD
  badge deferred to doc 02's join flow.
- **Day length / fixed hour**: `SkyAndLighting.tsx` reads `clientWorld.timeOfDay`,
  which `interpolation.ts:38` computes — switching that one call site (plus
  `connection.ts:275,307` for the HUD clock) to `effectiveGameHour` makes the sky,
  clock and server warm-hours logic agree by construction. `fixedHour` freezes
  `timeOfDay`; the sky renderer is a pure function of hour and handles a constant
  input trivially (`SkyAndLighting.tsx:183-190`).
- **No-welcome-config fallback**: `clientWorld.config` initializes to
  `DEFAULT_CONFIG`, so every read path is total even against an old server.

## Implications

**Opens up**

- Community servers with personality on day one — the directory (doc 03) gets real
  badges instead of a wall of identical clones, and the six presets are marketing copy
  that writes itself.
- `nightfall`-style total-conversion-by-config proves the welcome-transport pattern;
  doc 06 (building) and doc 07 (water) get their config groups reserved and validated
  before their features exist.
- The fingerprint generalizes the seed wipe: any future worldgen knob is one more
  fingerprint component, not a new persistence mechanism.
- Admin override machinery (meta row + whitelist merge) is the seed of any future ops
  tooling.

**Complicates**

- `GameState.config` threads through every system signature-free (it's already passed
  as `state`), but **tests and the loadtest bot** must now construct a config;
  `createGameState` gains a required parameter (one-line fix at each call site,
  `scripts/loadtest.mjs` is protocol-level and unaffected).
- M1 stands up the repo's **first test harness** — `package.json` has no test runner,
  no test script, no vitest/jest/miniflare today. Vitest in plain node mode covers
  everything pure (`resolveServerConfig`/`clampConfig` fuzzing, `DEFAULT_CONFIG` ⇔
  constants, fingerprint round-trip, epoch math, and M6's world hashing —
  `createWorld` is pure shared code, so hashing it once covers both sides). M2's
  DO-storage acceptance runs as a scripted procedure against `wrangler dev`'s local
  SQLite state, or via `@cloudflare/vitest-pool-workers` if M2 chooses to add it —
  either way the cost is named here, not smuggled into "zero behavior change" M1.
- The fail-closed wipe rule trades convenience for safety: deliberately changing the
  world now requires an explicitly present, cleanly-parsed `GAME_CONFIG`. A typo (or a
  deploy that drops the var) boots the OLD world with a loud error instead of wiping —
  the right default for an irreversible action; the cost is one extra explicit step in
  doc 01's "change my world" runbook.
- Leaderboard comparability: `survivedS` is game-seconds; servers with different
  `dayLengthMin` produce incomparable "days survived" numbers, and `driftwood` lives
  (no threats) will dwarf `ironcoast` lives. Fine per-server (each DO has its own
  leaderboard, `persistence.ts:341-359`); doc 03 must NOT build a cross-server
  leaderboard from these numbers without normalizing.
- The welcome message grows ~700 bytes — negligible (once per join, snapshots dwarf it).
- Six presets are six tuning surfaces to keep honest as constants evolve; the
  partial-over-default representation means presets only pin what they mean to pin.

**Breaks**

- Nothing for the default deploy: `DEFAULT_CONFIG` is asserted equal to today's
  constants, `worldParamsOf` returns the same seed, the fingerprint migration writes
  itself in-place without wiping, and old clients ignore the new welcome field.
- `createGameState(world)` → `createGameState(world, config)` is a compile break for
  any out-of-tree callers (there are none in-repo besides `GameRoom.ts:355`).

**Threatens**

- **Determinism, if an implementer takes a shortcut**: the moment any worldgen input
  comes from config, a server that resolves config differently from what it sent in
  `welcome` (e.g. admin override of a world field — forbidden, enforce in the
  whitelist) generates divergent worlds and silent prediction corruption. Mitigation:
  `worldParamsOf` is the only worldgen input path, WIPE-class fields are excluded from
  `ADMIN_LIVE_FIELDS` by construction, and the server asserts `seed ===
  config.world.seed` at boot.
- **Perf envelope at the edges**: `zombieDensity` 2 → 120 zombies; the O(n²)
  separation pass (`zombies.ts:240-294`) goes from ~1.8k to ~7.2k pair checks/tick and
  snapshots grow. The verified envelope is 0.51 ms EMA at 60 zombies/20 bots
  (`codebase-server.md` §5) — 2× density is inside budget on paper, which is why the
  clamp is 2 and not 3. M3's acceptance includes a loadtest at `zombieDensity: 2`.
- **Free-plan operators**: config does nothing about the rows-written ceiling
  (`cf-costs.md`); a "plentiful loot" preset slightly raises `world_state` row counts.
  Not a new risk, but preset docs in doc 01 should repeat the paid-plan recommendation.

## Migration & compatibility

- **Official deployed instance** (`survival-game.adam-730.workers.dev`): no
  `GAME_CONFIG` var → `DEFAULT_CONFIG` → behavior identical. First boot after deploy
  finds `world_seed=1337` matching and `world_fingerprint` absent → writes the
  fingerprint without wiping. Characters, world state, leaderboard all survive.
  `SCHEMA_VERSION` stays 2 — nothing about the persisted *shape* changes (new meta
  rows are additive, the established precedent at `persistence.ts:233-235`).
- **Existing saves under non-default LIVE config**: valid by classification — item
  types, positions, world geometry are all unchanged by LIVE fields.
- **Protocol**: additive optional `config` on `welcome`; open tabs across the deploy
  behave as today (old client ignores it). No other message changes. `PROTOCOL_VERSION`
  introduction belongs to doc 03; when it lands, this feature is part of version 2's
  changelog.
- **Worlds on other tiers / seeds**: by definition new worlds; the sanctioned
  fingerprint wipe is the migration (leaderboard survives, matching operator
  expectations set by today's seed-change behavior — now with a PITR bookmark first).
  Wipe-*schedule* changes are NOT migrations: they re-anchor the schedule/epoch pair
  without wiping (§4); only a crossed boundary under an unchanged schedule wipes.
- **Rollback / var loss**: removing `GAME_CONFIG` reverts LIVE fields to defaults on
  the next boot — confusing on a warpath server, so doc 01's update flow must carry the
  var forward and pass `keep_bindings: ["secret_text"]` to preserve `ADMIN_TOKEN` (§4),
  and `keep_vars: true` protects dashboard edits. It does **not** wipe
  a non-default world: an absent var is indistinguishable from "operator never set one"
  (both standard update paths can silently drop it), so the fail-closed rule (§4)
  refuses the automatic wipe and boots the world from the stored fingerprint with a
  loud config-error. Deliberately reverting to the default world = set `GAME_CONFIG` to
  an explicit value whose world fields differ (e.g. `"deadcoast"`); that is a present,
  cleanly-parsed config and wipes normally (bookmark first). Document loudly in doc 01
  that *deliberately* changing world fields in either direction costs the world — and
  that accidents no longer do.

## Implementation plan

Milestone 0 dependency: none of this blocks on docs 01/03/06/07; reserved fields are
validated no-ops until their docs land.

1. **M1 — `src/shared/config.ts` + plumbing + test harness, zero behavior change**
   *(Opus 4.8 — protocol + determinism-sensitive surface)*. Scope: full schema,
   `DEFAULT_CONFIG`, `DeepPartial`/`mergeConfig`, `resolveServerConfig` with
   warnings + `varAbsent`/`worldTainted` flags, `clampConfig` (the shared client-side
   clamp), `PRESETS` (all six), `worldParamsOf` (seed-only for now; non-default
   `world.seed` coerces to `WORLD_SEED` with a warning until M2 — see §2),
   `effectiveGameHour`, `effectiveZombieMax`, `effectiveDeerMax`, `summarizeRules`,
   `worldFingerprintOf` + `parseWorldFingerprint`, `wipeEpochOf`; `Env.GAME_CONFIG?:
   unknown` via interface merging in a new hand-owned `src/server/env.d.ts` — NOT via
   typegen, which derives `Env` from the deliberately var-less wrangler.jsonc and would
   emit a literal value type even if a var were present (§4); `keep_vars: true` in
   `wrangler.jsonc` (one line — protects the
   dashboard-edit path §4 recommends); ARCHITECTURE.md amendment (two lines — it is the
   binding contract and this design changes it in two places: the tunables rule becomes
   "constants.ts holds the defaults; `src/shared/config.ts` holds the deploy-time
   `ServerConfig` layered on top at each system's point of use", and the NET on-welcome
   contract gains the optional `config` field; M6 later amends on-welcome again to
   `createWorld(worldParamsOf(config.world))` — cheap now, expensive when a later
   session "fixes" config.ts back into constants because the stale contract said so);
   GameRoom constructor resolution + boot check
   `seed === config.world.seed` as log-and-coerce, never throw; `createGameState(world,
   config)`; welcome `config` field; client `clientWorld.config = clampConfig(...)`.
   **Test harness setup is in-scope here**: the repo has no test runner (package.json:
   dev/build/typecheck/deploy/cf-typegen only) — add vitest (plain node environment,
   no workers pool needed for pure shared functions) and an `npm test` script.
   Files: `src/shared/config.ts` (new), `src/server/env.d.ts` (new), `state.ts`,
   `GameRoom.ts`, `protocol.ts`, `runtime.ts`, `connection.ts`, `wrangler.jsonc`,
   `ARCHITECTURE.md`, `package.json` — `worker-configuration.d.ts` stays generated
   output, never hand-edited. Acceptance: both tsc projects clean; unit test asserts
   `DEFAULT_CONFIG` ⇔ constants field-by-field; default deploy byte-identical behavior;
   welcome carries config; `resolveServerConfig` fuzz cases (garbage, partials, NaN,
   unknown preset) all return usable configs with warnings, and the world-affecting
   fuzz cases set `worldTainted`; non-default `world.seed` coerces with a warning (the
   M1→M2 window can neither corrupt persistence nor brick boot).
2. **M2 — persistence: fail-closed fingerprint, config meta, wipe schedule** *(Opus
   4.8 — wipe semantics are data-loss-adjacent)*. Depends: M1. Scope: `initSchema(sql,
   boot)` signature returning the effective `WorldConfig` (§4); in-place fingerprint
   migration for legacy `world_seed` rows; the fail-closed decision table (refusal path
   boots from the STORED fingerprint and overrides `this.config.world`) plus the
   unconditional schema-version wipe rule above it; pre-wipe
   `getCurrentBookmark()` capture in try/catch (`"unavailable"` on throw/undefined —
   PITR does not exist under `wrangler dev`, §4) → `pre_wipe_bookmark` meta; full
   wipe-path meta
   enumeration including clearing `admin_overrides`; `config_json` change detection
   with the join-delivered notice (§4 — a boot-time broadcast reaches an empty room);
   `wipe_schedule`+`wipe_epoch` pair with re-anchor-on-schedule-change; lift
   M1's seed restriction. Files: `persistence.ts`, `GameRoom.ts`, `config.ts`.
   Acceptance (DO-storage cases run as a scripted procedure against `wrangler dev`'s
   local SQLite state, or via `@cloudflare/vitest-pool-workers` if the implementer
   prefers a real harness — the pure epoch/fingerprint logic stays in plain vitest):
   v2 DB with seed 1337 survives upgrade un-wiped; explicit seed or tier change wipes
   characters+world, keeps leaderboard, writes `pre_wipe_bookmark`; a `SCHEMA_VERSION`
   bump wipes unconditionally — even with ABSENT or garbage `GAME_CONFIG` (the refusal
   path must never hydrate old-shape rows into new code, §4); **custom-seed world
   + garbage `GAME_CONFIG` boots un-wiped from the stored fingerprint**; custom-seed
   world + ABSENT `GAME_CONFIG` boots un-wiped; weekly epoch boundary crossing wipes
   exactly once; `never` never wipes; `never→weekly`, `weekly→never` and
   `weekly→monthly` transitions all re-anchor without wiping. Local-dev expectation,
   stated up front: under `wrangler dev` every wipe case records `pre_wipe_bookmark =
   "unavailable"` — the real bookmark capture is only verifiable against deployed
   storage (or `@cloudflare/vitest-pool-workers`, if it stubs PITR).
3. **M3 — server systems consume config** *(Sonnet 4.8 — mechanical, table-driven)*.
   Depends: M1. Scope: every server row of the §5 touch-point table (`zombies.ts`,
   `survival.ts`, `combat.ts`, `loot.ts`, `players.ts`, `airdrops.ts`, `wildlife.ts`,
   `GameRoom.ts` session fields AND the `handleJoin` keep-inventory row). Acceptance:
   `driftwood` boots with 0 zombies and `/api/health` confirms; PvP-off server logs no
   player-kill path (manual two-tab test); `fullLoot=false` death leaves an empty
   corpse, live respawn keeps inventory, AND death-screen-disconnect → rejoin restores
   the inventory exactly once (no restore on a second rejoin); loot spawn points never
   leak under `density < 1` — unit-test the §5 invariant (every spawn point holds
   entity XOR pending timer through repeated stock/respawn cycles at density 0.6);
   loadtest passes at `zombieDensity: 2` with tick EMA < 5 ms; default config diff
   shows multiplication-by-1/gate-true only.
4. **M4 — client variant handling** *(Sonnet 4.8)*. Depends: M1 (parallel with M2/M3).
   Scope: client rows of §5 (`interpolation.ts`, `connection.ts`, `GameCanvas.tsx`,
   `Zombies.tsx`, `Animals.tsx`, `DeathScreen.tsx`, `MainMenu.tsx`), including the
   lazy pool growth both entity rows specify. Acceptance:
   zombies-off server renders and allocates no zombie rigs; deer pool sizes to
   `effectiveDeerMax + 4` (homestead renders all 20 deer); pools grow on exhaustion —
   with more wire entities than the initial pool (dev-forged snapshot), every entity
   renders, none silently skipped (this is what makes M5's live density raise visible
   to already-connected clients); `dayLengthMin: 4` visibly
   speeds the sky/clock and matches server warm-hours (temperature behavior flips at
   the displayed hours); `fixedHour: 1` shows a frozen night sky; old-server fallback
   (config absent) plays identically to today; **hostile-config fuzz**: a forged
   `welcome.config` (`zombieDensity: 1e9`, `dayLengthMin: 0`, NaN/negative absolutes)
   is clamped to documented ranges — no runaway allocation, no NaN clock.
5. **M5 — admin v1** *(Sonnet 4.8)*. Depends: M2, plus M4 for the
   renders-on-connected-clients acceptance below. Scope: `ADMIN_TOKEN` secret;
   **auth in `worker.ts` before `stub.fetch`** (404 when unset, 401 on bad bearer —
   never reaching the DO); `GET/POST /api/admin/config`; `POST /api/admin/restore`
   (§7); whitelist enforcement;
   `admin_overrides` meta + boot precedence; live application + notice broadcast;
   zombie **top-up on raise** (§7); `summarizeRules` wired into doc 03's
   `/api/server-info` DO handler (§6 — doc 03 M2 owns the route; if it has not landed,
   this milestone ships only the derivation function). Acceptance: curl
   without/with-wrong token answered by the Worker
   (404/401, zero DO requests); GET reflects env + overrides and echoes
   `preWipeBookmark`; POST raising
   `zombieDensity` tops up — population climbs to the new cap at respawn cadence
   *without a restart*, and an **already-connected client renders every new zombie**
   (M4's lazy pool growth; without it they'd be invisible-but-simulated, §7) — and
   lowering bites on respawns; overrides survive a DO
   restart and are cleared by a world wipe; POST of a non-whitelisted path → 400
   naming it; admin endpoints still answer 200/401 — not 404 — after a doc-01-style
   REST version update (exercises §4's `keep_bindings: ["secret_text"]` obligation);
   restore, against a DEPLOYED instance only (PITR is absent under `wrangler dev`,
   §4): wipe → revert `GAME_CONFIG` → `POST /api/admin/restore` brings the world back.
6. **M6 — world size tiers** *(Opus 4.8 — worldgen, determinism-critical)*. Depends:
   M1+M2 **and doc 03's `PROTOCOL_VERSION` join gate (hard dependency)** — a
   non-standard-tier server must refuse joins from clients that predate worldgen-param
   awareness, or a stale tab builds standard geometry from the bare seed
   (`connection.ts:260`) and plays inside divergent walls/terrain/loot with zero
   detection (§4). Coordinate with doc 07 before starting (water features join the
   same `createWorld` params change). Scope: `createWorld(params)` with
   `WorldGenParams` from `worldParamsOf`; `World.size` field; replace `WORLD_SIZE`
   reads in `zombies.ts:110`, `wildlife.ts:63-64`, `airdrops.ts:38`, `Terrain.tsx`,
   `WaterPlane.tsx` with `world.size`; un-restrict `sizeTier` validation. Acceptance:
   `standard` worlds bit-identical to pre-change (hash building/tree/loot positions in
   the vitest harness — `createWorld` is pure shared code, so one environment's hash
   covers client and server); all three tiers hash deterministically across repeated
   runs; tier change wipes via fingerprint; old-client join against a non-standard
   tier is refused by the version gate; large/huge play sanity (spawn ring finds
   beaches, military sites, town counts).

## Open questions

1. **Preset names** — `deadcoast` / `driftwood` / `ironcoast` / `warpath` /
   `homestead` / `nightfall`. Taste call; they're cheap to rename until doc 02 prints
   them on directory badges. Recommendation: keep these; they're one-word, lowercase-id
   safe, and on-theme without colliding with trademarked game titles.
2. **`zombieDensity` ceiling** — I clamped at 2 (120 zombies) based on the measured
   0.51 ms envelope; 3 would likely still fit but grows snapshots and the O(n²)
   separation pass nonlinearly. Recommendation: ship 2, raise after a 120-zombie
   loadtest if anyone asks.
3. **`fullLoot=false` semantics** — I chose "corpse spawns empty, respawn restores
   inventory" (no item duplication, body still marks the death). The no-destruction
   promise only holds because BOTH respawn paths restore: the live-socket path
   (`respawnPlayer`) and the death-screen-disconnect → rejoin path (`handleJoin`
   path 3 seeds from the dead row's `state_json` — §5 table row); covering only the
   live path would silently destroy the kept inventory on driftwood and homestead.
   Alternative: items stay on the corpse AND respawn restores copies (dupes items
   into the world). Recommendation: as designed; the alternative breaks the loot
   economy.
4. **Whole config in welcome vs subset** — I chose whole (~700 bytes, drift-proof).
   Subset saves bytes nobody is counting. Recommendation: whole.
5. **Should `threats.zombies=false` also imply `militaryZone=false` loot?** With no
   garrison, the compound is a free rifle piñata. I kept them independent (driftwood
   deliberately keeps military loot as the exploration prize; homestead turns it off).
   Recommendation: independent, presets express the intent.
6. **Admin live whitelist** — proposed `zombieDensity`, `respawnRate`, `pvp.enabled`,
   `maxPlayers`. Argument for adding `loot.airdrops` (event hosting: "drop party").
   Recommendation: ship the four; add airdrops in v1.1 if server owners ask.
7. **Wipe anchor/time** — epoch boundaries land at 00:00 UTC (≈ 6–7 PM Central, prime
   time — same hazard cf-costs.md flags for billing resets), and for any monitored
   server the wipe executes effectively AT the boundary: `initSchema` runs on every DO
   construction, and a health poll or leaderboard fetch re-constructs an evicted DO
   within minutes (§4) — "first player join" was wrong. Recommendation: accept for v1,
   documented; if operators object, move the epoch check into `ensureGame()` so it
   waits for a real join — at the cost of splitting wipe logic across two sites (the
   fingerprint check must stay in `initSchema`, which guards hydration) — or treat a
   scheduled-alarm wipe at a quiet hour as doc-03-era polish.
8. **Site/directory layout assumption** — nothing in this design contradicts the
   working assumption (second worker in `site/`); this doc's only contact points are
   the `summarizeRules` export and the `/api/server-info` endpoint doc 03 owns.
