# Create Your Server: one-click Worldspring deploys into the user's own Cloudflare account

## Summary

A visitor on the official Worldspring site clicks **Create Server**, signs in with Cloudflare
(self-managed OAuth, confidential client owned by us), picks a preset + server name, and the
site Worker deploys a prebuilt copy of the official game — Worker bundle, 4.8 MB of client
assets, the `GameRoom` DO with its `new_sqlite_classes` migration, a `GAME_CONFIG` var, and
a baked-in `DIRECTORY_TOKEN` secret — into **their** account at
`<name>.<their-subdomain>.workers.dev`, in seconds, using ~6 documented REST calls
(the stable multipart Script Upload API, the same path wrangler uses).

Decisions, up front:

1. **Tokens are deliberately ephemeral.** No refresh tokens, no `offline_access`. The OAuth
   access token lives only inside a deploy job (a DO row), is nulled the moment the job
   reaches **any** terminal state (`done` *or* `failed`), and paused jobs auto-fail after
   1 h — so no token survives longer than ~1 h on any path, mechanically (§5 failure
   handling). Updates re-run the OAuth bounce. Rationale in *Design §6* — holding
   standing deploy-capable credentials for every creator is the single worst risk this
   feature can take on, and it buys one click per ~monthly update.
2. **Deploys ship prebuilt artifacts, never source builds.** GitHub Actions builds on every
   `v*` tag and publishes a versioned artifact to R2 (mirrored to GitHub Releases). The site
   replays the artifact byte-for-byte into the user's account.
3. **Directory registration is decoupled from deploy.** The site mints a directory token
   pre-deploy and bakes it in as a `secret_text` binding; the deployed server activates its
   listing by heartbeating. The same registration page works for CLI-deployed servers, which
   stay a first-class path.
4. **Every redeploy rotates the directory token** — avoids relying on undocumented
   `keep_bindings`/secret-inheritance semantics in the raw upload API. Rotation activates
   through an old+new overlap window on the directory side, so an update job that dies
   mid-flight can never silently delist a live server (§7).
5. **Cost is shown before the deploy button is enabled**, with the real player-hours math
   from research/cf-costs.md — including the honest caveat that free-plan hosting needs the
   persistAll write-amplification fix first. Community deploys cap Workers Logs sampling at
   1% (§5 step 6) so observability cannot become the surprise line item the cost panel
   promises away (§4.3).

Hard prerequisite flagged early: **public OAuth client visibility requires DNS TXT
verification of the client URL's domain — workers.dev cannot be verified**
(research/cf-oauth.md §6, §8). Worldspring needs a custom domain before strangers can use this
flow. Everything below can be built and tested today under private visibility on Adam's
account.

## Goals / Non-goals

**Goals**

- Zero-CLI path from "I want my own server" to a running, directory-listed instance in the
  user's account, on their bill, in under a minute.
- Minimal scopes, minimal retention: we are never a custodian of long-lived account access.
- Versioned, reproducible releases; the site can only deploy artifacts our CI published.
- First-class update story ("v0.4 available → one click"), with honest warnings about world
  wipes (`SCHEMA_VERSION` semantics) and player disconnects (DO restart).
- CLI path (`git clone` + `wrangler deploy` + manual directory registration) remains fully
  supported and documented — the game is open source.

**Non-goals**

- Hosting servers in OUR account (Workers for Platforms) — noted as a possible later paid
  tier, see the comparison table.
- Per-deploy gameplay tunable editing beyond what `ServerConfig` (doc 02) defines.
- Custom domains for created servers (workers.dev only in v1).
- Gradual/canary rollouts of game versions to created servers — all-at-once is *correct*
  here because client and server share a deterministic sim (research/cf-deploy.md §8).
- Billing management or plan upgrades on the user's behalf.

## Current state

Verified against this worktree:

- **The game worker is fully self-contained and parameter-free.** `apps/game/src/server/worker.ts:6-22`
  routes `/ws`, `/api/leaderboard`, `/api/health` to `env.GAME.getByName("main")` and 404s
  everything else. The only binding is `GAME: DurableObjectNamespace<GameRoom>`
  (`worker-configuration.d.ts:5`). Zero vars, zero secrets.
