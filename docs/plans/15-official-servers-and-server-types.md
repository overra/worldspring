# 15 — Official Mode Servers & the Server-Type Model

**Status:** direction set 2026-07-15. The five decisions below are Adam's, made — this
plans the build, it does not relitigate them. Depends on the deploy model
([doc 00](00-agent-moddable-platform.md) §"A server is a DEPLOY, not a route"), the
directory ([doc 02](02-server-directory.md)), the versioned contract
([doc 03](03-server-info-contract.md)), and presets/`GAME_MODES`
([doc 04](04-gameplay-presets.md)). It **amends doc 00** on two points (subdomains-per-mode
and previews-per-mode).

## Summary

Worldspring runs three first-party games on **one binary/one fork**: `survival` (flagship,
live), `arena` (shipped GameMode), and `horde` (**does not exist yet — a build milestone
here**). Each becomes its **own official server**: a server is a *deploy*, not a route
(`worker.ts` routes `/ws` + `/api/*` to the single DO `env.GAME.getByName("main")`;
`GameRoom.ts:276` resolves one `GAME_CONFIG` per worker), so three modes = three worker
deploys of the same artifact, differing only in two deploy-time flags — `--name <worker>`
and `--var GAME_CONFIG:<preset>` — reached at subdomains (`arena.`/`horde.worldspring.games`)
attached **account-side**, never as committed `routes`. CI grows from deploying one flagship
to a **manifest-driven matrix** (`apps/game/official-servers.json`) that deploys every
official mode for **both** the per-PR preview and the prod-on-merge path. The directory is
how players find them — no separate hub: add a self-declared **`mode` server-TYPE field** to
the contract (additive on `RulesSummary`, **no `SERVER_INFO_SCHEMA_VERSION` bump**, per doc
03 §10), a `mode` D1 column + ingest, and a **Type filter** mirroring the existing preset
filter (`browse.ts`), plus a Type badge on the list/detail pages. First-party rows are marked
official by flipping `source='official'` (a directory-DB act; `official` is *derived*, not a
heartbeat field). The differentiation model — the platform-level answer to "how does a player
know what this server is" — is **self-declared** (`mode` + `tags` + `motd` + `repoUrl` in the
heartbeat), **verified-on-join** (`welcome.config` carries the real config; `/api/server-info`
serves the `summarizeRules` digest first), and **source-transparent** (it's a fork; link the
repo). We never classify or verify arbitrary mod code we can't see (doc 00) — the same fields
serve first-party and community **identically**.

## Decisions landed

1. **Three first-party official servers, one binary.** `survival`, `arena`, `horde` each get
   their own official server — but all three are the same fork/artifact, selected at deploy
   time by `GAME_CONFIG`. Mode is LIVE-class config (`config.mode`, `config.ts:196`), never
   worldgen, so it never taints a persisted world (`config.ts:49-56`).
2. **Deploy-per-game, on subdomains.** Each mode is its own worker deploy with its own
   `GAME_CONFIG`, reached at a subdomain (`arena.worldspring.games`, `horde.worldspring.games`)
   via Cloudflare account-side routing — **not** a single worker with `/paths`, **not** a
   `play.` hub page. This **refines doc 00** (see Amendments): subdomains are now the standard
   official-server address, not a marketing-only vanity.
3. **CI deploys the whole fleet, preview and prod.** A per-PR preview *per mode* and a prod
   deploy *per mode* on merge to main. Today CI deploys only the flagship. This **refines
   doc 00 §“A server is a DEPLOY, not a route”** ("previews don't multiply per mode") — see Amendments.
4. **The directory is the discovery surface — no separate hub.** Add a server-TYPE column
   (`= the GameMode`) + a Type filter to the existing list. Reuse the live preset-filter
   machinery.
5. **Differentiation is self-declared, verified-on-join, and source-transparent — never
   directory-verified.** The directory never pretends to verify code it cannot see (doc 00).
   A server self-declares `mode` + `tags` + `motd` + `repoUrl` in the heartbeat; the client
   gets the real resolved config in `welcome`; `/api/server-info` serves a rules digest first;
   the repo link makes the fork readable. We give a **structured way to self-describe and to
   read it** — we do not classify arbitrary mods. First-party and community use the identical
   fields; the only first-party-specific bit is `source='official'`.

## Goals / Non-goals

**Goals**

- Make the platform's versatility *visible*: one directory, filterable by game type, showing
  three official first-party worlds alongside community forks under one honest model.
- One build → N official deploys, added by **one manifest line**, gated so a new mode can't
  ship misconfigured.
- A `mode` server-TYPE field on the contract that is backward- *and* forward-compatible: old
  community servers that never send it still list cleanly; old directories reading a new
  server ignore the extra field (doc 03 §10 rules 1–2).
- A differentiation model that treats a community fork exactly like a first-party mode.

**Non-goals**

- Verifying or classifying arbitrary mod code — impossible and out of scope by doc 00's
  posture; we structure self-description, not attestation.
- A unified launcher / cross-server shared client (doc 00 decision 6) or a `play.` hub page —
  the directory *is* the discovery path.
- Named-rooms-in-one-worker / per-request config — fights "one server = one game" (doc 00 §“A server is a DEPLOY, not a route”).
- Federated cross-official identity ("one character across all official servers") — that is
  doc 00's deferred accounts contract, not a routing change (see the token-origin caveat).
- The directory's ranking/eviction/probe internals (doc 02) and the full `ServerConfig` knob
  set (doc 04) — this doc only adds one field and one filter.

## Current state (verified against this tree)

- **One worker, one DO, one config.** `worker.ts` routes `/ws` + `/api/*` to
  `env.GAME.getByName("main")` (`apps/game/src/server/worker.ts:37,44,66,70`); the DO resolves
  its config once from the worker-wide var: `this.resolved = resolveServerConfig(env.GAME_CONFIG)`
  (`GameRoom.ts:276`), then `makeMode(this.config)` (`GameRoom.ts:278`). Config, incl. `mode`,
  is per-**deploy**.
