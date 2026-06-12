# Monorepo Migration: pnpm Workspaces + apps/ + packages/shared

## Summary

The repo is one npm package (`package.json:2` name `"worldspring"`) that builds the
Vite + R3F client AND the Cloudflare Worker/`GameRoom` DO from a single `vite build`
(`vite.config.ts:7` registers `react()` + `cloudflare()` in one plugins array), with the
deterministic sim under `src/shared/` consumed by both ends through the `@/` alias
(`tsconfig.json:13-16`, `vite.config.ts:8-11`). This doc restructures it into a **pnpm
workspace** with three deployable apps and one shared package — done as its own reviewed
PR(s) **before** any platform-track feature milestone (docs 01–08) lands, because every
one of those touches `src/shared`, `wrangler.jsonc`, or the directory design this move
reshapes.

Target shape (decided with Adam):

1. **`packages/shared` = `@worldspring/shared`** — `src/shared/`'s 7 modules
   (`constants/items/math/movement/protocol/rng/world`, `ls src/shared/`) extracted
   **verbatim** and consumed as a workspace dep by the game client, the game server, AND
   the web app. This is the **determinism-critical** move: `createWorld(seed)`
   (`src/shared/world.ts:342`) must produce a **bit-identical world before and after** the
   move — a worldgen fingerprint is the **HARD GATE** on this milestone (§Design 1,
   §Implementation M2). The package ships **raw `.ts` via a subpath `exports` map, no build
   step, no declaration emit** — every consumer is a bundler that compiles TS, and a
   compile step is the one thing that could perturb floating-point worldgen.

2. **`apps/game` = `@worldspring/game`** — the existing Vite + R3F client + Worker/DO,
   moved wholesale, **stays Vite (not Astro)**. The worker name stays `"worldspring"`
   (`wrangler.jsonc:3`) and the DO migration `{tag:"v1", new_sqlite_classes:["GameRoom"]}`
   (`wrangler.jsonc:17-21`) is preserved **verbatim** — moving must not reset the deployed
   DO's SQLite storage. The 98 `@/shared/*` import sites
   (`grep -rn '@/shared/' src/client src/server | wc -l` = 98) rewrite to
   `@worldspring/shared/*`; the 60 `@/client/*` sites
   (`grep -rn '@/client' src/client` = 60) and the 0 `@/server/*` sites stay as `@/`.

3. **`apps/web` = `@worldspring/web`** — ONE Astro 6 app on `@astrojs/cloudflare`:
   prerendered marketing landing + Starlight docs (prerendered) + the server directory as
   per-page-SSR pages and `/api/v1/*` JSON endpoints backed by D1. **This supersedes
   doc 02's Hono `site/` worker** (`docs/plans/02-server-directory.md:97-148`,
   name `deadcoast-site`, `hono/jsx`). Doc 02 §1 itself chose "SSR, not SPA" on
   crawlability/first-paint/edge-cache grounds (`02-server-directory.md:112-127`) — Astro's
   island model satisfies those identically while folding in landing + docs.

4. **`apps/prober` = `@worldspring/prober`** — a SMALL standalone Worker with a Cron
   Trigger (`scheduled()` handler, `triggers.crons:["*/5 * * * *"]`), peeled off because
   Astro is request-driven and cannot host a cron. It probes registered servers'
   `GET /api/server-info` and writes liveness back to the **same D1** `apps/web` owns.

5. **`docs/plans/` stays at repo root** — internal design docs, NOT Starlight content.

Tooling: **pnpm workspaces** (migrate off npm; `package-lock.json` is 107KB at root,
`ls package-lock.json`) **+ Turborepo**, which earns inclusion narrowly for build-graph
ordering across the shared package and per-app filtered deploys/caches across the three
deploy targets. `.npmrc` stays **minimal** — pnpm's default isolated linker is correct for
wrangler 4 + the Cloudflare Vite plugin + Astro 6; the real gotcha is pnpm's build-script
approval gate, not hoisting.

The whole restructure is **mechanically faithful**: zero behavior change, zero worker/DO
identity change, zero worldgen change. The only code edit is a context-free import-specifier
rewrite (`@/shared/` → `@worldspring/shared/`), and it is gated on a determinism fingerprint
that must match byte-for-byte.

## Goals / Non-goals

**Goals**

- A pnpm workspace with `apps/game`, `apps/web`, `apps/prober`, `packages/shared`, root
  `pnpm-workspace.yaml` + `turbo.json` + `tsconfig.base.json`, replacing the single npm
  package and `package-lock.json`.
- Extract `src/shared` → `@worldspring/shared` with **provable determinism preservation**:
  the worldgen fingerprint over a seed matrix is identical pre/post-move (HARD GATE).
- Preserve the deployed game worker's identity completely: name `"worldspring"`, DO binding
  `GAME→GameRoom`, migration `v1`/`new_sqlite_classes:["GameRoom"]` — the live
  `worldspring.<sub>.workers.dev` world and its DO SQLite survive the move untouched.
- Stand up `apps/web` (Astro: landing + Starlight + directory SSR/D1) and `apps/prober`
  (cron Worker) as workspace packages with their own `wrangler.jsonc` and deploy scripts,
  sharing one directory D1.
- Land it as its own reviewed PR(s) **sequenced before** the doc 01–08 feature milestones,
  so the feature work begins on the workspace, not the single package.
- Keep `.npmrc` minimal and verified (isolated linker, build-allowlist correct) so a clean
  CI `pnpm install` produces a deployable tree.

**Non-goals**

- **No behavior change.** No gameplay, sim, protocol, render, or persistence change rides
  this PR. Worldgen output, the worker bundle's runtime behavior, and the DO storage are
  identical before and after.
- **No worker rename, no DO migration edit.** The worker name and the `v1` migration are
  load-bearing for DO identity; renaming either forks the live world. This doc forbids both.
- **No `src/shared` logic change, no build step for the shared package.** The package ships
  raw `.ts`; a tsc/declaration build is explicitly rejected (determinism risk + watch-mode
  footgun).
- **Not building out the directory / docs content.** `apps/web`'s pages, `apps/prober`'s
  full probe logic, and the D1 schema are doc 02/03/04's scope; this doc **scaffolds** those
  apps as workspace packages with the correct adapter/config and the superseding decisions,
  not their feature surface.
- **No CI authoring beyond the cutover gate.** Wiring `turbo run typecheck build` + the
  loadtest into a CI workflow is recommended (Open question) but the migration's hard gates
  run locally; a full GitHub Actions pipeline is a follow-up.
- **No remote Turbo cache.** Local cache only for v1 (no team, no cache backend).

## Current state

All verified against this worktree.

**One package, one build, one alias**

- Single npm package `"worldspring"`, `private`, `type:module`, exactly 5 scripts
  (`dev`/`build`/`typecheck`/`deploy`/`cf-typegen`), no test/lint/format
  (`package.json:1-12`). Lockfile is `package-lock.json` (107KB at root); no
  `pnpm-lock.yaml`, no `pnpm-workspace.yaml`, no `turbo.json`, no `.npmrc`.
- Runtime deps are client-only (`react 19.2`, `@react-three/fiber 9`, `drei 10`,
  `postprocessing`, `three 0.184`, `zustand 5`, `simplex-noise`, `n8ao`,
  `package.json:13-24`); devDeps carry the whole toolchain (`@cloudflare/vite-plugin
  ^1.40.1`, `@vitejs/plugin-react ^6`, `vite ^8.0.16` — Rolldown-based,
  `wrangler ^4.99.0`, `typescript ~5.9`, `package.json:25-34`).
- ONE `vite build` emits BOTH the client SPA AND the Worker bundle, because
  `@cloudflare/vite-plugin`'s `cloudflare()` sits beside `@vitejs/plugin-react`'s `react()`
  in the plugins array (`vite.config.ts:7`). There is no separate esbuild worker step. The
  build also carries a load-bearing `rolldownOptions.output.codeSplitting.groups`
  (vendor-react eager / vendor-three lazy) that keeps the 3D stack out of the menu chunk
  (`vite.config.ts:13-41`).