- **Deploy config**: `wrangler.jsonc:3` names the worker `worldspring`;
  `wrangler.jsonc:17-22` declares migration `v1` with `new_sqlite_classes: ["GameRoom"]`;
  assets use `not_found_handling: "single-page-application"` (`wrangler.jsonc:6-8`).
  `npm run deploy` = `vite build && wrangler deploy` (`package.json:10`); the Vite plugin
  emits `dist/survival_game/index.js` (34 KB gzip) + generated `wrangler.json` +
  `dist/client/**` (60 files, 4.8 MB) and a `.wrangler/deploy/config.json` redirect
  (research/cf-deploy.md §0, verified against the main checkout's build output).
- **Seed flow**: `WORLD_SEED = 1337` (`packages/shared/src/constants.ts:4`) is consumed server-side in
  exactly two places — `ensureGame()` (`apps/game/src/server/GameRoom.ts:354`,
  `createWorld(WORLD_SEED)`) and the wipe-on-mismatch check in `initSchema`
  (`apps/game/src/server/persistence.ts:109-117`). The client builds its world from the welcome
  message, not a local constant: `createWorld(msg.seed)` at
  `apps/game/src/client/net/connection.ts:260`; the `welcome` shape carries `seed` at
  `packages/shared/src/protocol.ts:194-206`. This is why per-server config is cheap: the server is
  the only place deploy-time vars need to land.
- **Wipe semantics**: `schema_version` or `world_seed` mismatch wipes `characters` +
  `world_state` + `meta` but keeps the leaderboard (`apps/game/src/server/persistence.ts:107-117`).
  This is the sanctioned path for breaking releases and directly shapes the update UX.
- **No site exists.** There is no `site/` directory, no `.github/` workflows, no version
  constant, no `PROTOCOL_VERSION` in `packages/shared/src/protocol.ts`, and **no `/api/server-info`
  route** — `grep -rn "server-info\|GAME_VERSION\|PROTOCOL_VERSION" src/ scripts/` returns
  nothing today. All three are designed (not yet implemented) in
  `docs/plans/03-server-info-contract.md`: its M1 creates `GAME_VERSION`
  (`packages/shared/src/version.ts`) and `PROTOCOL_VERSION`; its M2 adds the route. This doc's
  verify step depends on them — the §3 release gate makes that dependency mechanical.
- **Companion-doc map** — this doc's "doc 02"/"doc 03" shorthand predates the final file
  numbering: "doc 02" (`ServerConfig`/`PRESETS`, `packages/shared/src/config.ts`) =
  `docs/plans/04-gameplay-presets.md`; "doc 03" (directory tables, heartbeats, delisting)
  = `docs/plans/02-server-directory.md`; the `/api/server-info` + version-constants
  contract both lean on = `docs/plans/03-server-info-contract.md`.
- **Platform facts** (all from research, cited inline below): self-managed OAuth clients
  shipped 2026-06-03 (research/cf-oauth.md); the stable multipart Script Upload API handles
  our exact shape — assets + DO binding + `new_sqlite_classes` + vars + secrets — in one PUT
  (research/cf-deploy.md §2); SQLite-backed DOs run on the free plan
  (research/cf-deploy.md §7); free-plan viability for actual play is blocked on the
  persistAll fix (research/cf-costs.md §3, §6).

## Design

### 1. Components and where they live

```
repo root            — game worker (unchanged deploy story, gains optional env bindings)
site/                — NEW second Worker: official site + directory + create-server flow
  wrangler.jsonc     — name "worldspring-web", custom domain route, bindings:
                       D1 (site/directory DB, shared with doc 03), R2 (release artifacts),
                       DEPLOYER (DO), secrets: OAUTH_CLIENT_SECRET, SESSION_HMAC_KEY
  package.json       — own toolchain (site is a small SSR/static Worker, not part of the
                       game's Vite build)
  src/worker.ts      — routes: /, /create, /servers, /login, /oauth/callback,
                       /api/deploy-jobs/*, plus directory routes (doc 03)
  src/deployer.ts    — Deployer DO (deploy job state machine)
.github/workflows/release.yml — release pipeline (below)
```

This matches the working assumption (site = second Worker in `site/`) and the placement
recommendation in research/codebase-server.md §6: independent deploy
(`wrangler deploy -c site/wrangler.jsonc`), no interference with the root build's
`.wrangler/deploy/config.json` redirect, no SPA-navigation swallowing.

### 2. OAuth client registration and flow

Per research/cf-oauth.md §1-2, §8 — confidential client IS supported and is the right shape
for a server-side Worker:

**Client registration** (one-time, dashboard or
`POST /accounts/{account_id}/oauth_clients`):

```json
{
  "client_name": "Worldspring",
  "logo_uri": "https://<site-domain>/icon-512.png",
  "client_uri": "https://<site-domain>",
  "redirect_uris": ["https://<site-domain>/oauth/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic",
  "scopes": ["openid", "account.read", "<workers-write-scope>"]
}
```

- **No `refresh_token` grant** — deliberate (see §6). Adding it later is a PATCH.
- `<workers-write-scope>` is the one scope whose exact ID is **UNCONFIRMED**
  (research/cf-oauth.md §3 — only `account.read` and `workers-platform.read` are confirmed
  to exist; the write sibling must be enumerated via
  `GET https://api.cloudflare.com/client/v4/oauth/scopes`). Milestone 1 resolves this.
- Client secret → `wrangler secret put OAUTH_CLIENT_SECRET -c site/wrangler.jsonc`. Rotation
  uses the two-concurrent-secrets API (research/cf-oauth.md §6).
- **Visibility starts `private`** (only Adam's account members can authorize) — that is the
  dev/test mode. Promotion to `public` is **permanent** and requires logo + client URL +
  DNS TXT verification (`cloudflare_oauth_client_publisher=` record, 2-day polling window)
  on the site's custom domain (research/cf-oauth.md §6). Use throwaway clients for
  experiments; promote exactly one final client.

**Authorization flow** (standard RFC 6749 + PKCE for defense in depth, params UNCONFIRMED in
docs — research/cf-oauth.md §1):

1. `GET /login?next=/create` → site sets a short-lived HMAC-signed state cookie
   `{nonce, pkceVerifier, next}` and 302s to
   `https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=openid account.read <workers-write-scope>&state=<nonce>&code_challenge=…&code_challenge_method=S256`.
2. Cloudflare's consent screen handles **account selection natively** — a user with several
   accounts picks which account(s) to grant, and accounts whose admins disabled Public OAuth
   App access simply don't appear (research/cf-oauth.md §5).
3. `GET /oauth/callback?code&state` → verify state, then
   `POST https://dash.cloudflare.com/oauth2/token` with Basic auth
   (`client_id:client_secret`), `grant_type=authorization_code`, `code`, `redirect_uri`,
   `code_verifier`. Response: `access_token`, `expires_in`, `id_token` (because `openid`).
4. Extract `sub` from the id_token (the only documented claim — research/cf-oauth.md §4);
   this is the site's stable user identity. Set the session cookie (below).
5. `GET https://api.cloudflare.com/client/v4/accounts` with
   `Authorization: Bearer <access_token>` to enumerate granted accounts
   (**UNCONFIRMED** mechanism, high confidence — research/cf-oauth.md §5; spike item). One
   account → proceed; several → site-side picker.
6. Hand the access token + chosen `account_id` to a freshly created deploy job in the
   Deployer DO. The token never touches a cookie and is never logged.

**Site session** (what the browser holds): an HMAC-signed cookie
`dc_site_session = {sub, exp, csrf}` — identity only, no Cloudflare API capability. The
access token exists only inside the Deployer DO for the life of one job.

### 3. Release pipeline — versioned build artifacts

GitHub Actions workflow `.github/workflows/release.yml`, triggered on tag `v*` against
`overra/worldspring`:

1. `npm ci`, `npm run typecheck`, `npm run build` (`vite build`).
2. `node scripts/build-artifact.mjs` — produces the artifact from `dist/`:
   - `meta.json`:

     ```jsonc
     {
       "version": "0.4.0",
       "commit": "<sha>",
       "builtAt": "2026-06-11T00:00:00Z",
       "schemaVersion": 2,            // from apps/game/src/server/persistence.ts SCHEMA_VERSION
       "wipesWorld": false,           // set true when schemaVersion bumped vs previous release
       "protocolVersion": 1,          // PROTOCOL_VERSION from packages/shared/src/protocol.ts —
                                      // created by 03-server-info-contract.md M1; the
                                      // release gate below guarantees it exists
       "worker": { "path": "index.js", "sha256": "…", "bytes": 126976 },
       "assetManifest": {             // keys are /-prefixed paths under dist/client
         "/index.html": { "hash": "<32-hex>", "size": 1234, "contentType": "text/html" }
       },
       "metadataTemplate": { /* multipart metadata minus per-deploy fields, generated
                                from dist/survival_game/wrangler.json so config drift
                                is impossible (research/cf-deploy.md §6) — with ONE
                                deliberate override: observability gets
                                head_sampling_rate 0.01 (§5 step 6). The repo's
                                wrangler.jsonc has enabled:true and no sampling rate,
                                which defaults to 100% — fine for OUR instance, a
                                metered cost bomb on a community host's bill */ },
       "migrations": [ { "tag": "v1", "new_sqlite_classes": ["GameRoom"] } ]
     }
     ```

   - Asset hashes use Cloudflare's documented algorithm: first 32 hex chars of
     `sha256(base64(fileContents) + extensionWithoutDot)` (research/cf-deploy.md §2.2) —
     computed once in CI so the deployer never hashes at deploy time.
   - `migrations` is the **full ordered migration history**, copied from `wrangler.jsonc`'s
     `migrations` array — the update path needs the chain, not just the latest tag (§7).
   - **Release gate**: `build-artifact.mjs` hard-fails unless the built worker bundle
     contains the `/api/server-info` route and `PROTOCOL_VERSION` resolves to a number —
     i.e. 03-server-info-contract.md's M1+M2 must be in the tree before any deployable
     tag exists. This is what lets §5's verify step assert on version unconditionally: an
     artifact without the endpoint cannot exist in R2, so the deployer needs no fallback
     verification path. The dependency fails loudly at build time, not as a 90-second
     verify timeout at deploy time.
3. Upload to R2 bucket `worldspring-releases` (CI-scoped API token, write-only to that
   bucket): `releases/v0.4.0/meta.json`, `releases/v0.4.0/index.js`,
   `releases/v0.4.0/assets/<hash>` (raw bytes, one object per unique asset), and overwrite
   `releases/latest.json` → `{ "version": "0.4.0" }`.
4. Mirror the same files as a GitHub Release (transparency + CLI users + disaster recovery).
5. Inject `GAME_VERSION` at build: the workflow overwrites `packages/shared/src/version.ts` —
   the file itself is created by 03-server-info-contract.md M1 with a hand-maintained
   default — with `export const GAME_VERSION = "0.4.0";` from the tag before building, so
   `/api/server-info` and directory heartbeats report the release version. Local/dev
   builds keep the hand-maintained value.

The site Worker reads artifacts through an R2 binding (`RELEASES`) — no egress fees, no
GitHub rate limits, single-digit-ms reads. R2 is the deploy source of truth; GitHub Releases
is the public mirror.

### 4. The create flow, end to end

UI sequence on `https://<site-domain>/create`:

1. **Sign in with Cloudflare** (§2). Returning users with a live session skip to 2.
2. **Pick account** (only if multiple granted).
3. **Name + preset + cost panel**:
   - Server name → script name `worldspring-<slug>` (lowercased, `[a-z0-9-]`, ≤63 chars
     total, no leading/trailing dash — workers.dev constraints,
     research/cf-deploy.md §2.5). The `worldspring-` prefix is mandatory: it is the clobber
     guard (§5 step 3) and makes created workers self-identifying in the user's dashboard.
   - Preset: a named entry from the `PRESETS` registry in `packages/shared/src/config.ts` (doc 02
     owns the registry). The flow serializes the **`{preset, overrides?}` payload — doc
     02's canonical `GAME_CONFIG` carrier shape — into the `GAME_CONFIG` var**, never a
     fully-resolved `ServerConfig` object (doc 02's `resolveServerConfig` accepts
     `{preset?, overrides?}` and would ignore the groups of a resolved object with
     warnings, silently dropping overrides). The form also takes the display name + MOTD,
     baked as `SERVER_NAME`/`SERVER_MOTD` plain_text vars (03-server-info-contract.md's
     env surface) — the directory listing reads them from the server's own
     heartbeats/probes; registration itself collects only the URL
     (02-server-directory.md §5).
   - **Cost panel** (numbers from research/cf-costs.md, shown before the button enables):
     - *Free plan*: "$0. Hard budget ≈ 25 player-hours/day of WebSocket traffic; all caps
       reset at 00:00 UTC — 6–7 PM US Central, i.e. mid-evening. Past the cap, players
       disconnect until reset. Good for a few friends, evenings."
       Gated: this copy only appears once the persistAll one-row-snapshot fix has shipped
       in the deployed version (research/cf-costs.md §7 — as the code ships today, the
       rows-written cap breaks saves ~80 minutes into any session; until then the free
       option carries a red warning instead).
     - *Paid plan ($5/mo)*: "Covers a friends server flat. A busy 30-slot 24/7 server
       worst-cases ≈ $25/mo total. 100 player-hours ≈ 6¢ of request overage. No surprise
       bills — usage scales with player-seconds."
     - *Workers Logs are capped, not free-running.* Community deploys ship with
       `observability.head_sampling_rate: 0.01` (§5 step 6). This line exists because
       research/cf-costs.md's scenario tables never model Workers Logs at all: log events
       bill to the host (Paid: 20 M/mo included, $0.60 per extra million; Free: 200k/day,
       then forced 1% sampling), default sampling is 100% when unspecified, and IF each
       inbound WS message emits an invocation log (the M1 spike settles this), an
       unsampled 30-slot 24/7 server's ~1.6 B events/mo would bill ≈ $944/mo — silently
       falsifying the "never a surprise $500 bill" promise this very panel makes. At 1%
       the worst modeled case is ~16 M events/mo: inside Paid's 20 M included (≈ $0). On
       Free (where that load can't run anyway), the feasible ~25 player-hours/day ceiling
       logs ~18 k events/day at 1% — far under the 200 k/day cap, so observability
       survives instead of silently degrading. The 1% cap is what keeps cf-costs.md's
       omission honest.
       Hosts who want full logs can raise the rate in their own dashboard — their call,
       their bill.
     - We do not detect the user's plan (no documented read with our scopes); we state
       both numbers and recommend Paid for anything public.
4. **Deploy** → site POSTs `/api/deploy-jobs`, Deployer DO starts the state machine, UI
   polls `GET /api/deploy-jobs/:id` and renders step progress.
5. **Done** → shows `https://worldspring-<slug>.<their-subdomain>.workers.dev`, "open your
   server", directory listing status (pending → live on first heartbeat), and a link to the
   server-owner guide (costs, deleting, updating).

### 5. The deploy state machine (Deployer DO)

One `Deployer` DO instance (`getByName("main")`) holding a `jobs` table in its SQLite
storage. Job row:

```ts
// site/src/deployer.ts
export interface DeployJob {
  id: string;                        // ulid
  ownerSub: string;
  accountId: string;
  scriptName: string;                // "worldspring-<slug>"
  releaseVersion: string;            // resolved from releases/latest.json at job start
  preset: string;
  serverConfigJson: string;          // serialized GAME_CONFIG payload {preset, overrides?} (doc 02's carrier shape)
  kind: "create" | "update" | "delete";
  step: DeployStep;                  // resumable cursor
  accessToken: string;               // ENCRYPTED at rest? see threat model — deleted at terminal state
  tokenExpiresAt: number;            // from expires_in
  directoryServerId: string | null;  // minted in step 2
  uploadJwt: string | null;          // asset session JWT (1h validity)
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export type DeployStep =
  | "mint-directory-token" | "check-existing-script" | "ensure-subdomain"
  | "asset-session" | "asset-upload" | "script-put" | "enable-subdomain"
  | "verify" | "done" | "failed";
```

Steps, with the exact calls (all cited to research/cf-deploy.md §2 unless noted; all on
`https://api.cloudflare.com/client/v4` with `Authorization: Bearer <accessToken>` except
asset upload):

1. **mint-directory-token** — generate 32 random bytes hex; store
   `sha256(token)` + expected origin `https://<script>.<sub>.workers.dev` as a *pending*
   listing in the directory D1 (doc 03's tables); keep the plaintext token only in the job
   row (it ships as a binding in step 6, then is dropped). Pending listings older than 1 h
   are reaped by the directory.
2. **check-existing-script** — `GET /accounts/{id}/workers/scripts/{name}` (or the script
   list). 404 → fresh create. Exists → require the script's tags to include `worldspring`
   (we set `tags: ["worldspring", …]` on every upload, research/cf-deploy.md §2.4); if a
   non-Worldspring worker owns the name, **abort with a rename prompt — never clobber**.
   For `kind: "update"`, also read the current `migration_tag` (response field —
   research/cf-deploy.md §2.4) to drive migration chaining (§7).
   (**UNCONFIRMED**: whether tags round-trip on GET for raw-API uploads — spike item; the
   fallback guard is a marker route probe `GET https://<url>/api/server-info`, valid
   because every artifact the site can deploy serves that route — §3 release gate. A
   Worldspring worker CLI-deployed from a tree predating the route 404s the probe and is
   treated as non-Worldspring: abort-with-rename, which errs in the safe direction.)
3. **ensure-subdomain** — `GET /accounts/{id}/workers/subdomain`; if the account has none
   (fresh accounts don't — research/cf-deploy.md §2.5), pause the job with
   `needs: "subdomain-name"`; the UI prompts ("this names everything you ever deploy:
   `*.<choice>.workers.dev`"), then `PUT /accounts/{id}/workers/subdomain
   { "subdomain": "<choice>" }`. Name-taken error → re-prompt (exact error shape
   **UNCONFIRMED**, research/cf-deploy.md §10.3).
4. **asset-session** — `POST /accounts/{id}/workers/scripts/{name}/assets-upload-session`
   with the artifact's `assetManifest` (hashes/sizes precomputed in CI). Response:
   `{ jwt, buckets }`. Empty `buckets` → jwt is already the completion token, skip step 5.
5. **asset-upload** — for each bucket:
   `POST /accounts/{id}/workers/assets/upload?base64=true`, `Authorization: Bearer
   <session-jwt>`, multipart parts named by file hash, base64 bodies, per-part
   Content-Type from the manifest. Stream each asset out of R2, base64-encode in the DO.
   Final 201 returns the completion JWT. Both JWTs live 1 hour — a job stalled past that
   restarts from step 4 (cheap).
6. **script-put** — `PUT /accounts/{id}/workers/scripts/{name}` multipart:
   part `metadata` (application/json) + part `index.js`
   (application/javascript+module, streamed from R2; sha256-verified against `meta.json`
   before upload). Metadata = artifact `metadataTemplate` merged with per-deploy fields:

   ```json
   {
     "main_module": "index.js",
     "compatibility_date": "2026-06-01",
     "bindings": [
       { "type": "durable_object_namespace", "name": "GAME", "class_name": "GameRoom" },
       { "type": "plain_text", "name": "GAME_CONFIG", "text": "<gameConfigJson>" },
       { "type": "plain_text", "name": "SERVER_NAME", "text": "<display name>" },
       { "type": "plain_text", "name": "SERVER_MOTD", "text": "<motd>" },
       { "type": "plain_text", "name": "DIRECTORY_URL", "text": "https://<site-domain>" },
       { "type": "secret_text", "name": "DIRECTORY_TOKEN", "text": "<minted token>" }
     ],
     "migrations": { "new_tag": "v1", "new_sqlite_classes": ["GameRoom"] },
     "assets": {
       "jwt": "<completion JWT>",
       "config": { "not_found_handling": "single-page-application" }
     },
     "observability": { "enabled": true, "head_sampling_rate": 0.01 },
     "tags": ["worldspring", "worldspring-v0.4.0"],
     "annotations": { "workers/message": "Worldspring v0.4.0 via <site-domain>" }
   }
   ```

   This single call creates the version AND deploys it to 100%, and is the only documented
   home of `migrations` (research/cf-deploy.md §2.4). `migrations` is included on create;
   on update it is computed per §7 (usually omitted).
   Assert on the response: `named_handlers` contains `{"name":"GameRoom"}`,
   `migration_tag` equals the expected tag, `has_assets: true`
   (research/cf-deploy.md §2.4 — cheap success assertions).
   The `head_sampling_rate: 0.01` is load-bearing, not a tuning nicety: Workers Logs
   bills the HOST per log event, unspecified sampling defaults to 100%, and WS-heavy DO
   traffic can make unsampled logs the largest line on their bill (math in §4.3; the M1
   spike measures actual per-message invocation-log volume).
7. **enable-subdomain** —
   `POST /accounts/{id}/workers/scripts/{name}/subdomain { "enabled": true,
   "previews_enabled": false }` — always, never rely on the default
   (**UNCONFIRMED** default for raw-API scripts, research/cf-deploy.md §2.5).
8. **verify** — poll `GET https://<script>.<sub>.workers.dev/api/server-info` (non-navigation
   fetch reaches the Worker despite SPA asset handling — research/codebase-server.md §1)
   until 200 with `gameVersion === releaseVersion` (field name per
   03-server-info-contract.md's `ServerInfo`), timeout 90 s. The endpoint is guaranteed
   to exist: the §3 release gate refuses to build an artifact without it, so this poll
   can never 404-loop against a successful deploy. On success: upsert the
   `created_servers` row (§6) **including `server_config_json`** — the durable copy that
   update jobs re-send verbatim (§7) — and mark the job `done`; terminal-state cleanup
   nulls all tokens (see failure handling). The directory listing flips pending → live on
   the server's first authenticated heartbeat + connect-back probe (doc 03).

**Failure handling and idempotency**

- Every step is retried with exponential backoff (3 attempts) before the job parks as
  `failed` with a user-readable error. All steps are safe to re-run: session/upload re-mint
  cleanly, the script PUT is a full replace, subdomain POST is idempotent.
- The one retry hazard is step 6 with `migrations`: if the PUT succeeded but we never saw
  the response, a blind retry re-sends `new_tag: "v1"` against a worker that already has
  tag v1. Defense: re-run step 2 before any step-6 retry and recompute the migrations field
  from the worker's actual `migration_tag` (**UNCONFIRMED** how the API treats a re-sent
  identical migration — spike item 5 in research/cf-deploy.md §10; the recompute makes the
  question moot).
- Error classification: `401/403` → token expired or revoked mid-job → job pauses with
  `needs: "reauth"`; the UI offers one-click re-auth, which attaches a fresh token to the
  *same* job and resumes at the recorded step. `10000`-series quota errors → surface the
  paid-plan advice. Subdomain/name conflicts → pause with a prompt, resume.
- **Token lifecycle is terminal-state-driven, not happy-path-driven.** On entry to ANY
  terminal state — `done` *or* `failed` — the job nulls `accessToken`, `uploadJwt`, and
  the plaintext directory token. Paused jobs (`needs: "subdomain-name"`,
  `needs: "reauth"`) expire 1 h after pausing: the job moves to `failed` and the same
  nulling runs. This is what makes the Summary's "no token survives ~1 h" claim
  mechanical, rather than a bet on undocumented Cloudflare token expiry or on jobs only
  ever ending happily.
- Jobs are swept at terminal state + 2 h: the row is deleted entirely. The sweep is
  bookkeeping only — by then the row holds zero capability.
- Rate limits are a non-issue: a full deploy is 5–7 calls + ~5 MB against a 1,200 req/5 min
  per-user budget (research/cf-deploy.md §2.8) — but the budget is the *user's*, so the
  deployer serializes jobs per account (one active job per `accountId`).

### 6. What we store, and the threat model of deploy-capable tokens

**Stored durably (site D1)** — metadata only, nothing capability-bearing:

```sql
CREATE TABLE created_servers (
  id TEXT PRIMARY KEY,             -- ulid
  owner_sub TEXT NOT NULL,         -- OAuth `sub` (the only identity claim, cf-oauth.md §4)
  account_id TEXT NOT NULL,
  script_name TEXT NOT NULL,
  url TEXT NOT NULL,               -- https://<script>.<sub>.workers.dev
  preset TEXT NOT NULL,            -- display metadata after create; never re-resolved (§7)
  server_config_json TEXT NOT NULL,-- GAME_CONFIG payload {preset, overrides?} (doc 02's
                                   -- carrier shape), written at §5 step 8; the
                                   -- authoritative source update jobs re-send verbatim (§7)
  deployed_version TEXT NOT NULL,
  migration_tag TEXT NOT NULL,
  directory_server_id TEXT,        -- joins to the directory listing (doc 03)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_created_servers_owner ON created_servers(owner_sub);
```

**Stored transiently (Deployer DO)**: the access token, for the life of one job (≤ 1 h by
JWT validity and the sweep). **Not stored, ever**: refresh tokens, client API keys, the
plaintext directory token past job completion.

**The decision: ephemeral, not refresh tokens in D1.** Weighed honestly:

| | Ephemeral (chosen) | Stored encrypted refresh tokens |
|---|---|---|
| Update UX | One OAuth bounce per update (already-authorized apps re-consent fast; whether Cloudflare skips the consent screen on re-auth is **UNCONFIRMED**) | True one-click, and we could even auto-update fleets |
| Blast radius if the site Worker is compromised | Tokens of jobs in flight at that moment (typically zero to a few) | **Every creator who ever consented** — attacker deploys arbitrary code into all their accounts |
| Reliability | No silent decay; every deploy starts from a fresh consent | Refresh rotation policy and lifetime are **UNCONFIRMED** (research/cf-oauth.md §1, §10) — stale tokens fall back to re-auth anyway, so the one-click promise is soft |
| Our operational burden | Nearly stateless site | Key management, encryption-at-rest story, breach-notification liability, revocation bookkeeping |

Updates are roughly monthly; the stored-token upside is one click saved per server per
month against the worst tail risk in the whole design. Ephemeral wins. If fleet auto-update
ever matters, revisit with a separate, explicit "keep me updated" consent that adds the
`refresh_token` grant — the client PATCH is cheap (research/cf-oauth.md §6).

**Threat model for the window we do hold tokens:**

- *Scope minimization*: `openid` + `account.read` + the single Workers write scope. No D1,
  no KV, no zone scopes — the deploy needs none of them (research/cf-deploy.md §1).
- *Exfiltration*: token lives in DO SQLite (platform-encrypted at rest), is never logged,
  never serialized into responses, and the job status endpoint returns step names only.
- *CSRF/redirect attacks*: signed `state`, PKCE S256, exact-match registered redirect URI,
  session cookie is `HttpOnly; Secure; SameSite=Lax`.
- *Supply chain (what we deploy INTO their account)*: the deployer verifies
  `sha256(index.js)` against `meta.json` before upload; R2 write access is held only by the
  CI token (write-only, single bucket). Residual risk: an attacker with CI or R2 write
  rewrites `meta.json` *and* the artifact together — mitigable later by signing `meta.json`
  with a key held as a site secret; noted as hardening, not v1.
- *User-side trust*: the consent screen shows our name, logo, and verified-domain badge
  (research/cf-oauth.md §5); users can revoke at any time at
  dash.cloudflare.com → profile → Manage OAuth authorizations; account admins can block new
  authorizations entirely — the flow must render that failure politely.
- *What we can never do*: nothing standing. After a job reaches any terminal state —
  success, failure, or expired pause — Worldspring holds zero capability against the user's
  account (§5 failure handling makes that a state-machine invariant, not a happy-path
  property). That sentence belongs verbatim in the UX copy.

### 7. The update story

- **Detection**: directory heartbeats carry `gameVersion` (= `GAME_VERSION`, doc 03);
  `created_servers.deployed_version` is updated on every site-driven deploy. The
  "Your servers" page (keyed by session `sub`) compares against `releases/latest.json` and
  shows **"v0.4 available"** per server. Servers the site did not create but that are
  directory-listed get the same banner with the CLI update instructions instead of a
  button.
- **One-click update**: re-auth (ephemeral token, §2) → `kind: "update"` job. Differences
  from create:
  - Step 1 mints a **new** directory token — every redeploy rotates the secret. This is
    deliberate: re-sending all bindings on the PUT replaces the binding set, and whether
    the raw API supports inheriting an existing `secret_text` without re-sending its value
    (`keep_bindings`-like semantics) is **UNCONFIRMED** — rotation sidesteps the question
    and is better hygiene anyway.
  - **Rotation activates through an overlap window, not at job completion.** The hazard:
    the new token goes live on the worker at step 6 (the PUT deploys it to 100%), two
    steps before the job can reach `done`. If the directory swapped hashes only on
    completion, an update that dies between step 6 and step 8 (verify timeout, DO
    eviction) leaves a live worker heartbeating the NEW token against a directory that
    only knows the OLD hash — every beat 401s, the game worker treats 401 as "unlisted"
    (§8), and the failed job's sweep destroys the only plaintext copy: a previously-listed
    live server silently delists until the owner runs another full update. So instead:
    at step 1 the directory stores `sha256(newToken)` as a **second valid hash** on the
    listing; old OR new authenticates heartbeats for the duration of the job. Settlement
    is observation-driven, because the deployer cannot always know whether the step-6 PUT
    landed (§5 retry hazard): on `done`, drop the old hash immediately (verify proved the
    new bundle — and its baked token — is live); on `failed`/expired pause, keep both and
    let the first authenticated heartbeat *after* the terminal timestamp pick the winner —
    whichever hash it matches becomes the sole hash, the other is dropped. Mid-flight
    death is harmless in both directions (PUT landed or not), which is what makes the
    Summary's "can never silently delist a live server" claim mechanical. Doc 03's token
    table must hold two hashes per listing during the window (see Implications).
  - Step 6 computes `migrations` from the worker's actual `migration_tag` (read in step 2)
    against the artifact's full migration history: equal to latest → **omit the field
    entirely** (wrangler's behavior; raw-API omit-on-update is **UNCONFIRMED**,
    research/cf-deploy.md §10.5); behind → send
    `{ old_tag: <current>, new_tag: <latest>, steps: [<missing steps in order>] }`
    (multi-step shape, research/cf-deploy.md §2.4). This is the general mechanism for
    sequencing DO migrations across versions a server skipped.
  - Step 6 re-sends `GAME_CONFIG` **verbatim from `created_servers.server_config_json`**
    — the durable copy written once, at create (§5 step 8). The `preset` column is display
    metadata only and is never re-resolved against the live `PRESETS` registry, so
    preset-definition drift across releases can never silently change a deployed config —
    in particular can never flip the seed and trip the wipe in
    `apps/game/src/server/persistence.ts:107-117` on an update the owner was told preserves their
    world.
  - Step 6 must also carry **operator-set bindings** forward: the multipart PUT replaces
    the binding set wholesale (research/cf-deploy.md §8.1), so an update that re-sends
    only our own bindings silently deletes anything the owner added by hand — most
    importantly doc 02's `ADMIN_TOKEN` secret (set via `wrangler secret put`), whose loss
    turns the admin surface off (404) and strands stale `admin_overrides`
    (04-gameplay-presets.md §4). Obligation: GET current settings first, re-send every
    non-Worldspring binding, and pass `keep_bindings: ["secret_text"]` so unreadable
    operator secrets survive. How `keep_bindings` interacts with an *explicitly re-sent*
    `secret_text` of the same name (our rotated `DIRECTORY_TOKEN`) is **UNCONFIRMED** —
    added to the M1 spike list; if explicit values do not win, rotation switches to
    delete-then-set semantics confirmed by the spike.
  - Asset dedupe is per-Worker, so only changed files upload (research/cf-deploy.md §2.2) —
    updates are faster than creates.
- **What happens to DO state**: the `GameRoom` DO's SQLite storage survives script updates
  (same class, same namespace, no deleted_classes). In-memory state does not, and the known
  sharp edge applies: a DO restart with hibernation-accepted sockets open wedges those
  sessions — pings still pong but the world freezes; recovery is manual reconnect
  (research/codebase-server.md §2). The update UI must (a) show current player count from
  the server's public `/api/server-info` and (b) say "updating will disconnect players;
  they can immediately reconnect."
- **World wipes**: if the release's `schemaVersion` (or the server's configured seed)
  differs from what the server persisted, the existing wipe logic clears characters + world
  and keeps the leaderboard (`apps/game/src/server/persistence.ts:107-117`). The release artifact's
  `wipesWorld` flag drives a mandatory red confirmation step: "v0.5 resets worlds
  (leaderboards survive). Type the server name to continue."
- **Determinism corollary** (binding): a server must never move to a version that reorders
  existing rng streams against a persisted world — repo contract; release notes must mark
  any such release as `wipesWorld: true` and the `SCHEMA_VERSION` bump enforces it
  mechanically.

### 8. Deleting and unlisting

Two separate actions on the "Your servers" page:

- **Unlist** (no OAuth needed): site marks the directory listing removed and revokes the
  directory token hash (doc 03's delist mechanism). The server keeps running; it just
  stops being discoverable. The server's own heartbeats start getting 401s — the game
  worker treats that as "unlisted", not an error loop (doc 03 specifies backoff).
- **Delete** (OAuth re-auth, `kind: "delete"` job):
  `DELETE /accounts/{id}/workers/scripts/{name}?force=true` — force is required for a
  script with DO namespaces and **destroys the DO storage (their world)**
  (**UNCONFIRMED** exact param/behavior on the current API — spike item; wrangler's
  `wrangler delete` does this dance). Mandatory type-the-name confirmation, copy states
  the world is gone and the leaderboard with it. Then delete the directory listing and the
  `created_servers` row. Always also show the manual path: "or delete the
  `worldspring-<slug>` worker in your Cloudflare dashboard — same effect."

### 9. The CLI path (first-class forever)

The game is open source; the site flow is sugar, not a gate. `docs/SELF_HOSTING.md` (new)
documents:

```
git clone https://github.com/overra/worldspring
cd worldspring && npm ci
# optional: edit vars in wrangler.jsonc → { "vars": { "GAME_CONFIG": "warpath" } }
npm run deploy            # vite build && wrangler deploy → your account, your workers.dev
```

- The game worker reads `GAME_CONFIG` (doc 02) and `DIRECTORY_TOKEN` from env when
  present; absent both, it behaves exactly as today — so CLI deploys and the official
  instance need zero extra steps.
- **Manual directory registration**: site page "Register an existing server" → paste
  `https://<your>.workers.dev` → directory probes `/api/server-info`, mints a token, shows
  it once → owner runs `wrangler secret put DIRECTORY_TOKEN` → server heartbeats → probe
  verifies → listed. Identical activation path to site-created servers (§5 step 1) — one
  registration mechanism, two on-ramps.
- CLI-deployed servers update with `git pull && npm run deploy`; wrangler handles migration
  chaining natively.

### 10. Comparison: why not the alternatives

| | **Site flow (this doc)** | Deploy-to-Cloudflare button | Workers for Platforms |
|---|---|---|---|
| What the user gets | Running server in their account, seconds, no repo | A *clone* of our repo in their GitHub + Workers Builds CI (research/cf-deploy.md §3) | A server in OUR account behind a dispatch Worker (research/cf-deploy.md §5) |
| Updates | One click, version-aware, migration-chained | Manual — clones have no upstream link; copies go stale | We push centrally |
| Build time | None (prebuilt artifact) | Minutes (full npm install + Vite build of the 3D client) | None |
| Who pays | Them ($0–$25/mo, research/cf-costs.md) | Them | **Us** — $25/mo base + DO duration/requests; a 15 Hz always-on room is exactly the expensive shape; denial-of-wallet risk |
| Orchestration / directory baking | Full (vars, secrets, registration) | None — can't inject the directory token | Full |
| Verdict | **The product** | Keep in the README for hackers (fix `package.json` first: the button would run `vite build` twice via our `deploy` script — research/cf-deploy.md §3) | Possible later **paid managed tier** ("we host it for $X/mo"); not v1 |

Workers Builds API as a fourth option is a confirmed dead end (user-scoped token + manual
GitHub App install; research/cf-deploy.md §4).

## Implications

**Opens up**

- Community servers with zero CLI knowledge, on the owner's bill and quota — the directory
  (doc 03) gets a population without us hosting anything.
- A release discipline (tags → artifacts) the whole project benefits from: reproducible
  builds, version surfacing in `/api/server-info`, a place to hang `wipesWorld` warnings.
- The managed-hosting paid tier later: the WfP upload path is the *same multipart metadata*
  against a dispatch namespace (research/cf-deploy.md §5), so the Deployer DO is reusable.
- OAuth identity (`sub`) gives the site a login for free — usable later for server-owner
  dashboards, favorites, etc., without passwords.

**Complicates**

- We now run two Workers with different release cadences; the site needs its own deploy
  scripts and secrets management.
- The game worker grows an env surface (`GAME_CONFIG`, `DIRECTORY_TOKEN`) that must stay
  strictly optional so the root deploy and CLI path remain zero-config.
- Cross-doc coupling: this flow serializes doc 02's `ServerConfig` and bakes doc 03's
  directory token — and §7's rotation requires doc 03's token table to hold **two** valid
  hashes per listing during an update window, settled by observed heartbeat; the three
  must land in a compatible order (see milestones). The §3 release gate additionally
  hard-couples every deployable artifact to 03-server-info-contract.md M1+M2.
- Six **UNCONFIRMED** platform behaviors gate implementation details (scope IDs, accounts
  discovery, migrations-omit-on-update, subdomain defaults/errors, script tags round-trip,
  force-delete semantics) — milestone 1 exists to burn these down on a scratch account.

**Breaks**

- Nothing in the shipped game. No protocol change, no worldgen change, no schema change.
  The official instance and existing CLI deploys are untouched until they opt into the new
  env vars.

**Threatens**

- **Deploy-capable tokens, even ephemeral ones, make the site Worker a high-value target.**
  A compromise during active jobs deploys attacker code into those users' accounts. The
  ephemeral decision caps the blast radius; it cannot zero it.
- **Public OAuth promotion is irreversible and freezes the verified domain**
  (research/cf-oauth.md §6) — promoting a half-baked client or the wrong domain pollutes the
  account permanently. Mitigation: throwaway private clients until launch.
- **Free-plan disappointment**: if we ship the flow before the persistAll fix, free-tier
  servers break saves ~80 minutes in (research/cf-costs.md §3) and the brand eats it. The
  cost panel gating in §4.3 is the guard; the real fix is the one-row world snapshot.
- **Reputation coupling**: servers we deployed are still operated by strangers; the
  directory's trust tiers (doc 03 / research/directory-prior-art.md) carry that load, not
  this flow.

## Migration & compatibility

- **Existing worlds/saves**: unaffected. Created servers start fresh DBs; the
  `SCHEMA_VERSION`/`world_seed` wipe logic (`apps/game/src/server/persistence.ts:107-117`) governs
  their updates exactly as it does the official instance.
- **Wire protocol**: no changes here. `PROTOCOL_VERSION` (new, in `packages/shared/src/protocol.ts`)
  is doc 03's addition; this flow only *reports* it via the release artifact.
- **Deployed official instance**: keeps deploying via `npm run deploy` from the repo root;
  the new env bindings are optional with constant-backed defaults
  (`WORLD_SEED = 1337` stays in `packages/shared/src/constants.ts:4` as the default).
- **Config compatibility across versions**: `GAME_CONFIG` is re-sent verbatim on update
  jobs from `created_servers.server_config_json` — the durable copy written at create
  (§5 step 8). Job rows are swept at terminal + 2 h and hold nothing authoritative;
  preset definitions are resolved exactly once, at create time, and never re-resolved
  (§6, §7). Doc 02 owns forward-compatible parsing (unknown keys ignored, missing keys
  defaulted). A config whose seed differs from the persisted `world_seed` triggers the
  sanctioned wipe — the verbatim re-send is what makes a routine site-driven update
  mechanically incapable of changing the seed, leaving a release's `schemaVersion` bump
  (`wipesWorld`, §7) as the only wipe trigger an update can carry.
- **Artifact ↔ deployer compatibility**: `meta.json` carries an `artifactSchema: 1` field;
  the deployer refuses artifacts with a newer schema than it understands.

## Implementation plan

Ordering note: M1 (spike) gates M4–M8 details; M2 and M3 can run in parallel with it.
03-server-info-contract.md's M1+M2 (version constants + `/api/server-info`) must land
before this plan's M2 can cut a passing release tag — the §3 gate enforces that, so no
deployable artifact (and therefore no M5 end-to-end run) exists without them. Doc 02
(`ServerConfig`/`PRESETS`) must land before M6 ships real presets; doc 03's
directory tables must land before M5's step 1 does anything real (a stub directory client
is acceptable in the interim). The persistAll one-row-snapshot fix (research/cf-costs.md
§6 lever 1) is tracked outside this plan but gates the free-plan marketing copy in M6.

1. **M1 — Scratch-account spike** *(Sonnet 4.8)* — no repo code changes except
   `scripts/spike-deploy.mjs` (zero-dep Node, like `apps/game/scripts/loadtest.mjs`). Enumerate
   `GET /oauth/scopes` and pin the Workers write scope ID; create a private confidential
   client; run the full code+secret exchange; record `expires_in`/token shape; confirm
   `GET /accounts` discovery; then drive the full §5 call sequence into a brand-new free
   account: subdomain GET-on-empty/PUT/conflict shapes, first PUT with migrations,
   re-PUT with migrations omitted, re-PUT with recomputed migrations, tags round-trip,
   `?force=true` delete, and **`keep_bindings: ["secret_text"]` semantics** — does an
   explicitly re-sent `secret_text` of the same name win over the kept one, and do
   operator-set secrets (doc 02's `ADMIN_TOKEN`) survive a PUT that keeps `secret_text`
   (§7 update obligations). Separately, **measure Workers Logs volume under WS load**: deploy
   a scratch copy of the game worker with `observability.enabled: true` and **no**
   `head_sampling_rate` (the repo default), hold one real WS session for ~10 minutes, and
   count Log Events Written in the dashboard — settling whether each inbound
   `webSocketMessage` on a pinned DO emits an invocation log. This one number swings the
   unsampled worst case between ~$0 and ~$944/mo (§4.3) and must be settled before M6
   ships the "no surprise bills" cost copy. Acceptance: research/cf-oauth.md §10 and
   research/cf-deploy.md §10 updated in place with findings; the measured WS
   invocation-log rate recorded in research/cf-costs.md; every UNCONFIRMED in this doc
   resolved or re-flagged.
2. **M2 — Release pipeline** *(Sonnet 4.8)* — `.github/workflows/release.yml`,
   `scripts/build-artifact.mjs` (including the §3 release gate), the CI overwrite of
   `packages/shared/src/version.ts` from the tag (the file itself is created by
   03-server-info-contract.md M1, hand-maintained default), R2 bucket + CI token setup
   notes. Acceptance: tagging `v0.0.1-rc1` produces a complete artifact in R2 + GitHub
   Release; `meta.json` hashes verify against the files; `metadataTemplate` matches
   `dist/survival_game/wrangler.json` field-for-field *except* the documented
   `observability.head_sampling_rate: 0.01` override (§3); the gate demonstrably
   hard-fails on a tree missing `PROTOCOL_VERSION` or the `/api/server-info` route.
   Depends: 03-server-info-contract.md M1+M2 (version constants + route) — the gate makes
   a passing tag impossible without them, so M2's pipeline code can land any time but its
   acceptance only passes once they do.
3. **M3 — Game worker env surface** *(Opus 4.8 — determinism-sensitive)* — read optional
   `GAME_CONFIG` (doc 02's `resolveServerConfig`) and thread the seed into the two call
   sites (`GameRoom.ts` `ensureGame`, `persistence.ts` `initSchema`); read optional
   `DIRECTORY_TOKEN` and expose it to doc 03's heartbeat system; regenerate
   `worker-configuration.d.ts`. Acceptance: absent both vars, behavior is byte-identical to
   today (existing loadtest passes); with a seed var set, client and server agree via
   `welcome.seed` with zero client changes; seed change triggers the wipe path, leaderboard
   survives. Depends: doc 02 shape (can stub with `{ seed?: number }`).
4. **M4 — site/ skeleton + OAuth** *(Opus 4.8 — security-sensitive)* — `site/wrangler.jsonc`
   (name `worldspring-web`), `site/src/worker.ts` with `/login`, `/oauth/callback`, signed
   session cookie, accounts discovery + picker, against a **private**-visibility client on
   Adam's account. Root script `"deploy:site": "wrangler deploy -c site/wrangler.jsonc"`.
   Acceptance: full login round-trip on the deployed site; state/PKCE verified; token never
   appears in logs or responses. Depends: M1 (scope IDs, redirect URI rules).
5. **M5 — Deployer DO + create flow backend** *(Opus 4.8 — cross-cutting, retries,
   token handling)* — `site/src/deployer.ts` state machine per §5, R2 artifact reads,
   job status API, per-account serialization, sweep. Directory token step against doc 03's
   tables (or a stub). Acceptance: end-to-end deploy of a real artifact into a scratch
   free account from the deployed site; kill the DO mid-job and the job resumes at its
   recorded step; forced 401 mid-job pauses with `needs: "reauth"` and resumes; PUT
   response assertions enforced. Depends: M1, M2, M4.
6. **M6 — Create Server UI** *(Sonnet 4.8)* — `/create` page: preset picker (doc 02's
   `PRESETS`), name → slug, subdomain prompt flow, cost panel with research/cf-costs.md
   numbers and the free-plan gate, job progress polling, success screen. Acceptance:
   non-technical-user walkthrough produces a playable server; cost copy matches
   research/cf-costs.md §7 verbatim-ish. Depends: M5, doc 02.
7. **M7 — Your servers + update flow** *(Opus 4.8 — migration chaining correctness)* —
   `created_servers` table, "Your servers" page, version-available banners, `kind:
   "update"` jobs with migration-tag recompute, directory token rotation, `wipesWorld`
   confirmation, player-count disconnect warning. Acceptance: update a v0.0.1 server to
   v0.0.2 with no migrations (field omitted) and to a synthetic release adding a migration
   (chained `old_tag`/`new_tag` applied); world survives the former, wipe warning shown for
   a `schemaVersion` bump. Depends: M5; doc 03 for version-via-heartbeat (can read
   `/api/server-info` directly meanwhile).
8. **M8 — Delete/unlist + register-existing** *(Sonnet 4.8)* — unlist via directory,
   `kind: "delete"` jobs with force-delete + type-name confirmation, "Register an existing
   server" page for CLI deploys. Acceptance: deleted worker disappears from the user's
   dashboard and the directory; a CLI-deployed server gets listed via paste-URL + secret.
   Depends: M5, doc 03.
9. **M9 — Launch hardening + docs** *(Sonnet 4.8, plus Adam manual steps)* —
   `docs/SELF_HOSTING.md` (CLI path, §9), server-owner cost guide, fix `package.json`
   `deploy` script for Deploy-button compatibility + README button, runbook for the
   one-way public-visibility promotion (custom domain, TXT record, logo, ToS/privacy
   URLs — research/cf-oauth.md §6). Acceptance: a stranger's Cloudflare account can
   complete the flow (requires the promoted public client). Depends: custom domain
   (open question 1), M6–M8.

## Open questions

1. **Custom domain for the site** — ~~hard blocker for public OAuth visibility (TXT
   verification cannot happen under workers.dev, research/cf-oauth.md §8). Which domain, and
   does Adam want the game itself to move under it too (e.g. `play.<domain>`)?~~
   **RESOLVED 2026-07-07: `worldspring.games`** (a zone on Adam's Cloudflare account).
   The apex is a Workers custom domain on `worldspring-web` (`apps/web/wrangler.jsonc`
   `routes`); the game worker stays on workers.dev for v1 per the recommendation
   (`play.worldspring.games` remains a later option). OAuth client URL is
   `https://worldspring.games`, redirect URI `https://worldspring.games/oauth/callback`;
   the M9 public-visibility promotion does its `cloudflare_oauth_client_publisher` TXT
   verification on this zone.
2. **Ephemeral tokens — confirm the call.** The §6 table is the case; the cost is one OAuth
   bounce per update. *Recommendation: ephemeral. Revisit only if fleet auto-update becomes
   a real ask, and then as a separate opt-in consent.*
3. **Script naming**: enforce the `worldspring-` prefix in user accounts? It costs vanity
   URLs (`worldspring-bobs-island.foo.workers.dev`) but is the clobber guard and brand
   marker. *Recommendation: yes, enforce; vanity can come later via custom domains on their
   side.*
4. **Gate the whole launch on the persistAll fix?** Free-plan servers break saves ~80 min
   in as shipped (research/cf-costs.md §3). *Recommendation: yes — land the one-row world
   snapshot before M6 ships, and keep the cost-panel gate as belt-and-braces. Shipping
   "free hosting" that corrupts evenings is worse than shipping late.*
5. **Site storage: D1 vs DO SQLite.** This doc assumes a shared site D1 (with doc 03's
   directory tables) plus the Deployer DO's private job table. *Recommendation: keep that
   split — relational queries and dashboards favor D1; job state wants DO atomicity. Push
   back if doc 03 chose differently.*
6. **R2 vs GitHub Releases as the deploy source.** *Recommendation: R2 primary (binding
   reads, no rate limits), GitHub mirror for transparency/recovery — as designed.*
7. **Artifact signing** (meta.json signature verified by the site) — hardening against
   CI/R2 compromise. *Recommendation: defer to post-launch; the CI-token blast radius is
   acceptable for v1 and the verification hook (sha256 check in §5 step 6) already exists
   to extend.*
8. **Workers-for-Platforms managed tier** — price and demand unknown.
   *Recommendation: park until ≥ dozens of "I don't have a Cloudflare account" requests;
   the Deployer DO is already reusable for it.*
