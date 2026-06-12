# Deploying DEADCOAST into someone else's Cloudflare account

Research for the create-server flow: every viable way to programmatically deploy a copy of
this game (Worker bundle + static assets + `GameRoom` Durable Object with the
`new_sqlite_classes` migration + vars) into a third party's Cloudflare account, given an
OAuth-derived API token for that account.

All endpoints below were verified against live Cloudflare docs on **2026-06-11**. Cloudflare's
docs site serves raw markdown at `<page-url>index.md` — re-verify the same way before
implementing; this API surface moves weekly. Anything not directly confirmed is marked
**UNCONFIRMED**.

---

## 0. What exactly we are deploying (ground truth from this repo)

`wrangler.jsonc` (repo root):

```jsonc
{
  "name": "survival-game",
  "main": "src/server/worker.ts",
  "compatibility_date": "2026-06-01",
  "assets": { "not_found_handling": "single-page-application" },
  "durable_objects": { "bindings": [{ "name": "GAME", "class_name": "GameRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }],
  "observability": { "enabled": true }
}
```

`vite build` (via `@cloudflare/vite-plugin`) emits — verified against the main checkout's
`dist/`:

| Artifact | Path | Measured |
| --- | --- | --- |
| Worker bundle (single ESM module) | `dist/survival_game/index.js` | 124 KB raw, **34 KB gzip** |
| Generated deploy config | `dist/survival_game/wrangler.json` | `main: "index.js"`, `assets.directory: "../client"`, `no_bundle: true`, carries the DO binding + migration verbatim |
| Client assets | `dist/client/**` | **60 files, 4.8 MB total** |
| Config redirect | `.wrangler/deploy/config.json` | `{"configPath":"../../dist/survival_game/wrangler.json"}` — how root `wrangler deploy` finds the built config |

Implications: the worker is one module (no multi-module multipart gymnastics), 1% of the
free-plan 3 MB gzip size limit, and the asset set is 0.3% of the free-plan 20,000-file limit.
Everything fits a free Cloudflare account.

---

## 1. The token premise: Cloudflare self-managed OAuth clients (NEW — June 3, 2026)

Cloudflare shipped **self-managed OAuth clients** on 2026-06-03 — one week before this
research. This is the mechanism that makes "OAuth-derived API token" real: we register an
OAuth app, the user consents, and we get a bearer access token that works against
`api.cloudflare.com` exactly like an API token.

- Changelog: <https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/>
- Docs hub: <https://developers.cloudflare.com/fundamentals/oauth/>
- Create a client: <https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/>
- Endpoints: <https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/>

Key facts:

- **Endpoints**: authorize `https://dash.cloudflare.com/oauth2/auth`, token
  `https://dash.cloudflare.com/oauth2/token`, revoke `https://dash.cloudflare.com/oauth2/revoke`,
  OIDC discovery `https://dash.cloudflare.com/.well-known/openid-configuration`.
- **Authorization Code flow only** (PKCE supported/required depending on client type). No
  client-credentials, no device flow.
- Clients are created in the dash (**Manage account → OAuth clients**) or via
  `POST /accounts/{account_id}/oauth_clients` (needs `OAuth Clients Write` permission).
- Clients start **private** (usable only by members of the creating account). Making it
  **public** (usable by any Cloudflare user — what we need) requires extra fields, TOS/policy
  URLs, and **client domain ownership verification** (verified badge on the consent screen).
- **Scopes correspond to API token permission names** (example scope id seen in docs:
  `workers-platform.read`). Enumerate live with `GET https://api.cloudflare.com/client/v4/oauth/scopes`.
- Available on all plans including Free.

