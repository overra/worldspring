# Preview Testbed & QA — Isolated Per-PR Worlds as the Pre-Merge Proving Ground

Status: design. Companion docs: 09 (monorepo — lands first; this doc builds on `apps/game`, `packages/shared`, and the emitted `dist/worldspring/wrangler.json`), 04 (the fail-closed wipe this preview surface exists to exercise), 05/06/07 (whose manual two-client smoke tests and loadtests defer here), 08 (the `?debug=1` profiler as a QA tool). Research grounding: `docs/plans/research/codebase-server.md`, `docs/plans/research/cf-costs.md §6`.

## Summary

The CI/CD spine is already on this branch — `.github/workflows/ci.yml` (typecheck + vitest + build + a Linux-canonical worldgen fingerprint gate) and `.github/workflows/preview.yml` (a throwaway `worldspring-pr-<N>` Worker per PR, each with its own fresh Durable Object world). This doc makes that spine **testable**: it adds a preview-only **Testbed** provisioning layer so a fresh-token join lands a player fully kitted, on the dry beach, next to a lit fire — and an **extensible, typed Scenario schema** that drives both that server-side setup and a headless **agent harness**, so every gameplay milestone's two-client smoke test runs in isolation against a disposable world, never against prod data, before merge. It is the manual-QA acceptance harness docs 05/06/07 each defer to.

Two things are the keystone, and the phasing is built around them:

1. **An extensible, typed Scenario schema** (`parseScenario` in `packages/shared`, validated like `resolveServerConfig`) — provisioning primitives and assertions as discriminated unions, NOT a flat item-use list. One type shared by server, build, the harness, and the skill. It grows a **vocabulary** (spawn-zombie / spawn-animal / set-time / set-weather / teleport-to-zone / set-config near the player; assert on the snap fields that already carry `zombies`/`animals`/`loot`/`corpses`/`fires`/`drops`/`weather`/`events`/`count`) so it adapts to *whatever we need to QA* — every primitive reuses an existing authoritative system function.
2. **A `/testbed` Claude Code skill** (a project skill, version-controlled in the repo) that reads a diff/PR/description, infers the touched systems + real item ids + **verbatim** notice strings from the changed code, and emits a schema-validated `apps/game/scenarios/<name>.json` — *and* the human "Manual smoke tests needed" markdown from the **same** artifact, so the two never drift. This is the robust realization of the rejected "checklist-as-code" idea: a regex/markdown parser is fragile; an LLM authoring a **typed, schema-validated** scenario is not.

The **load-bearing invariant** is that **prod is byte-identical to today**. The whole feature hangs off one gate: `env.TESTBED`, read once in the DO constructor (`this.testbed = env.TESTBED === "1"`, beside the `resolveServerConfig` read at `apps/game/src/server/GameRoom.ts:206`), declared ONLY via declaration-merge in `apps/game/src/server/env.d.ts:13` (the same pattern as `GAME_CONFIG`), and **never** in `wrangler.jsonc`. `preview.yml` injects `--var TESTBED:1` on the `worldspring-pr-<N>` deploy (`preview.yml:75-77`); the official deploy never passes it, so `env.TESTBED` is `undefined`, `provisionTestbed()` never runs, and join path 3 (`GameRoom.ts:735`) is byte-identical to today. The design **deliberately rejects** admin WS verbs and any client-trusted flag for v1 — that is prod attack surface — so there is **no new wire surface**: `provisionTestbed` mutates only through existing authoritative code, and the `welcome` message's `you`/`inv` fields (`protocol.ts:232-233`) already serialize everything it sets.

This doc does **not** own doc 01's "deploy into the user's own Cloudflare account" flow. Preview Workers deploy into the **Worldspring account** (per `.github/workflows/README.md`), not a stranger's — an explicit distinction. It documents the determinism fingerprint gate operationally but does **not** own it: doc 07 M1 owns the gate as a CI requirement, doc 08 M4 must keep worldgen bit-identical, and this doc just describes where it lives (`packages/shared/scripts/world.fingerprint.txt`, Linux-canonical, Node pinned via `.nvmrc`).

## Goals / Non-goals

**Goals**

