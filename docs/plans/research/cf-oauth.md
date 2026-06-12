# Research: Cloudflare Self-Managed OAuth Clients ("Login with Cloudflare")

**Researched:** 2026-06-11 (feature shipped 2026-06-03 — post-training-data; everything below was fetched from live docs/endpoints, not memory).
**Status of claims:** Every claim is tagged with its source URL. Anything not directly stated in docs or observed from a live endpoint is marked **UNCONFIRMED**.

**Naming note:** The official product name in Cloudflare docs is **"self-managed OAuth clients"** / "OAuth Applications on Cloudflare". "Login with Cloudflare" is not a name that appears anywhere in the docs — don't search for it, and don't use it in code comments expecting it to match Cloudflare's terminology.

## Sources (all fetched 2026-06-11)

| Doc | URL |
|---|---|
| Changelog announcement (2026-06-03) | https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/ |
| OAuth overview | https://developers.cloudflare.com/fundamentals/oauth/ |
| Create an OAuth client | https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ |
| Integrate (endpoint list) | https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/ |
| Authorizing an application (user POV) | https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/ |
| OAuth Clients management API | https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/ |
| OAuth Scopes API | https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/ |
| Live OIDC discovery doc | https://dash.cloudflare.com/.well-known/openid-configuration |
| API token permission names (scope mapping) | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ |
| API global rate limits | https://developers.cloudflare.com/fundamentals/api/reference/limits/ |
| Wrangler OAuth precedent (2021, first-party) | https://blog.cloudflare.com/wrangler-oauth/ |

Tip for future sessions: each docs page has a raw-markdown twin at `<page-url>/index.md`, and the section index is at https://developers.cloudflare.com/fundamentals/oauth/llms.txt. Curl those — they're complete and unsummarized.

---

## TL;DR

Cloudflare now lets anyone register OAuth 2.0 clients (dashboard: **Manage Account > OAuth clients**, or API). Users authorize via a consent screen with account selection; the app gets an OAuth **access token scoped like an API token** that calls `api.cloudflare.com` on the user's behalf. Only the **Authorization Code flow** is supported (confidential with client secret, or public with PKCE S256). Refresh tokens are opt-in via `grant_types: ["authorization_code", "refresh_token"]`. Client **visibility** (private = own-account members only, public = any Cloudflare user) is a separate axis from confidential-vs-public **client type**, and going public is permanent and requires DNS TXT domain verification — which means DEADCOAST needs a real custom domain (you cannot put a TXT record under `*.workers.dev`) before any public "deploy your own server" button can exist.

---

## 1. Grant types

Source: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/#supported-oauth-flows and the client API schema at https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/

- **Authorization Code: YES** — the only supported authorization flow. Docs verbatim: "Cloudflare OAuth clients support the OAuth 2.0 Authorization Code flow" and "Cloudflare does not support Client Credentials, Implicit, Resource Owner Password Credentials, Device Authorization, or other OAuth grant types for third-party clients."
- **Device code: NO** for third-party clients (explicitly excluded, above). The OIDC discovery doc does advertise `device_authorization_endpoint: https://dash.cloudflare.com/oauth2/device/auth` — that reflects the shared auth server used by first-party tooling (Wrangler, dashboard), not a capability of self-managed clients. The create-client API enum makes this hard: `grant_types` only accepts `"authorization_code"` and `"refresh_token"`.
- **Client credentials: NO.** There is no app-only token. Every action is on behalf of a user who consented. (Implication for DEADCOAST in §8.)
- **Refresh tokens: YES, opt-in.** Client API schema: `grant_types: array of "authorization_code" or "refresh_token"` — "`authorization_code` is required; `refresh_token` may be included optionally." The schema also says: "Protocol scopes `offline_access` and `openid` are added or removed automatically based on `grant_types` and `response_types`" — i.e. registering with the `refresh_token` grant automatically adds `offline_access` to the client's allowed scopes.
  - **Refresh token lifetime / rotation policy: UNCONFIRMED.** Not documented anywhere in the OAuth section. The Wrangler OAuth blog (first-party precedent) says access tokens are "short-lived" and that using a refresh token "invalidates the previous access token", but gives no numbers and predates this feature. Treat `expires_in` from the token response as the only source of truth at runtime; assume refresh tokens may rotate on use (store the new one returned by each refresh).