Scopes/permissions our deploy flow needs (permission-group names from
<https://developers.cloudflare.com/fundamentals/api/reference/permissions/>):

| Need | Permission group | Confidence |
| --- | --- | --- |
| Script upload, assets upload sessions, deployments, migrations | **Workers Scripts Edit** (account-scoped) | Confirmed this is the Workers write permission; exact OAuth scope id UNCONFIRMED — read `GET /oauth/scopes` |
| Account + script workers.dev subdomain | Workers Scripts Edit covers it in wrangler's own token template | UNCONFIRMED — verify with a minimal-scope token on a test account |
| List accounts to discover `account_id` post-OAuth | `Account Settings Read` (or OIDC userinfo + `GET /accounts`) | UNCONFIRMED exact minimal scope |

Also worth knowing: **the user can simply paste a manually created API token** ("Edit
Cloudflare Workers" template) as a fallback flow — every API below works identically with
either token type.

`account_id` discovery: `GET https://api.cloudflare.com/client/v4/accounts` with the
OAuth-derived token returns the accounts the token can act on.

---

## 2. Option A (recommended): direct REST upload — the stable multipart Script Upload API

This is what `wrangler deploy` itself does, so it is the only path *proven* to handle our
exact combination (assets + DO binding + `new_sqlite_classes` migration + immediate deploy)
in one shot. Docs:

- Script Upload API: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/>
- Multipart metadata: <https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/>
- Assets direct upload: <https://developers.cloudflare.com/workers/static-assets/direct-upload/>
- IaC overview (incl. REST examples): <https://developers.cloudflare.com/workers/platform/infrastructure-as-code/>

### 2.1 Call sequence (5–7 HTTP calls total)

```text
1. POST /accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session
2. POST /accounts/{account_id}/workers/assets/upload?base64=true       (xN buckets, JWT auth)
3. PUT  /accounts/{account_id}/workers/scripts/{script_name}           (multipart: metadata + index.js)
4. GET  /accounts/{account_id}/workers/subdomain                       (does the account have one?)
5. PUT  /accounts/{account_id}/workers/subdomain                       (register if missing)
6. POST /accounts/{account_id}/workers/scripts/{script_name}/subdomain (enable workers.dev route)
```

All on `https://api.cloudflare.com/client/v4`, `Authorization: Bearer <token>` except step 2
(see below).

### 2.2 Step 1 — asset upload session

`POST /accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session`
(<https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/assets/subresources/upload/methods/create/>)

Body: `{ "manifest": { "/<path>": { "hash": "<32-hex>", "size": <bytes> }, ... } }`

**The hash algorithm matters** — it must match what the dedupe layer expects. From
Cloudflare's own SDK example (embedded in the direct-upload doc, verified):

```ts
// hash = first 32 hex chars of sha256( base64(fileContents) + fileExtensionWithoutDot )
const hash = crypto.createHash("sha256")
  .update(fileContent.toString("base64") + extension) // extname(path).substring(1)
  .digest("hex")
  .slice(0, 32);
```

Manifest keys are `/`-prefixed paths relative to the asset root (`dist/client`), e.g.
`/index.html`, `/assets/vendor-three-<hash>.js`.

Response: `{ result: { jwt, buckets: string[][] } }`.

- `jwt` is the **upload token**, valid **1 hour**.
- `buckets` = arrays of file hashes to upload together, one request per bucket. Files already
  known to Cloudflare **from previous versions of this same Worker** are omitted (dedupe is
  per-Worker — a fresh account uploads everything once, updates only upload changed files).
- If `buckets` is empty, `jwt` is already a **completion token** — skip step 2.

### 2.3 Step 2 — upload asset files

`POST /accounts/{account_id}/workers/assets/upload?base64=true`
(<https://developers.cloudflare.com/api/resources/workers/subresources/assets/subresources/upload/methods/create/>)

- `Authorization: Bearer <upload-jwt-from-step-1>` — NOT the account API token.
- `multipart/form-data`; one part per file in the bucket, **part name = the file's hash**,
  part body = **base64-encoded contents**, part `Content-Type` = the MIME type to serve
  (use `application/null` to suppress serving a content-type).
- When the last manifest file lands, the response is **201** with
  `{ result: { jwt: <completion-token> } }` — also valid **1 hour**.

### 2.4 Step 3 — multipart script upload (this is the deploy)

`PUT /accounts/{account_id}/workers/scripts/{script_name}`

`multipart/form-data` with:

- part `metadata` (type `application/json`) — see below
- part `index.js` (type `application/javascript+module`, `filename=index.js`) — the built
  worker bundle from `dist/survival_game/index.js`

Exact `metadata` for DEADCOAST, first deploy:

```json
{
  "main_module": "index.js",
  "compatibility_date": "2026-06-01",
  "bindings": [
    { "type": "durable_object_namespace", "name": "GAME", "class_name": "GameRoom" },
    { "type": "plain_text", "name": "SERVER_NAME", "text": "<user-chosen name>" }
  ],
  "migrations": { "new_tag": "v1", "new_sqlite_classes": ["GameRoom"] },
  "assets": {
    "jwt": "<completion-token-from-step-2>",
    "config": { "not_found_handling": "single-page-application" }
  },
  "observability": { "enabled": true },
  "tags": ["deadcoast", "deadcoast-v<release>"],
  "annotations": { "workers/message": "DEADCOAST <release>", "workers/tag": "<release>" }
}
```

Notes, all confirmed in docs:

- This endpoint **implicitly creates a version AND deploys it to 100%** — and it is the
  documented home of `migrations` ("Additional attributes: Workers Script Upload API ...
  not available for version uploads").
- `migrations` shape (from the API schema): single-step
  `{ deleted_classes?, new_classes?, new_sqlite_classes?, renamed_classes?, transferred_classes?, new_tag?, old_tag? }`
  or multi-step `{ new_tag, old_tag, steps: MigrationStep[] }`. `old_tag` "is used to verify
  against the latest migration tag for this Worker. If they don't match, the upload is
  rejected."
- **Migration tag rules** (<https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>):
  once a Worker has a migration tag, future deploys that include migrations must chain tags
  (`old_tag` = current `migration_tag`). On **updates with no new migrations, omit the
  `migrations` field entirely** — the response's `migration_tag` stays `v1`. (This is
  wrangler's behavior; the omit-on-update path is **UNCONFIRMED** against the raw API — test
  once on a scratch account.)
- `assets.config` accepts `html_handling`, `not_found_handling`, `run_worker_first` — match
  wrangler.jsonc exactly (`single-page-application`).
- Vars become `plain_text` bindings; secrets become `secret_text` bindings in the same array
  (or set later via `PUT /accounts/{id}/workers/scripts/{name}/secrets`).
- An `assets` **binding** (`{"type":"assets","name":"ASSETS"}`) is only needed if the worker
  code calls `env.ASSETS.fetch()` — DEADCOAST's `src/server/worker.ts` does not today; the
  platform serves assets ahead of the worker without it.
- Optional `bindings_inherit=strict` query param fails the upload if inherited bindings can't
  resolve — irrelevant for first deploys.
- Response includes `migration_tag`, `has_assets`, `named_handlers` (you should see
  `{"name":"GameRoom","handlers":["class"]}` echoed back — a cheap deploy-success assertion),
  and `startup_time_ms`.

### 2.5 Steps 4–6 — workers.dev subdomain (fresh accounts have none)

Account-level subdomain — <https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/>:

- `GET  /accounts/{account_id}/workers/subdomain` → `{ result: { subdomain } }`
- `PUT  /accounts/{account_id}/workers/subdomain` body `{ "subdomain": "<desired>" }` —
  **creates/renames** the account's `<subdomain>.workers.dev`. Subdomains are globally
  unique; handle the conflict error by prompting for another name. (Exact error
  code/response for "name taken" and for GET on a never-registered account: **UNCONFIRMED**
  — probe on a scratch account.)

Per-script enablement — <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/>:

- `POST /accounts/{account_id}/workers/scripts/{script_name}/subdomain` body
  `{ "enabled": true, "previews_enabled": false }`. Do this explicitly after the PUT upload —
  the docs' GET example shows `enabled: false` as a possible state and wrangler issues this
  call itself; do not rely on a default. (**UNCONFIRMED** what the default is for
  API-created scripts.)

Final URL: `https://{script_name}.{account_subdomain}.workers.dev`. Worker name constraints
when workers.dev is used: ≤63 chars, `[a-zA-Z0-9-]`, no leading/trailing dash
(<https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>).

### 2.6 The newer "beta" Workers API (versions/deployments as first-class resources)

The multipart-metadata doc now banners: "There is a new API for uploading Workers" → the
**beta** API the v5 Terraform provider and current SDKs use:

- `POST /accounts/{account_id}/workers/workers` — create Worker; body supports `name`,
  `observability`, **`subdomain: { enabled, previews_enabled }`** (no separate subdomain call)
- `POST /accounts/{account_id}/workers/workers/{worker_id}/versions` — JSON (not multipart):
  `modules: [{ name, content_type, content_base64 }]`, `main_module`, `compatibility_date`,
  `bindings`, `assets: { jwt, config }`, **`migrations`** ("applied when the version is
  deployed"), `limits: { cpu_ms }`, plus **query param `?deploy=true`** ("a deployment will
  be created that sends 100% of traffic to the new version")
- `POST /accounts/{account_id}/workers/scripts/{script_name}/deployments` — body
  `{ strategy: "percentage", versions: [{ percentage: 100, version_id }] }`
- Refs: <https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/>
  and <https://developers.cloudflare.com/workers/platform/infrastructure-as-code/>

**Hazard, documented**: "Durable Object migrations are applied with deployments. This means
you can't bind to a Durable Object in a Version if a deployment doesn't exist i.e. migrations
haven't been applied" — the IaC page shows Terraform needing a two-pass dance for exactly
our shape (DO binding + migration on first deploy). Whether
`POST .../versions?deploy=true` with binding+migration in one call clears that validation is
**UNCONFIRMED**. The API is also explicitly labeled **beta** ("See the multipart/form-data
API below for the stable API").

**Verdict**: ship Option A on the stable multipart PUT. Revisit the beta API when it leaves
beta; it's the long-term direction (immutable versions, `?deploy=true`, subdomain at create).

### 2.7 Older version-upload API — explicitly ruled out for first deploys

`POST /accounts/{account_id}/workers/scripts/{script_name}/versions` (the *non*-beta one)
**cannot apply DO migrations** — "Uploading a version with Durable Object migrations is not
supported. Use wrangler deploy" (<https://developers.cloudflare.com/workers/configuration/versions-and-deployments/>).
Also "First upload ... using wrangler versions upload the first time you upload a Worker
will fail." Only useful for post-v1 gradual rollouts of code-only changes.

### 2.8 Where the artifacts come from (our side, once per release)

In OUR CI, per release: `vite build`, then persist `dist/survival_game/index.js` +
`dist/client/**` + a precomputed asset manifest (hashes/sizes/content-types) to R2. The
create-server Worker then replays steps 1–6 against the user's account with their token —
pure `fetch()`, no wrangler, no Node, runs fine inside a Worker/DO. Total cost: 5–7 API
calls + ~5 MB of asset bytes per fresh deploy (well inside the **1,200 req / 5 min** global
API rate limit — <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/>).

---

## 3. Option B: "Deploy to Cloudflare" button

Docs: <https://developers.cloudflare.com/workers/platform/deploy-buttons/>

What it actually does (confirmed, current docs):

1. **Clones our public GitHub/GitLab repo into the user's own GitHub/GitLab account** (a
   copy, not a fork — no upstream link, so updates do NOT flow automatically).
2. Shows a single setup page: repo name, Worker name, resource names; the customizations are
   written into the newly created repo.
3. Builds with **Workers Builds** and deploys; resources in wrangler config are
   auto-provisioned — supported list explicitly includes **Durable Objects** (plus KV, D1,
   R2, Hyperdrive, Vectorize, Queues, Workers AI, Secrets Store).

Mechanics relevant to us:

- URL format: `https://deploy.workers.cloudflare.com/?url=<git repo URL>` — subdirectory via
  the `/tree/<branch>/<subdir>` URL form. `url` is the only documented query param today.
  (The 2020-era deploy-button service had a `paid=true` param — that's the legacy system;
  treat any other param as **UNCONFIRMED**: <https://github.com/cloudflare/deploy.workers.cloudflare.com/blob/master/DEVELOPERS.md>.)
- Build/deploy commands come from `package.json` scripts; if no `deploy` script, it
  preconfigures `npx wrangler deploy`. **Our `deploy` script is
  `vite build && wrangler deploy` while `build` is `vite build` — the button would run vite
  twice.** Cheap repo fix before publishing a button.
- DO migrations work because the deploy command is just `wrangler deploy` reading our
  wrangler.jsonc.
- Vars: `vars` in wrangler config; secrets prompted from `.dev.vars.example`/`.env.example`;
  per-binding descriptions via `package.json` → `"cloudflare": { "bindings": { NAME: { description } } }`.
- Hard limitations: public repos only; github.com/gitlab.com only; Workers (not Pages) only;
  monorepo subdir must be fully self-contained.

User experience: click button → log into Cloudflare → connect GitHub → one config page →
build runs (~minutes, it's a full `npm install` + vite build of the 3D client) → live on
their workers.dev. They end up owning a repo copy + a git-connected Worker.

**Fit for DEADCOAST**: great as the zero-effort public option ("Run your own server" in the
README), and it's the only option where the user can then hack on their copy. Bad as THE
create-server flow: no programmatic control, repo copies go stale, build time is minutes not
seconds, and we can't orchestrate it with the OAuth token at all.

---

## 4. Option C: Workers Builds (git-connected CI) configured via API

Docs: <https://developers.cloudflare.com/workers/ci-cd/builds/> and the API reference
<https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/>.

A real Builds API exists (endpoints under `/accounts/{account_id}/builds/...`):

- `PUT /accounts/{account_id}/builds/repos/connections` — create repo connection
  (`provider_type: "github"`, `provider_account_id`, `repo_id`, `repo_name`)
- `GET /accounts/{account_id}/builds/tokens` — list build tokens (deploy credentials)
- `POST /accounts/{account_id}/builds/triggers` — create trigger (`external_script_id` =
  Worker **tag**, `repo_connection_uuid`, `build_token_uuid`, `build_command`,
  `deploy_command`, `branch_includes`, ...)
- `PATCH /accounts/{account_id}/builds/triggers/{uuid}/environment_variables`
- `POST /accounts/{account_id}/builds/triggers/{uuid}/builds` — trigger a build

Why it does NOT work for our flow:

1. **"The Builds API requires a user-scoped API token. Account-scoped tokens are not
   supported"** — permission `Workers Builds Configuration: Edit`. An OAuth-derived token is
   account-scoped in spirit; whether Cloudflare's OAuth can mint the user-scoped equivalent
   is **UNCONFIRMED** and I'd bet against it.
2. **The Cloudflare GitHub App must be installed via the dashboard first** ("Before using
   the API, you must first install the Cloudflare GitHub App through the dashboard") — a
   manual step on the user's GitHub account.
3. The repo connection rides that GitHub App installation, so the repo must be **in the
   user's GitHub account/org** — you cannot point Workers Builds at OUR public repo without
   the user copying it first (push events need webhooks on the repo). **UNCONFIRMED** edge:
   whether a connection to a public repo outside the installation is accepted — community
   feature request <https://github.com/cloudflare/workers-sdk/issues/12058> implies no.

**Verdict**: not viable for a token-only create-server flow. It's what the Deploy button
automates anyway — if we want git-connected deploys for users, send them to Option B.

---

## 5. Option D: Workers for Platforms — host community servers in OUR account instead

Docs: <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/>,
API <https://developers.cloudflare.com/api/resources/workers_for_platforms/>,
limits <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/>,
pricing <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/>.

Mechanics (all confirmed):

- `POST /accounts/{our_account}/workers/dispatch/namespaces` body `{ "name": "deadcoast-servers" }`
- Upload user Workers with the **same multipart metadata** as Option A:
  `PUT /accounts/{our_account}/workers/dispatch/namespaces/{ns}/scripts/{server-name}`
- Assets have a namespace-scoped session endpoint:
  `POST .../dispatch/namespaces/{ns}/scripts/{name}/assets-upload-session`, then the same
  `POST /accounts/{id}/workers/assets/upload?base64=true`, completion JWT into metadata.
- DOs in user Workers: supported; "Workers for Platforms do not have a limit for the number
  of Durable Object namespaces"; responses carry `migration_tag` (the dispatch script PUT
  accepts `migrations` like the regular one).
- Routing: namespaced scripts get **no workers.dev URL**. We run a dispatch Worker bound to
  the namespace (`env.DISPATCH.get(scriptName).fetch(request)`) and route
  `<server>.deadcoast.example` or `/s/<server>/*` — WebSockets proxy through fine.
- Controls: per-script `limits` (CPU ms via custom limits), ≤8 tags per script for tenant
  bookkeeping, namespace-wide observability; `caches.default` disabled and `request.cf`
  hidden unless trusted mode; **gradual deployments unsupported** for user Workers.

Cost reality (lands on US):

- **$25/month** base; 20M requests + 60M CPU-ms included; 1,000 scripts included then
  **$0.02/script/month**; no duration charge for the Workers themselves.
- BUT the **Durable Objects usage bills to our account at paid rates** — requests
  ($0.15/M after 1M), duration ($12.50/M GB-s after 400k), SQLite storage
  (reads/writes/GB after included amounts). A 15 Hz simulation DO held active by connected
  players is exactly the expensive shape: ~0.125 GB-s per active room-second →
  ~$5.60/month of duration per *continuously* active room after the included pool, plus WS
  message requests at a 20:1 billing ratio. Denial-of-wallet is a real threat — custom
  limits cap CPU but not duration.

**Verdict**: the right architecture for *official* or *managed* servers and for users who
have no Cloudflare account, but it inverts the cost model the create-server flow exists for
(their server, their bill). Keep as a separate "hosted server" tier, not the default.

---

## 6. Option E: headless wrangler vs reimplementing the calls

- Wrangler authenticates non-interactively with **`CLOUDFLARE_API_TOKEN`** (+
  `CLOUDFLARE_ACCOUNT_ID`) env vars — <https://developers.cloudflare.com/workers/wrangler/system-environment-variables/>.
  An OAuth-derived bearer token works here (it is "an API token" to the API).
- **Wrangler has no programmatic deploy API.** The exported Node API surface is dev-only:
  `unstable_dev`, `unstable_startWorker`, `getPlatformProxy`,
  `experimental_generateTypes` — <https://developers.cloudflare.com/workers/wrangler/api/>.
  Headless means spawning the CLI.
- CI affordances: `WRANGLER_OUTPUT_FILE_PATH` writes ND-JSON records of deployments/version
  uploads for machine parsing; `wrangler deploy --dry-run --outdir build` bundles without
  uploading (the IaC page's recommended way to feed Terraform/API uploads).
- Where would it run? Not in our Worker. It needs a Node sandbox per deploy (Cloudflare
  Containers/Sandbox SDK, or GitHub Actions in our repo with the user's token passed as an
  input — do NOT do that; tokens in third-party CI logs are a breach waiting to happen).

**Verdict**: wrangler-at-deploy-time buys nothing — our artifact is prebuilt and the upload
is 5–7 documented HTTP calls. Use wrangler only on OUR side (it already produces
`dist/survival_game/wrangler.json`, which is the exact source of truth to template the
upload metadata from — generate the metadata JSON from that file in CI so config drift is
impossible).

---

## 7. Account prerequisites and free-plan reality check

Sources: <https://developers.cloudflare.com/workers/platform/limits/>,
<https://developers.cloudflare.com/durable-objects/platform/pricing/>,
<https://developers.cloudflare.com/durable-objects/platform/limits/>.

**No paid plan is required.** Specifically:

- **SQLite-backed Durable Objects are available on Workers Free** — and only SQLite-backed
  ones, which is exactly what `new_sqlite_classes: ["GameRoom"]` creates. (KV-backed DOs are
  paid-only; irrelevant to us.)
- Static assets are served free on any plan.
- workers.dev subdomain: free; just needs registration (Option A step 5).

Free-plan ceilings that matter for a game server:

| Limit | Free | Paid ($5/mo) | DEADCOAST impact |
| --- | --- | --- | --- |
| Worker requests | 100k/day | unlimited | page loads + /api/* — fine |
| DO requests (HTTP + **WS messages at 20:1** + alarms) | 100k/day | 1M/mo incl., then $0.15/M | THE binding constraint, see below |
| DO duration | 13,000 GB-s/day | 400k GB-s/mo incl. | ≈ 29 always-on room-hours/day at 128 MB — fine for one community server |
| DO storage | 5 GB total, 1 GB/DO | 10 GB/DO | persistAll world state — fine |
| SQLite rows read/written | 5M / 100k per day | 25B / 50M per mo incl. | watch `persistAll` write amplification on busy servers |
| Worker size (gzip) | 3 MB | 10 MB | bundle is 34 KB — fine |
| Asset files / file size | 20k / 25 MiB | 100k / 25 MiB | 60 files / 4.8 MB — fine |
| Workers per account | 100 | 500 | one per server — fine |
| DO CPU per invocation | 30 s default | 30 s, raisable via `limits.cpu_ms` | 15 Hz tick budget unaffected (timer resets per incoming message) |

The WS-message math (the honest caveat for the create-server UX): incoming client messages
bill at 20:1. If a client sends ~15 input msgs/s, one player-hour ≈ 15×3600/20 = **2,700
billed DO requests**. The free 100k/day ≈ **37 player-hours/day** across the server (plus
WS connects, HTTP, alarms). A casual community server fits; a popular 24/7 server with 5–10
concurrent players will hit the daily cap and **further requests fail until 00:00 UTC**.
Recommendation for the flow: deploy to free by default, detect 10000-series
over-limit errors / advise the $5 Workers Paid upgrade in the server-owner docs. Outgoing
messages (our 15 Hz state broadcast) are free; `setWebSocketAutoResponse` pings are free.

Fresh-account snags to handle in code: account has no workers.dev subdomain (step 5);
**UNCONFIRMED** whether a never-touched account needs any other one-time Workers onboarding
before the script PUT succeeds — test the whole flow against a brand-new free account before
shipping.

---

## 8. Versioning / update paths (re-deploying on new releases)

1. **Same-shape re-upload (recommended).** Re-run Option A steps 1–3 with the new artifacts.
   Asset dedupe means only changed files upload. Omit `migrations` unless the release adds a
   DO class (then chain `old_tag`/`new_tag`). `keep_assets: true` in metadata skips assets
   entirely for server-only patches. Optional `If-None-Match: <etag>` guards races.
2. **Gradual rollout** (paid feature? — available on free per docs, no plan gate mentioned):
   upload a version (`POST .../versions` — legacy or beta), then
   `POST .../deployments { strategy: "percentage", versions: [{...50/50...}] }`.
   Constraints that bite us: versions with **new DO migrations can't be gradually deployed**
   (atomic only), and **assets + gradual = version-skew 404s** (HTML from v1 referencing
   hashed asset names only in v2 — <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>).
   For DEADCOAST, gradual is actively wrong anyway: client and server run the same
   deterministic sim from `src/shared/`; skew between served client code and server sim is a
   desync generator. **All-at-once, always.**
3. **Who pushes the update?** With OAuth refresh tokens stored server-side we can redeploy
   on the user's behalf (consent screen should say so); otherwise the directory pings the
   server's `/api/health` (already exists) for a version field and shows "update available →
   re-run flow". Decide in design; both are mechanically identical to the calls above.
4. **DETERMINISM IS SACRED corollary**: a community server on version N with a world
   persisted under N's rng stream order must never be flipped to a version that reorders
   existing streams — which is already the repo contract (new features = new hash-salted
   streams, e.g. the `^0x6a09e6` precedent). Surface `gameVersion` in `/api/health` and in
   the welcome message alongside the seed so the directory can refuse mismatched clients.

---

## 9. Recommendation

| Path | Verdict |
| --- | --- |
| **A. Direct REST upload (stable multipart PUT)** | **Build the create-server flow on this.** Proven shape (it's wrangler's own path), ~6 calls, seconds-fast, pure fetch from a Worker, free plan suffices. |
| B. Deploy to Cloudflare button | Ship alongside as the README/"power user" path; users get their own hackable repo. Fix `package.json` scripts first. |
| C. Workers Builds API | Dead end for token-only automation (user-scoped token + manual GitHub App install). Skip. |
| D. Workers for Platforms | Optional future "we host it" tier; costs land on us; $25/mo + DO usage. Not the default. |
| E. Headless wrangler | Use in OUR CI to produce artifacts (`vite build` → `dist/survival_game/`); never at user-deploy time. |

Create-server flow sketch: OAuth (public self-managed client, Workers-write scopes) →
`GET /accounts` → pick/confirm account → ensure account subdomain → asset session → asset
upload → multipart PUT with metadata templated from `dist/survival_game/wrangler.json` +
user vars → enable script subdomain → poll `https://<name>.<sub>.workers.dev/api/health` →
register in directory.

## 10. UNCONFIRMED items (verify on a scratch account before implementation)

1. Exact OAuth scope ids for Workers Scripts Edit / subdomain management
   (`GET /client/v4/oauth/scopes`), and whether Cloudflare approves our public OAuth client
   (domain verification + review prerequisites).
2. Whether the **account-level subdomain PUT and script subdomain POST are covered by
   Workers Scripts Edit** or need an extra permission.
3. `GET /workers/subdomain` response on a never-registered account, and the error shape for
   a taken subdomain name.
4. Default `enabled` state of the workers.dev route for a script created via raw API PUT
   (we POST `enabled: true` regardless).
5. Re-upload with `migrations` omitted on a worker whose `migration_tag` is `v1` — expected
   to succeed and preserve the tag (wrangler behavior), not doc-confirmed for raw API.
6. Beta API: whether `POST .../versions?deploy=true` with DO binding + migration succeeds on
   a first deploy (Terraform docs imply a validation ordering problem).
7. Whether a brand-new account requires any dashboard-side Workers onboarding before the
   first script PUT.
8. Workers Builds repo connection to a public repo outside the user's GitHub App
   installation (assumed impossible).
9. Deploy button: any query params besides `url` in the current (2025+) system; `paid=true`
   is legacy.
10. Whether OAuth-derived tokens can ever satisfy the Builds API's "user-scoped token"
    requirement (assumed no).
