# Doc 01 M1 — Cloudflare OAuth + deploy-API spike runbook

> **Refresh 2026-07-07** (facts below that changed since this runbook was written;
> the harness is updated to match):
> - Build output moved: worker bundle `apps/game/dist/worldspring/index.js`, generated
>   config `apps/game/dist/worldspring/wrangler.json`, assets `apps/game/dist/client/**`
>   (~90 files / 7.5 MB, honoring `.assetsignore`). Run
>   `pnpm --filter @worldspring/game build` before the `deploy` phase.
> - `/api/server-info` NOW EXISTS (doc 03 M2 landed) and `PROTOCOL_VERSION` is **5** —
>   the deploy phase verifies via `/api/server-info` like the real deployer will,
>   not `/api/health`.
> - The site is live at **worldspring.games** (doc 01 open Q1 resolved); the production
>   OAuth client (M4) will use redirect `https://worldspring.games/oauth/callback`. The
>   spike keeps its throwaway client + localhost redirect — which also settles whether
>   localhost redirects are accepted (U6).
> - The release pipeline (doc 01 M2) is now committed: `.github/workflows/release.yml`
>   + `scripts/build-artifact.mjs`. Its asset-hash + multipart-metadata assumptions are
>   exactly what this spike validates — run the spike before trusting a first real tag.
>
> ---
>
> Produced by the `wave0-next-milestones` workflow. This milestone **cannot run autonomously** —
> it needs a throwaway Cloudflare account + credentials and makes side-effectful API calls (create an
> OAuth client, upload a Worker, force-delete it). Run the harness one phase at a time. The milestone's
> deliverable is the **findings** written back into `docs/plans/research/cf-{oauth,deploy,costs}.md`.
>
> **The harness is committed at [`scripts/spike-deploy.mjs`](../../../scripts/spike-deploy.mjs) in this
> PR — use the tracked file, do not run an untracked local copy.** Any "create it from the skeleton"
> phrasing in the summary/steps below predates committing it.

## Summary

RUNBOOK — Doc 01 Milestone M1: scratch-account OAuth + Workers deploy-API spike for Worldspring. This milestone CANNOT run autonomously: it needs Adam's Cloudflare credentials and makes side-effectful calls (creating an OAuth client, uploading a Worker via the multipart Script Upload API, deleting it). Goal: Adam runs it himself in ~30-60 min and the spike burns down the six UNCONFIRMED platform behaviors plus keep_bindings semantics plus the Workers-Logs WS measurement, then updates the three research files in place.