- `deploy = "vite build && wrangler deploy"` (`package.json:10`) — plain `wrangler deploy`,
  **no `-c` flag**: the plugin writes a redirect `.wrangler/deploy/config.json` →
  generated `dist/<workerName>/wrangler.json`, and wrangler auto-discovers it
  (`docs/plans/research/cf-deploy.md`, `codebase-server.md`).
- The `@/` alias is configured in **two independent places that must agree**: Vite
  `resolve.alias["@"] = fileURLToPath(new URL("./src", import.meta.url))`
  (`vite.config.ts:8-11`) for bundling, and TS `baseUrl:"."` + `paths {"@/*":["src/*"]}` in
  the base `tsconfig.json:13-16` for typecheck. Neither reads the other.
- Two tsc projects over disjoint libs, both extending `tsconfig.json`: client
  (`lib ES2022+DOM`, `types ["vite/client"]`, `include [src/client, src/shared,
  src/vite-env.d.ts]`, `tsconfig.client.json`) and server (`lib ES2022` no DOM, `types []`,
  `include [src/server, src/shared, worker-configuration.d.ts]`, `tsconfig.server.json`).
  `src/shared` is compiled by BOTH — the determinism-critical code that runs identically on
  client and server.

**Worker / DO identity**

- `wrangler.jsonc`: name `"worldspring"`, `main "src/server/worker.ts"`,
  `compatibility_date "2026-06-01"`, `assets.not_found_handling "single-page-application"`
  (**no `assets.directory`** — the plugin injects it at build), DO binding
  `GAME→GameRoom`, migration `{tag:"v1", new_sqlite_classes:["GameRoom"]}`, observability
  on. No `account_id`/`route`/`workers_dev` — identity is **name-only** (`wrangler.jsonc:1-25`).
- The worker uses ambient-global `Env`: `async fetch(request, env: Env)` +
  `satisfies ExportedHandler<Env>` with **no import** (`src/server/worker.ts:6,22`). It
  resolves because the wrangler-generated `worker-configuration.d.ts` declares a global
  `interface Env` and **hard-codes** `import("./src/server/worker").GameRoom`
  (`worker-configuration.d.ts:5,9`). Regenerated by `wrangler types` (`cf-typegen`), never
  hand-edited.
- The worker routes ONLY `/ws` (426 without Upgrade), `/api/leaderboard`, `/api/health` to
  `env.GAME.getByName("main")`; everything else 404s (`src/server/worker.ts:9-20`). There is
  **no `/api/server-info`** and no directory code anywhere (doc 03 M2 adds the former).

**Shared sim is a clean leaf**

- `src/shared` is exactly 7 `.ts` modules, **no barrel `index.ts`**
  (`ls src/shared/`). Every consumer imports a subpath; `grep 'from "@/shared"'` returns 0.
- **98** `@/shared/*` import lines across client+server
  (`grep -rn '@/shared/' src/client src/server | wc -l` = 98); frequency: `constants` 29,
  `protocol` 18, `math` 18, `items` 14, `world` 13, `movement` 4, `rng` 2.
- **60** `@/client/*` uses (`grep -rn '@/client' src/client` = 60); **0** `@/server/*`
  (server uses relative + `@/shared` only). `src/shared` has **0** `@/` references
  (`grep -rn '@/' src/shared` = 0) — its internal imports are all relative `./`, so a
  verbatim directory move needs **zero edits inside shared**.
- `src/shared`'s only npm dep is `simplex-noise` (imported solely by
  `src/shared/world.ts`, `grep -rln 'simplex-noise' src/` → that one file). No
  react/three/zustand.
- `createWorld(seed: number): World` at `src/shared/world.ts:342`, **2 call sites**:
  server `GameRoom.ts:354 createWorld(WORLD_SEED)` and client
  `connection.ts:266 createWorld(msg.seed)`. Both build the same world from `WORLD_SEED`
  and rely on byte-identical output for prediction/reconciliation.

**Forward-looking shared additions (not yet on disk)**

- `ServerInfo`/`ServerConfig`/`PROTOCOL_VERSION`/`PRESETS`/`serverInfo.ts`/`config.ts`/
  `version.ts`/`text.ts` do NOT exist yet (`grep ServerInfo src/shared` → 0). Doc 03 owns
  `serverInfo.ts` + `PROTOCOL_VERSION` (`03-server-info-contract.md:10-12,111-113`), doc 04
  owns `config.ts`/`PRESETS`/`worldParamsOf`/`summarizeRules`
  (`04-gameplay-presets.md:11,125,328,477`). When they land, they land in
  `packages/shared/src/` and `apps/web` imports them as `@worldspring/shared/*` — **this
  supersedes doc 02 §1's relative `../src/shared/...` import convention**
  (`02-server-directory.md:156-168`).

**Tooling on this machine**

- node `v22.21.1`, pnpm `10.33.4` (via corepack), npm `10.9.4`
  (`node --version` / `corepack pnpm --version` / `npm --version`). `node_modules` and
  `dist` absent (clean checkout).
- `.gitignore` is single-root-oriented: `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`,
  `*.log`, `.DS_Store`, `.mcp.json` (`.gitignore:1-7`). In a workspace these become
  per-app artifacts and need `**` globs.
- The only test asset is `scripts/loadtest.mjs` — a zero-dep Node 22+ harness that drives N
  bots at `ws://localhost:4173/ws` (against `vite preview`), exits non-zero on failure,
  not wired to any CI (`scripts/loadtest.mjs:6,40`; no `.github`, no `vitest.config.*`).
  `scripts/perf-probes.md` is doc 08's profiler note
  (`docs/plans/08-rendering-performance.md:41,213,270`).

## Target structure

```
worldspring/
  pnpm-workspace.yaml        # packages globs + catalog + build-allowlist
  package.json               # private root, packageManager, thin turbo wrappers
  turbo.json                 # build/typecheck/dev/deploy task graph
  .npmrc                     # minimal: auto-install-peers only (no hoisting)
  tsconfig.base.json         # shared compilerOptions (was the root tsconfig.json body)
  .gitignore                 # broadened to **/dist, **/.wrangler, .turbo, …

  apps/
    game/                    # @worldspring/game — Vite + R3F client + Worker/DO (STAYS Vite)
      package.json           #   client runtime deps + build devDeps + @worldspring/shared
      wrangler.jsonc         #   UNCHANGED identity: name "worldspring", GAME→GameRoom, v1
      vite.config.ts         #   alias "@" -> ./src (relative; unchanged), rolldown groups
      index.html             #   <script src="/src/client/main.tsx"> (Vite-root-relative; unchanged)
      tsconfig.json          #   extends ../../tsconfig.base.json; paths @/* + @worldspring/shared
      tsconfig.client.json   #   extends ./tsconfig.json; include src/client only (shared dropped)
      tsconfig.server.json   #   extends ./tsconfig.json; include src/server only (shared dropped)
      worker-configuration.d.ts  # REGENERATED in place via cf-typegen
      src/
        client/              #   git mv'd unchanged
        server/              #   git mv'd unchanged
        vite-env.d.ts
      public/                #   icons, models/*.glb, sfx — client build input
      scripts/loadtest.mjs   #   targets ws://localhost:4173/ws
      assets/                #   items.blend (non-shipped art) — or leave at repo root

    web/                     # @worldspring/web — ONE Astro app (supersedes doc 02 Hono site/)
      package.json           #   astro + @astrojs/cloudflare + @astrojs/starlight + shared
      astro.config.mjs       #   adapter cloudflare(); starlight() integration
      wrangler.jsonc         #   name "worldspring-web", D1 binding DB, NO cron
      src/content.config.ts  #   Content Layer docs collection (REQUIRED, Astro 6)
      src/pages/             #   index.astro (prerendered) + servers/*, api/v1/* (SSR)
      src/content/docs/      #   Starlight public docs (prerendered) — NOT docs/plans
      src/lib/               #   doc-02 db/tokens/probe/rank/sanitize modules
      src/env.d.ts
      migrations/            #   doc-02 §3 D1 schema (.sql)

    prober/                  # @worldspring/prober — cron Worker (peeled off Astro)
      package.json           #   wrangler + typescript + @worldspring/shared
      wrangler.jsonc         #   name "worldspring-prober", triggers.crons, SAME D1 id
      src/index.ts           #   scheduled() handler
      tsconfig.json

  packages/
    shared/                  # @worldspring/shared — DETERMINISM-CRITICAL, raw .ts, no build
      package.json           #   7-entry subpath exports map; dep simplex-noise
      tsconfig.json          #   extends ../../tsconfig.base.json; noEmit
      scripts/fingerprint.mjs    # determinism gate (committed permanent guard)
      scripts/world.fingerprint.txt  # the pinned seed-matrix hash
      src/
        constants.ts items.ts math.ts movement.ts protocol.ts rng.ts world.ts  # git mv'd VERBATIM

  docs/plans/                # STAYS at repo root (internal design docs)
  ARCHITECTURE.md README.md  # stay at repo root
```