- **Modes: survival + arena only. No horde.** `GAME_MODES = ["survival", "arena"] as const`
  (`packages/shared/src/config.ts:57`); `makeMode` switches `arena`→`createArenaMode()`,
  default→`survivalMode` (`apps/game/src/server/mode/registry.ts:11-19`); the mode dir holds
  only `GameMode.ts`, `arenaMode.ts`, `survivalMode.ts`, `registry.ts`. The only `"horde"`
  token in the tree is a zombie-density band label in `summarizeRules` (`config.ts:1086`;
  `RulesSummary.zombies` union, `serverInfo.ts:30`) — **not** a mode. **A horde official
  server is build-the-mode-first.**
- **The `arena` preset is the only preset that sets a non-survival mode** — `mode:"arena"`
  plus zombies-off / pvp-on / building-off / no-logout-linger (`session.logoutLingerS:0`;
  respawn is a quick 3s = `ARENA_RESPAWN_DELAY_S`, not instant) (`config.ts:373-379`,
  `constants/arena.ts:14`). All other
  presets inherit `DEFAULT_CONFIG.mode = "survival"` (`config.ts:223`). `resolveServerConfig`
  accepts a **bare preset-name string** as `GAME_CONFIG` (`config.ts:812-836`), so
  `GAME_CONFIG:arena` alone selects arena.
- **`RulesSummary` carries `preset` but NOT `mode`** (`serverInfo.ts:20-42`), and its `preset`
  is a **closed union that excludes `arena`/`horde`** (`serverInfo.ts:22-29`). `arena` is not
  in `KNOWN_PRESETS` (`config.ts:1055-1062`), so `summarizeRules` bands an arena server's
  `preset` to **`"custom"`** (`config.ts:1079-1082`). **Today an official arena server is
  indistinguishable from any community-custom server in the directory** — the core gap this
  doc closes. `SERVER_INFO_SCHEMA_VERSION` is still `1` (`serverInfo.ts:11`).
- **The directory is live; `official` is derived, not stored.** `official = row.source ===
  "official"` (`packages/shared/src/browse.ts:315,418`). `source` is written in exactly one
  place — the register POST, **hardcoded `'manual'`** (`apps/web/src/pages/api/v1/servers.ts:90`).
  Heartbeat UPDATE (`apps/web/src/pages/api/v1/heartbeat.ts:104-131`) never touches `source`;
  admin actions don't either. So every registered server — flagship included — is
  `source='manual'` → `official:false`. The `servers` table allows `source IN
  ('deploy','manual','official')` (`apps/web/migrations/0002_directory.sql:43`) but no code
  ever writes `'official'`.
- **A preset filter already exists end-to-end.** `BROWSE_PRESETS` (`browse.ts:26-35`),
  `parseBrowseParams` (`browse.ts:87`), `applyBrowse` (filters + pins `official` to row 0,
  `browse.ts:156`), `canonicalListCacheUrl` (stable edge cache key, `browse.ts:110`). A
  page-local `show=all|official|community` facet exists on the SSR list only
  (`apps/web/src/pages/servers/index.astro:40-52`) — not in the shared vocabulary, not honored
  by the JSON API. The list table is Server / Players / Preset / Version / Region-Ping /
  Uptime / Join; detail is a `<dl class="spec">` grid.
- **CI deploys only the flagship.** `deploy-prod` (`.github/workflows/ci.yml:139-206`):
  `needs: verify`, push-to-main only, skip-**green** secret gate (`ci.yml:161-171`), then
  `command: deploy -c dist/worldspring/wrangler.json` — **no `--name`, no `--var`**
  (`ci.yml:198`). Per-PR preview `deploy-game` (`.github/workflows/preview.yml:27-87`):
  `--name worldspring-pr-<N> --var TESTBED:1` (`preview.yml:84-87`); cleanup deletes it on PR
  close from `runner.temp` (`preview.yml:209-233`, the `workspace:*`-install safeguard at
  `:216-221`). Both build one artifact keyed off the unchanged `name:"worldspring"`
  (`apps/game/wrangler.jsonc:6`). `keep_vars:true` (`:20`) preserves the operator-set
  `GAME_CONFIG`; `workers_dev:true` pinned (`:16`); **no `routes`** (deliberate, `:9-15`).
- **Guards run in `verify`'s `pnpm -w test`.** `wrangler-parity.mjs` asserts root↔apps/game
  equality on `name`/`compatibility_date`/DO bindings/migrations/`assets.not_found_handling`
  (`apps/game/scripts/wrangler-parity.mjs:78-82`) and **forbids** `route`/`routes`/`account_id`
  in root config (`:87-97`). A `TESTBED`-not-baked grep fails the build if `TESTBED` appears in
  committed or emitted wrangler config (`ci.yml:74-82`).
- **Identity is origin-scoped.** The client stores a 32-hex `ws_token` in `localStorage`
  (`apps/game/src/client/net/connection.ts:48-84`) and connects to `location.host` (`:104-105`);
  the DO keys characters by `token_hash` PRIMARY KEY (`apps/game/src/server/persistence.ts:188`).
  `localStorage` is partitioned per origin → **each subdomain is a separate identity origin**.

## Design

### 1. A server is a deploy, per mode (the subdomain routing model)

Build on doc 00 §"A server is a DEPLOY, not a route". Three official workers —
`worldspring`, `worldspring-arena`, `worldspring-horde` — are **three deploys of one binary**,
not three routes on one worker and not three forks. A single
`pnpm --filter @worldspring/game build` emits one `apps/game/dist/worldspring/wrangler.json`
(keyed off the unchanged `name:"worldspring"`); every official server reuses that artifact
byte-for-byte and differs only in `--name <worker>` and `--var GAME_CONFIG:<preset>`. **Mode
is a deploy flag, never a config-file fact** — nothing per-mode is ever committed to either
`wrangler.jsonc`, so the whole fleet is `wrangler-parity`-clean by construction.

