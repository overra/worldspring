# Doc 04 M1–M2 — implementation plan

> Anchor-verified plan produced by the `wave0-next-milestones` workflow against `main` (commit df13557).
> Persisted so the milestone is implemented one careful PR at a time. It was deliberately **not**
> auto-implemented: the fail-closed `world_fingerprint` wipe (M2) is data-loss-sensitive and wants a
> reviewed session.

**readyToImplement:** true

## Milestone

Doc 04 M1–M2 — packages/shared/src/config.ts (ServerConfig + 6 presets + validation + derivations), config plumbing into GameRoom/welcome/client, the repo's first vitest harness, and the fail-closed world_fingerprint wipe in persistence.ts. Two PRs: M1 (zero behavior change + harness), M2 (fail-closed fingerprint + config meta + wipe schedule, lifts M1's seed restriction).

## Depends on

- Wave 0 spine item; verified on main @ df13557 (doc 03 M1 #11, monorepo #10, persistAll single-row fix #9 all merged)
- NO hard code dep on doc 03 M2: PROTOCOL_VERSION is still 1 and welcome already carries proto (GameRoom.ts:537) — M1 adds an additive `config?` field and does NOT bump proto. Doc 03 M2's stub config.ts has NOT landed (clean slate verified), so README's 'doc 04 M1 replaces it' is moot here — M1 CREATES packages/shared/src/config.ts outright. Coordinate only if doc 03 M2 lands first (then M1 truly replaces the stub; merge-order note below).
- M6 (size tiers) is OUT OF SCOPE for M1–M2 and is subsumed by doc 07 M1–M2 per README; M1 ships worldParamsOf returning {seed} only and coerces any non-default world.seed back to WORLD_SEED until M2 lifts it.
- persistAll single-row fix (#9) MUST stay merged — M2's wipe path and meta rewrites are written against the single-row world_state schema in persistence.ts; do not reintroduce per-entity rows.

## Summary

Build-ready plan for the determinism- and data-loss-sensitive chokepoint. Verified every doc anchor against the real monorepo paths (docs predate it: src/shared → packages/shared/src; src/server → apps/game/src/server). Confirmed CLEAN SLATE: zero config plumbing exists anywhere (grep for ServerConfig/clampConfig/GAME_CONFIG/world_fingerprint returns nothing), and NO test runner exists (vitest not installed; package.json has only build/typecheck/dev/deploy via turbo). The fingerprint harness the README references already exists at packages/shared/scripts/fingerprint.mjs with baseline packages/shared/scripts/world.fingerprint.txt — it esbuild-bundles createWorld over an 8-seed matrix and hashes geometry+height grid; it is the doc 09 worldgen gate and is the regression oracle M1/M2 must keep green (it does NOT need to change for M1–M2 because standard-tier worldgen is byte-identical, but run it as a gate).

DATA-LOSS / FAIL-CLOSED SEMANTICS (the core of M2). persistence.ts #9 reworked storage into a single world_state 'snapshot' row plus meta rows; initSchema (apps/game/src/server/persistence.ts:88-126) today wipes characters+world_state (KEEPS leaderboard) ONLY when meta schema_version !== '2' OR world_seed !== '1337' (lines 116-126: DELETE FROM characters; DELETE FROM world_state; DELETE FROM meta; then re-set both meta rows). M2 generalizes the seed half into a world_fingerprint gate that FAILS CLOSED. Exact wipe triggers and preservation, binding:
- schema_version mismatch → wipe UNCONDITIONALLY (bookmark captured first), regardless of config provenance — version bumps are code-driven and old-shape rows may not parse under new code, so the refusal path below must NEVER apply to a schema bump (it would hydrate dead rows). This is today's version-half, preserved.
- world_fingerprint (canonical 'v1|seed:1337|size:standard|water:0' of WIPE-class fields seed/sizeTier/waterFeatures) vs stored, ONLY when schema_version matches: match→boot normally; mismatch + varAbsent (no GAME_CONFIG in env)→REFUSE TO WIPE, boot from STORED fingerprint via parseWorldFingerprint, overwrite this.config.world so worldgen+welcome+clients agree, console.error + surface in admin GET; mismatch + worldTainted (any world field from fallback/coercion: unparseable JSON, unknown preset name, bad world value)→same refusal; mismatch + explicit cleanly-parsed world config→SANCTIONED WIPE.
- characters are PRESERVED on a benign config edit because LIVE-class fields (threats/loot/survival/pvp/time/wildlife/building/session/preset) are NEVER part of the fingerprint, so editing zombieDensity or dayLengthMin does NOT change the fingerprint and cannot wipe. leaderboard ALWAYS survives every wipe (matches today). Worst-case data-loss path the design closes: a one-char GAME_CONFIG typo (or a deploy that DROPS the var — wrangler deletes dashboard vars without keep_vars; doc 01's multipart PUT replaces bindings wholesale) falls back to seed 1337, mismatches a custom-seed world's stored fingerprint, and naive composition would DELETE FROM meta (persistence.ts:123) erasing the only record of the real seed. The varAbsent/worldTainted flags from resolveServerConfig (M1) are exactly what let M2 refuse. A SANCTIONED wipe first awaits ctx.storage.getCurrentBookmark() inside try/catch (PITR is unsupported under wrangler dev — throw-or-undefined → store 'unavailable', NEVER block the wipe, NEVER crash-loop the constructor), then clears characters+world_state and rewrites meta ENUMERATED IN FULL (schema_version, world_fingerprint, wipe_schedule, wipe_epoch, config_json, pre_wipe_bookmark) and deliberately does NOT rewrite admin_overrides (a wipe clears it). Deliberately reverting a custom world to default is an EXPLICIT act: set GAME_CONFIG to a concrete value ('deadcoast'), never delete the var.

PERSISTENCE CONSISTENCY (no re-break of #9): all new meta rows are additive INSERT OR REPLACE via the existing setMeta helper (persistence.ts:76-78) — the established additive-meta precedent. NOTHING in this plan adds per-entity rows, raises rows-written, or changes the world_state single-row schema. config_json is one meta row (not a world row); the free-plan rows-written math (cf-costs.md §3: ~411 rows/save → single-row fix brought it to O(1)) is untouched because meta writes only happen at boot/wipe, not per-save. Characters are never touched by any LIVE config change.

DOC 03 M2 STUB HANDOFF (real path packages/shared/src/config.ts). README canonical-vocab says 'Doc 03 M2 ships a stub config.ts; doc 04 M1 replaces it.' Verified doc 03 M2 has NOT landed — there is no config.ts. So M1 CREATES the full file. Merge-order contingency: if doc 03 M2 merges first and ships a stub, M1 must fully replace it (re-export anything doc 03 imported from it; check doc 03's actual imports at merge time). Either way doc 04 owns ServerConfig/PRESETS/GAME_CONFIG/resolveServerConfig/clampConfig/summarizeRules/world_fingerprint per the vocab table.

FIRST VITEST HARNESS (lives in packages/shared; turbo wiring). The repo has no test runner. M1 adds vitest as a devDependency to packages/shared/package.json (the package whose pure functions are under test), a 'test' script there, a root 'test': 'turbo run test' script, and a 'test': {} task entry in turbo.json. Plain node environment (no @cloudflare/vitest-pool-workers needed — config.ts and the derivations are pure shared code). DETERMINISM HARNESS HAZARD: vitest must resolve the @worldspring/shared/* subpath exports (package.json exports map: ./constants, ./items, etc.) and transpile .ts ESM — vitest's esbuild transform handles this, but verify import paths resolve in-test (config.ts imports type LootTier from ./items and constants from ./constants). The M1 field-by-field unit test asserts DEFAULT_CONFIG ⇔ shipped constants: world.seed===WORLD_SEED(1337), session.maxPlayers===MAX_PLAYERS(24), session.respawnDelayS===RESPAWN_DELAY_S(4), session.logoutLingerS===LOGOUT_LINGER_S(60), time.dayLengthMin===DAY_DURATION_S/60(16), time.startHour===START_HOUR(9), time.fixedHour===null, and EVERY multiplier===1 / EVERY toggle matching today (threats.zombies true, militaryZone true, pvp.enabled true, pvp.fullLoot true, building.enabled true, building.pieceCapPerPlayer 120, building.decayHours 168, building.offlineRaidMult 0.25, session.wipeSchedule 'never'). M2's DO-storage cases extend the EXISTING in-memory-SqlStorage mock pattern already proven at apps/game/scripts/persist-roundtrip.mjs (node --experimental-strip-types, fake sql.exec switch, imports persistence.ts directly) — add a getCurrentBookmark stub to the fake storage; the pure epoch/fingerprint round-trip logic stays in plain vitest.

DETERMINISM (sacred). M1–M2 introduce NO new rng draws: worldParamsOf returns {seed} only and createWorld(seed) is UNCHANGED (world.ts:342), so existing stream draw order is frozen and the committed world.fingerprint.txt stays green for all 8 seeds. New hash-salted streams are a M6/doc-07 concern (subsumed by doc 07). The fingerprint GATE that matters for M1–M2 is the worldgen-equality gate (packages/shared/scripts/fingerprint.mjs) — run it to prove standard-tier byte-identity. The SEPARATE world_fingerprint string (config WIPE-class identity) is new persistence machinery, NOT the worldgen hash; do not conflate them. The boot check seed===config.world.seed is log+coerce, NEVER throw (a throwing constructor crash-loops the DO).

## Edit sites

### `packages/shared/src/config.ts` — create (M1)

THE new file. Full ServerConfig schema (WorldConfig/ThreatsConfig/LootConfig/SurvivalConfig/PvpConfig/TimeConfig/WildlifeConfig/BuildingConfig{enabled,pieceCapPerPlayer,decayHours,offlineRaidMult}/SessionConfig), imports `type LootTier` from ./items (verified export at items.ts:128: coastal|inland|military) for tierDensity Record. DEFAULT_CONFIG = deadcoast (all multipliers 1, toggles match constants). DeepPartial<T> + hand-rolled mergeConfig (allowlist walk, NOT Object.assign — also the admin injection guard). resolveServerConfig(raw:unknown):ResolvedConfig{config,warnings,varAbsent,worldTainted} accepting undefined|preset-name|JSON-string|{preset,overrides}; clampConfig(raw):ServerConfig (the client-side total clamp). PRESETS: Record<string,DeepPartial<ServerConfig>> all six per §3 matrix (deadcoast/driftwood/ironcoast/warpath/homestead/nightfall). worldParamsOf(world):{seed} — M1 SEED-ONLY; non-default world.seed coerces to WORLD_SEED(1337) with warning + sets worldTainted (until M2). effectiveGameHour/effectiveZombieMax/effectiveDeerMax derivations. summarizeRules(cfg):RulesSummary (type lives in doc 03's serverInfo.ts; derivation here — if doc 03 M2 not landed, ship derivation + a local type, wire to route later). worldFingerprintOf(world)+parseWorldFingerprint(fp):WorldConfig|null (round-trippable, 'v1|seed:..|size:..|water:..'). wipeEpochOf(schedule,nowMs) with ANCHOR_MS=Date.UTC(2026,0,5). Strict TS, named exports, no deps. M2 LIFTS the seed coercion (worldParamsOf honors custom seed once persistence compares the fingerprint).

### `packages/shared/package.json` — edit (M1)

Add the new ./config subpath to the exports map (mirrors ./constants etc., verified exports block lines 6-15). Add vitest to devDependencies and a 'test':'vitest run' script (and optionally 'test:watch'). This is the package whose pure functions are tested.

### `package.json` — edit (M1)

Add root 'test':'turbo run test' script alongside build/typecheck (verified scripts block lines 10-20). No new root dep needed (vitest lives in packages/shared).

### `turbo.json` — edit (M1)

Add a 'test': {} task entry to tasks (alongside typecheck:{}, verified line 7). Keep it dependsOn-free and uncached-by-default-is-fine, or add outputs for coverage if enabled.

### `apps/game/src/server/env.d.ts` — create (M1)

Hand-owned ambient decl: `declare global { interface Env { GAME_CONFIG?: unknown; ADMIN_TOKEN?: string } }` (ADMIN_TOKEN reserved for M5; harmless to declare now or defer to M5 — recommend declaring GAME_CONFIG only in M1, add ADMIN_TOKEN in M5). Interface-merges into the generated Env (verified worker-configuration.d.ts:12/14 declare `interface Env extends __BaseEnv_Env {}`). Auto-picked-up: tsconfig.server.json include is ['src/server','worker-configuration.d.ts'] (verified) so src/server/env.d.ts is in scope. NOT via typegen (derives Env from var-less wrangler.jsonc; would emit a literal type if a var existed). worker-configuration.d.ts stays generated — never hand-edit.

### `apps/game/wrangler.jsonc` — edit (M1)

Add `"keep_vars": true` (one line) to protect the dashboard-edit path §4 recommends (without it the next wrangler deploy silently deletes dashboard-set GAME_CONFIG). Do NOT add a GAME_CONFIG var to the official config — the official deploy is deliberately var-less (verified wrangler.jsonc has no vars block) so it resolves to DEFAULT_CONFIG. Verified current keys: name/main/compatibility_date/assets/durable_objects/migrations/observability.

### `apps/game/src/server/systems/state.ts` — edit (M1)

GameState interface (line 221) gains `config: ServerConfig`. createGameState(world) (line 256) → createGameState(world, config) and set config in the returned object. VERIFIED only ONE in-repo caller besides the definition: GameRoom.ts:356 (import at :84). Import ServerConfig from @worldspring/shared/config.

### `apps/game/src/server/GameRoom.ts` — edit (M1+M2)

M1: constructor (lines 154-162) — resolve config from env BEFORE initSchema: `this.resolved = resolveServerConfig(env.GAME_CONFIG)`, store this.config = this.resolved.config, log this.resolved.warnings. ensureGame (lines 353-366): createWorld(worldParamsOf(this.config.world)) (still {seed} in M1) + createGameState(world, this.config); boot check `if (game.world.seed !== this.config.world.seed) console.error(...)` — log+coerce, NEVER throw. sendWelcome (lines 526-545): add `config: this.config` to the welcome object (after proto/seed). M2: the blockConcurrencyWhile closure (lines 156-159) awaits ctx.storage.getCurrentBookmark() in try/catch and passes the boot bundle {fingerprint,wipeSchedule,wipeEpoch,configJson,varAbsent,worldTainted,bookmark} into the new initSchema signature, then applies the returned effective WorldConfig back onto this.config.world (the refusal path overrides it). Session fields are M3 (out of scope here) — do NOT touch MAX_PLAYERS/RESPAWN_DELAY_S/LOGOUT_LINGER_S sites in M1/M2.

### `packages/shared/src/protocol.ts` — edit (M1)

welcome ServerMsg variant (lines 219-238) gains additive optional `config?: ServerConfig` (import the type from ./config). Do NOT bump PROTOCOL_VERSION (still 1, line 28) — additive optional field per the established forward-compat rule (same as how proto itself was added). gameHours stays (line 359, used by effectiveGameHour).

### `apps/game/src/client/runtime.ts` — edit (M1)

ClientWorldState interface (lines 137-167) gains `config: ServerConfig`; the clientWorld literal (lines 169-187) initializes it to DEFAULT_CONFIG (import both from @worldspring/shared/config). Makes every client read-path total against an old/absent-config server.

### `apps/game/src/client/net/connection.ts` — edit (M1)

onWelcome (lines 267-309): `clientWorld.config = clampConfig(msg.config)` — NEVER store the raw object (the §2 trust note: a hostile open-source server's welcome.config drives client alloc sizes/divisors). Keep createWorld(msg.seed) in M1 (worldParamsOf is seed-only; M6 switches to worldParamsOf(config.world)). The HUD clock at line 299 (gameHours(msg.time,DAY_DURATION_S,START_HOUR)) → effectiveGameHour(clientWorld.config.time, msg.time) — this is a client-variant concern; if keeping M1 strictly zero-behavior-change, the clock switch can defer to M4 (DEFAULT_CONFIG makes effectiveGameHour identical to today). Recommend: store config in M1, defer the gameHours call-site swaps to M4 to keep M1 truly byte-identical.

### `apps/game/src/server/persistence.ts` — edit (M2)

initSchema (lines 88-126) signature → initSchema(sql, boot:{fingerprint,wipeSchedule,wipeEpoch,configJson,varAbsent,worldTainted,bookmark}): WorldConfig. Keep the unconditional schema_version-mismatch wipe ABOVE the table (today's version half, lines 116-118 — wipe captures bookmark first). Replace the bare world_seed comparison with the world_fingerprint decision table (match/varAbsent-refuse/worldTainted-refuse/explicit-wipe). GRACEFUL MIGRATION: when world_fingerprint row is ABSENT but legacy world_seed==config seed AND rest-of-fingerprint default → write fingerprint WITHOUT wiping (official deployed world survives). Add meta rows via setMeta (lines 76-78): world_fingerprint, config_json, wipe_schedule, wipe_epoch, pre_wipe_bookmark. Sanctioned-wipe path: clear characters+world_state (KEEP leaderboard, exactly today's DELETE at 121-122), rewrite meta ENUMERATED IN FULL, set pre_wipe_bookmark=bookmark (or 'unavailable'), do NOT rewrite admin_overrides. wipe-schedule: rows absent→write pair no-wipe; schedule changed→rewrite pair no-wipe (re-anchor); schedules equal & epoch>stored→sanctioned wipe once then store epoch; 'never' pins 0. Bump nothing in SCHEMA_VERSION (stays 2 — shape unchanged, additive meta only).

### `ARCHITECTURE.md` — edit (M1)

Two-line amendment shipped IN the M1 PR (it is the binding contract; a later session will 'fix' config.ts back into constants if the contract still says constants-only). (1) Tunables rule at line 27 ('All tunables come from @worldspring/shared/constants') → 'constants.ts holds the DEFAULTS; packages/shared/src/config.ts holds the deploy-time ServerConfig layered on top at each system point of use'. (2) On-welcome contract at lines 76-77 gains the optional `config` field. Note M6 later amends on-welcome again to createWorld(worldParamsOf(config.world)).

### `apps/game/scripts/persist-roundtrip.mjs (pattern reference, M2 test)` — reference (no edit) / extend in test

Existing in-memory SqlStorage mock (fake sql.exec switch, node --experimental-strip-types, imports persistence.ts directly) is the PROVEN precedent for M2's DO-storage acceptance WITHOUT a real DO. Extend this pattern (new test file or vitest case) with a fake DurableObjectStorage exposing getCurrentBookmark (returns a string, or throws to simulate wrangler-dev) to exercise the wipe decision table. Real PITR bookmark capture is only verifiable against deployed storage (or @cloudflare/vitest-pool-workers) — under the mock every wipe records pre_wipe_bookmark='unavailable', matching the doc's stated local-dev expectation.

## Acceptance checks

- M1: both tsc projects clean (turbo run typecheck) — packages/shared + apps/game (client + server projects).
- M1: the field-by-field unit test passes — DEFAULT_CONFIG equals shipped constants for EVERY field (seed=1337, maxPlayers=24, respawnDelayS=4, logoutLingerS=60, dayLengthMin=16, startHour=9, fixedHour=null, all multipliers=1, all toggles match today, building defaults 120/168/0.25, wipeSchedule='never').
- M1: default deploy is byte-identical behavior — no GAME_CONFIG var resolves to DEFAULT_CONFIG with zero warnings and varAbsent=true; createWorld output unchanged (worldparamsOf returns {seed:1337}); the committed packages/shared/scripts/world.fingerprint.txt stays green (npm run fingerprint in packages/shared matches all 8 seed hashes).
- M1: welcome carries config — a join receives welcome.config===resolved ServerConfig; an old client ignores it (additive field), a client receiving no config falls back to clampConfig(undefined)===DEFAULT_CONFIG.
- M1: resolveServerConfig fuzz — garbage strings, partial objects, NaN/Infinity, out-of-range numbers, unknown preset names ALL return a usable config with warnings; world-affecting fuzz cases (unparseable JSON, unknown preset, bad world.seed/sizeTier/waterFeatures) set worldTainted=true; non-default world.seed coerces to 1337 with a warning (the M1→M2 window can neither corrupt persistence nor brick boot).
- M1: clampConfig hostile-input — zombieDensity:1e9 clamps to its documented max (0..2), dayLengthMin:0 clamps into 4..120, NaN/negative absolutes clamp to range — no value escapes its band (the client trust guard).
- M2: a v2 DB with seed 1337 and ABSENT world_fingerprint boots UN-WIPED and writes the fingerprint in place (official deployed world survives the feature landing) — characters, world_state, leaderboard all intact.
- M2: an explicit cleanly-parsed seed-or-tier change WIPES characters+world_state, KEEPS leaderboard, and writes pre_wipe_bookmark (='unavailable' under the mock/wrangler dev).
- M2 (THE fail-closed cases): a custom-seed world + GARBAGE GAME_CONFIG boots UN-WIPED from the stored fingerprint (worldTainted refusal); a custom-seed world + ABSENT GAME_CONFIG boots UN-WIPED from the stored fingerprint (varAbsent refusal); in BOTH this.config.world is overwritten with the parsed stored fingerprint so worldgen/welcome/clients agree, and a configError is recorded.
- M2: a SCHEMA_VERSION bump wipes UNCONDITIONALLY — even with ABSENT or garbage GAME_CONFIG (the refusal path must NEVER hydrate old-shape rows into new code).
- M2: a benign LIVE config edit (e.g. zombieDensity or dayLengthMin change) does NOT change the fingerprint and does NOT wipe — characters preserved (proves fingerprint excludes LIVE fields).
- M2: wipe-schedule transitions — weekly epoch-boundary crossing wipes EXACTLY once; 'never' never wipes; never→weekly, weekly→never, weekly→monthly all RE-ANCHOR (rewrite the pair) WITHOUT wiping.
- M2: getCurrentBookmark capture is wrapped in try/catch — a throw or undefined yields pre_wipe_bookmark='unavailable' and the wipe still proceeds; the constructor never crash-loops (no throw escapes blockConcurrencyWhile).

## Validation commands

```bash
pnpm install   # adds vitest to packages/shared (verified NOT installed today)
pnpm --filter @worldspring/shared test   # M1/M2 pure unit tests (config defaults, fuzz, fingerprint round-trip, epoch math)
pnpm test   # root turbo run test (wires the new task)
pnpm typecheck   # turbo run typecheck — both tsc projects must stay clean after the config-threading + env.d.ts changes
pnpm --filter @worldspring/shared fingerprint   # MUST match the committed world.fingerprint.txt for all 8 seeds — proves worldgen byte-identity (worldParamsOf seed-only)
node --experimental-strip-types apps/game/scripts/persist-roundtrip.mjs   # existing save-path round-trip must still pass after persistence.ts M2 changes
node --experimental-strip-types <M2 wipe-decision test>.mjs   # extend the persist-roundtrip mock with a getCurrentBookmark stub to exercise the fail-closed table (or run as a vitest case)
pnpm dev:game   # smoke: default boot resolves DEFAULT_CONFIG, /api/health responds, welcome carries config (inspect via window.__game.clientWorld.config in dev console)
```

## Determinism hazards

- worldParamsOf MUST return {seed} only in M1 and createWorld(seed) MUST stay unchanged — any new rng draw or changed draw order flips the committed world.fingerprint.txt (8 seeds) and silently desyncs client prediction vs server authority. New hash-salted streams are a M6/doc-07 concern, explicitly out of scope here.
- Do NOT conflate the two 'fingerprints': packages/shared/scripts/fingerprint.mjs + world.fingerprint.txt is the WORLDGEN determinism hash (the gate to run); the new world_fingerprint STRING (v1|seed|size|water) is config WIPE-class persistence identity. They are unrelated; mixing them up could either skip the worldgen gate or mis-gate a wipe.
- The boot check seed===config.world.seed is log-and-COERCE, NEVER throw — a throwing GameRoom constructor crash-loops the DO on every wake (the exact failure the never-throw validator exists to prevent). Same rule for the getCurrentBookmark capture (try/catch → 'unavailable').
- M1 honoring a custom world.seed BEFORE M2's fingerprint machinery would hydrate stale world_state into a different world (or crash the boot check) — hence M1 coerces non-default seed to 1337 + worldTainted; M2 lifts this ONLY after initSchema compares the fingerprint. Do not lift the restriction in M1.
- Admin override of any world.* field would make the server generate a world different from what it sent in welcome → silent prediction corruption. WIPE-class fields (seed/sizeTier/waterFeatures) MUST be excluded from ADMIN_LIVE_FIELDS by construction (an M5 concern, but the M1 schema/derivations must not make world fields look live-safe).
- Client MUST run clampConfig(welcome.config) and never store the raw object — config drives client-side allocation sizes (render pool) and divisors (dayLengthMin); a hostile open-source server (doc 02's first-party join path) could send zombieDensity:1e9 (OOM) or dayLengthMin:0 (NaN clock). clampConfig is the shared validation half; the guard is one call (M1) + a fuzz case.
- vitest must resolve @worldspring/shared/* subpath exports and transpile .ts ESM in-test (config.ts imports type LootTier from ./items and constants from ./constants); verify the harness resolves these before relying on the field-by-field assertion. Pin determinism-relevant deps are unaffected here (simplex-noise already pinned 4.0.3), but the test transform must not alter numeric semantics.
- persistence consistency: every new meta row is additive via setMeta (INSERT OR REPLACE) — do NOT add per-entity world rows, do NOT change the single-row world_state schema (#9), do NOT touch the per-save path. config_json/fingerprint/wipe rows are written only at boot/wipe, so the free-plan rows-written ceiling (cf-costs.md §3) is unaffected. The sanctioned wipe must clear characters+world_state but KEEP leaderboard (today's semantics) and must rewrite meta enumerated-in-full so it never leaves a half-written meta table that re-triggers a wipe next boot.

## Open questions (recommendations pre-filled)

- **Q:** Q15 (doc 04 Q1) Preset names — deadcoast/driftwood/ironcoast/warpath/homestead/nightfall. Cheap to rename until doc 02 prints them on directory badges.
  **Rec:** KEEP. One-word, lowercase-id-safe, on-theme, no trademark collisions. ('deadcoast' is also retained as a preset per the Worldspring-rename memory.) No blocker for M1–M2; the registry is single-sourced so a rename is a one-line key change.

- **Q:** Q16a (doc 04 Q2) zombieDensity ceiling — clamp at 2 (120 zombies) vs 3.
  **Rec:** SHIP 2; raise only after a 120-zombie loadtest. Affects only the clampConfig range constant in config.ts. The O(n^2) separation pass and snapshot size grow nonlinearly past 2 (codebase-server.md envelope 0.51ms @ 60z/20bots). Not a M1–M2 blocker (no system consumes density until M3).

- **Q:** Q16b (doc 04 Q3) fullLoot=false semantics — corpse spawns empty + respawn restores (no dup) vs items stay on corpse AND restore (dupes).
  **Rec:** As designed (corpse empty, respawn restores). M3/M5 implementation detail — does NOT touch M1–M2 — but the schema/derivations are designed around it now (pvp.fullLoot boolean). The no-destruction promise needs BOTH respawn paths (live respawnPlayer AND death-screen-disconnect→rejoin handleJoin path 3) to restore — flagged for M3.

- **Q:** Q16c (doc 04 Q4) Whole config in welcome vs hand-picked subset.
  **Rec:** WHOLE (~700B once per join, drift-proof). This IS a M1 decision — the welcome `config?` field carries the entire resolved ServerConfig; the client clamps and ignores what it doesn't read. Settled; implement whole.

- **Q:** Q16d (doc 04 Q5) threats.zombies=false should also imply militaryZone=false loot?
  **Rec:** INDEPENDENT — presets express intent (driftwood keeps military loot as the exploration prize; homestead turns it off). Schema models them as two separate fields (threats.zombies, threats.militaryZone). No M1–M2 impact beyond the schema already reflecting it.

- **Q:** Q18 (doc 04 Q7) Scheduled wipes land at 00:00 UTC (~prime-time Central). For monitored servers the wipe executes effectively AT the boundary (initSchema runs on every DO wake: health poll, leaderboard fetch, /api/server-info cache-miss, or join).
  **Rec:** ACCEPT for v1, documented. This is a M2 SEMANTIC the implementer must encode honestly (epoch counter in initSchema, NOT an alarm — adding an alarm bills a request + a row and breaks the tick-only-while-connected cost model per cf-costs.md §6 lever 3). If operators object later, move the epoch check into ensureGame() (waits for a real join) at the cost of splitting wipe logic — the fingerprint check MUST stay in initSchema (it guards hydration). Not a blocker; ship the epoch-in-initSchema design.

- **Q:** Merge-order with doc 03 M2 (parallel Wave 0). doc 03 M2 'ships a stub config.ts' per the README vocab table, but it has NOT landed (verified: no config.ts exists).
  **Rec:** PROCEED — M1 creates the full config.ts outright. If doc 03 M2 merges FIRST and ships a stub, M1 fully replaces it and must re-export whatever doc 03 imported (grep doc 03's imports at merge time). doc 04 owns these names per the vocab table, so there is no ownership conflict — only a textual replace. No PROTOCOL_VERSION coordination needed (M1 doesn't bump it).

- **Q:** vitest coverage artifacts — .gitignore does not list coverage/ (verified).
  **Rec:** If enabling vitest --coverage, add 'coverage/' to .gitignore in the M1 PR. Minor/optional; default vitest run needs no coverage. Not a blocker.

## ARCHITECTURE.md amendment (ship in the M1 PR)

Ship a two-line ARCHITECTURE.md amendment IN the M1 PR (it is the binding contract; omitting it means a later session 'fixes' config.ts back into constants because the stale rule says constants-only). (1) Replace the tunables rule at ARCHITECTURE.md:27 — 'All tunables come from @worldspring/shared/constants — never inline magic gameplay numbers.' becomes 'constants.ts holds the DEFAULTS; packages/shared/src/config.ts holds the deploy-time ServerConfig layered on top at each system's point of use — never inline magic gameplay numbers.' (2) Amend the on-welcome contract at ARCHITECTURE.md:76-77 (which today reads 'On welcome: build createWorld(seed), set clientWorld.world, ready, myId, seed me from you, store inventory, phase playing') to note the additive optional `config` field is received and clamped (clampConfig) into clientWorld.config. Flag for future maintainers: M6/doc-07 amends on-welcome AGAIN to createWorld(worldParamsOf(config.world)) — cheap to note now, expensive to rediscover.