- **PKCE:**
  - Public clients (`token_endpoint_auth_method: "none"` — browser/mobile/desktop/CLI): PKCE **required, S256** (docs table, create-an-oauth-client page).
  - Confidential clients (server-side, with client secret): PKCE "Optional/not required" (same table). Use it anyway; it's cheap.
  - Live discovery doc lists `code_challenge_methods_supported: ["plain", "S256"]` — only use S256; the docs only ever mention S256.
- **Response types:** client API enum is `"code" | "id_token" | "token"`, but given the flow restriction above, register `response_types: ["code"]`. (`id_token`/`token` exist in the schema presumably for OIDC hybrid; docs never describe using them — **UNCONFIRMED** whether they work for third-party clients, don't rely on them.)
- **`token_endpoint_auth_method`:** `"client_secret_basic"`, `"client_secret_post"`, or `"none"` (client API enum). Discovery doc also advertises `private_key_jwt` but the client-registration schema does not accept it — **not available** to self-managed clients.

### OAuth endpoints (verbatim from https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)

| Purpose | URL |
|---|---|
| Authorization | `https://dash.cloudflare.com/oauth2/auth` |
| Token | `https://dash.cloudflare.com/oauth2/token` |
| Revoke | `https://dash.cloudflare.com/oauth2/revoke` |
| Session logout | `https://dash.cloudflare.com/oauth2/logout` (discovery doc says `end_session_endpoint` is `https://dash.cloudflare.com/oauth2/sessions/logout` — minor discrepancy, verify at implementation time) |
| User info | `https://dash.cloudflare.com/oauth2/userinfo` |
| JWKS | `https://dash.cloudflare.com/.well-known/jwks.json` |
| OIDC discovery | `https://dash.cloudflare.com/.well-known/openid-configuration` |

Both `/oauth2/auth` and `/oauth2/token` were probed live on 2026-06-11 and respond with standard RFC 6749 behavior (auth endpoint 302s; token endpoint returns `{"error":"invalid_request", "error_description":"...Client credentials missing or malformed in both HTTP Authorization header and HTTP POST body."}` — i.e. it accepts client auth via Basic header or POST body, matching `client_secret_basic`/`client_secret_post`).

**Authorization request parameters: UNCONFIRMED in docs.** No worked example exists in the Cloudflare docs. The changelog says to "include that scope list when sending users to Cloudflare for consent". Everything else is standard RFC 6749/7636: `response_type=code`, `client_id`, `redirect_uri`, `scope` (space-separated scope IDs, plus `offline_access` if you want a refresh token — the offline_access-in-request detail is standard OIDC practice but **UNCONFIRMED** for Cloudflare specifically), `state`, `code_challenge`, `code_challenge_method=S256`. Budget a spike to confirm exact behavior.

---

## 2. Visibility vs. confidentiality — two different axes, don't conflate

Source: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/#private-and-public-clients

**Axis 1 — Visibility (`visibility: "private" | "public"`)**: WHO may authorize the app.
- `private` (default): "Private clients can only be authorized by members of the parent Cloudflare account."
- `public`: "allow authorization from any Cloudflare user." Prerequisites before promotion: required fields (client name, **logo**, **client URL**, scopes) plus **domain ownership verification** of the client URL (§6).
- Promotion is via dashboard (**Change Visibility** action menu) or `PATCH /accounts/$ACCOUNT_ID/oauth_clients/$CLIENT_ID` with body `{ "visibility": "public" }`.
- **Promotion is PERMANENT** — docs warning verbatim: "Setting a client's visibility to public is permanent. You cannot change the visibility back to private." Use throwaway clients for experiments.

**Axis 2 — Client confidentiality (`token_endpoint_auth_method`)**: whether the client holds a secret.
- Confidential: `client_secret_basic` or `client_secret_post` — server-side apps that can protect a secret. "Cloudflare displays the client secret if the client requires one. ... You cannot view the secret again after you leave the page. If you lose the secret, rotate it."
- Public (OAuth sense): `none` + mandatory PKCE S256 — SPA/mobile/desktop/CLI.

All four combinations are valid: e.g. a `private`-visibility confidential client (internal tool), or a `public`-visibility PKCE client (a CLI anyone can use, like Wrangler).

---

## 3. Scopes and mapping to API token permissions

Sources: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/#select-scopes, https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/

- Docs verbatim: "OAuth scope names correspond to Cloudflare API token permission names. Use the Cloudflare API documentation to identify the permissions your client needs." Permission name reference: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- **Scope ID format:** dot-delimited, lowercase, e.g. `account.read` (API doc example: `{ "id": "account.read", "name": "Account Read", "category": "account_and_billing", "scopes": ["com.cloudflare.api.account"] }`) and `workers-platform.read` (used in the docs' create-client example payload). The `scopes` array inside each entry is the underlying "Bach scopes" (Cloudflare's internal authz resource identifiers).
- **Colon-delimited scopes are NOT accepted** (API schema, verbatim: "Colon-delimited scopes are not accepted. Dot-delimited scopes are validated against available OAuth API scopes; simple identity scopes are allowed."). The colon style (`account:read`, `workers_scripts:write`, `d1:write`) is Wrangler's *first-party* scope dialect — do not copy scope names from Wrangler docs/source into a self-managed client.
- **Enumerate the real list:** `GET https://api.cloudflare.com/client/v4/oauth/scopes` with any API token — "requires authentication but has no authorization role requirements" (API doc). Unauthenticated calls fail with code 9106 (verified live). The example `result_info` in docs shows `total_count: 2000`, suggesting a long list — paginate.
- Protocol scopes `openid` and `offline_access` are managed automatically based on `response_types`/`grant_types` (see §1). The discovery doc's `scopes_supported` (`offline_access`, `offline`, `openid`) only lists these protocol scopes, not the API scopes — ignore it for scope discovery.

### Scopes DEADCOAST would need (deploy-into-user-account flow)

**Exact OAuth scope IDs are UNCONFIRMED** — the docs only name `account.read` and `workers-platform.read`. The first implementation step is one authenticated `GET /client/v4/oauth/scopes` call and a grep. What we need in API-token-permission terms (the documented mapping basis):

| Capability | API token permission (documented) | Likely OAuth scope | Confidence |
|---|---|---|---|
| Upload/deploy Worker script | Workers Scripts Write (account-scoped) | `workers-platform.write` or similar — `workers-platform.read` is confirmed to exist, so a `.write` sibling is plausible | UNCONFIRMED (guess) |
| Create DO namespaces + run migrations | Same as script upload — DO namespaces/migrations are created as part of the script-upload metadata (`PUT /accounts/{id}/workers/scripts/{name}` multipart with `migrations` field), no separate permission | follows from above | I think (mechanism known from Workers API; scope ID unconfirmed) |
| Enable workers.dev subdomain | Workers Scripts Write covers `PUT /accounts/{id}/workers/subdomain` and per-script `POST .../scripts/{name}/subdomain` | follows from above | I think — verify in spike |
| Create D1 database | D1 Write | `d1.write`? | UNCONFIRMED (guess) |
| Create KV namespace | Workers KV Storage Write | unknown | UNCONFIRMED (guess) |
| List accounts to pick one | Account Settings Read (for `GET /accounts`) | `account.read` | CONFIRMED scope exists; that it gates `GET /accounts` is UNCONFIRMED |
| Read memberships | Memberships Read (for `GET /memberships`, user-scoped) | unknown — note user-scoped permissions may surface differently | UNCONFIRMED |

Whether "workers-platform" is one coarse scope bundling scripts+KV+D1+DO or whether per-product scopes exist: **UNCONFIRMED**. The scope list response has a `category` field, so the picker UI groups them — expect granularity roughly matching API token permission groups.

---

## 4. Token model

- **What you get:** a standard OAuth 2.0 access token (plus refresh token if the client has the `refresh_token` grant and the auth request asked for offline access; plus `id_token` if `openid` was requested). Exchange happens at `POST https://dash.cloudflare.com/oauth2/token`.
- **It is NOT a persistent API-token object.** Nothing in the docs says authorization mints an entry in the user's API Tokens list; instead, grants live on a dedicated page: **profile > Manage OAuth authorizations** (`https://dash.cloudflare.com/?to=/profile/access-management/authorization`). Doc: https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/#view-and-revoke-authorized-applications
- **How to call the API with it:** `Authorization: Bearer <access_token>` against `https://api.cloudflare.com/client/v4/...`. The docs frame the whole feature as accessing "Cloudflare API resources on behalf of users" and the Wrangler precedent (https://blog.cloudflare.com/wrangler-oauth/) confirms OAuth access tokens are used for authorized API calls. The exact header usage is **not literally spelled out in the new docs** — high confidence, but confirm in the first spike.
- **Access token lifetime: UNCONFIRMED.** Not documented. Wrangler blog: "access tokens are short-lived" (historically ~1h for Wrangler — that figure is from memory, treat as UNCONFIRMED). Read `expires_in` from the token response.
- **Refresh:** `POST /oauth2/token` with `grant_type=refresh_token` (standard; the client must have been registered with the `refresh_token` grant). Rotation behavior UNCONFIRMED (§1) — always persist the refresh token returned by each refresh.
- **Revocation:**
  - By the user: "Application authorizations may be viewed and revoked at any time" via the Manage OAuth authorizations page; per-row **Revoke** button.
  - By the app: `POST https://dash.cloudflare.com/oauth2/revoke` (endpoint documented on the integrate page; parameter shape is presumably RFC 7009 `token=` + client auth — **UNCONFIRMED**, not spelled out).
  - By an account admin, prospectively: **Manage Account > Members > Settings > Public OAuth App access** toggle blocks *new* authorizations against that account; docs warning verbatim: "This will not prevent existing authorizations account members may already have in place."
- **Identity ("Login with Cloudflare" as an identity provider):** `openid` scope + `https://dash.cloudflare.com/oauth2/userinfo`. Discovery doc lists `claims_supported: ["sub"]` only — **no email/name claim is documented**. If DEADCOAST wanted Cloudflare login purely for site identity, you'd get a stable opaque subject ID and nothing else (UNCONFIRMED whether userinfo returns more in practice). ID tokens are RS256-signed; keys at the JWKS URL.

---

## 5. Consent UX

Source: https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/

The consent screen shows, verbatim list:
1. **Application name and logo**
2. **Publisher domain** — "The verified domain of the application publisher"
3. **Account selection** — "Choose which Cloudflare account(s) the application can access". Plural is the docs' wording: a user with multiple accounts picks which one(s) to grant. Accounts whose admins disabled "Public OAuth App access" don't appear ("If an account is not available for selection during the consent flow, it may be due to an administrator of that account disabling access to account resources via OAuth").
4. **Requested permissions** — shown *after* account selection; user reviews scopes then clicks **"Authorize"**.

- **Verified badge:** after domain verification, "users see a verified badge on the consent page" (changelog).
- **How your app learns which account(s) the user granted: UNCONFIRMED.** Userinfo only exposes `sub`. Most likely you call `GET /client/v4/accounts` with the access token and it returns exactly the granted accounts (this is how Wrangler discovers accounts). Spike item #1.

---

## 6. Registration: requirements, fields, limits

Source: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ and https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/

- **Who can register:** account role Super Administrator, Administrator, or **OAuth Client Write**. Via API: a token with the **`OAuth Clients Write`** permission.
- **Dashboard:** Manage Account > OAuth clients > Create client (deep link `https://dash.cloudflare.com/?to=/:account/oauth-clients`).
- **API — full CRUD (all under `https://api.cloudflare.com/client/v4`):**
  - `GET  /accounts/{account_id}/oauth_clients` — list
  - `POST /accounts/{account_id}/oauth_clients` — create
  - `GET  /accounts/{account_id}/oauth_clients/{oauth_client_id}` — details
  - `PATCH /accounts/{account_id}/oauth_clients/{oauth_client_id}` — update (also: promote visibility, restart domain verification)
  - `DELETE /accounts/{account_id}/oauth_clients/{oauth_client_id}` — delete
  - `POST /accounts/{account_id}/oauth_clients/{oauth_client_id}/rotate_secret` — mint second secret
  - `DELETE /accounts/{account_id}/oauth_clients/{oauth_client_id}/rotate_secret` — drop old secret
  - `GET /oauth/scopes` — list available scopes (any authenticated token)
- **Create body — required:** `client_name`, `grant_types`, `redirect_uris`, `scopes`, `response_types`, `token_endpoint_auth_method`. **Optional:** `post_logout_redirect_uris`, `logo_uri`, `policy_uri`, `tos_uri`, `client_uri`, `allowed_cors_origins`.
- **Secrets:** shown once at creation (if auth method needs one). Rotation model: each client can hold **two secrets simultaneously**; create new → deploy it → delete old. `has_rotated_secret: true` in GET means a rotation is in flight.
- **Redirect URI rules: UNCONFIRMED.** Docs say only "Array of allowed redirect URIs" with an `https://example.com/oauth/callback` example. No documented stance on `http://localhost`, custom schemes, wildcards, or max count. (Wrangler's first-party client uses `http://localhost:8976/oauth/callback`, so localhost redirects exist *somewhere* in the system — whether self-managed clients may register them is untested.) Spike item.
- **Max clients per account: UNCONFIRMED** — no documented limit.
- **Domain verification (required for public visibility):**
  - DNS `TXT` record whose value is the provided verification code *including* the `cloudflare_oauth_client_publisher=` prefix ("The record must include all text, including the `cloudflare_oauth_client_publisher=` prefix").
  - "Cloudflare polls this DNS record until it is found or until the request times out after two days."
  - Restart a timed-out/failed verification: dashboard **Restart verification**, or `PATCH .../oauth_clients/{id}` re-sending the *unchanged* `client_uri`.
  - "After Cloudflare verifies domain ownership, you cannot change the domain of the client URL. You can still update the route for that domain."
  - Verification state in API responses: `client_uri_verification: { status: "pending" | "in_progress" | "verified" | "failed", text: "<exact TXT value>" }`.

---

## 7. Rate limits / restrictions

- **OAuth-endpoint-specific rate limits: UNCONFIRMED** — nothing documented for `/oauth2/*` on dash.cloudflare.com.
- The management API and any API calls made with the access token fall under the documented global Cloudflare API limit: **1,200 requests per 5 minutes per user**, "cumulatively regardless of whether the request is made via the dashboard, API key, or API token" (https://developers.cloudflare.com/fundamentals/api/reference/limits/). Note this is per *user* — tokens acting for a user share that user's budget, so a popular deploy flow hammering one user's account is fine, but DEADCOAST's own service token usage is bounded too.
- **Restrictions recap:** no client_credentials / implicit / device / ROPC; public visibility is irreversible; verified domain is frozen post-verification; admins can block new OAuth authorizations per account; available on **all plan tiers** including Free (https://developers.cloudflare.com/fundamentals/oauth/).

---

## 8. Server-side (confidential) integration — what this means for DEADCOAST

Our official site is a Cloudflare Worker (`src/server/worker.ts`), so we can run a **confidential client**: `token_endpoint_auth_method: "client_secret_basic"`, secret stored via `wrangler secret put` — never in `wrangler.jsonc` or client bundles. This matches the docs' "Server-side web app or backend service" row exactly.

Plausible product shape: a **"host your own DEADCOAST server"** button. User clicks → OAuth consent (scopes: workers deploy + account read) → our Worker uses the access token to `PUT` the GameRoom Worker script (with the DO migration metadata, `new_sqlite_classes` etc.) into *their* account, enables their workers.dev subdomain, done. This is literally the changelog's example use case ("after a user grants consent, Wrangler can deploy Workers into that account").

**Flow on our Worker:**
1. `GET /login` handler → 302 to `https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=...&redirect_uri=https://<our-domain>/oauth/callback&scope=<scope ids>&state=<random>` (+ PKCE for defense in depth).
2. `/oauth/callback` → `POST https://dash.cloudflare.com/oauth2/token` with Basic auth (`client_id:client_secret`), `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`.
3. `GET https://api.cloudflare.com/client/v4/accounts` with `Authorization: Bearer <access_token>` to enumerate granted account(s) (mechanism UNCONFIRMED — spike).
4. Deploy via the Workers script-upload API into the chosen account.
5. If we registered `grant_types: ["authorization_code","refresh_token"]`, store the refresh token (encrypted, in D1 or DO storage) for later redeploys/updates without re-consent.

**Implications, Adam-style:**

- **Opens up:** one-click self-hosted DEADCOAST servers in users' own accounts (their free-tier DO quota, not ours); OAuth-based admin login for the official site without anyone pasting API tokens; future Wrangler-less deploy tooling.
- **Complicates:** token storage becomes a real security surface on our side (refresh tokens = standing access to users' accounts — encrypt at rest, scope minimally); scope IDs must be enumerated before we can even register the client; consent re-prompt/refresh-expiry behavior is undocumented, so the redeploy path needs defensive re-auth UX.
- **Breaks (blocker for public visibility):** domain verification needs a DNS TXT record on the client URL's domain. `worldspring.adam-730.workers.dev` won't work — you can't create TXT records under `workers.dev`. **A custom domain is a hard prerequisite** for any public-visibility client. Private visibility (testing within Adam's own account) needs no domain and works today.
- **Threatens:** public promotion is irreversible and the verified domain is frozen — promoting a half-baked client pollutes the account permanently (mitigation: disposable clients for dev; only promote the final one). A compromised official Worker with stored refresh tokens could deploy arbitrary code into every consenting user's account — this is the single biggest risk of the feature and argues for the narrowest possible write scopes and short retention.

---

## 9. Spike checklist before any design doc (1–2 hours, needs only Adam's existing account)

1. `GET https://api.cloudflare.com/client/v4/oauth/scopes` (any API token) → capture full scope list; identify exact IDs for Workers deploy, D1, KV, account/memberships read. Resolves the biggest UNCONFIRMED.
2. Create a **private** confidential client via dashboard; note whether `http://localhost` redirect URIs are accepted (UNCONFIRMED rule).
3. Run the code+secret exchange; record `expires_in`, whether a `refresh_token` arrives, and the token response shape.
4. Call `GET /client/v4/accounts` with the access token → confirm account-discovery mechanism and that the Bearer header works as expected.
5. Refresh once → check whether the refresh token rotates.
6. Attempt a Worker script upload with the token into a scratch account → confirms the deploy scope choice end-to-end (including DO migration metadata and workers.dev subdomain enable).

## 10. UNCONFIRMED summary (do not guess these at implementation time)

- Exact OAuth scope IDs beyond `account.read` / `workers-platform.read` (enumerate via `GET /oauth/scopes`).
- Access token lifetime; refresh token lifetime and rotation policy.
- Redirect URI restrictions (localhost/http/wildcards/max count); max clients per account.
- Authorization-request parameter specifics (incl. whether `offline_access` must be requested explicitly in `scope`).
- How the app discovers granted account(s) (likely `GET /accounts`; unverified).
- Revoke-endpoint request shape (likely RFC 7009; unverified).
- Whether userinfo returns anything beyond `sub`.
- Whether `id_token`/`token` response types function for third-party clients.
- OAuth-endpoint-specific rate limits.