- Distinct `--name` ⇒ distinct worker ⇒ **its own `GameRoom` DO namespace / isolated world**
  (the `v1` migration `new_sqlite_classes:["GameRoom"]` applies per worker — the exact
  mechanism that isolates PR previews). `--name worldspring` for survival equals the built
  config's own name, so the flagship deploy is **behaviorally identical to today**.
- `--var GAME_CONFIG:arena` sets the mode from source. Survival stays var-less
  (operator-managed `GAME_CONFIG` via `keep_vars`, doc 04 §4); arena/horde are **pinned from
  CI** (reproducible-from-source). See §6.
- Subdomains (`arena.`/`horde.worldspring.games`) attach **account-side** exactly like
  `play.worldspring.games` did (`wrangler triggers deploy`, 2026-07-07) — **never** a `routes`
  entry in the shared `apps/game/wrangler.jsonc` (a `routes` entry both defeats artifact reuse
  and makes every PR preview fight for the domain; it would also trip `wrangler-parity`, §6).
  Ops, not code (Ops checklist).

### 2. The `mode` server-TYPE field on the contract (additive, doc 03 §10)

`config.mode` (`config.ts:196`) is resolved at boot and shipped in `welcome.config`, but it is
**not** in `ServerInfo`/`RulesSummary` today — the directory has never received the mode.
`mode` is **not derivable from `preset`** (they are orthogonal axes; only the `arena` preset
happens to pin a mode, and it bands to `"custom"` anyway). So `mode` must be a **first-class
additive field**.

Placement — **add `mode` to `RulesSummary`** (the badge object the directory already ingests
and the preset filter already lives on). Change set, all backward/forward-safe under doc 03 §10
rules 1–2, **no `SERVER_INFO_SCHEMA_VERSION` bump** (additions don't bump; only
removal/rename/retype/resemantic do — `serverInfo.ts:1-11`):

1. `packages/shared/src/serverInfo.ts` — add `mode?: string` to `RulesSummary`. **Optional**,
   per doc 03 §10 rule 1 (new fields MUST be `field?: T` with a documented default — an absent
   `mode` reads as "unknown", never fabricated) — this is what keeps `directory.ts:164`'s
   `return v as ServerInfo` sound for an old server whose `rules` has no `mode`. Type it as an
   **open string**, NOT the closed `GameModeId` union, so a future community mode never forces
   a schema bump (doc 03 rule 7, enum-ish strings grow). Also add `tags?: string[]` and
   `repoUrl?: string` to `ServerInfo` (optional — the source-transparency + self-describe
   fields, §4).
2. `packages/shared/src/config.ts::summarizeRules` — populate `mode: cfg.mode` in the return
   object (`config.ts:1131-1144`; `cfg` is already in scope). Raw, not banded — it is already a
   short token. No sender-side change beyond this: `buildServerInfo` already calls
   `summarizeRules(this.config)` (`GameRoom.ts:493`), and the heartbeat body *is* that same
   `ServerInfo` (doc 03 §6).
3. `apps/game/src/server/GameRoom.buildServerInfo` — populate `tags`/`repoUrl` from new optional
   env vars (`SERVER_TAGS`, `SERVER_REPO_URL`), sanitized exactly like `name`/`motd`
   (`GameRoom.ts:489-492` pattern); declare them in `env.d.ts`. `repoUrl` inherits doc 03 rule
   8: **untrusted operator input — validate as `https:` before it ever becomes an href.**

Backward/forward guarantee: an **old server** omits `mode`/`tags`/`repoUrl` → the directory
parser tolerates absence (it reads only named fields and returns `v as ServerInfo`,
`directory.ts:164`), the DB columns (§3) stay NULL, the UI renders "unknown type" — no error.
An **old directory** reading a **new server** ignores the extras (rule 2, already enforced). No
`schemaVersion` bump ⇒ no 6-month dual-accept window needed.

### 3. Directory: the Type column + filter (extend doc 02's browse.ts)

Server-TYPE = the GameMode. Thread `mode` from the heartbeat into a filterable column, mirroring
the live preset filter:

- **Migration `apps/web/migrations/0004_server_type.sql`** — `ALTER TABLE servers ADD COLUMN
  mode TEXT;` (nullable, no `CHECK` — keep it open like `preset`; doc 00's self-declared posture
  says don't reject unknown types). `ADD COLUMN` is non-destructive (unlike 0002's rebuild).
  Add `tags TEXT` (JSON) and `repo_url TEXT` (nullable) in the same migration for §4. Index
  optional at the 500-row cap.