## Design

### 1. The determinism gate (the spine of the shared extraction)

The shared extraction is **only allowed to land if worldgen output is byte-identical before
and after**. `src/shared` is PURE — no `Math.random`, `Date`, `import.meta`, `process`,
`globalThis`, `typeof window`, or `performance.now` anywhere
(`grep -rnE 'Math.random|Date|import.meta|process\.|globalThis|typeof window' src/shared` →
only a comment in `world.ts`). `createWorld(seed)` output depends ONLY on its seed argument.
That purity is the precondition that makes a verbatim file relocation **provably**
determinism-preserving: the same `.ts` text V8-compiles to the same bytes on every consumer,
and the move changes no text inside `packages/shared`.

The gate is an **offline esbuild double-build fingerprint** authored as
`packages/shared/scripts/fingerprint.mjs` (zero-dep Node ESM; esbuild via `npx esbuild`,
**pin the version**, e.g. `esbuild@0.24.x`, and record it — `ls node_modules/.bin/esbuild`
is absent locally). It bundles `world.ts` (including `simplex-noise`) to a temp ESM module,
imports it, runs `createWorld` over a fixed seed matrix
`[0, 1, 1337, 2, 7, 42, 99999, 0x7fffffff, 123456789, 2024]`, and emits a stable SHA-256
over a canonical serialization that touches **every field of the `World` contract** — every
rng-stream-derived array (towns, buildings + windows + walls, militaryWalls, props, trees,
lootSpawns, spawnPoints) plus the closures (`heightAt`, `groundHeight`, `raycastStatics`)
sampled on a fixed lattice and fixed rays, with locale-independent float formatting
(round to `1e-9`, normalize `-0`). The multi-seed matrix (incl. `1337`, `0`, `INT_MAX`)
exercises the mask/rejection branches.

The determinism law restated (binding, mirrors
`docs/plans/research/codebase-sim.md` and `07-world-and-wildlife.md` §2): the 10 hash/xor-keyed
rng streams in `createWorld` (`world.ts:343-866` — base `rng`, `noise ^0x9e3779b9`,
`milRng ^0x3f1c7`, `townRng ^0x7041`, `bRng ^0xb17d`, `lRng ^0x100c`, `tRng ^0x7ee5`,
`rockRng ^0x6a09e6`, `propRng ^0x1d872b`, per-building `placeWindows`) keep their fixed draw
order, and the trailing `rng.next()` burn is preserved. **The move touches none of this** —
it is a file relocation, not a logic change.

**Gate procedure:**

1. On the **current** tree (pre-move): `node fingerprint.mjs src/shared/world.ts > BEFORE.txt`.
2. Perform the `git mv` + package wiring + the `sed` rewrite + `pnpm install`.
3. On the **new** tree (post-move):
   `node fingerprint.mjs packages/shared/src/world.ts > AFTER.txt`.
4. **ASSERT** `diff BEFORE.txt AFTER.txt` is empty. **If non-empty, the move altered
   worldgen — STOP and revert.** The extraction is rejected.
5. Commit `packages/shared/scripts/world.fingerprint.txt` (= the BEFORE hash) as a
   **permanent** guard (`packages/shared` script `fingerprint`), so any future accidental
   determinism break — not just this move — is caught.

Run the fingerprint **after** `pnpm install` so any transitive resolution change to
`simplex-noise` is also caught. (Pinning the esbuild version matters: an esbuild codegen
change is a theoretical fingerprint risk — mitigated because the hash is over data, not
emitted code, but pin anyway for cross-machine reproducibility.)

> **Future-watch:** doc 04 changes the signature to
> `createWorld(worldParamsOf(cfg.world))` (`04-gameplay-presets.md:472,477`). Today it is
> still `createWorld(seed: number)` (`world.ts:342`). Gate against the signature **on the
> tree you are moving**. If doc 04 has already merged, drive `serializeWorld` with
> `createWorld(worldParamsOf({...defaults}))` over the matrix and re-baseline `BEFORE.txt` on
> the pre-move tree — before/after equality still holds because the move stays a pure
> relocation.

### 2. `packages/shared` — `@worldspring/shared` (raw `.ts`, no build)

Verbatim move, no edits to internals:

```
packages/shared/
  package.json
  tsconfig.json
  src/
    constants.ts items.ts math.ts movement.ts protocol.ts rng.ts world.ts   ← git mv'd unchanged
```

`packages/shared/package.json`:

```json
{
  "name": "@worldspring/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./constants": "./src/constants.ts",
    "./items":     "./src/items.ts",
    "./math":      "./src/math.ts",
    "./movement":  "./src/movement.ts",
    "./protocol":  "./src/protocol.ts",
    "./rng":       "./src/rng.ts",
    "./world":     "./src/world.ts"
  },
  "dependencies": { "simplex-noise": "^4.0.3" }
}
```

**Decision — ship raw `.ts` via a subpath `exports` map; NO build step, NO declaration
emit, NO `dist`.** Rationale grounded in the repo: every consumer (Vite+Rolldown client,
the Worker bundled by `@cloudflare/vite-plugin`, Astro's Vite SSR) uses
`moduleResolution:"bundler"` and bundles TS source directly today — there is no `dist`
artifact anywhere. A source-only package keeps the determinism guarantee trivial (the same
`.ts` text V8-compiles on every end) and avoids a compile that could perturb output. The
exports map is the explicit enumerated public surface of the 7 modules — it mirrors today's
subpath-only usage (0 barrel imports found) and forbids deep-imports into non-existent
files. **No `.` root export, no `index.ts` barrel** — a barrel invites an import cycle
(`world.ts ← items.ts ← barrel ← world.ts`) and would drag the 31KB `world.ts` into the
menu/web chunk that only needs a type, defeating the `vendor-three` lazy boundary.
`simplex-noise` moves OUT of the game package and INTO `packages/shared/package.json` (its
true owner; pnpm hoists it).

**Types — `paths`, not project references.** The package emits no declarations, so
references (which require `composite`+`declaration`+`outDir`) buy nothing; the repo already
resolves cross-package types via `paths` + bundler resolution. Each consuming app maps the
package name to source (§3, §4). `packages/shared/tsconfig.json`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": [], "noEmit": true },
  "include": ["src"]
}
```

> **Open decision (coordinate with the apps-game owner):** tsconfig `paths` mapping to
> `packages/shared/src` (simpler, no build-ordering signal) vs tsconfig project references
> (explicit graph, plays with turbo `^build`). Because the package is source-only and emits
> no `.d.ts`, **paths is the recommendation** — references would need a declaration build the
> package deliberately does not have. Resolve the package **exactly one way for runtime**
> (pnpm workspace symlink → Vite/Astro resolve natively) and **mirror it for tsc** via the
> paths mapping to the SAME `packages/shared/src`. Never overload `@/` for the package.

### 3. Workspace tooling — pnpm + Turborepo + `.npmrc`

`pnpm-workspace.yaml` (repo root):

```yaml
packages:
  - "apps/*"
  - "packages/*"

# Single source of truth for versions shared across packages. Reference as
# "catalog:" in each package.json. Keeps react/three/wrangler/typescript in lockstep.
catalog:
  typescript: ~5.9.0
  wrangler: ^4.99.0          # satisfies @astrojs/cloudflare@13 peer (wrangler ^4.83)
  react: ^19.2.7
  react-dom: ^19.2.7
  three: ^0.184.0
  "@types/react": ^19.2.17
  "@types/react-dom": ^19.2.3
  "@types/three": ^0.184.1