KEY PATH MAPPING (docs predate the monorepo; verified against the primary checkout at HEAD df13557):
- Game worker + GameRoom DO: apps/game/src/server/worker.ts, apps/game/src/server/GameRoom.ts, apps/game/src/server/persistence.ts (NOT src/server/...). worker.ts is parameter-free, routes /ws + /api/leaderboard + /api/health to env.GAME.getByName("main"); zero vars/secrets.
- Game wrangler config: apps/game/wrangler.jsonc — name "worldspring", main "src/server/worker.ts" (relative to apps/game), DO binding GAME->GameRoom, migration v1 new_sqlite_classes ["GameRoom"], observability.enabled:true and NO head_sampling_rate (defaults to 100% — this is exactly the cost-bomb the WS-Logs measurement settles).
- Shared package: packages/shared/src/* (NOT src/shared/...). constants.ts:WORLD_SEED, protocol.ts, version.ts.
- Build output dir is dist/survival_game/ (the @cloudflare/vite-plugin output name "survival_game" was NOT renamed with the brand; the dist/ in the tree is a stale Jun-11 build whose generated wrangler.json still says name "survival-game"). Worker bundle dist/survival_game/index.js = 34 KB gzip; client assets dist/client/** = 60 files / 4.8 MB. Generated deploy config dist/survival_game/wrangler.json is the metadata source-of-truth.
- Research files live at docs/plans/research/cf-deploy.md, cf-oauth.md, cf-costs.md (NOT research/...). These are where M1 records findings.
- Spike script per doc: scripts/spike-deploy.mjs at repo root (zero-dep Node ESM, modeled on apps/game/scripts/loadtest.mjs). NOTE the brief says zero repo CHANGES — so for THIS runbook the harness is committed at `scripts/spike-deploy.mjs` (this PR) — use the tracked file.

REPO-STATE FACTS that shape the spike:
- doc 03 M1 ALREADY landed: PROTOCOL_VERSION=1 (packages/shared/src/protocol.ts:28) and GAME_VERSION="0.1.0" (packages/shared/src/version.ts) both exist.
- BUT /api/server-info route does NOT exist yet (worker.ts routes /api/health only; only a TODO reference in apps/prober/src/index.ts:32). So the WS-load measurement and any deploy-verify in the spike must target /api/health, not /api/server-info. The doc's §5-step-8 verify poll of /api/server-info is a FUTURE-state assertion (doc 03 M2) — for M1, poll /api/health.
- The spike deploys a SCRATCH copy of the game worker; script name is arbitrary, so use a guard-prefixed throwaway like "spike-worldspring-<rand>" (NOT a name a future real deploy would want).

LIVE-DOC RE-VERIFICATION (done in this session against current public CF docs, no live account touched): the OAuth endpoints (dash.cloudflare.com /oauth2/auth, /oauth2/token, /oauth2/revoke, /oauth2/userinfo, /.well-known/openid-configuration), the POST /accounts/{id}/oauth_clients create body shape (client_name, grant_types, redirect_uris, response_types, scopes, token_endpoint_auth_method + optional logo_uri/client_uri/policy_uri/tos_uri; response has client_id, client_secret once-only, client_uri_verification{status,text}), GET /oauth/scopes returning {id,name,category,scopes} entries, and the multipart metadata fields (main_module, compatibility_date, bindings, migrations, assets{jwt,config}, tags, annotations; DO binding needs type/name/class_name) ALL match the research dated 2026-06-11. Two things I could NOT confirm in current docs and that remain genuinely UNCONFIRMED: (a) any worked authorization-request param example (still absent — RFC-6749 assumed), and (b) keep_bindings — it appears in NEITHER the Script Upload method reference NOR the multipart-upload-metadata page (only keep_assets is documented). The whole §7 update-token-rotation obligation leans on keep_bindings:["secret_text"]; that this field may not exist in the raw multipart API is now a first-order spike risk, not a footnote.

The spike is read-mostly on OAuth (one client created+deleted) and write-heavy on Workers (create/PUT/re-PUT/delete a scratch script) — all on a BRAND-NEW FREE scratch account that is NOT Adam's main account, so nothing real is at risk. The client itself can be created on Adam's main account (private visibility) OR on the scratch account; private-visibility clients only authorize members of the creating account, so create the client on whichever account will hold the membership doing the consent. Simplest: create the client on the scratch account and consent as the scratch account's own user — fully self-contained.

## UNCONFIRMED behaviors to burn down

### U1-oauth-scope-ids

**Claim:** The exact OAuth scope ID for Workers script WRITE (script upload, assets-upload-session, migrations, subdomain enable) is unknown. Research confirms only account.read and workers-platform.read exist by name; a .write sibling (e.g. workers-platform.write) is a GUESS. Also unknown: whether one coarse workers-platform.write bundles scripts+subdomain or whether per-product scopes exist, and which scope gates GET /accounts for account discovery (account.read is the likely-but-unverified candidate).

**How to confirm:** GET https://api.cloudflare.com/client/v4/oauth/scopes with any API token (Authorization: Bearer). Endpoint confirmed live this session: needs auth, no role requirement, returns {id,name,category,scopes} entries, paginate (result_info total ~2000). grep the result for 'worker' and 'account'. Pin the smallest set of ids that, when registered on the client and granted, lets the script PUT + subdomain calls succeed. Confirm empirically by deploying with ONLY those scopes on the token. Record the exact ids in docs/plans/research/cf-oauth.md §3 and §10.

### U2-accounts-discovery

**Claim:** How the site learns which account(s) the user granted after consent is unconfirmed. The likely mechanism is GET /accounts with the access token returning exactly the granted accounts (this is how wrangler does it), but userinfo only documents the sub claim, so this is high-confidence-but-unverified.

**How to confirm:** After the token exchange, GET https://api.cloudflare.com/client/v4/accounts with Authorization: Bearer <access_token>. Confirm it returns the scratch account and nothing the user did not grant. Also GET /oauth2/userinfo and record exactly which claims come back (research says sub only). Record in cf-oauth.md §5/§10.

### U3-authz-request-params

**Claim:** No worked example of the /oauth2/auth authorization-request URL exists in CF docs (re-confirmed absent this session). Whether offline_access must be passed explicitly in scope for a refresh token, and the exact param set CF honors, is assumed-RFC-6749 but unverified. (Worldspring chose NO refresh token, so offline_access is moot for the product, but the auth-request param shape still needs confirming for the code path.)

**How to confirm:** Build the auth URL with response_type=code, client_id, redirect_uri (exact-match registered), scope=<space-joined ids>, state, code_challenge, code_challenge_method=S256. Open it in a browser as the scratch user, complete consent, and confirm the callback returns ?code&state. Note any param CF rejects or ignores. Record the working URL shape in cf-oauth.md §1/§10.

### U4-token-shape-lifetime

**Claim:** Access-token lifetime and the exact token-response shape are undocumented. Worldspring's whole ephemeral-token security model (no token survives ~1h) assumes a short expires_in; the design also asserts already-authorized apps re-consent fast / CF may skip the consent screen on re-auth — both UNCONFIRMED.

**How to confirm:** POST https://dash.cloudflare.com/oauth2/token with Basic auth (client_id:client_secret), grant_type=authorization_code, code, redirect_uri, code_verifier. Record verbatim: access_token presence, expires_in (the only runtime source of truth), token_type, id_token presence (because openid), scope echoed, and whether refresh_token is absent (it must be, since the client omits the refresh_token grant). Then immediately re-run /login as the same already-consented user and record whether CF re-shows the consent screen or bounces straight back (settles the 'one-click update' soft-promise in §6). Record in cf-oauth.md §4/§10.

### U5-subdomain-get-empty-and-conflict

**Claim:** GET /accounts/{id}/workers/subdomain response on a NEVER-registered account, and the error code/shape for a taken subdomain name on PUT, are unconfirmed. The Deployer DO's ensure-subdomain step (§5 step 3) pauses with needs:'subdomain-name' based on these shapes.

**How to confirm:** On the FRESH scratch account: GET /accounts/{id}/workers/subdomain before registering — record status code and body (does result.subdomain come back null / 404 / empty?). Then PUT a deliberately-common name to force a conflict and record the error code (10000-series?) and message. Then PUT a unique name and confirm success. Record both shapes in cf-deploy.md §2.5 and §10.3.

### U6-subdomain-default-enabled

**Claim:** The default enabled state of the workers.dev route for a script created via the raw multipart PUT is unconfirmed. The design POSTs enabled:true unconditionally rather than trusting a default (§5 step 7).

**How to confirm:** Immediately after the first script PUT (before calling the per-script subdomain POST), GET /accounts/{id}/workers/scripts/{name}/subdomain and record whether enabled is true or false by default. Then POST {enabled:true, previews_enabled:false} and confirm the URL becomes reachable. Record in cf-deploy.md §2.5/§10 item 4.

### U7-tags-roundtrip

**Claim:** Whether the tags array set on a raw-API multipart upload ROUND-TRIPS on a subsequent GET of the script is unconfirmed. The clobber-guard in §5 step 2 (require tags to include 'worldspring' before treating an existing script as ours) depends on tags surviving; the documented fallback is a GET /api/server-info probe.

**How to confirm:** On the script PUT, set tags:['worldspring','spike-vTEST']. Then GET /accounts/{id}/workers/scripts/{name} (and/or the script list / a tags subresource) and record whether the tags come back. If tags do NOT round-trip on the raw API, the design must rely on the route-probe fallback — note that explicitly. Record in cf-deploy.md §2.4/§10.

### U8-migrations-omit-on-update

**Claim:** Re-uploading the SAME worker with the migrations field OMITTED, on a worker whose migration_tag is already v1, is expected to succeed and preserve the tag (wrangler's behavior) but is NOT doc-confirmed for the raw multipart API. The update path (§7) omits migrations when the artifact's latest tag equals the worker's current tag.

**How to confirm:** After the first PUT (which sent migrations:{new_tag:'v1',new_sqlite_classes:['GameRoom']}), do a second identical PUT with the migrations field entirely absent. Record: does it 200? Does the response migration_tag stay 'v1'? Does the DO keep working? Then ALSO test a blind retry hazard: re-send the SAME migrations:{new_tag:'v1',...} against the already-v1 worker and record whether CF rejects it (old_tag mismatch) or accepts it idempotently. Record both in cf-deploy.md §2.4 and §10 item 5.

### U9-force-delete-do

**Claim:** The exact param and behavior of DELETE /accounts/{id}/workers/scripts/{name}?force=true for a script that owns a DO namespace — specifically that force is required AND that it destroys the DO SQLite storage (the world) — is unconfirmed against the current API.

**How to confirm:** DELETE /accounts/{id}/workers/scripts/{name} WITHOUT force and record the error (does it refuse because of the DO namespace?). Then DELETE with ?force=true and record success. Confirm the worker is gone from the account and (best-effort) that re-creating the same name starts with empty DO storage. Record in cf-deploy.md §8/§10. (This is also the spike's cleanup step — do it last.)

### U10-keep-bindings-secret-text

**Claim:** keep_bindings:['secret_text'] semantics are the single most load-bearing UNCONFIRMED for the update path (§7) — AND this session could not find keep_bindings documented in EITHER the Script Upload method reference OR the multipart-upload-metadata page (only keep_assets is documented). Two sub-questions: (a) does keep_bindings even exist on the raw multipart PUT? (b) if it does, when you keep secret_text AND also explicitly re-send a secret_text of the SAME name (the rotated DIRECTORY_TOKEN), does the explicit value win? And do operator-set secrets (doc 02's ADMIN_TOKEN, set via wrangler secret put) survive a PUT that keeps secret_text?

**How to confirm:** Sequence on the scratch worker: (1) PUT with a secret_text binding DIRECTORY_TOKEN=old + a plain binding. (2) Out-of-band, set a second secret as an operator would: wrangler secret put ADMIN_TOKEN -c apps/game/wrangler.jsonc (or POST /accounts/{id}/workers/scripts/{name}/secrets). (3) Re-PUT the worker re-sending ONLY the worldspring bindings PLUS keep_bindings:['secret_text'] PLUS an explicit DIRECTORY_TOKEN=new. Record: does the PUT accept keep_bindings at all (if it errors/ignores, that itself is the finding — rotation must then move to explicit delete-then-set)? Does ADMIN_TOKEN survive? Does DIRECTORY_TOKEN end up old or new? Verify final binding set via GET /accounts/{id}/workers/scripts/{name}/settings (or the bindings subresource). Record decisively in cf-deploy.md §8.1/§10; if explicit values do NOT win, document the delete-then-set fallback the design names.

### U11-ws-invocation-log-volume

**Claim:** Whether each inbound webSocketMessage on a pinned GameRoom DO emits an invocation log under observability — the one number that swings the unsampled worst case between ~$0 and ~$944/mo (doc 01 §4.3) and gates the 'no surprise bills' cost copy in M6. cf-costs.md's scenario tables never model Workers Logs at all.

**How to confirm:** Deploy a scratch copy of the GAME worker with observability.enabled:true and NO head_sampling_rate (the repo default at apps/game/wrangler.jsonc — i.e. 100% sampling). Hold ONE real WebSocket session (a browser tab OR one bot from apps/game/scripts/loadtest.mjs pointed at wss://<scratch>.<sub>.workers.dev/ws) for ~10 minutes. In the Cloudflare dashboard (Workers > the worker > Observability/Logs), read 'Log Events Written' over that window. Divide by (session minutes x ~20.5 inbound msgs/s x 60) to get logs-per-inbound-message. Record the measured rate and the implied 30-slot-24/7 monthly event count in docs/plans/research/cf-costs.md (new line) and re-flag doc 01 §4.3. NOTE: target /ws + /api/health; /api/server-info does NOT exist yet.

## API steps

### 0. Enumerate OAuth scopes and pin the Workers write scope ID (resolves U1, the biggest blocker)

```text
GET https://api.cloudflare.com/client/v4/oauth/scopes  (Authorization: Bearer <scratch-account API token>)
```

Confirmed live this session: requires auth, no role requirement, returns paginated {id,name,category,scopes}. grep for 'worker' and 'account'. Pick the minimal write scope id (research guess: workers-platform.write) and the account-read id (account.read confirmed to exist). Everything downstream uses these ids. Per research/cf-oauth.md §3.

### 1. Create a PRIVATE confidential OAuth client on the scratch account

```text
POST https://api.cloudflare.com/client/v4/accounts/{scratch_account_id}/oauth_clients  (Bearer token needs 'OAuth Clients Write' permission)
```

Body (shape confirmed live this session): {client_name:'Worldspring M1 Spike', grant_types:['authorization_code'], redirect_uris:['http://localhost:8788/oauth/callback'], response_types:['code'], token_endpoint_auth_method:'client_secret_basic', scopes:['openid', <account-read-id>, <workers-write-id>]}. NO refresh_token grant (deliberate, doc §6 — adding it later is a PATCH). visibility starts private automatically (do NOT promote — promotion is permanent and needs DNS TXT on a custom domain, impossible here). Response returns client_id and client_secret ONCE — capture both immediately. Whether localhost redirect URIs are accepted is itself UNCONFIRMED (cf-oauth.md §6) — if rejected, fall back to a deployed callback or a 127.0.0.1 variant and record the rule. Per doc 01 §2.

### 2. Authorization request -> consent -> capture code (manual browser step; resolves U3)

```text
GET https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=<id>&redirect_uri=http%3A%2F%2Flocalhost%3A8788%2Foauth%2Fcallback&scope=openid%20<account-read>%20<workers-write>&state=<nonce>&code_challenge=<S256>&code_challenge_method=S256
```

No documented worked example (re-confirmed absent this session) — params are RFC-6749/7636 assumed. Generate code_verifier (43-128 chars) + code_challenge=base64url(sha256(verifier)). Open URL in a browser logged in as the scratch user, authorize, and read code+state off the localhost callback (the skeleton runs a tiny one-shot http listener on :8788, OR just copy the code from the redirected URL bar). Record exactly which params CF honored. Per doc 01 §2 step 1-3.

### 3. Token exchange (resolves U4)

```text
POST https://dash.cloudflare.com/oauth2/token  (Authorization: Basic base64(client_id:client_secret); body application/x-www-form-urlencoded: grant_type=authorization_code, code=<code>, redirect_uri=<exact-match>, code_verifier=<verifier>)
```

Confirmed live: token endpoint accepts client_secret_basic. Record verbatim: access_token, expires_in (only runtime truth for the ephemeral model), token_type, id_token (present because openid), and that refresh_token is ABSENT. Decode id_token and confirm sub is the only claim. Per doc 01 §2 step 3-4. THEN immediately re-run step 2 as the same consented user to settle whether CF re-prompts consent (the §6 'fast re-consent' assumption).

### 4. Account discovery (resolves U2)

```text
GET https://api.cloudflare.com/client/v4/accounts  (Authorization: Bearer <access_token>)
```

Confirm it returns exactly the granted scratch account. Also GET https://dash.cloudflare.com/oauth2/userinfo and record claims (expect sub only). All subsequent Workers calls use account_id from here + the access_token. Per doc 01 §2 step 5; cf-oauth.md §5.

### 5. Pre-check existing script name + read migration_tag (exercises U7 clobber guard)

```text
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{spike-name}  (Bearer access_token)
```

Expect 404 on a fresh name -> fresh create. (After step 8 you re-GET this to check whether tags['worldspring',...] round-trip — U7 — and whether migration_tag is readable for update chaining.) Per doc 01 §5 step 2; cf-deploy.md §2.4.

### 6. Ensure account workers.dev subdomain (resolves U5)

```text
GET then PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/subdomain  (Bearer access_token; PUT body {subdomain:'<unique>'})
```

FRESH accounts have none. Record the GET-on-empty shape (404? null?). Force a conflict with a common name, record the error code/message, then PUT a unique name. Final URLs become https://<spike-name>.<subdomain>.workers.dev. Per doc 01 §5 step 3; cf-deploy.md §2.5/§10.3.

### 7. Asset upload session + bucket upload

```text
POST .../workers/scripts/{spike-name}/assets-upload-session (Bearer access_token, body {manifest:{'/path':{hash,size},...}})  THEN  POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/assets/upload?base64=true (Bearer SESSION-JWT, multipart, part name=file hash, body=base64, per-part Content-Type)
```

Hash algorithm (confirmed in cf-deploy.md §2.2): first 32 hex of sha256(base64(fileContents)+extensionWithoutDot). Manifest keys are /-prefixed paths under dist/client. Session response {jwt, buckets}; empty buckets => jwt is already the completion token, skip the upload POST. Both JWTs live 1h. For the spike you can shortcut by deploying the worker WITHOUT assets first (assets are optional to prove the DO+migration+subdomain+logs path) — but at least one full asset round-trip should be exercised to validate the hash algo. Per doc 01 §5 steps 4-5; cf-deploy.md §2.2-2.3.

### 8. Multipart script PUT — the actual deploy (resolves U6 default, exercises U7 tags)

```text
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{spike-name}  (Bearer access_token; multipart/form-data: part 'metadata' application/json + part 'index.js' application/javascript+module filename=index.js)
```

metadata (fields confirmed live): {main_module:'index.js', compatibility_date:'2026-06-01', bindings:[{type:'durable_object_namespace',name:'GAME',class_name:'GameRoom'},{type:'plain_text',name:'SERVER_NAME',text:'spike'},{type:'secret_text',name:'DIRECTORY_TOKEN',text:'<old>'}], migrations:{new_tag:'v1',new_sqlite_classes:['GameRoom']}, observability:{enabled:true}, tags:['worldspring','spike-vTEST'], annotations:{'workers/message':'spike'}}. For the U11 LOGS measurement deploy use observability.enabled:true and OMIT head_sampling_rate (100% default). Assert response: named_handlers contains {name:'GameRoom'}, migration_tag=='v1', has_assets reflects whether you sent assets. This single call creates the version AND deploys to 100%. Per doc 01 §5 step 6; cf-deploy.md §2.4.

### 9. Enable the per-script workers.dev route (resolves U6)

```text
GET (record default enabled) THEN POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{spike-name}/subdomain  (Bearer access_token; POST body {enabled:true, previews_enabled:false})
```

GET first to record whether enabled defaults true/false for a raw-API script (U6). Then POST enabled:true regardless. URL https://<spike-name>.<subdomain>.workers.dev should now serve. Per doc 01 §5 step 7; cf-deploy.md §2.5.

### 10. Verify the deploy is live (M1-appropriate target)

```text
GET https://<spike-name>.<subdomain>.workers.dev/api/health  (no auth — public worker route)
```

IMPORTANT: poll /api/health, NOT /api/server-info — the server-info route does NOT exist in the tree yet (doc 03 M2 not landed). /api/health is what worker.ts routes today (apps/game/src/server/worker.ts) and what loadtest.mjs already reads. A 200 with the health stats payload proves the DO booted. Per doc 01 §5 step 8 (adapted for current tree).

### 11. WORKERS-LOGS WS MEASUREMENT (resolves U11) — the headline number

```text
Open wss://<spike-name>.<subdomain>.workers.dev/ws from ONE client (browser tab or one loadtest bot: node apps/game/scripts/loadtest.mjs wss://<spike-name>.<subdomain>.workers.dev/ws 1 600) for ~10 min, then read 'Log Events Written' in the dashboard Observability panel.
```

Worker MUST be the observability.enabled:true + NO head_sampling_rate build (step 8). Compute logs-per-inbound-message = events / (minutes x ~20.5 x 60). This settles whether webSocketMessage emits per-message invocation logs and thus the ~$0-vs-$944/mo swing in doc 01 §4.3. Record in cf-costs.md. (loadtest.mjs is the cheapest single-bot driver; it already speaks the protocol and reads /api/health.)

### 12. Update-path tests (resolve U8 + U10) — the migration & keep_bindings burn-down

```text
Re-PUT the same worker three ways: (a) migrations field OMITTED; (b) migrations re-sent identical {new_tag:'v1'}; (c) re-send only worldspring bindings + keep_bindings:['secret_text'] + explicit DIRECTORY_TOKEN=new, after having set ADMIN_TOKEN out-of-band via the secrets endpoint.
```

(a)+(b) resolve U8 (omit-on-update succeeds & preserves tag? identical-migration re-send rejected or idempotent?). (c) resolves U10 — CRITICAL because keep_bindings was NOT found in current Script Upload OR multipart-metadata docs this session: first confirm the field is even accepted; then confirm ADMIN_TOKEN survives and whether explicit DIRECTORY_TOKEN=new wins over the kept old. Verify final bindings via GET .../workers/scripts/{name}/settings. If keep_bindings is unsupported, document the delete-then-set fallback. Per doc 01 §7; cf-deploy.md §8.1/§10.

### 13. Cleanup / force-delete (resolves U9) — ALWAYS run last

```text
DELETE https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{spike-name}?force=true  (Bearer access_token).  THEN DELETE https://api.cloudflare.com/client/v4/accounts/{adam_or_scratch_account_id}/oauth_clients/{client_id} to remove the spike OAuth client.
```

First DELETE WITHOUT force to record the refusal-because-of-DO behavior, then with ?force=true. Confirm the worker disappears from the dashboard. Then delete the OAuth client (it was private/throwaway). Optionally revoke the access token via POST https://dash.cloudflare.com/oauth2/revoke (shape RFC-7009 assumed, UNCONFIRMED). Per doc 01 §8; cf-deploy.md §8/§10.

## Credentials needed

- A BRAND-NEW, THROWAWAY Cloudflare account on the Workers FREE plan to be the deploy target (the 'scratch account'). Must be separate from Adam's real worldspring account so the create/PUT/force-delete cycle and the world-destroying force-delete touch nothing real. Sign up fresh; do NOT register a workers.dev subdomain in advance (the spike must observe the GET-on-empty + PUT-conflict shapes — U5).
- An API token ON THE SCRATCH ACCOUNT with 'OAuth Clients Write' permission (to create the spike OAuth client via POST /accounts/{id}/oauth_clients) and broad enough to also run GET /oauth/scopes (any authenticated token works for scopes). Simplest: an 'Edit Cloudflare Workers' template token PLUS OAuth Clients Write on the scratch account. This bootstraps client creation; the ACTUAL deploy calls use the OAuth access_token, not this token.
- The OAuth client_id and client_secret minted at step 1 — the secret is shown ONCE at creation; capture it immediately into an env var / paste buffer. token_endpoint_auth_method is client_secret_basic.
- The minimal OAuth SCOPE IDs resolved at step 0: the Workers-write scope (research guess workers-platform.write — must be confirmed from GET /oauth/scopes) and account.read (confirmed to exist). Register exactly these (plus openid) on the client; grant exactly these at consent. No D1/KV/zone scopes — the deploy needs none.
- The scratch account_id — discovered post-OAuth via GET /accounts with the access token (U2). Do not hardcode it before confirming discovery works.
- Node 22+ locally (the skeleton uses the built-in global WebSocket and fetch — zero npm deps, same baseline as apps/game/scripts/loadtest.mjs). A browser to complete the one manual consent click.
- The built worker artifact: run `pnpm --filter @worldspring/game build` (or `pnpm deploy:game`'s build half) FIRST so dist/survival_game/index.js and dist/client/** are FRESH — the dist/ currently in the tree is a stale Jun-11 build whose generated wrangler.json still says name 'survival-game'. The skeleton reads dist/survival_game/index.js and (optionally) dist/client/** + the manifest.
- NO custom domain and NO public-visibility promotion are needed or wanted for M1. Public promotion is permanent and requires DNS TXT verification on a real domain (cf-oauth.md §6) — explicitly out of scope; keep the client private.

## Manual steps (Adam runs these)

1. Create the throwaway scratch Cloudflare account (free plan). Do NOT pre-create its workers.dev subdomain. Confirm Workers is enabled enough to accept an API script PUT (one of the spike's own open questions — cf-deploy.md §7 — is whether a brand-new account needs any dashboard-side Workers onboarding first; if step 8 fails with an onboarding error, click into Workers once in the dashboard and retry, and RECORD that requirement).

2. On the scratch account, create the bootstrap API token (Edit Cloudflare Workers template + OAuth Clients Write). Copy it.

3. Build fresh artifacts from the primary checkout: `cd "$(git rev-parse --show-toplevel)" && pnpm --filter @worldspring/game build`. Verify dist/survival_game/index.js exists (~34 KB gzip) and dist/client/** has ~60 files.

4. Use the committed `scripts/spike-deploy.mjs` (this PR — do not run an untracked local copy). Fill the CONFIG block: BOOTSTRAP_TOKEN, and after step 0 the SCOPE_IDS, and after step 1 the CLIENT_ID/CLIENT_SECRET.

5. Run phase 0 (`node scripts/spike-deploy.mjs scopes`) to dump the scope list; pick and pin the Workers-write + account-read ids into CONFIG.

6. Run phase 1 (`node scripts/spike-deploy.mjs create-client`) to mint the private client; paste client_id/client_secret into CONFIG.

7. Run phase 2 (`node scripts/spike-deploy.mjs login`): the script prints the /oauth2/auth URL and starts a one-shot localhost:8788 listener. Open the URL in a browser logged in as the SCRATCH user, click Authorize, let the callback hit localhost; the script captures code+state and does the token exchange. Re-run login once more to observe whether consent is re-prompted (U4).

8. Run phase 3 (`node scripts/spike-deploy.mjs deploy`): drives account-discovery -> subdomain GET/PUT -> (optional asset round-trip) -> script PUT (with observability.enabled and NO sampling) -> per-script subdomain enable -> /api/health verify. Capture every response shape it logs (U5/U6/U7/U8 partial).

9. MANUAL MEASUREMENT (U11): with the worker live, run `node apps/game/scripts/loadtest.mjs wss://<spike-name>.<subdomain>.workers.dev/ws 1 600` (one bot, 10 min) OR just open a browser tab to the worker URL and play for 10 min. Then in the scratch account dashboard go to Workers > <worker> > Observability and read 'Log Events Written'. Record the number and compute logs-per-inbound-message. THIS is the headline cost finding.

10. Run phase 4 (`node scripts/spike-deploy.mjs update-tests`): re-PUT with migrations omitted, re-PUT with identical migrations, and the keep_bindings test (after setting ADMIN_TOKEN out-of-band: `wrangler secret put ADMIN_TOKEN -c apps/game/wrangler.jsonc` against the scratch account, or via the secrets API). Record whether keep_bindings is even accepted (it was NOT visible in current CF docs this session) and the binding-survival outcomes (U8/U10).

11. Run phase 5 (`node scripts/spike-deploy.mjs cleanup`): force-delete the worker (first without force to see the refusal, then ?force=true — U9), then delete the OAuth client. Confirm both are gone in the dashboard.

12. ACCEPTANCE / write-up: edit docs/plans/research/cf-oauth.md §3,§4,§5,§10 and docs/plans/research/cf-deploy.md §2.4,§2.5,§8,§10 IN PLACE with the findings; add the measured WS invocation-log rate to docs/plans/research/cf-costs.md; then go through docs/plans/01-create-server-deploy.md and resolve-or-re-flag every UNCONFIRMED marker (U1-U11). That doc-update is the milestone's deliverable, per the M1 acceptance criteria.

13. Tear down: delete the scratch Cloudflare account (or at least revoke its tokens) once findings are recorded, so no throwaway credentials linger.

## Risks

- force-delete (U9 / cleanup) DESTROYS the DO SQLite storage — that is intentional but ONLY safe because the target is a throwaway worker on a throwaway account. NEVER point this script at Adam's real worldspring account. The SCRIPT_NAME is guard-prefixed 'spike-worldspring-<rand>' precisely so it can never collide with a real future deploy name.
- Public-visibility promotion of the OAuth client is PERMANENT and freezes the verified domain (cf-oauth.md §6). The skeleton deliberately leaves the client private and never PATCHes visibility. Do not promote the spike client; if a real public client is ever needed, mint a fresh one on the custom domain at launch (doc 01 M9).
- The OAuth scope IDs are the biggest unknown (U1) and everything downstream depends on them. If phase `scopes` does not surface an obvious Workers-write id, the deploy will 403 — over-granting on the throwaway client to unblock is acceptable for the spike, but the milestone deliverable is the MINIMAL working set, so narrow it back down and re-test before recording.
- keep_bindings may not exist on the raw multipart PUT at all — it was absent from both the Script Upload method reference and the multipart-upload-metadata doc when checked this session. The §7 update design (token rotation + preserving operator ADMIN_TOKEN) is built on it. If the U10 test shows keep_bindings is rejected or ignored, the whole update-path binding story needs the delete-then-set fallback; treat a negative result here as a real design input, not a script bug.
- The verify/measurement target is /api/health, NOT /api/server-info — the server-info route is doc 03 M2 and is NOT in the tree (only PROTOCOL_VERSION + GAME_VERSION constants landed). If you copy the doc's §5-step-8 poll verbatim it will 404-loop. Re-confirm against worker.ts before assuming any route exists.
- The dist/ artifacts currently in the checkout are a STALE Jun-11 build (generated wrangler.json still says name 'survival-game'). Deploying that stale bundle is fine for the spike's purposes, but rebuild with `pnpm --filter @worldspring/game build` first so index.js + the asset manifest match current source — otherwise the asset hashes and bundle won't reflect HEAD.
- Brand-new free accounts may require a one-time dashboard Workers onboarding before the first script PUT succeeds (cf-deploy.md §7, itself UNCONFIRMED). If step 8 fails with an onboarding/entitlement error, click into Workers once in the scratch dashboard, retry, and RECORD that this prerequisite exists — it directly affects the Deployer DO's fresh-account UX.
- Authorization-request params and the revoke-endpoint shape are RFC-assumed, not CF-documented (re-confirmed absent this session). If the /oauth2/auth URL is rejected, adjust params empirically and record the working shape — do not assume the skeleton's URL is canonical.
- localhost redirect URIs may not be accepted for self-managed clients (UNCONFIRMED, cf-oauth.md §6). If `create-client` rejects http://localhost:8788/oauth/callback, fall back to a deployed callback or 127.0.0.1 and record the rule — this affects how M4 develops the OAuth flow locally.
- The whole spike runs inside the 1,200 req / 5 min per-user global API limit with enormous headroom (a full deploy is ~6 calls + ~5 MB), so rate limiting is not a practical risk — but note the budget is the USER's, which is why the real Deployer DO serializes one job per account (doc §5).
- Findings are the deliverable. If Adam runs the calls but does not edit docs/plans/research/cf-{oauth,deploy,costs}.md and re-flag the UNCONFIRMED markers in docs/plans/01-create-server-deploy.md, the milestone is not actually complete — the next session will re-inherit the same six unknowns. The acceptance criteria are doc edits, not green API responses.

## Harness

The full zero-dep Node harness is at [`scripts/spike-deploy.mjs`](../../../scripts/spike-deploy.mjs).
Phases (run one at a time, fill the CONFIG block between them):

```bash
node scripts/spike-deploy.mjs scopes        # U1  GET /oauth/scopes
node scripts/spike-deploy.mjs create-client # create the private OAuth client
node scripts/spike-deploy.mjs login         # U3,U4 auth URL + token exchange
node scripts/spike-deploy.mjs deploy        # U2,U5,U6,U7 full deploy sequence
node scripts/spike-deploy.mjs update-tests  # U8,U10 migrations-omit + keep_bindings
node scripts/spike-deploy.mjs cleanup       # U9  force-delete + delete client
```