- **Ingest** — both write sites that read `info.rules.preset` must also read `info.rules.mode`:
  the heartbeat UPDATE (`apps/web/src/pages/api/v1/heartbeat.ts:104-131`, `preset =
  info.rules.preset` at `:116`) and the registration INSERT (`servers.ts:87-90,99`). **Store the
  sanitized `mode` string as-is** — `sanitizeListingText(mode, N)` (cap length + strip `<`, doc 03
  rule 8), exactly as `preset` is stored: `preset` is NOT whitelisted at ingest (both sites write
  `sanitizeListingText(String(info.rules.preset), 24)` raw; the unknown→`"custom"` collapse is
  server-side in `summarizeRules`, `config.ts:1079-1082`). An **absent** `mode` stores NULL,
  read as "unknown type" — never fabricate `"survival"`, or a pre-field server would masquerade
  as survival. The `BROWSE_MODES` whitelist (below) constrains the **filter query-param only**,
  never what is stored or shown — so a community `mode:"heist"` is stored and rendered, just not
  a first-class filter chip. This is what makes the differentiation model (Decision #5) hold for
  community servers. Validate `repo_url` as `https:`; cap/sanitize `tags`.
- **Browse vocabulary (shared, so the JSON API *and* SSR page both honor it — unlike the
  page-local `show` facet)** — in `packages/shared/src/browse.ts`: add a bounded `BROWSE_MODES`
  whitelist, `mode` on `BrowseParams`, parse it in `parseBrowseParams`, filter it in
  `applyBrowse` alongside the preset filter, and **add it to `canonicalListCacheUrl`** or cache
  keys collide across types. Keep it a whitelist (never free-text) for cache-cardinality
  discipline. Surface `mode` in `shapeListedServer`/`shapeServerDetail` + the `ListRow`/
  `ServerDetailRow` interfaces + the `listing.ts` SELECTs (`apps/web/src/lib/listing.ts:35-63,
  87-125`).
- **UI (two surfaces)** — List (`apps/web/src/pages/servers/index.astro`): a **Type** column in
  the table + a **Type** filter-chip group modeled on the existing Preset/Show groups. Detail
  (`.../[id]/index.astro`): a **Type/Mode** cell in the `<dl class="spec">` grid, plus the
  repo-link (validated href) and tags when present.

Type (the game) and official/community are **orthogonal axes** — the directory wants both a
Type filter and the existing Show facet.

### 4. The differentiation model (self-declared / verified-on-join / source-transparent)

The platform-level answer to "how does a player know what's different about this server",
identical for first-party and community. Three layers, coarse → fine:

- **Self-declared (the listing).** Rides the heartbeat, rendered as badges/text:
  - **`mode`** (§2) — the coarsest signal, "which game is this" (survival / arena / horde /
    a community mode). One badge.
  - **`official`** — `source='official'` (§5), the gold first-party pin. Orthogonal to `mode`.
  - **`preset` + the `rules` digest** — `summarizeRules` bands the config into render-ready
    badges (zombies / pvp / loot / vitals / night / wipe / map …), "how is it tuned".
  - **`motd`** — free operator text (render-as-text only, doc 03 rule 8).
  - **`gameVersion` / `protocolVersion`** — compatibility, not gameplay.
  - **`repoUrl`** *(new, §2)* — source transparency: the fork you can actually read.
- **Verified-on-join (before you commit).** `/api/server-info` serves the `summarizeRules`
  digest — read the rules *before* you join. On join, `welcome.config` carries the **real
  resolved `ServerConfig`** (doc 04 whole-config-in-welcome), so the client's rules always match
  the sim actually running. This is the "read it before you play" leg — it already exists; §2
  just adds `mode` to it.
- **Source-transparent (the fork is the truth).** It's an open fork; `repoUrl` links it. For a
  community server that customizes gameplay, the honest answer to "what did they change" is
  "read their repo" — not a directory attestation.

**The honest limit (doc 00, stated plainly):** none of this verifies the fork's *actual
running code*. A server can self-declare `mode:"survival"` and run anything; the directory pins
`joinUrl` at registration and measures reachability, but the `/api/server-info` **body is a
self-report by whatever code answers at the origin** (doc 03 §7 — the probe measures
reachability/TLS, not truthful gameplay). We give a **structured way to self-describe and to
read it**; we never classify or verify arbitrary mods. This is *why* community forks and
first-party modes use the same fields with no special-casing: the model doesn't depend on trust
we can't earn — it depends on legibility we can provide.

### 5. Making the flagship (and arena/horde) `official`

`official` is derived directory-side from `source === "official"` (`browse.ts:315,418`), and no
code path writes `'official'` (register hardcodes `'manual'`, `servers.ts:90`). So marking a
first-party server official is a **directory-DB act**, independent of the deploy:
`UPDATE servers SET source='official' WHERE url=?` (key on the `UNIQUE` `url` = the subdomain,
`0002_directory.sql:36` — no need to capture the ULID minted at registration). It instantly
pins the row to list-position 0
under every sort (`applyBrowse`, `browse.ts:166`), shows the gold Official tag + `.is-official`
border, and gives a straight-out Join. This is **ops** (Ops checklist) — the `official` field
in the manifest (§6) enumerates the exact rows. An authenticated `set-official` admin action is
a possible future (Open Q3), not v1.

### 6. CI: the manifest-driven per-mode deploy matrix

The fleet is a committed **manifest** — the single source of truth read by prod, preview,
cleanup, and the ops checklist, and validated in `verify`.

**`apps/game/official-servers.json`** (committed):

```json
{
  "schema": 1,
  "servers": [
    { "mode": "survival", "name": "worldspring",       "config": "deadcoast", "pinConfig": false, "subdomain": "play.worldspring.games",  "official": true },
    { "mode": "arena",    "name": "worldspring-arena",  "config": "arena",     "pinConfig": true,  "subdomain": "arena.worldspring.games", "official": true }
  ]
}
```

Horde lands as one object in the same slice that builds the mode (§7):
`{ "mode": "horde", "name": "worldspring-horde", "config": "horde", "pinConfig": true,
"subdomain": "horde.worldspring.games", "official": true }`.

| Field | Consumed by | Meaning |
| --- | --- | --- |
| `mode` | validator, directory Type, ops | The `GameModeId` (`GAME_MODES`, `config.ts:57`). Must equal the mode `config` resolves to. |
| `name` | `--name` at deploy; cleanup | Worker script name. **`worldspring` for survival is immutable** — a rename mints a fresh DO namespace and wipes the live prod world. Distinct name ⇒ own isolated world. |
| `config` | `--var GAME_CONFIG:<config>` when `pinConfig`; validator | A **preset name** (`PRESETS` key), NOT a bare mode id — `resolveServerConfig` treats a bare string as a preset and an unknown one falls back to deadcoast **and taints world identity** (`config.ts:865-870`). |
| `pinConfig` | deploy step's conditional `--var` | `true` ⇒ CI re-pins mode from source every deploy (arena/horde). `false` ⇒ var-less; `keep_vars:true` retains the operator's dashboard `GAME_CONFIG` (survival). |
| `subdomain` | ops checklist only | The account-side route Adam attaches. **Never** a `routes` entry. |
| `official` | directory ops | The exact rows to flip to `source='official'`. |

**Prod** — `deploy-prod` (`ci.yml:139-206`) gains a tiny `matrix` job that `jq`s the manifest
(`servers=$(jq -c '.servers' apps/game/official-servers.json)`) and a `strategy: { fail-fast:
false, matrix: { server: ${{ fromJSON(...) }} } }`. Everything else — `needs: verify`, the
push-to-main `if`, the skip-green secret gate, the pinned `wrangler-action@…#v4.0.0` /
`wranglerVersion:"4.99.0"` / `workingDirectory: apps/game`, the shared secrets — is unchanged.
The only new surface assembles the command from the entry: `deploy -c
dist/worldspring/wrangler.json --name $NAME [ --var GAME_CONFIG:$CONFIG if $pinConfig ]`.
Result on merge: `worldspring` (no `--var`, identical to today), `worldspring-arena --var
GAME_CONFIG:arena`, `worldspring-horde --var GAME_CONFIG:horde`. `fail-fast:false` keeps a bad
arena deploy from stranding survival — official servers are independent products.

**Preview** — `deploy-game` (`preview.yml:27-87`) uses the same matrix; survival keeps
`worldspring-pr-<N>` byte-for-byte. Non-survival previews **always pin** config (an ephemeral
worker has no dashboard var for `keep_vars` to retain): `--name <name>-pr-<N> --var TESTBED:1
[--var GAME_CONFIG:<config>]`. Names: `worldspring-pr-<N>`, `worldspring-arena-pr-<N>`,
`worldspring-horde-pr-<N>`, each a fresh isolated world. Two knock-ons: the sticky comment
(`preview.yml:154-207`) aggregates one row per mode (the names are deterministic); the cleanup
loop (`preview.yml:209-233`) iterates the manifest names, **keeping the `runner.temp`
safeguard** and `--force`, plus the existing `worldspring-web-pr-<N>`.

**keep_vars, secrets, tokens.** Two distinct persistence mechanisms — don't conflate them.
`keep_vars:true` (both committed configs, parity-clean) preserves only the plaintext **vars**
a var-less deploy would otherwise clear: survival's operator `GAME_CONFIG` and each worker's
`DIRECTORY_URL`. The `DIRECTORY_TOKEN` **secret** is a different thing: `wrangler deploy` never
touches secrets **regardless of `keep_vars`** — a secret, once set, survives every later deploy
unconditionally. The heartbeat sender (`apps/game/src/server/heartbeat.ts`) arms only when both
`DIRECTORY_URL` and `DIRECTORY_TOKEN` are set; each official server needs its **own**
`DIRECTORY_TOKEN` (per-server identity — revoking one can't silence the others). **Decision:
operator-set-once secrets** — Adam runs `wrangler secret put DIRECTORY_TOKEN --name <worker>`
once per new worker; it persists across every later CI deploy, so **CI never sees a directory
token**. Rotation is a manual `wrangler secret put` (rare, acceptable). GitHub-Environments-
managed tokens are a documented future option (the manifest can grow an `environment` field);
not built for v1.

**Guards (all in `verify`'s `pnpm -w test`):**

1. **`wrangler-parity`** — unchanged; passes by construction (per-mode identity is `--name`/
   `--var` at deploy, both configs stay `name:"worldspring"` with no routes). Its active value
   is negative: any attempt to bake a mode/name/route into committed config trips its equality +
   forbidden-`route`/`routes`/`account_id` asserts (`wrangler-parity.mjs:78-97`).
2. **NEW — `GAME_CONFIG`-not-baked check.** Enforces "official mode arrives only via `--var`."
   NOT a raw grep like the `TESTBED` one (`ci.yml:74-82`): that works only because `TESTBED`
   appears in no comment, whereas `apps/game/wrangler.jsonc:17-19` already contains the literal
   `GAME_CONFIG` **twice** in the `keep_vars` comment — a raw grep would false-fail `verify` on
   day one. So check the **emitted** `dist/worldspring/wrangler.json` (real JSON, no comments):
   assert its `vars` object has no `GAME_CONFIG` key (or parse the `.jsonc` and assert on `vars`
   specifically). Compatible with survival (its operator `GAME_CONFIG` lives on the deployed
   worker, never in committed config).
3. **NEW — manifest validator** (`apps/game/scripts/official-servers-check.mjs`, wired as
   `test:official-servers`, modeled on `wrangler-parity.mjs`; imports `resolveServerConfig` /
   `GAME_MODES` / `PRESETS` from `@worldspring/shared`). Asserts: `name` and `subdomain` unique;
   **exactly one entry with `name:"worldspring"` and `mode:"survival"`** (blocks the accidental
   flagship rename that wipes prod); every `mode ∈ GAME_MODES`; every `config` is a `PRESETS`
   key; and **`resolveServerConfig(entry.config).mode === entry.mode`**. That last check makes
   "add one line" *safe* — CI fails loudly if you list horde before its preset+mode exist, and
   guarantees the directory Type label can never drift from the config the server runs.

Adding a mode is one enforced path: build the mode (gated by `verify`) → add one manifest object
→ CI's prod/preview/cleanup all iterate it → Adam runs the ops checklist. Until the token is set
the deploy still ships (skips heartbeat); until the D1 flip it lists non-official.

### 7. The `horde` GameMode (net-new build-out)

Horde does not exist (§Current state). A first-party horde server is **build-the-mode-first**,
not a config toggle. Prerequisite scope, owned by doc 00's engine/game-seam track:

- add `"horde"` to `GAME_MODES` (`config.ts:57`) — a wire-enum growth **owned by doc 03's bump
  rule** (`GameModeId` widening; if a client ever gates on it, that is a `PROTOCOL_VERSION` bump
  — but see Migration: the field is server-declared and the directory types it as open string,
  so the *directory* side never bumps `SERVER_INFO_SCHEMA_VERSION`);
- `createHordeMode()` in a new `apps/game/src/server/mode/hordeMode.ts` + a `case "horde"` in
  `registry.ts:11-19`;
- a `horde` entry in `PRESETS` (`config.ts:295`) that sets `mode:"horde"` (arena is the
  template, `config.ts:373`) — LIVE-class, so it never taints a persisted world;
- optionally a `constants/horde.ts` and a client HUD-module entry (the per-mode HUD seam).

Until this lands, the manifest validator (§6) *rejects* a horde row — the validator gates
ordering. This is why horde is a separate build milestone, not an assumed asset.

## Implications

**Opens up**

- The directory becomes the platform storefront it was always meant to be: one honest list,
  filterable by game type, first-party and community side by side.
- Adding an official mode is one manifest line + an ops batch — arena ships immediately; horde
  ships the day its mode lands.
- The `mode` + `tags` + `repoUrl` fields give *every* community fork a structured way to
  self-describe and be found — the same lever that surfaces first-party arena surfaces a
  community heist mode.
- `arena`/`horde` previews per PR give real per-mode human QA (the `TESTBED` provisioning
  applies to each), not just headless probes.

**Complicates**

- CI grows a matrix and a manifest with a validator — three consumers (prod, preview, cleanup)
  must agree; the validator is the cost of making "one line adds a server" safe.
- Every new mode is now also a directory-vocabulary question (whitelist it in `BROWSE_MODES`,
  or it lists as an unfiltered "unknown type" — acceptable, but a small standing tax).
- Per-server directory tokens are per-worker ops (mint + `wrangler secret put` once each).

**Breaks**

- Nothing existing. The survival deploy is byte-identical (`--name worldspring`, no `--var`).
  The `mode`/`tags`/`repoUrl` contract fields are additive-optional (no `SERVER_INFO_SCHEMA_VERSION`
  bump); the `0004` migration is `ADD COLUMN` (non-destructive). Old servers and old directories
  keep working (doc 03 §10 rules 1–2).

**Threatens**

- **Accidental flagship rename = prod world wipe.** A wrong `name` on the survival manifest entry
  mints a fresh DO namespace under a new worker and orphans the live world. **RESOLVED by §6's
  validator** (exactly-one immutable `worldspring`/survival entry).
- **A horde row before horde exists = a silent survival server on a tainted world**
  (`GAME_CONFIG:horde` → unknown preset → deadcoast fallback + `worldTainted`, `config.ts:865-870`).
  **RESOLVED by §6's `resolveServerConfig(config).mode === mode` check.**
- **Token-origin identity split (do not "fix").** Each subdomain is a separate `localStorage`
  origin → a separate `ws_token` → a separate character (§Current state; `connection.ts:48-84`).
  A player who built a survival character at `play.` and visits `arena.` arrives **empty** —
  correct for round-based arena/horde, but must be stated. **Hard constraint: never repoint or
  rename an *existing* origin** (don't unset `workers_dev`, don't move `play.`) without an
  identity-migration story — repointing silently orphans every character (doc 00:38 warning).
  *New* subdomains for *new* modes are safe (nobody has identity there yet). Cross-official
  identity portability is doc 00's deferred accounts contract, not a routing change here.
- **Per-mode Worker request caps.** Each official worker gets its own free-plan caps and its own
  directory-browser ping load (doc 03 §9) — a first-party concern once traffic grows; the $5
  paid plan is the lever, already the recommendation.

## Migration & compatibility

- **Contract field additive, no bump.** `mode` on `RulesSummary` + `tags?`/`repoUrl?` on
  `ServerInfo` are additions within `SERVER_INFO_SCHEMA_VERSION = 1` (`serverInfo.ts:11`). Old
  server omits them → directory reads NULL / "unknown type", never errors. Old directory reads a
  new server → ignores extras (`directory.ts:164`, `v as ServerInfo`). No 6-month dual-accept
  window needed (no `schemaVersion` change).
- **`GAME_MODES` growth (horde).** Widening the union is doc 03's wire-enum bump surface. The
  *directory* never bumps `SERVER_INFO_SCHEMA_VERSION` (it stores `mode` as open TEXT). Whether
  the widening bumps `PROTOCOL_VERSION` is doc 03's call and only matters if a *client* gates on
  the mode id; the server-declared directory field does not.
- **D1.** `0004_server_type.sql` is `ADD COLUMN mode/tags/repo_url` — nullable, default NULL, so
  existing rows and pre-field servers read cleanly. Non-destructive (unlike 0002's rebuild).
- **Deploy.** Survival is byte-identical; arena/horde are new workers with new DO namespaces
  (empty worlds by design). `keep_vars:true` unchanged in both committed configs.
- **Amendment to doc 00 (applied in place there; restated here).** Doc 00 §“A server is a DEPLOY, not a route” item 2 said
  *"Subdomains don't scale servers — the directory does … reserve a vanity subdomain (`arena.`)
  only for a mode we actively market."* → **now:** subdomains are the **standard official-server
  address** for all three first-party modes (the mechanism — deploy + account-side custom domain
  — is unchanged; only the "how many get one" policy moves; **community still directory-links-out,
  so doc 00's "subdomains don't scale servers" holds for community**). Doc 00 §“A server is a DEPLOY, not a route” item 3 said
  *"Previews don't multiply per mode … inject a `--var` on the single per-PR preview worker."* →
  **now:** the per-PR preview **does** multiply per official mode (`worldspring-<mode>-pr-<N>`),
  because human QA of arena/horde as their own products is worth N ephemeral workers per PR. The
  cost: N preview deploys per PR vs one + `--var`.

## Ops checklist (Adam — outside the repo)

Separated from "code/CI we build" per the ops boundary. The manifest (§6) `jq`s this exact list;
none of it is automatable in-repo (needs Adam's Cloudflare account + directory D1). **The worker
must already be deployed** (merge its manifest entry → CI deploys it, §6) before steps 2–3 can
succeed — the route attaches to an existing worker, and registration (step 3) runs a connect-back
probe of the live origin (`servers.ts:78`). Ordering is deploy → route → register → secret → flip.
**Per new official mode:**

1. **DNS** — create the subdomain record for `<subdomain>` (`arena.` / `horde.worldspring.games`).
   A Cloudflare Custom Domain on the existing `worldspring.games` zone creates it automatically.
2. **Route attach** — bind `<subdomain>` → `worldspring-<mode>` **account-side** (`wrangler
   triggers deploy` or dashboard Custom Domain), **NOT** a `routes` entry — mirrors how `play.`
   was attached 2026-07-07. Keep `workers_dev:true` or the route disables the workers.dev URL.
3. **Token mint + register** — with the origin live, mint a per-server `DIRECTORY_TOKEN`
   (`dcd1.<serverId>.<secretHex>`, doc 02) and register the listing directory-side (the register
   POST probes the origin, so it must be reachable first).
4. **Secret set (once)** — `wrangler secret put DIRECTORY_TOKEN --name worldspring-<mode>`
   (+ `DIRECTORY_URL` var if not shared) — this is what arms the heartbeat. Persists across all
   later CI deploys (secrets survive `wrangler deploy` unconditionally).
5. **Official flag** — `UPDATE servers SET source='official' WHERE url='<subdomain-origin>'` (§5).

**One-time now:** flip the **flagship** row — `UPDATE servers SET source='official' WHERE
url='https://play.worldspring.games'` — so `play.worldspring.games` finally lists as Official
(§Current state: it's `source='manual'` today).

## Implementation plan

Ordering: **M1 → M4**; **M2 → {M3, M6}**; **M5 → M6**. M1, M2, M5 are mutually independent.
One milestone per session — pick one, finish it, run its acceptance checks.

1. **M1 — `mode` (+ `tags`/`repoUrl`) on the contract** *(Opus 4.8 — versioned external
   contract; get the additive/no-bump discipline exactly right)*. Depends: none.
   - Scope: add `mode?: string` (optional, doc 03 rule 1) to `RulesSummary` and `tags?: string[]`
     / `repoUrl?: string` to `ServerInfo` (`packages/shared/src/serverInfo.ts`, **no
     `SERVER_INFO_SCHEMA_VERSION` bump**);
     emit `mode: cfg.mode` in `summarizeRules` (`config.ts:1131-1144`); populate `tags`/`repoUrl`
     from new optional `SERVER_TAGS`/`SERVER_REPO_URL` env vars in `buildServerInfo`
     (`GameRoom.ts:489-493`), sanitized like `name`/`motd`, `repoUrl` https-validated; declare
     the vars in `env.d.ts`.
   - Acceptance: `curl /api/server-info` on an arena config returns `rules.mode:"arena"`; on a
     default config returns `rules.mode:"survival"`; omitting the env vars omits `tags`/`repoUrl`
     with no error; `pnpm -w test` + both typechecks green. Unblocks M4.
2. **M2 — Manifest + guards + matrix-ify prod & preview (survival-only)** *(Opus 4.8 — "prod is
   byte-identical" is the load-bearing safety invariant; a survival rename or a leaked `--var`
   is the failure mode)*. Depends: none.
   - Scope: new `apps/game/official-servers.json` (survival entry only, `pinConfig:false`); new
     `apps/game/scripts/official-servers-check.mjs` + `test:official-servers` in
     `apps/game/package.json`; the `GAME_CONFIG`-not-baked check in `ci.yml` (assert on the
     emitted `dist` config's `vars` object — NOT a raw grep; the committed `.jsonc` names
     `GAME_CONFIG` in comments); the `matrix` job +
     `strategy` on `deploy-prod` (`ci.yml:139-206`); `deploy-game` matrix + command assembly +
     manifest-driven cleanup loop (`preview.yml:27-87, 209-233`), preserving the `runner.temp`
     safeguard + sticky-comment aggregation.
   - Acceptance: a one-cell matrix reproduces today's pipeline exactly — merge to main deploys
     `worldspring` with the same command shape (no `--name` behavior change, no `--var`); a PR
     preview is still `worldspring-pr-<N>` with `TESTBED:1`; cleanup deletes it + the web worker;
     the validator + the `GAME_CONFIG`-not-baked check pass; a mutation baking `GAME_CONFIG` into
     `wrangler.jsonc` (it propagates to the emitted `dist` config the check inspects), or a second
     survival-named entry, **fails `verify`**. Unblocks M3, M6.
3. **M3 — Arena official server** *(Sonnet 4.8 — one manifest object + ops; arena mode already
   exists)*. Depends: M2.
   - Scope: one entry in `official-servers.json` (`name:"worldspring-arena"`, `config:"arena"`,
     `pinConfig:true`, `subdomain:"arena.worldspring.games"`, `official:true`). No code beyond
     the manifest — `resolveServerConfig("arena").mode === "arena"` (`config.ts:373`) satisfies
     the validator.
   - Acceptance: merge deploys `worldspring-arena --var GAME_CONFIG:arena`; every PR spins a
     `worldspring-arena-pr-<N>` world running arena; Adam completes the arena ops checklist.
     (Arena *runs* but isn't Type-filterable/official until M4 + the ops flip — not a blocker
     for this milestone.)
4. **M4 — Directory Type column + filter + official visibility** *(Sonnet 4.8 — mechanical
   D1/browse/UI; the migration is `ADD COLUMN`)*. Depends: M1.
   - Scope: migration `apps/web/migrations/0004_server_type.sql` (`mode`/`tags`/`repo_url` TEXT,
     nullable); ingest `info.rules.mode` (+ `tags`/`repoUrl`) in the heartbeat UPDATE
     (`heartbeat.ts:104-131`) and register INSERT (`servers.ts:87-90`), whitelist-validated,
     NULL-defaulted; shared browse vocab (`BROWSE_MODES`, `BrowseParams.mode`, `parseBrowseParams`,
     `applyBrowse`, `canonicalListCacheUrl`) in `browse.ts`; thread `mode` through
     `listing.ts` SELECTs + `ListRow`/`ServerDetailRow` + shapers; Type column + filter chips on
     `servers/index.astro`, Type/Mode cell + validated repo link on `[id]/index.astro`.
   - Acceptance: `GET /api/v1/servers?mode=arena` returns only arena rows and a distinct cache
     key; the list renders a Type badge + a working Type filter; an old server with no `mode`
     lists as "unknown type" (NULL) without error; the flagship + arena rows, once flipped
     (§5/ops), show the gold Official tag.
5. **M5 — Horde GameMode build-out** *(Opus 4.8 — new mode + preset is determinism-adjacent; a
   bad preset taints world identity)*. Depends: none (parallel; owned by doc 00's engine/game
   seam).
   - Scope: `"horde"` into `GAME_MODES` (`config.ts:57`); `createHordeMode()` +
     `apps/game/src/server/mode/hordeMode.ts` + a `case "horde"` in `registry.ts:11-19`; a
     `horde` `PRESETS` entry setting `mode:"horde"` (`config.ts:295`, arena as template);
     optional `constants/horde.ts` + client HUD-module entry; whitelist `horde` in `BROWSE_MODES`
     (M4's vocab).
   - Acceptance: `resolveServerConfig("horde").mode === "horde"`; the mode boots under `verify`;
     a headless `horde-probe.mjs` (arena-probe precedent) passes; the manifest validator would
     now *accept* a horde row. Unblocks M6.
6. **M6 — Horde official server** *(Sonnet 4.8 — one manifest object + ops)*. Depends: M5, M2.
   - Scope: one entry (`name:"worldspring-horde"`, `config:"horde"`, `pinConfig:true`,
     `subdomain:"horde.worldspring.games"`, `official:true`).
   - Acceptance: CI deploys/previews all three; Adam completes the horde ops checklist. The
     single-source-of-truth payoff demonstrated: three servers, one pipeline, one line each.

## Open questions

1. **Store `mode` on `RulesSummary` (recommended) or top-level `ServerInfo`?**
   **Recommendation:** on `RulesSummary` — the directory already ingests `info.rules`, the
   preset filter already lives there, and "type" reads naturally beside "preset". Either is
   doc-03-rule-1 compliant; pick the one adjacent to the filter.
2. **Type it as an open `string` or the closed `GameModeId` union?** **Recommendation:** open
   `string` on the contract (doc 03 rule 7 — a future community mode must not force a schema
   bump), whitelist-validated on the directory side. First-party code can still use `GameModeId`
   internally.
3. **A `set-official` admin action, or hand-SQL the `source='official'` flip?**
   **Recommendation:** hand-SQL / `wrangler d1 execute` for v1 (ops, three rows, rare). Add an
   authenticated `set-official` admin action + audit row only if the fleet grows enough that
   hand-SQL is a footgun.
4. **Operator-set-once directory tokens (recommended) vs GitHub-Environments-managed?**
   **Recommendation:** operator-set-once secrets (matches the existing web-worker OAuth-secret
   pattern; CI never sees a token; a new mode's first deploy just works). Grow the manifest an
   `environment` field later if fleet-scale token rotation becomes real.
5. **Pin arena/horde config from CI (recommended) or leave them operator-managed like survival?**
   **Recommendation:** pin (`pinConfig:true`) — an official mode server should be
   reproducible-from-source; keep_vars/operator-management is the right posture only for the
   flagship's long-lived tuned world.
6. **Does the survival flagship keep both origins (`worldspring.adam-730.workers.dev` +
   `play.worldspring.games`)?** **Recommendation:** yes, unchanged — repointing/renaming an
   existing origin orphans every character (§Threatens). New modes get new subdomains only.

## Amendments & cross-references

- **Amends doc 00** §“A server is a DEPLOY, not a route” items 2 and 3 (subdomains-per-mode;
  previews-per-mode) — restated in
  Migration above; a dated amendment note is applied in place in
  [00-agent-moddable-platform.md](00-agent-moddable-platform.md). The underlying "a server is a
  DEPLOY, not a route" model is unchanged and is the basis of §1.
- **Builds on doc 02** — the Type column/filter extends the live `BROWSE_PRESETS`/`applyBrowse`/
  `canonicalListCacheUrl` machinery and the `servers` D1 schema (§3).
- **Amends/extends doc 03** — the one canonical external contract. `mode`/`tags`/`repoUrl` are
  additive-only (no `SERVER_INFO_SCHEMA_VERSION` bump); the `RulesSummary`/`ServerInfo` *types*
  remain doc 03's owned surface — this doc adds fields at its request. `GAME_MODES` widening
  (horde) is doc 03's wire-enum bump surface.
- **References doc 04** — `config.mode` / `GAME_MODES` / `PRESETS` / `summarizeRules` / the
  `arena` preset / `GAME_CONFIG`→`resolveServerConfig` all live here; the `horde` preset (§7) is
  a doc-04 registry addition; the operator-managed `GAME_CONFIG` via `keep_vars` is doc 04 §4.
- **Owns** (canonical vocabulary): the `official-servers.json` manifest, the per-mode deploy/CI
  matrix + the two new `verify` guards, the `--var GAME_CONFIG:<preset>` official-deploy
  convention, and the `horde` GameMode+preset. The `RulesSummary.mode` **field** stays doc 03's
  surface, added at this doc's request; the directory **Type filter** extends doc 02's
  `BrowsePreset` pattern.

_(README doc-index row, Status amendment, and canonical-vocabulary row applied in place in
[README.md](README.md) when this doc landed — matching the in-place doc-00 amendment.)_