# pnpm BLOCKS dependency build scripts by default. Whitelist the native-binary
# packages our tools need, or `pnpm install` leaves them unbuilt and
# wrangler/astro/esbuild break at runtime.
onlyBuiltDependencies:
  - esbuild
  - workerd
  - "@cloudflare/workerd-darwin-arm64"
  - "@cloudflare/workerd-linux-64"
  - sharp        # Astro/Starlight image optimization native dep
```

> Catalog earns its place because react/react-dom/@types must stay pinned together and
> wrangler must stay one version across game+web+prober. Do NOT catalog `@react-three/*` or
> the vite-specific trio — they live in exactly one package (game); pin those in
> `apps/game` directly. **pnpm-version note:** this repo's pnpm is `10.33.4`, where the
> build-allowlist key is **`onlyBuiltDependencies:` (a list)**. On pnpm 11 it is
> `allowBuilds:` (a map). Pick one pnpm major and use its key — do not mix. `pnpm
> approve-builds` captures the exact platform package names if a clean install warns about
> ignored build scripts.

Root `package.json` (thin wrappers over turbo; add `packageManager` so Corepack pins pnpm
for every contributor and CI):

```json
{
  "name": "worldspring-monorepo",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@10.33.4",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "deploy:game": "turbo run deploy --filter=@worldspring/game",
    "deploy:web": "turbo run deploy --filter=@worldspring/web",
    "deploy:prober": "turbo run deploy --filter=@worldspring/prober",
    "loadtest": "pnpm --filter @worldspring/game loadtest",
    "cf-typegen": "turbo run cf-typegen"
  },
  "devDependencies": { "turbo": "^2.9.18" }
}
```

`.npmrc` (minimal — the hoisting decision):

```ini
# pnpm's default isolated (symlinked) node_modules is CORRECT here — wrangler's
# esbuild, the Cloudflare Vite plugin, Astro, and @astrojs/cloudflare all resolve
# fine under it at the pinned versions. Do NOT set node-linker=hoisted or
# shamefully-hoist unless a concrete phantom-dependency "Cannot find module" appears,
# and then add a TARGETED public-hoist-pattern[]=<pkg>, never the nuclear option.
auto-install-peers=true
```

The real CI risk is **not** hoisting — it is the build-script approval gate above: on a
clean `pnpm install` the esbuild/workerd/sharp postinstalls are skipped silently unless
whitelisted, producing a broken wrangler/astro at deploy time. Verify by checking the
install output for an "ignored build scripts" warning.

`turbo.json` (deliberately tiny):

```jsonc
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".wrangler/deploy/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "dev":       { "cache": false, "persistent": true },
    "deploy":    { "dependsOn": ["build"], "cache": false },
    "cf-typegen":{ "cache": false }
  }
}
```

Per-key rationale (all verified against current docs): `dependsOn:["^build"]` on `build`
AND `typecheck` makes every app wait for upstream packages first — mostly moot for the
source-only shared package (it has no build), but it **future-proofs** the moment any
package gains a build and makes the build-order race deterministic vs bare
`pnpm -r --parallel`. `dev` is `cache:false` + `persistent:true` (long-lived vite/wrangler
dev servers). `deploy` is `cache:false` (side-effecting) and chains `build`. `build`'s
`outputs` lets turbo cache the worker + asset artifacts and `apps/game`'s two full tsc
passes.

**Why Turbo earns inclusion (the asked decision):** for 3 apps + 1 lib, `pnpm -r` alone is
genuinely sufficient and Turbo is not mandatory. Recommend it **narrowly** for two concrete
wins: (1) `^build` topological ordering for the moment a package gains a real build;
(2) per-task local caching so the common "I only touched `apps/web`" loop doesn't re-run
`apps/game`'s two tsc projects. Skip remote cache for v1. **Equivalent pnpm-only fallback
if Turbo is rejected:** swap every `turbo run X` for `pnpm -r X` (and `dev` for
`pnpm -r --parallel dev`), drop the `turbo` devDep + `turbo.json` — you lose only cross-app
caching; correctness is unchanged.

`.gitignore` broadens to workspace globs: `node_modules` (root + nested), `**/dist/`,
`**/.wrangler/`, `**/.dev.vars`, `.turbo`, `apps/*/.turbo`, plus the existing `*.log`,
`.DS_Store`, `.mcp.json`. Commit `pnpm-lock.yaml`; delete `package-lock.json`.

### 4. `apps/game` — `@worldspring/game` (STAYS Vite; identity preserved)

Physical moves (`git mv`, preserve history) — everything game-related under `apps/game/`:
`src/client`, `src/server`, `src/vite-env.d.ts`, `index.html`, `vite.config.ts`,
`wrangler.jsonc`, `tsconfig.client.json`, `tsconfig.server.json`,
`worker-configuration.d.ts`, `public/`, `scripts/loadtest.mjs`, `assets/`.
`src/shared` is NOT part of this app — it extracts to `packages/shared` (§2) and the game
consumes it as a workspace dep.

`apps/game/package.json` (`name "@worldspring/game"`, `private`, `type:module`) carries the
client runtime deps + build devDeps from the old root `package.json:13-34`, the existing
scripts, plus `loadtest`, and `"@worldspring/shared":"workspace:*"`. **Drop `simplex-noise`
from game deps** — no client/server file imports it directly (`grep -rln 'simplex-noise'
src/` → only `world.ts`), so it is inherited transitively through `@worldspring/shared`.
Remove the moved deps from the root `package.json` (root keeps only workspace tooling).

```jsonc
{
  "name": "@worldspring/game",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.server.json --noEmit",
    "deploy": "vite build && wrangler deploy",
    "cf-typegen": "wrangler types",
    "loadtest": "node scripts/loadtest.mjs"
  },
  "dependencies": {
    "@worldspring/shared": "workspace:*",
    "@react-three/drei": "^10.7.7",
    "@react-three/fiber": "^9.6.1",
    "@react-three/postprocessing": "^3.0.4",
    "n8ao": "^1.10.1",
    "postprocessing": "^6.39.1",
    "react": "catalog:",
    "react-dom": "catalog:",
    "three": "catalog:",
    "zustand": "^5.0.14"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.40.1",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@types/three": "catalog:",
    "@vitejs/plugin-react": "^6.0.2",
    "typescript": "catalog:",
    "vite": "^8.0.16",
    "wrangler": "catalog:"
  }
}
```

**The `@/` alias decision (load-bearing).** Keep `@/` meaning `apps/game/src/` for the
client+server INTERNAL imports, but stop using it for the shared module:

- `apps/game/vite.config.ts`: `resolve.alias["@"] = fileURLToPath(new URL("./src",
  import.meta.url))` is **unchanged** — the URL is relative to the config file, which now
  sits in `apps/game/`, so `./src` = `apps/game/src` automatically. The rolldown
  `codeSplitting.groups` move unchanged. No `configPath` needed: `cloudflare()`
  auto-discovers the sibling `apps/game/wrangler.jsonc` (it searches the Vite root).
  `@worldspring/shared` needs **no** Vite alias — pnpm symlinks it into
  `apps/game/node_modules` and Vite resolves it natively. (An explicit
  `"@worldspring/shared" -> ../../packages/shared/src` alias is optional belt-and-suspenders
  to *guarantee* Rolldown picks source not a phantom dist; harmless, since the exports map
  already points only at `./src/*.ts`.)
- `apps/game/tsconfig.json` (new app base, extends `../../tsconfig.base.json`): keep
  `paths {"@/*":["src/*"]}` and ADD `{"@worldspring/shared/*":["../../packages/shared/src/*"]}`
  so tsc resolves shared types to source during dev. Because `@/server` is unused and
  `@/client` only appears under `apps/game/src/client`, the `@`→`./src` remap is a no-op
  rename — `@/client/...` and `@/server/...` keep working; **only `@/shared/*` changes**.

```jsonc
// apps/game/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@worldspring/shared/*": ["../../packages/shared/src/*"]
    }
  }
}
// apps/game/tsconfig.client.json — extends ./tsconfig.json; lib ES2022+DOM+DOM.Iterable;
//   types ["vite/client"]; include ["src/client", "src/vite-env.d.ts]  (src/shared DROPPED)
// apps/game/tsconfig.server.json — extends ./tsconfig.json; lib ES2022; types [];
//   include ["src/server", "worker-configuration.d.ts]  (src/shared DROPPED)
```

`tsconfig.base.json` at repo root holds the compiler flags currently in
`tsconfig.json:2-12` (`target ES2022`, `module ESNext`, `moduleResolution bundler`, `jsx
react-jsx`, `strict`, `noEmit`, `isolatedModules`, `skipLibCheck`,
`forceConsistentCasingInFileNames`, `noFallthroughCasesInSwitch`) **without** the `@/*`
paths block (paths now live per-app). `apps/web` and `packages/shared` extend it too.

**The mechanical rewrite (the only code edit):**
`find apps/game/src -name '*.ts*' -exec sed -i '' 's#@/shared/#@worldspring/shared/#g' {} +`
— exactly **98 lines** change. The swap is context-free because the 7 subpaths
(`constants|items|math|movement|protocol|rng|world`) are identical pre/post. Leave
`@/client/*` (60) and `@/server/*` untouched. Guard with
`rg "@/shared" apps/game/src` → must return 0; typecheck + build fail fast on any miss.

`apps/game/wrangler.jsonc` — **identity preserved verbatim**, only `main` is reinterpreted
(its literal string is unchanged — it was always app-root-relative):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "worldspring",                         // UNCHANGED — sole deploy identity; do NOT rename
  "main": "src/server/worker.ts",                // unchanged literal; resolves under apps/game/
  "compatibility_date": "2026-06-01",
  "assets": { "not_found_handling": "single-page-application" },  // NO directory key — plugin injects it
  "durable_objects": { "bindings": [ { "name": "GAME", "class_name": "GameRoom" } ] },  // UNCHANGED
  "migrations": [ { "tag": "v1", "new_sqlite_classes": ["GameRoom"] } ],                // UNCHANGED — same lineage
  "observability": { "enabled": true }
}
```

The plugin still emits `dist/worldspring/{index.js, wrangler.json}` (name-derived subdir),
`dist/client/**`, and `apps/game/.wrangler/deploy/config.json` →
`../../dist/worldspring/wrangler.json` — `wrangler deploy` from `apps/game` picks it up with
no `-c` flag. `index.html:13` `<script src="/src/client/main.tsx">` is **unchanged** (the
leading-slash path is Vite-root-relative; `apps/game/` is the new root).
`worker-configuration.d.ts` is **regenerated in place** via
`pnpm --filter @worldspring/game cf-typegen` after the move — its hard-coded
`import("./src/server/worker")` (`worker-configuration.d.ts:5,9`) stays valid because
`worker.ts` lives beside `src/` inside `apps/game`. Never hand-edit; commit the regenerated
file.

Invocation from root: `pnpm --filter @worldspring/game {dev|build|preview|deploy}` (or
`turbo run … --filter=@worldspring/game`). The `deploy` script runs `vite build && wrangler
deploy` with `cwd = apps/game`, so wrangler finds its own config and the DO lineage is
intact.

### 5. `apps/web` — ONE Astro app (supersedes doc 02's Hono `site/`)

`apps/web` is an Astro 6 app on `@astrojs/cloudflare`, deployed as its own Worker
(`worldspring-web`), serving three concerns in one project: (A) prerendered marketing
landing, (B) Starlight docs (prerendered), (C) the server directory as SSR pages + `/api/v1`
JSON endpoints backed by D1. It pulls **no React/three** — plain `.astro` + minimal vanilla
island scripts, so it does not inherit `apps/game`'s heavy deps. **This is the formal
supersession of doc 02 §1's separate Hono `site/` worker** (`02-server-directory.md:97-148`,
name `deadcoast-site`); doc 02 already chose SSR over SPA on its own grounds
(`02-server-directory.md:112-127`), so the swap is sound.

`apps/web/package.json` (peers verified 2026-06-12: `@astrojs/cloudflare@13` needs
`astro ^6.3` + `wrangler ^4.83`; `@astrojs/starlight@0.40` needs `astro ^6.4.5`):

```json
{
  "name": "@worldspring/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "wrangler dev",
    "deploy": "astro build && wrangler deploy",
    "typecheck": "astro check",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "astro": "^6.4.6",
    "@astrojs/cloudflare": "^13.7.0",
    "@astrojs/starlight": "^0.40.0",
    "@worldspring/shared": "workspace:*"
  },
  "devDependencies": { "wrangler": "catalog:" }
}
```

`astro.config.mjs` — leave render mode at Astro 6's default **`static`** (prerender by
default); do NOT set `output:'server'`. Pages opt into SSR per-route with
`export const prerender = false`:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://worldspring-web.<sub>.workers.dev', // or custom domain
  adapter: cloudflare({
    platformProxy: { enabled: true }, // local D1 in `astro dev`
    imageService: 'compile',          // build-time transforms; avoids an Images binding
  }),
  integrations: [
    starlight({
      title: 'Worldspring Docs',
      sidebar: [
        { label: 'Getting Started', items: [{ slug: 'getting-started' }] },
        { label: 'Hosting a Server', autogenerate: { directory: 'hosting' } },
        { label: 'Reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
});
```

`src/content.config.ts` is **REQUIRED** on Astro 6 (Content Layer; Starlight 0.40 needs
`docsLoader()` + `docsSchema()`, legacy glob collections are gone — without this file the
docs build emits zero pages):

```ts
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
export const collections = { docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }) };
```

**Rendering matrix:** landing `src/pages/index.astro` and `policy.astro` are **prerendered**
(default). Starlight docs under `src/content/docs/**` are **prerendered** (these are PUBLIC
product docs — hosting guide, the `/api/server-info` contract, presets; `docs/plans/` at
repo root stays internal and is NOT imported). Directory pages
(`servers/index.astro`, `servers/[id].astro`, `join/[id].astro`, `register.astro`,
`admin.astro`) and ALL `/api/v1/*` endpoints set `export const prerender = false` → SSR on
the Worker. Filters/sorts/pagination are query params (cacheable URLs per doc 02 §8/§11).
**Route-collision fix:** keep the landing as an explicit `src/pages/index.astro` file route
(file routes win over Starlight-generated slugs) and namespace docs under `/docs` via a
leading `docs/` slug segment.

**CRITICAL API CHANGE vs doc 02's implied API:** with `@astrojs/cloudflare` v13 the
`Astro.locals.runtime` object has been **REMOVED**. Bindings come from
`import { env } from 'cloudflare:workers'`; the cf object from `Astro.request.cf`;
`ExecutionContext` from `Astro.locals.cfContext`. Every endpoint reads D1 via
`env.DB`, not `Astro.locals.runtime.env.DB`:

```ts
// src/pages/api/v1/heartbeat.ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { HeartbeatBody, ServerInfo } from '@worldspring/shared/serverInfo';
export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  // parse Bearer dcd1.<id>.<secret>; token-bucket rate limit (doc 03 §9); 8 KB body cap
  const body = (await request.json()) as HeartbeatBody;   // strict-validate
  const db = env.DB as D1Database;
  await db.prepare('UPDATE servers SET players=?,motd=?,updated_at=? WHERE id=? AND token_hash=?')
    .bind(/* … */).run();
  return new Response(null, { status: 204 });
};
```

The doc-02 `tokens.ts`/`probe.ts`/`rank.ts`/`sanitize.ts` modules move into `src/lib/`
verbatim, importing `STRIP_TEXT_RE`/`PRESETS`/`summarizeRules`/`PROTOCOL_VERSION` from
`@worldspring/shared/*`. The doc 02 §1 "constants/types-only" boundary is now enforced
**mechanically as a package boundary** — `apps/web` simply doesn't depend on any game
client/server package — retiring doc 02 Open-Q6's review-only stance. Add
`@worldspring/shared` to `vite.ssr.noExternal` in `astro.config` as the documented
monorepo safeguard so Astro's SSR build bundles the workspace source instead of
externalizing it.

`apps/web/wrangler.jsonc` (v13 adapter entrypoint shape — the adapter emits
`dist/_worker.js/index.js` and binds `ASSETS` over `./dist`):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "worldspring-web",
  "main": "dist/_worker.js/index.js",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS", "directory": "./dist" },
  "d1_databases": [
    { "binding": "DB", "database_name": "worldspring-directory", "database_id": "<created at setup>" }
  ],
  "observability": { "enabled": true }
  // secrets via `wrangler secret put -c apps/web/wrangler.jsonc`: ADMIN_TOKEN, SESSION_SECRET, REPORT_SALT
  // NO cron triggers here — the prober Worker owns scheduled(). Astro is request-driven.
}
```

D1 migrations live at `apps/web/migrations/*.sql` (the doc 02 §3 schema moves here
unchanged; all `*_at` columns stay epoch ms), applied with
`wrangler d1 migrations apply worldspring-directory -c apps/web/wrangler.jsonc`. `apps/web`
**owns** the schema/migrations.

### 6. `apps/prober` — cron Worker (peeled off Astro)

`apps/prober` is a SMALL standalone Worker (no assets, no React, no Astro) whose ONLY job is
the `scheduled()` Cron handler. **Why it can't live in `apps/web`:** `@astrojs/cloudflare`
produces a request-driven Worker — its handlers fire on inbound HTTP; a Cron Trigger
delivers a scheduled event with NO request object, and only a Worker that exports
`scheduled(controller, env, ctx)` receives it. Astro provides no `scheduled()` entrypoint.
It binds the **SAME D1** as `apps/web` (D1 is account-level, keyed by `database_id`; both
Workers list the same binding), runs **no migrations**, and only reads `servers` rows +
writes `probes`/`servers`/`stats_hourly`.

`apps/prober/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "worldspring-prober",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "triggers": { "crons": ["*/5 * * * *"] },   // doc 02 cadence (Free allows 5 crons; 1 used)
  "d1_databases": [
    { "binding": "DB", "database_name": "worldspring-directory", "database_id": "<same id apps/web uses>" }
  ],
  "observability": { "enabled": true }
  // NO secrets: the prober only READS public /api/server-info (CORS *) and writes D1.
}
```

`apps/prober/src/index.ts` skeleton:

```ts
import type { ServerInfo } from "@worldspring/shared/serverInfo";
interface Env { DB: D1Database; }

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runProbeSweep(controller, env)); // survives past the sync return
  },
} satisfies ExportedHandler<Env>;
```

Subrequest/connection discipline (verified platform limits, Free plan; binding even on
Paid): every `fetch` AND every D1 op counts against the **50-subrequest/invocation cap**,
and at most **6 outgoing connections** are open per invocation. Design consequences for the
implementer (doc 02 §6 scope, restated as the architecture the package must follow):
**(a)** cap the due-set `SELECT` to ~45 servers/invocation, `ORDER BY last_probe_at ASC` so
the backlog drains round-robin across successive 5-min runs; **(b)** probe with a worker
**pool of 6**, NOT "chunks of 20" (doc 02's batching figure predates the connection model —
20 concurrent fetches can only open 6 connections, and uncancelled bodies hold them open);
**(c)** fold ALL writeback into ONE `db.batch([...])` (a single atomic subrequest), not
per-server `UPDATE`s (which would blow the cap at ~16 servers). Call `res.body?.cancel()` on
every non-2xx to free the connection. SSRF guard, ServerInfo shape validation, and
`directoryChallenge` re-check against the stored `challenge_hash` are doc 02 §6 / doc 03 §7
logic that moves here verbatim. **Recommend Workers Paid on the directory account** (raises
the cap to 10,000 and lifts D1 free-tier write limits) — doc 02 Open Q1.

`apps/prober/package.json`: `name "@worldspring/prober"`, `private`, `type:module`, scripts
`{deploy:"wrangler deploy", dev:"wrangler dev --test-scheduled", typecheck:"tsc --noEmit",
cf-typegen:"wrangler types"}`, deps `"@worldspring/shared":"workspace:*"` + `wrangler` +
`typescript` (catalog). Local-test with `wrangler dev --test-scheduled` +
`curl 'http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*'`.

> **Schema coupling to police:** the prober hard-codes `apps/web`'s D1 column names/types.
> Put the `ServerRow` type + the directory column contract in `@worldspring/shared` (or
> generate it from the schema), imported by BOTH apps, so a schema change is a typecheck
> failure in both packages — not a silent runtime break.

## Implementation plan

Sequencing law: **the restructure lands BEFORE any doc 01–08 feature milestone**, as its own
reviewed PR(s). Those docs all touch `src/shared`, `wrangler.jsonc`, or the directory design;
starting them on the single package and migrating mid-flight multiplies merge pain and risks
a determinism break hidden inside a feature diff. **M1 → M2 (HARD GATE) → M3 → M4 →
{M5, M6} → M7.** M1–M4 are one PR (the game+shared move — the live deploy path); M5–M7 are a
second PR (the new apps — no impact on the running game). Each milestone is one focused,
PR-sized session.

Model recommendations follow doc 07's convention: **Opus 4.8** for the determinism-critical
shared extraction and the DO-migration-continuity work (a silent worldgen desync or a DO
reset is unrecoverable); **Sonnet 4.8** for mechanical moves and scaffolds.

1. **M0 — Workspace skeleton + tooling** *(Sonnet 4.8 — mechanical)*
   Create `pnpm-workspace.yaml` (`apps/*`, `packages/*`, catalog, `onlyBuiltDependencies`),
   root `package.json` (`packageManager: pnpm@10.33.4`, turbo wrappers), `.npmrc` (minimal),
   `turbo.json`, `tsconfig.base.json` (the current `tsconfig.json:2-12` body **minus** the
   `@/*` paths), broadened `.gitignore`. `corepack enable && corepack prepare
   pnpm@10.33.4 --activate`; verify `pnpm -v` = 10.33.4.
   **Accept:** `pnpm-workspace.yaml` + `turbo.json` + `tsconfig.base.json` exist and parse;
   `corepack pnpm -v` = 10.33.4; no app moved yet (skeleton only); root `package.json` has no
   game runtime deps.

2. **M1 — Move `apps/game` + rewrite imports** *(Opus 4.8 — DO-identity continuity)*
   `git mv` the game files into `apps/game/` (§4); author `apps/game/package.json`
   (`@worldspring/game`, deps moved from old root, `@worldspring/shared:"workspace:*"`, drop
   `simplex-noise`); write `apps/game/tsconfig.json` (extends base; `paths @/*` +
   `@worldspring/shared/*`) and re-point `tsconfig.client/server.json` (`extends
   ./tsconfig.json`, **drop `src/shared` from both `include`**); run the `sed` rewrite
   `@/shared/` → `@worldspring/shared/` across `apps/game/src`. Verify `apps/game/wrangler.jsonc`
   is byte-identical in the identity fields (name `"worldspring"`, `GAME→GameRoom`,
   `v1`/`new_sqlite_classes:["GameRoom"]`). **Do NOT** rename the worker, edit the migration
   tag, rename the class, or add a divergent `account_id`.
   **Accept:** `rg "@/shared" apps/game/src` returns 0 (rewrite complete);
   `apps/game/wrangler.jsonc` identity fields diff-clean vs pre-move;
   `apps/game/index.html` line 13 unchanged.

3. **M2 — `pnpm install` + DETERMINISM GATE + cf-typegen** *(Opus 4.8 — HARD GATE)*
   **Before** the move (captured in M1's branch base): author
   `packages/shared/scripts/fingerprint.mjs`, run `node fingerprint.mjs src/shared/world.ts
   > BEFORE.txt` on the pre-move tree (esbuild via `npx`, version pinned). `git mv
   src/shared/*.ts packages/shared/src/`; write `packages/shared/package.json` (7-entry
   exports map, `simplex-noise`) + `tsconfig.json`. `pnpm import` then delete
   `package-lock.json`; `pnpm install` (generates `pnpm-lock.yaml`, symlinks
   `@worldspring/shared`). Regenerate `apps/game/worker-configuration.d.ts` via
   `pnpm --filter @worldspring/game cf-typegen`. Run `node fingerprint.mjs
   packages/shared/src/world.ts > AFTER.txt`.
   **Accept (HARD GATE — blocks the entire migration):** `diff BEFORE.txt AFTER.txt` is
   **empty** — worldgen is byte-identical across the 10-seed matrix. If non-empty, **revert
   and investigate**; the extraction does not land. Commit
   `packages/shared/scripts/world.fingerprint.txt` (= the BEFORE hash) as the permanent CI
   guard. Secondary: `pnpm install` shows **zero** "ignored build scripts" warnings
   (build-allowlist correct); `pnpm why simplex-noise three react` shows no version drift vs
   the old lock.

4. **M3 — Validate the game slice + typecheck/build gates** *(Opus 4.8 — deploy-path proof)*
   `pnpm --filter @worldspring/game typecheck` (both tsc projects); `pnpm --filter
   @worldspring/game build`; assert the build output; `pnpm --filter @worldspring/game
   preview` + `node apps/game/scripts/loadtest.mjs ws://localhost:4173/ws 20 120`; then
   `pnpm --filter @worldspring/game exec wrangler deploy --dry-run`.
   **Accept (typecheck + build gates):** both tsc projects green with zero unresolved
   `@worldspring/shared/*`; build emits `dist/worldspring/{index.js, wrangler.json}` +
   `dist/client/**` + `apps/game/.wrangler/deploy/config.json`; the `vendor-react` /
   `vendor-three` chunk boundary holds (diff the chunk list against a pre-migration
   baseline — the eager menu chunk must NOT gain the 3D stack); loadtest prints
   `RESULT: PASS` with tick EMA unchanged vs the standard envelope; `wrangler deploy
   --dry-run` shows `name = worldspring` and the `v1`/`GameRoom` migration as a **no-op**
   (already applied — proves no DO reset). **This is the end of PR #1** — the game+shared
   move, the only piece touching the live deploy.

5. **M4 — Scaffold `apps/web` (Astro)** *(Sonnet 4.8 — scaffold)*
   Add `apps/web` to the workspace; install `astro@^6.4.6`,
   `@astrojs/cloudflare@^13.7.0`, `@astrojs/starlight@^0.40.0`, `wrangler` (catalog),
   `@worldspring/shared:"workspace:*"`. Write `astro.config.mjs` (cloudflare adapter,
   starlight, `vite.ssr.noExternal:["@worldspring/shared"]`), `src/content.config.ts`
   (Content Layer), a prerendered `src/pages/index.astro` + `policy.astro`, one SSR
   `servers/index.astro` (`prerender = false`) and one SSR `api/v1/latest.ts` reading
   `env` from `cloudflare:workers`, `src/env.d.ts`, `apps/web/wrangler.jsonc` (v13 shape, D1
   `DB`, NO cron). Create the D1 (`wrangler d1 create worldspring-directory`), paste
   `database_id`, place the doc 02 §3 schema in `apps/web/migrations/`. (Full directory page
   set + endpoints are doc 02/03/04 scope — this milestone proves the shell deploys.)
   **Accept:** `pnpm --filter @worldspring/web build` emits `dist/_worker.js/index.js` +
   the docs routes (Content Layer wired); `astro check` green; `pnpm --filter
   @worldspring/web exec wrangler deploy --dry-run` resolves `main` + D1; landing prerenders
   and `/docs/*` resolves without colliding with `/`; the one SSR endpoint reads D1 via
   `cloudflare:workers` (not `Astro.locals.runtime`).

6. **M5 — Scaffold `apps/prober` (cron Worker)** *(Sonnet 4.8 — scaffold)*
   Add `apps/prober` to the workspace; `package.json` (`@worldspring/prober`, shared +
   wrangler + typescript), `wrangler.jsonc` (name `worldspring-prober`,
   `triggers.crons:["*/5 * * * *"]`, SAME D1 `database_id` + binding `DB`, no assets/secrets),
   `src/index.ts` with a `scheduled()` skeleton (`ctx.waitUntil`, a due-set `SELECT` LIMIT
   ~45 ordered by `last_probe_at`, a 6-wide pool stub, a single `db.batch` writeback stub),
   `tsconfig.json`. (Full probe state machine + housekeeping are doc 02 §6 scope.)
   **Accept:** `pnpm --filter @worldspring/prober typecheck` green; `wrangler dev
   --test-scheduled` + `curl '…/__scheduled?cron=*%2F5+*+*+*+*'` fires `scheduled()` against
   the local D1 without error; `wrangler deploy --dry-run` shows the cron trigger + the
   shared `database_id`.