- A preview-only **Testbed** layer: one gated server-side function (`provisionTestbed`) run at fresh-token join, before `sendWelcome`, that seeds loadout + baseline vitals + a lit fire at the player's feet + a coast-station position — through existing system functions only.
- The **prod-safety gate** as a provable invariant: `env.TESTBED` read once in the DO constructor, declared only in `env.d.ts`, injected only by `preview.yml`'s `--var`, guarded by a CI grep that `wrangler.jsonc` contains no `TESTBED` and a unit assertion that `env={}` → `this.testbed === false`.
- An **extensible, typed Scenario schema** with `parseScenario` in `packages/shared` (the keystone), read by `provisionTestbed` AND the harness, with scenarios on disk in `apps/game/scenarios/*.json`.
- A **`/testbed` Claude Code skill** that authors a schema-validated scenario from a change and emits the matching human checklist from the same artifact.
- A headless **agent harness** (`packages/testkit`, `@worldspring/testkit`) forked from the proven `apps/game/scripts/loadtest.mjs` transport, importing protocol/constants from `@worldspring/shared` (killing loadtest's mirrored-constant drift), with a 0/1 exit contract.
- A post-deploy **smoke step** in `preview.yml` (under the existing `CLOUDFLARE_API_TOKEN` gate) that runs the harness and appends per-step PASS/FAIL to the sticky PR comment.
- A **vocabulary-growth path** so the schema adapts to arbitrary QA, reusing existing system functions and the snap fields the wire already carries.

**Non-goals**

- **No new wire surface.** No new `ClientMsg` variant (`packages/shared/src/protocol.ts:68`), no admin WS verb, no client-trusted "I'm a tester" flag. The design rejected admin verbs for v1 as prod attack surface; the `welcome` message's `you`/`inv` fields already carry everything the testbed sets.
- **No sim / persistence / `PROTOCOL_VERSION` change.** This adds process/CI surface and one gated server-side seeding step. `provisionTestbed` mutates the already-created `ServerPlayer`/`GameState` via existing functions; it changes no rng draw, no save shape, and no protocol version (`packages/shared/src/protocol.ts:29`).
- **No `TESTBED` in `wrangler.jsonc`.** Baking it there would defeat the gate (`env.d.ts:1-11` is explicit: a wrangler value would override the code default and `wrangler types` would emit a literal). Inject at deploy time via `--var` only.
- **Not owning the determinism fingerprint.** Doc 07 M1 owns `world.fingerprint.txt` as the gate; doc 08 M4 must keep it bit-identical. This doc documents where it runs (`ci.yml:59-65`), not what it protects.
- **Not doc 01's per-account deploy.** Previews deploy into the Worldspring account; doc 01 owns deploying into the *user's* account. Restated to prevent conflation.
- **No interactive mid-session spawning in v1's core model** — the all-at-join safety property doesn't fit "spawn a zombie NOW." That tension is named as a real decision (§5), not silently papered over.

## Current state

All verified against this worktree.

**The CI/CD spine is already here (the substrate this doc extends, not reinvents)**

- `ci.yml` `verify` job (`.github/workflows/ci.yml:22`): `pnpm -w typecheck` (`48`), `pnpm -w test` (`51`), `pnpm -w build` (`54`), and the worldgen fingerprint diff (`59-65`, against `packages/shared/scripts/world.fingerprint.txt`). **No loadtest / smoke step today.** `permissions: contents: read` only (`18-19`) — a smoke step posting to a PR needs `pull-requests: write`, which `ci.yml` does NOT have and `preview.yml` does.
- `preview.yml` deploys `worldspring-pr-<N>` (`.github/workflows/preview.yml`): a per-PR Worker built by `pnpm --filter @worldspring/game build` (`62`) and deployed via `wrangler-action` v3 with `deploy -c dist/worldspring/wrangler.json --name worldspring-pr-${{ … number }}` (`75-77`, `wranglerVersion "4.99.0"`). The `--name` override + the `v1` migration create a **fresh GameRoom DO namespace** under the per-PR name — so a schema-changing PR exercises doc 04 M2's fail-closed wipe against a throwaway world (header comment `3-6`, deploy comment `64-65`). Everything gated on `CLOUDFLARE_API_TOKEN` being set (`36-46`); fork PRs skipped (`24-26`).
- The sticky-comment step (`preview.yml:79-114`) edits only the `github-actions[bot]` comment carrying the hidden marker `<!-- worldspring-preview -->` (`86`, `103-105`). A smoke PASS/FAIL line appends into its `body` array (`89-96`) or a new step reusing the same marker — **greenfield; there is no smoke step to "extend" yet.**
- The Node pin lives at `.nvmrc` = `22.21.1`, consumed by both workflows (`ci.yml:41`, `preview.yml:53`, both via `node-version-file: .nvmrc`). The fingerprint depends on V8 transcendentals, so the pin is load-bearing (`ci.yml:36-39`).

**The join path the testbed hooks (DO server)**

- `GameRoom.handleJoin` path 3 — the fresh-token branch — starts at `GameRoom.ts:735` (`// (3) Dead row or no row: a brand-new life.`). `createPlayer(...)` at `739`; keep-inventory restore for a dead-row rejoin at `745-748`; recap clear at `749-750`; `sendWelcome(ws, game, player, false, recap)` at `754`; `persistAll(game)` at `755`. A `provisionTestbed()` call sits **after `748`** (so a keep-inventory rejoin doesn't overwrite seeded inventory) and **before `754`** (so the welcome carries the seeded state) — a real window with pre-existing mutations, not a blank gap.
- The DO constructor (`GameRoom.ts:199`) reads `this.resolved = resolveServerConfig(env.GAME_CONFIG)` at `206`; `env` is in scope. `resolveServerConfig` consumes only `GAME_CONFIG` — it does **not** touch `TESTBED`. The flag is an independent additive read: a `private testbed: boolean` DO field set to `env.TESTBED === "1"` at `206-207`, declared alongside the other private fields (~`167-197`).
- `env.d.ts:13` declares `interface Env { SERVER_NAME?; SERVER_MOTD?; GAME_CONFIG?: unknown }` — a script-style file (no import/export) that declaration-merges with the ambient global `Env`. Its header (`env.d.ts:1-11`) is explicit that these stay OUT of `wrangler.jsonc` because `wrangler types` would bake a literal and a wrangler value would override the code default. `apps/game/wrangler.jsonc` has `keep_vars: true` (`:9`) and **no `vars` block**; `dist/worldspring/wrangler.json` emits `"vars":{}` (the `cloudflare()` plugin at `vite.config.ts:7` passes vars through as authored). `TESTBED` appears nowhere in `apps/`/`packages/`/`.github` today (grep clean).

**The provisioning primitives all exist as authoritative functions**

- Position: the beach-ring spawn march (`packages/shared/src/world.ts:534`) marches inward from `WORLD_SIZE*0.49` to `0.2` (`537`) and accepts the dry-beach band `h > 0.4 && h < 1.6` (`541`). The island is radial (`WORLD_SIZE=800`, height has a `-4` sea offset at `world.ts:188`), so **seaward = open ocean and inland = dry land are guaranteed for any seed**. `groundHeight` (`world.ts:806`, exposed at `871`) gives spawn Y. The server computes the ocean/inland facing from its **own** world instance via `yawToDir`/the `(-sin,-cos)` forward convention (`packages/shared/src/math.ts:202`) — the client/agent never reconstruct geometry, which neutralizes the macOS↔Linux worldgen-drift hazard.
- Fire: `players.ts:375` (`case "placeable"`) pushes `{ id, x, y: groundHeight(x,z), z, burnRemaining: CAMPFIRE_BURN_S }` at `381-387`. `nearFire` (`players.ts:313`, duplicated from `survival.ts:98` to avoid an import cycle) uses `FIRE_WARMTH_RADIUS` (`packages/shared/src/constants.ts:64`, `= 5`). Both copies matter if a scenario asserts warmth.
- Loadout: `addToInventory(inv, type, count): number` (`players.ts:279`) tops up stacks then fills empties, keyed on `ITEM_DEFS[type].stack` (`packages/shared/src/items.ts:56`). It is **string-keyed** on `ItemType` (`items.ts:1` — `beans`…`cooked_venison`; **no `canteen_*`, no `fishing_rod`** on main today, grep clean).
- Vitals/cooldowns: `ServerPlayer` carries `diedAt` (`apps/game/src/server/systems/state.ts:49`, gates respawn via `config.session.respawnDelayS`, checked at `GameRoom.ts:505`), `attackCooldown` (`74`), `attackAnimT` (`76`) — a scenario reset writes these directly on the living player.

**The harness substrate (loadtest, the proven transport)**

- `apps/game/scripts/loadtest.mjs` connects over the built-in `WebSocket` and joins with `{ t:"join", name, token, proto: PROTOCOL_VERSION }` (`259-261`), derives `/api/health` from the WS URL (`333-337`, server route `GameRoom.ts:268`), and prints `RESULT: PASS`/`FAIL` returning `failed ? 1 : 0` (`401-403`), with `process.exit(code)` at `434` (fatal/usage path exits `2`, `loadtest.mjs:46,54`). This 0/1 contract is the natural smoke driver.
- It **duplicates every protocol/timing constant** (`loadtest.mjs:21-38`: `PROTOCOL_VERSION=1`, `INPUT_SEND_MS=50`, `MAX_INPUT_DT=0.05`, `MAX_CMDS_PER_FRAME=6`, `RESPAWN_DELAY_S=4`, …) and its header even cites the **wrong path** (`src/shared/protocol.ts` at `:10-11`, `src/shared/constants.ts` at `:16`; the real package is `packages/shared/src/`). The drift-fix target: import from `@worldspring/shared` (`PROTOCOL_VERSION` from `protocol.ts:29`, the rest from `constants.ts`).

**The wire already carries what assertions need**

- The `t:"snap"` variant (`packages/shared/src/protocol.ts:245-263`) carries `you`, `players` (NOT `you`-only), `zombies`, `loot`, `corpses`, `fires`, `drops`, `animals` (NOT `animal`), `weather`, `events`, `count`. **Inventory is NOT in snap** — it is delivered out-of-band as the `welcome` message's `inv` field (`protocol.ts:233`) and via the standalone `t:"inv"` message (`264`, sent by `sendInventory`, `players.ts:267`). A scenario verifying seeded inventory over the wire reads `welcome.inv` / the `inv` frame, never the snapshot.

**No skill/command directory exists yet**

- `.claude/` holds only `launch.json`; there is **no** `.claude/skills/` and **no** `.claude/commands/`. The `/testbed` skill creates the directory from scratch — `.claude/skills/testbed/SKILL.md` (model-invoked, the recommendation, since it is a reusable authoring procedure).

## Design

### 1. The prod-safety gate (the load-bearing invariant)

Everything in this doc is dead code in production. The gate is one boolean, read once:

```ts
// apps/game/src/server/GameRoom.ts — constructor, beside the resolveServerConfig read (:206)
this.resolved = resolveServerConfig(env.GAME_CONFIG);
this.testbed  = env.TESTBED === "1";   // independent additive read; NOT threaded through ResolvedConfig
```

```ts
// apps/game/src/server/env.d.ts (:13) — declaration-merge, same pattern as GAME_CONFIG
interface Env {
  SERVER_NAME?: string;
  SERVER_MOTD?: string;
  GAME_CONFIG?: unknown;
  /** Preview-only. "1" ⇒ provisionTestbed() runs at fresh-token join.
   *  Injected by preview.yml's `--var TESTBED:1`; NEVER in wrangler.jsonc
   *  (a baked value would override this code default). Prod is var-less ⇒
   *  env.TESTBED === undefined ⇒ this.testbed === false. */
  TESTBED?: string;
}
```

The injection point is the existing deploy command — append one token to `preview.yml:75-77`:

```yaml
command: >-
  deploy -c dist/worldspring/wrangler.json
  --name worldspring-pr-${{ github.event.pull_request.number }}
  --var TESTBED:1
```

| Path | `env.TESTBED` | `this.testbed` | `provisionTestbed` |
| --- | --- | --- | --- |
| Production (`worldspring`) | `undefined` | `false` | never runs — join path 3 byte-identical to today |
| Preview (`worldspring-pr-<N>`) | `"1"` | `true` | runs after `GameRoom.ts:748`, before `sendWelcome` at `754` |
| Local dev (`pnpm dev`) | `undefined` unless set | `false`/opt-in | off by default; set `TESTBED=1` in `.dev.vars` to opt in |

Why `--var` and not `wrangler.jsonc`: `env.d.ts:1-11` already documents that vars consumed with code defaults stay out of `wrangler.jsonc` (typegen bakes a literal; a wrangler value overrides the default). `dist/worldspring/wrangler.json` emits `"vars":{}` — confirming nothing flows from source. `--var` sets it at deploy time on the *preview only*, leaving prod's resolved config untouched. **Two CI guards make the invariant testable, not just asserted:** (a) a grep in `ci.yml` that `apps/game/wrangler.jsonc` and `dist/worldspring/wrangler.json` contain no `TESTBED`; (b) a vitest unit that a `GameRoom` constructed with `env = {}` yields `this.testbed === false` and that `provisionTestbed` is never reached on path 3 when `testbed` is false.

### 2. `provisionTestbed` — one gated function, existing code only

`provisionTestbed(state, player, scenario?)` runs server-side on the already-created player (`GameRoom.ts:739`'s `createPlayer` result), after the keep-inventory restore (`748`) and before `sendWelcome` (`754`). It mutates **only** through authoritative functions, so the welcome serializes a legal state:

- **Position:** reuse the beach-ring logic (`world.ts:534-545`) at a fixed angle to land on the dry-beach band, set `player.core.x/z` and `player.core.y = state.world.groundHeight(x,z)` (`world.ts:806`), and set `player.core.yaw` so `yawToDir` (`math.ts:202`) faces seaward — the server reads its own world for the ocean/inland facing, so determinism drift is irrelevant.
- **Fire:** push the exact campfire shape from `players.ts:381-387` at the player's feet, re-granted each join (always lit ⇒ `nearFire` true ⇒ cook/boil work). Note both `nearFire` copies (`players.ts:313`, `survival.ts:98`) if a scenario asserts warmth.
- **Loadout:** `addToInventory(player.inventory, type, count)` (`players.ts:279`) per scenario line. **String-keyed and no-op on unknown ids** — the forward-compat trick: because `addToInventory` is keyed on the `ItemType` string and a scenario line is just `{ type: string }`, an id not yet in the `ItemType` union (`items.ts:1`) is simply never matched, so the testbed JSON is loadable on `main` today and auto-lights-up once `canteen_*`/`fishing_rod` (doc 05's items) enter the union, with no schema edit. (TS-side, the schema types `type` as `string`, not `ItemType`, so naming a future id does not break compilation.)
- **Baseline vitals + cooldowns:** set known values (e.g. hp 50 / food 50 / water 20) so documented deltas are checkable; clear `attackCooldown`/`diedAt` and any item cooldowns directly on the living player (`state.ts:49,74`).

No new message, no new field: the `welcome` message's `you` and `inv` fields (`protocol.ts:232-233`) already carry position, vitals, and inventory. The agent reads the welcome; the human's foreground tab renders it normally.

### 3. The Scenario schema (the keystone) — `parseScenario` in `packages/shared`

The scenario is the contract every consumer shares — server, build, harness, and skill — exactly like `resolveServerConfig` is the one config type. It is an **extensible, typed discriminated union**, not a flat item-use shape, so it can express *whatever we need to QA*. It lives in `packages/shared/src/scenario.ts` with a `parseScenario(input: unknown): Scenario` validator (vitest-tested, never-throws, value set owned here):

```ts
// packages/shared/src/scenario.ts (new; consumed by server, testkit, and the /testbed skill)
export type Provision =
  | { kind: "loadout"; items: { type: string; count: number }[] }   // addToInventory, no-op unknown ids
  | { kind: "vitals"; hp?: number; food?: number; water?: number; temp?: number }
  | { kind: "fire"; atFeet: true }                                    // players.ts:381-387 shape
  | { kind: "position"; zone: "coastal" | "inland" | "military"; face: "ocean" | "inland" }
  | { kind: "clearCooldowns"; which: ("attack" | "respawn" | "item")[] }
  // --- vocabulary-growth primitives (M5; each reuses an existing system fn) ---
  | { kind: "spawnZombie"; nearPlayer: true; count: number }
  | { kind: "spawnAnimal"; species: string; count: number }
  | { kind: "spawnLoot" | "spawnCorpse" | "spawnDrop"; nearPlayer: true; /* … */ }
  | { kind: "setTime"; fixedHour: number }
  | { kind: "setWeather"; intensity: number }                         // snap.weather is 0..1
  | { kind: "config"; overrides: Partial<ServerConfig> };             // per-DO/deploy-time

export type Assert =
  | { on: "inv"; has: { type: string; count: number }[] }             // welcome.inv / t:"inv" (NOT snap)
  | { on: "vitals"; field: "hp" | "food" | "water"; delta?: number; eq?: number }
  | { on: "notice"; matches: string }                                  // VERBATIM server string
  | { on: "error"; matches: string }
  | { on: "snap"; field: "zombies" | "animals" | "loot" | "corpses" | "fires" | "drops" | "weather" | "events" | "count"; /* … */ };

export interface Scenario { name: string; provision: Provision[]; steps?: Step[]; assert?: Assert[]; }
export function parseScenario(input: unknown): Scenario { /* clamp/validate, never throw */ }
```

Scenarios live on disk at `apps/game/scenarios/*.json`, validated by `parseScenario` at load. `provisionTestbed` reads the parsed `provision[]`; the harness reads `provision`/`steps`/`assert`. There is a built-in **default universal testbed** (kitted coast station + fire) used when no scenario is selected; an optional `Testbed: <name>` PR-body line selects a named scenario, resolved at deploy time (config is per-DO/deploy-time, so selection happens when `preview.yml` deploys, e.g. via a second `--var SCENARIO:<name>`).

**Why the snap fields make assertions free:** the wire already carries `zombies`/`animals`/`loot`/`corpses`/`fires`/`drops`/`weather`/`events`/`count` (`protocol.ts:245-263`). The schema only has to *express* an assertion on them — the data is already on the wire. (Inventory is the exception: it rides the `welcome` message's `inv` field / `t:"inv"`, so `on:"inv"` reads those, not snap.)

### 4. The agent harness — `packages/testkit` (`@worldspring/testkit`)

A headless WS harness forked from `loadtest.mjs`'s proven zero-dep transport (`connectBot` at `loadtest.mjs:259`, health-fetch at `333`, 0/1 exit at `401-434`), but **importing** `PROTOCOL_VERSION`/`ITEM_DEFS`/constants from `@worldspring/shared` (`protocol.ts:29`, `items.ts:56`, `constants.ts`) — killing loadtest's mirrored-constant drift (`loadtest.mjs:21-38`). It joins fresh-token, asserts the welcome loadout/vitals (the welcome's `you`/`inv` fields), then drives `{t:"equip"}`/`{t:"use"}`/`{t:"input"}` over the existing protocol (`protocol.ts:68`) and asserts on `snap`/`inv`/`notice`/`error` frames. It **never renders**, so the paused-rAF hidden-tab problem is irrelevant; the human gets the identical server-side setup and their foreground tab runs rAF normally. A `runScenario(wsUrl, scenarioPath)` bin returns `0`/`1`/`2` (PASS/FAIL/usage), mirroring loadtest's contract so the CI smoke step keys on the exit code.

### 5. The honest tension — all-at-join vs interactive QA

The "no new wire surface / all-at-join" safety property is the same property that makes **mid-session interactive** setup (spawn a zombie NOW, advance time NOW) not fit the model: there is no client→server verb to trigger it, by design. This is a real decision, not a gap:

| Option | Covers | Cost |
| --- | --- | --- |
| **(a) Re-join with a richer scenario** | set-up-then-observe — ~90% of QA | none — stays inside the safe model; a new join re-runs `provisionTestbed` with the new scenario |
| **(b) A gated runtime verb / debug ProvPanel** | live "spawn NOW / advance time NOW" | **reopens exactly the wire surface §Non-goals avoids** — a new `ClientMsg` gated on `this.testbed` |

**Recommendation: (a) for v1.** Most QA is "arrange a situation, then observe outcomes," which a re-join serves cleanly. Option (b) is M6 (optional) and is the *only* piece that may reopen a gated runtime request channel — kept behind the testbed flag so prod never sees the verb even if it lands.

### 6. The `/testbed` Claude Code skill (the second keystone)

A project skill at `.claude/skills/testbed/SKILL.md` (created from scratch — no convention exists yet). Given a diff / PR / description, it:

1. reads the changed code to infer touched systems, **real item ids** (against `items.ts:1`), and **verbatim** notice/error strings (so an `on:"notice"` assertion matches the server byte-for-byte);
2. emits a schema-validated `apps/game/scenarios/<name>.json` (validated by `parseScenario`, §3) — failing loudly if validation fails rather than emitting a fragile blob;
3. optionally adds a `Testbed: <name>` line to the PR body (the deploy-time selector) and runs the harness bin;
4. generates the human **"Manual smoke tests needed"** markdown from the **same** `Scenario` artifact — so the agent checklist and the human checklist provably never drift.

This is the robust form of the rejected "checklist-as-code": a regex/markdown parser is fragile, but an LLM authoring a *typed, schema-validated* scenario removes that fragility entirely. The shared `Scenario` type is what lets one artifact drive server provisioning, the agent harness, and both checklists.

### 7. Wiring into `preview.yml` (the smoke step)

The smoke step is greenfield — there is no step to extend. After the deploy step (`preview.yml:66-77`), under the same `steps.gate.outputs.ok == 'true'` guard, add a step that forks the testkit bin against `steps.deploy.outputs.deployment-url` (`preview.yml:83`), captures its 0/1 exit, and appends a per-step PASS/FAIL block into the sticky comment's `body` array (`preview.yml:89-96`) reusing the marker `<!-- worldspring-preview -->` (`86`). `preview.yml` already has `pull-requests: write` (`:20`); `ci.yml` does not (`:18-19`), so the smoke comment belongs in `preview.yml`, not `ci.yml`.

### 8. Worked example — PR #19 (the bar)

PR #19 adds canteen + fishing (doc 05's items). The preview deploys with `--var TESTBED:1`. On a fresh-token join, `provisionTestbed` teleports to the dry-beach station, lights a feet campfire, grants `raw_venison`/`canteen_empty`/`canteen_dirty`/`canteen_clean`/`fishing_rod`/`beans` (unknown ids no-op on `main`, light up under #19), sets baseline vitals, clears the fishing cooldown, faces seaward.

**Agent** (testkit bin): joins, asserts the welcome's `inv`/`you`, then per checklist line equips + uses over the protocol and asserts authoritative replies — cook near fire ⇒ `cooked_venison`, no HP loss; eat raw away from fire ⇒ food +15 / hp −8; canteen fill facing ocean ⇒ dirty; boil near fire ⇒ clean; drink clean ⇒ water +70; drink dirty inland ⇒ water +25 / hp −10; fish facing ocean ⇒ caught-or-nothing disjunction + ~8s cooldown; fish on cooldown ⇒ the verbatim "rod needs a moment" notice; fish inland ⇒ the verbatim "no water ahead" notice; `proto:2` rejoin ⇒ incompatible-version + close. (The exact delta and string values above are doc 05's to define; the `/testbed` skill lifts them verbatim from the changed code.)

**Human:** opens the preview link, clicks JOIN, spawns standing on the fire with the full hotbar, walks the printed checklist (generated from the same scenario by `/testbed`). On current `main` (no canteen/fishing) only the venison cases pass; the rest light up when #19's code lands — which is correct, **#19 is the change under test.**

## Implications

**Opens up:** every gameplay milestone gets a one-command isolated proving ground (kitted player, lit fire, coast station) and an agent that drives its protocol and asserts outcomes — the manual two-client smoke test docs 05/06/07 defer to becomes scripted and PR-gated. The Scenario schema gives QA a typed vocabulary that grows with the game (spawn-zombie, set-weather, teleport-to-zone) without touching the wire. The `/testbed` skill turns "what should I manually test for this PR?" into a generated, schema-valid artifact that also feeds the agent. Doc 08's `?debug=1` profiler becomes a documented QA tool on previews.

**Complicates:** a new shared module (`scenario.ts`) + a new package (`packages/testkit`) + `apps/game/scenarios/` are three edit sites the schema must stay consistent across — mitigated because `parseScenario` is the single validator all three consume. `preview.yml` grows a deploy `--var` and a smoke step; the smoke step's pass/fail must reflect the *actual* harness exit, never claim a green it didn't get (the sticky-comment honesty rule the workflow already follows for teardown, `preview.yml:140-141`).

**Breaks:** nothing in prod. `env.TESTBED` is absent in production ⇒ `this.testbed === false` ⇒ `provisionTestbed` never runs ⇒ join path 3 (`GameRoom.ts:735`) is byte-identical to today. No protocol bump, no persistence change, no `wrangler.jsonc` change. The one behavior change is **preview-only**: a fresh join on a `worldspring-pr-<N>` Worker lands kitted instead of empty — which is the point.

**Threatens:** the safety property rests entirely on the gate being read in exactly one place and `wrangler.jsonc` staying `TESTBED`-free — both made testable by the CI grep + the `env={}` unit assertion (§1). If a future change adds `TESTBED` to `wrangler.jsonc` "for convenience," the grep fails the build. The interactive-QA tension (§5) is a standing pressure: if option (b) is ever taken, it must stay strictly gated on `this.testbed`, or it becomes the prod attack surface the design exists to avoid.

## Migration & compatibility

- **No protocol, no persistence, no `PROTOCOL_VERSION` bump** — this is process/CI surface plus one gated server-side seeding step. The wire (`protocol.ts`), the save shape, and the determinism fingerprint are untouched.
- **Prod is byte-identical.** `env.TESTBED` undefined in production ⇒ the testbed path never executes. `dist/worldspring/wrangler.json` still emits `"vars":{}`; the `--var` lives only on the preview deploy command.
- **ARCHITECTURE.md amendment is light, and explicit about it.** This doc adds no sim/wire/persistence surface, so — like doc 08's "no protocol, no persistence, no `PROTOCOL_VERSION` bump" framing — it does not amend the protocol or determinism sections. **If** it amends ARCHITECTURE.md at all, it is to add a short "Testing / preview" subsection (the `env.TESTBED` gate, the `worldspring-pr-<N>` isolation, and a `.github/workflows` ownership note pointing at `.github/workflows/README.md`) — declared in the milestone that lands it (M1 for the gate, M2 for the workflow surface), shipped in the **same PR as the code** so the next session doesn't "fix" it back to a stale contract.
- **Canonical vocabulary deferral:** where this doc names things other docs own — `world_fingerprint` and the fingerprint gate (doc 04 §4 / doc 07 M1), `worldspring-pr-<N>` and the isolated DO (the preview spine already on this branch), the `?debug=1` profiler (doc 08), and the `canteen_*`/`fishing_rod` items used in the §8 example (doc 05, the items owner per the README canonical-vocabulary table) — the owner's definition is binding; this doc only references them. New names this doc introduces (`Scenario`, `parseScenario`, `provisionTestbed`, `env.TESTBED`, `@worldspring/testkit`) are owned here.
- **Depends on doc 09 landing first:** previews build via `pnpm --filter @worldspring/game build` and the `dist/worldspring/wrangler.json` emit that doc 09 establishes; `packages/testkit` and `packages/shared/src/scenario.ts` assume the workspace shape. This shares doc 09's "infrastructure, do first / no behavior change" framing.

## Implementation plan

One milestone per session; pick one, finish it, run its acceptance checks. Order: M1 → M2 → **M3 (keystone)** → M4 → M5 → (M6 optional). M3 unblocks the schema-driven form of M1's hardcoded testbed and M4's skill; M4 depends on M3; M5 grows M3's vocabulary; M6 is optional and reopens the only debated wire surface.

1. **M1 — hardcoded universal testbed + the prod gate** *(Opus 4.8 — the gate is the load-bearing safety invariant; a leak into prod is the failure mode)*. Files: `apps/game/src/server/GameRoom.ts` (constructor `:206`, the `provisionTestbed` call after `:748`), a new `apps/game/src/server/testbed.ts`, `apps/game/src/server/env.d.ts:13`, `.github/workflows/preview.yml:75-77`, a new vitest under `apps/game`. Scope: add `private testbed: boolean` set to `env.TESTBED === "1"` in the constructor; implement `provisionTestbed(state, player)` seeding loadout (`addToInventory`, `players.ts:279`), a feet fire (`players.ts:381-387` shape), a dry-beach coast position (`world.ts:534`/`806`, faced via `math.ts:202`), and baseline vitals/cooldowns (`state.ts:49,74`); add `TESTBED?: string` to `env.d.ts`; append `--var TESTBED:1` to the preview deploy. Accept: a `worldspring-pr-<N>` preview join lands kitted at the coast next to a lit fire (`nearFire` true) and the welcome's `inv` carries the loadout; a `GameRoom` built with `env={}` yields `this.testbed === false` and `provisionTestbed` is never reached (unit); a CI grep proves `wrangler.jsonc` + `dist/worldspring/wrangler.json` contain no `TESTBED`; prod join path 3 diff-clean vs pre-M1. Safe to build on `main` now.

2. **M2 — `packages/testkit` harness + smoke step in `preview.yml`** *(Sonnet 4.8 — mechanical fork of a proven transport)*. Depends: M1. Files: new `packages/testkit` (`@worldspring/testkit`, forked from `apps/game/scripts/loadtest.mjs`), a `runScenario`/`runPr19Checklist` bin, `.github/workflows/preview.yml` (new smoke step after `:77`, comment append into `:89-96`). Scope: import `PROTOCOL_VERSION`/`ITEM_DEFS`/constants from `@worldspring/shared` (`protocol.ts:29`, `items.ts:56`, `constants.ts`) instead of mirroring (`loadtest.mjs:21-38`); join fresh-token, assert the welcome's `inv`/`you`, drive `equip`/`use`/`input`, assert `snap`/`inv`/`notice`/`error`; 0/1 exit like `loadtest.mjs:401-434`; the smoke step runs the bin against `steps.deploy.outputs.deployment-url` (`preview.yml:83`) under the `CLOUDFLARE_API_TOKEN` gate and appends per-step PASS/FAIL to the sticky comment (same `<!-- worldspring-preview -->` marker, `preview.yml:86`). Accept: the bin exits 0 against a kitted preview and non-0 against a deliberately broken one; the PR comment shows per-step PASS/FAIL reflecting the *actual* exit; fork PRs and token-absent runs skip cleanly (green).

3. **M3 — KEYSTONE: extensible typed Scenario schema + `parseScenario`** *(Opus 4.8 — the shared contract every consumer reads; getting the union right is load-bearing for M4/M5)*. Depends: M1, M2. Files: new `packages/shared/src/scenario.ts` (+ its `exports` map entry), vitest under `packages/shared`, `apps/game/scenarios/*.json`, refactor `apps/game/src/server/testbed.ts` (M1) and the testkit bin (M2) to read the parsed scenario. Scope: `Provision`/`Assert` discriminated unions + `Scenario` + `parseScenario(input): Scenario` (clamp/validate, never throw, like `resolveServerConfig`); a built-in default universal testbed; an optional `Testbed: <name>` deploy-time selector (e.g. a `--var SCENARIO:<name>` resolved per-DO). Accept: `parseScenario` round-trips valid JSON and rejects/clamps malformed input under vitest; `provisionTestbed` and the testkit bin both consume the *same* parsed `Scenario`; the default scenario reproduces M1's universal testbed exactly; a named scenario selected via the PR body deploys and provisions on the preview.

4. **M4 — `/testbed` Claude Code skill** *(Sonnet 4.8 — authoring/codegen against a fixed schema)*. Depends: M3. Files: new `.claude/skills/testbed/SKILL.md` (+ any helper script), writes `apps/game/scenarios/<name>.json`. Scope: given a diff/PR/description, read changed code to infer touched systems + real item ids (`items.ts:1`) + verbatim notice/error strings; emit a `parseScenario`-valid scenario; optionally add a `Testbed: <name>` PR-body line and run the M2 bin; generate the human "Manual smoke tests needed" markdown from the **same** `Scenario` artifact. Accept: run on the PR #19 diff, the skill emits a scenario that `parseScenario` validates, the testkit bin runs it green on a #19 preview (and only the venison cases on `main`), and the generated human checklist matches the scenario step-for-step.

5. **M5 — grow the provisioning/assertion vocabulary** *(Sonnet 4.8 — table-driven additions, each reusing an existing system fn)*. Depends: M3. Files: `packages/shared/src/scenario.ts`, `apps/game/src/server/testbed.ts`, the relevant system modules (`zombies.ts`, `wildlife.ts`, `loot.ts`, `survival.ts`, weather). Scope: add `spawnZombie`/`spawnAnimal`/`spawnLoot`/`spawnCorpse`/`spawnDrop` near-player, `setTime`/`fixedHour`, `setWeather` (snap `weather` is 0..1 intensity, `protocol.ts:259-260`), `teleport-to-zone` (coastal/inland/military), `config` overrides — each delegating to the existing authoritative spawn/state function; add `snap`-field assertions keyed on the fields the wire already carries (`protocol.ts:245-263`); **resolve the interactive-vs-rejoin decision (§5) here** (default: rejoin-with-richer-scenario). Accept: a scenario can place zombies/animals/loot near the player and the harness asserts their presence over `snap`; `setTime`/`setWeather` reflect in `snap.weather`/the day-night state; every primitive is exercised by a vitest + one harness run; no new `ClientMsg` added.

6. **M6 — human ProvPanel deep-link + guided overlay (optional)** *(Opus 4.8 — the only milestone that may reopen a gated runtime request channel)*. Depends: M5. Files: a client `ProvPanel` (preview-only), and *if* live interaction is chosen, a new `this.testbed`-gated `ClientMsg` + handler (`protocol.ts:68` union, `GameRoom` dispatch). Scope: a deep-linked overlay that walks the human through the generated checklist; optionally a gated runtime verb for live "spawn NOW / advance time NOW" (option (b) of §5). Accept: the panel renders only when the welcome indicates a testbed world; **if** the runtime verb lands, it is strictly gated on `this.testbed` and a prod build proves the verb is rejected when `this.testbed === false`; no change to prod join behavior.

## Open questions for Adam

1. **Landing vitals — hp 50 / food 50 / water 20, or full 100?** Half-vitals make documented deltas (eat ⇒ food +15, drink dirty ⇒ hp −10) immediately checkable without first burning the player down; full vitals are "fresh spawn" realistic but clip positive deltas at the cap. **Recommendation:** default to a known *baseline* (hp 50 / food 50 / water 20) in the universal scenario so every delta is observable, and let a scenario override per-test.
2. **CI smoke gate — block the PR (red) or annotate-only?** A red smoke failure is a real merge gate but can flake on a cold preview; annotate-only keeps signal without blocking. **Recommendation:** annotate-only on the sticky comment for v1 (the harness exit is logged, the PASS/FAIL is visible), promote to a required check once the harness has soaked and proven non-flaky — mirroring doc 09's "wire CI as a follow-up, not a hard gate day one" stance.
3. **`--var TESTBED:1` literal, or a per-run secret token?** A literal is simplest and the preview Worker is already a throwaway in the Worldspring account; a secret token only matters once a runtime verb exists to abuse. **Recommendation:** literal `--var TESTBED:1` until admin/runtime verbs exist (M6); revisit only if (b) lands.
4. **Interactive mid-session QA — accept rejoin-with-scenario, or build a gated runtime verb later?** Rejoin covers ~90% of QA inside the safe model; a runtime verb reopens the wire surface §Non-goals avoids. **Recommendation:** rejoin-with-scenario for v1 (resolved in M5); treat the gated verb as optional M6, strictly behind `this.testbed`.
5. **Scenario selection — default-universal, or per-PR `Testbed:` line?** A default universal testbed needs zero PR ceremony and covers most smoke tests; the `Testbed: <name>` line lets a PR target a specific scenario the `/testbed` skill authored. **Recommendation:** ship the default-universal testbed in M1, add the optional `Testbed: <name>` selector in M3 — default when absent, named when present.