7. **M6 — Root orchestration + docs cutover** *(Sonnet 4.8 — mechanical)*
   Confirm root `turbo run build` / `typecheck` order the three apps after
   `@worldspring/shared`; finalize root `deploy:game`/`deploy:web`/`deploy:prober` +
   `loadtest`. Revise the docs in `docRevisionsNeeded`: README "Run" block → pnpm/Corepack;
   doc 02 §1 → Astro app + the `@worldspring/shared` package boundary + the
   `cloudflare:workers` env API, with §6 cron text pointing at `apps/prober`; ARCHITECTURE.md
   alias/ownership lines; the `scripts/perf-probes.md` and `scripts/loadtest.mjs` path refs
   in docs 02/03/04/06/08 → `apps/game/scripts/…`.
   **Accept:** `pnpm build` and `pnpm typecheck` at root succeed and demonstrably build
   `@worldspring/shared` before each app; `pnpm loadtest` runs the game harness; the listed
   docs no longer reference `src/shared` relative imports, the Hono `site/` worker, the old
   npm run block, or stale `scripts/` paths. **This is the end of PR #2.**

> **Recommended (Open question, not a hard gate):** before merging PR #1, wire `turbo run
> typecheck build` + the loadtest into a CI workflow — the migration sharply raises the cost
> of a silent cross-app/alias break, and the loadtest already exits non-zero on failure.

## Implications

**Opens up**

- Three independent deploy targets with clean boundaries: `apps/game` (the live world,
  untouched identity), `apps/web` (landing + docs + directory), `apps/prober` (cron). Each
  deploys on its own cadence via `turbo run deploy --filter=…`.
- The doc 02 §1 "constants/types-only" import rule becomes a **mechanical package boundary**
  (`apps/web`/`apps/prober` simply don't depend on any game client/server package) instead
  of a review-only convention — retiring doc 02 Open-Q6.
- `apps/web` folds the marketing landing + Starlight docs into the same project that serves
  the directory, on Astro's island model — superseding doc 02's separate Hono worker on
  doc 02's own stated SSR grounds.
- The shared package's enumerated `exports` map gives every future shared symbol
  (`serverInfo`, `config`, `version`, `text` when docs 03/04 land them) a single typed
  import surface (`@worldspring/shared/*`) for game + web + prober at once.
- Catalog-pinned react/three/wrangler/typescript across packages — one place to bump a
  version that must stay in lockstep.

**Complicates**

- The `@/` alias now lives only in `apps/game` and resolves **two** ways (Vite symlink
  resolution for `@worldspring/shared`, the `@/`→`./src` remap for internal imports), with
  tsc paths mirroring both. One more surface to keep in sync — mitigated by resolving the
  shared package exactly one way for runtime and one way for tsc, both pointing at
  `packages/shared/src`.
- Build-order correctness now depends on `^build` (or accepting that the source-only shared
  package needs none today). The moment any package gains a real build, bare `pnpm -r
  --parallel` becomes a race; turbo's `dependsOn:["^build"]` is the guard.
- Two D1-binding Workers (`apps/web` + `apps/prober`) share one database with no
  compile-time link between them — schema drift in `apps/web`'s migrations silently breaks
  `apps/prober`'s queries until the shared `ServerRow` contract is added.
- `worker-configuration.d.ts` is a generated artifact with a hard-coded relative
  `import("./src/server/worker")` — it must be regenerated (never hand-edited) after the
  move and after any `wrangler.jsonc` binding change.
- npm → pnpm changes the dependency tree (hoisting, peer resolution for the R3F stack);
  decoupled from the determinism gate (shared's only dep is `simplex-noise`), but the
  fingerprint must run **after** install so a `simplex-noise` resolution change is caught.

**Breaks**

- Nothing at runtime — by design. No gameplay, sim, protocol, render, or persistence
  behavior changes; the worker name, DO binding, and `v1` migration are preserved verbatim,
  so the live world's DO SQLite survives.
- The build/dev/deploy commands change: `npm run dev/typecheck/deploy` → `pnpm dev` /
  `pnpm typecheck` / `pnpm deploy:game` (+ `deploy:web`/`deploy:prober`). README and any CI
  must update; Corepack must be enabled so `packageManager` pins pnpm.
- Doc 02's `site/` Hono worker design and its relative `../src/shared/...` import convention
  are **superseded** — an implementer who builds doc 02 §1 as written would produce a Hono
  worker and relative imports the monorepo has retired.

**Threatens**

- **Determinism desync** is the worst-case failure: if any step perturbs `createWorld`
  output (a stray build step, a `simplex-noise` version drift, a non-verbatim move), client
  prediction silently diverges from server authority near nothing visible. Mitigated by the
  HARD GATE (M2) — byte-compare before/after across the seed matrix, blocking the merge — and
  by shipping the package as raw `.ts` with no build.
- **DO-identity loss** is the second unrecoverable failure: a worker rename, a migration-tag
  edit, or a class rename without `renamed_classes` strands the deployed `GameRoom` storage
  under a dead name → fresh empty world. Mitigated by forbidding all four (M1 accept:
  identity fields diff-clean; M3 accept: `--dry-run` shows `name = worldspring` + migration
  no-op).
- **Silent CI breakage** from pnpm's build-script gate: a clean `pnpm install` that skips
  esbuild/workerd/sharp postinstalls yields a broken wrangler/astro at deploy time, with a
  cryptic missing-binary error rather than an install failure. Mitigated by the
  `onlyBuiltDependencies` allowlist + the M2 "zero ignored-build-scripts" accept.
- **Chunk-split regression:** a pnpm/catalog bump pulling a different Vite/Rolldown could
  change `codeSplitting.groups` chunking and re-bloat the eager menu chunk (the exact
  regression `vite.config.ts:13-41` warns about). Mitigated by pinning vite +
  `@cloudflare/vite-plugin` + `@vitejs/plugin-react` and diffing the `dist/client` chunk
  list against a pre-migration baseline (M3 accept).
- **`@astrojs/cloudflare` v13 API drift:** designing `apps/web` endpoints against the
  removed `Astro.locals.runtime.env.DB` (doc 02's implied API) would fail to compile/run.
  Mitigated by building against `import { env } from 'cloudflare:workers'` and the M4
  accept that the SSR endpoint reads D1 that way.

## Migration & compatibility

- **The live game (worker `worldspring`):** zero runtime impact. The worker name, DO binding
  `GAME→GameRoom`, and migration `{tag:"v1", new_sqlite_classes:["GameRoom"]}` are preserved
  verbatim (`wrangler.jsonc:3,9-21`), so the deployed DO's SQLite is untouched. M3's
  `wrangler deploy --dry-run` proves `name = worldspring` and the migration as a no-op
  before any real deploy. The deploying account context must remain the same account that
  owns the existing worker (identity is name-only; confirm `CLOUDFLARE_ACCOUNT_ID`).
- **Worldgen / persistence:** the shared extraction is determinism-gated — the fingerprint
  over the seed matrix is **byte-identical before/after** (M2 HARD GATE). No `SCHEMA_VERSION`
  change, no world reset. The permanent `world.fingerprint.txt` guard pins the seed-matrix
  hash forever so any future accidental break is caught.
- **Imports:** the only code edit is the context-free `@/shared/` → `@worldspring/shared/`
  rewrite (98 lines); `@/client` (60) and `@/server` (0) are untouched. `git diff --stat`
  should show ~98 changed lines under `apps/game/src` and **nothing** under
  `packages/shared`.
- **Tooling:** `package-lock.json` → `pnpm-lock.yaml` (via `pnpm import` to preserve resolved
  versions, then delete the npm lock, in the **same commit** so bisect stays clean). Corepack
  pins pnpm `10.33.4` via `packageManager`.
- **`apps/web` / `apps/prober`:** net-new, no existing deploy to migrate. They share one D1
  (`apps/web` owns migrations; `apps/prober` reads/writes with the same `database_id`).
  Standing them up does not affect the running game.
- **Docs:** README "Run" block, doc 02 §1 (Astro + package boundary + `cloudflare:workers`
  env), ARCHITECTURE.md alias/ownership, and the `scripts/perf-probes.md` /
  `scripts/loadtest.mjs` path refs in docs 02/03/04/06/08 all need updating (see
  `docRevisionsNeeded`). `docs/plans/` stays at repo root.

## Open questions for Adam

1. **Turborepo IN or pnpm-only?** With 3 deploy targets sharing `packages/shared`, turbo's
   build-graph ordering + filtered deploys + local caching of `apps/game`'s two tsc passes
   earn it. **Recommendation: include the tiny `turbo.json`.** The fallback (`pnpm -r` +
   `pnpm --filter`) is a clean one-find-replace drop-in losing only caching — decide before
   M0 writes `turbo.json`.
2. **Shared-types resolution: tsconfig `paths` vs project references.** The package is
   source-only (no `.d.ts` emit), so references buy nothing. **Recommendation: `paths`
   mapping to `packages/shared/src`.** Confirm so M2 wires the right one.
3. **Catalog scope.** Cataloging the Cloudflare/TS/wrangler versions shared across
   game+web+prober is clearly worth it. The vite-specific trio
   (`vite`/`@cloudflare/vite-plugin`/`@vitejs/plugin-react`) is game-only — catalog for
   one-place visibility, or pin in `apps/game` directly? **Recommendation: pin in
   `apps/game`** (web/prober don't use Vite directly).
4. **`@astrojs/cloudflare` version pin.** Commit to **v13 + Astro 6** (current; bindings via
   `cloudflare:workers`, `Astro.locals.runtime` removed) — recommended — or pin v12 to keep
   doc 02's implied `Astro.locals.runtime.env.DB` API at the cost of Astro 6 features? This
   changes every `apps/web` endpoint's binding-access code; needs an explicit call.
5. **CI in scope for this migration?** None exists today (no `.github`, no test runner). The
   restructure multiplies moving parts with zero automated gate beyond the manual loadtest.
   **Recommendation: wire `turbo run typecheck build` + the loadtest into CI as part of the
   cutover** — cheap, and the loadtest already exits non-zero on failure. In-scope for PR #1,
   or a follow-up?
6. **Non-shipped art (`assets/items.blend`) location.** `docs/plans/` stays at repo root per
   the agreed target; `assets/` is build-irrelevant — leave at repo root, or move under
   `apps/game`? **Recommendation: move under `apps/game`** (co-located with the game it feeds)
   so no root-level tooling globs it; confirm so the move is clean.
7. **`vite preview` port under the workspace.** `loadtest.mjs` hard-codes
   `ws://localhost:4173/ws` (`scripts/loadtest.mjs:6`). Confirm `vite preview` still binds
   4173 when invoked as a pnpm-filtered script from `apps/game`; if not, set
   `preview.port:4173` in `apps/game/vite.config.ts` or pass the URL arg. Longer term, import
   the harness's hand-mirrored constants from `@worldspring/shared` instead of duplicating
   them.
8. **D1 ownership across two Workers.** Confirm `apps/web` is the sole migration owner and
   `apps/prober` only reads/writes the shared db with the same `database_id`, both binding it
   as `DB`. **Recommendation: yes** — and add the `ServerRow` contract to
   `@worldspring/shared` so a schema change is a typecheck failure in both packages.
9. **`apps/web` host: custom domain vs `workers.dev`.** doc 02 Open-Q2 flagged that public
   OAuth-client visibility needs a TXT-verifiable custom domain; the same now lands on the
   Astro app's host. The `site:` config and the join interstitial copy depend on the final
   origin — decide before authoring directory/docs URLs.
