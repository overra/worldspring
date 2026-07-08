// OAuth + site-session seam (doc 01 §2/§6, M4; research/cf-oauth.md). The
// pure crypto (cookie sign/verify, PKCE S256, next-path guard) lives in
// @worldspring/shared/signedCookie, and the request-shaped pure validators
// (state/session codecs, idTokenSub) in @worldspring/shared/authSession —
// both vitest-covered there; this module binds them to env, cookie names,
// and the Cloudflare OAuth endpoints (same split as tokens.ts ↔ directory.ts).
//
// M4 ships in DISABLED mode: none of the three secrets below are set until
// issue #66 runs `wrangler secret put` — /login renders a 200 info page,
// /oauth/callback 404s, and no other route changes. Unlike REPORT_SALT,
// absence here is a deliberate mode, not a degradation, so it rates one
// informational log per isolate, not a warning.
//
// The session cookie is IDENTITY ONLY: `{sub, exp, csrf, accounts}` where
// accounts is the read-only {id, name} list from the one-time /accounts
// discovery (proves discovery; lets /account render it). NO access token,
// NO refresh token, NO capability — ever (doc 01 §6 stored-durably table).
// M5's Deployer DO is the future — and only — holder of tokens.

import { env } from "cloudflare:workers";

export {
  idTokenSub,
  mintSession,
  mintState,
  readSession,
  readState,
  SESSION_MAX_AGE_S,
  STATE_MAX_AGE_S,
} from "@worldspring/shared/authSession";
export type { MintedState, OauthState, Session, SessionAccount } from "@worldspring/shared/authSession";

/** All three are OPTIONAL runtime secrets (issue #66 sets them via
 * `wrangler secret put`) — never declared in wrangler.jsonc, never in the
 * generated Env types; the REPORT_SALT hand-written-interface precedent. */
export interface AuthEnv {
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  /** 32+ random bytes (hex or base64) — HMAC key for both auth cookies. */
  SESSION_HMAC_KEY?: string;
}

export function authEnv(): AuthEnv {
  return env as unknown as AuthEnv;
}

export function oauthConfigured(e: AuthEnv): boolean {
  return !!(e.OAUTH_CLIENT_ID && e.OAUTH_CLIENT_SECRET && e.SESSION_HMAC_KEY);
}

let loggedDisabled = false;

/** One informational line per isolate when a sign-in route is hit unconfigured. */
export function logAuthDisabledOnce(): void {
  if (loggedDisabled) return;
  loggedDisabled = true;
  console.info(
    "[auth] OAuth secrets unset — sign-in runs in disabled mode (deliberate until issue #66 sets " +
      "OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET / SESSION_HMAC_KEY).",
  );
}

// --- Endpoints + client params (research/cf-oauth.md §1/§3) -----------------

export const OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const CF_ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";
/** Doc 01 open Q1, resolved 2026-07-07: the apex custom domain, exactly. */
export const OAUTH_REDIRECT_URI = "https://worldspring.games/oauth/callback";
// TODO(M1): the workers-write scope id is UNCONFIRMED (cf-oauth §3) — the M1
// spike (`GET /oauth/scopes`) owns it. `openid account.read` suffices for the
// M4 round-trip; only M5's deploy jobs exercise the write scope.
export const OAUTH_SCOPES = "openid account.read";

export const STATE_COOKIE = "ws_oauth_state";
export const SESSION_COOKIE = "ws_session";

export function buildAuthorizeUrl(clientId: string, nonce: string, challenge: string): string {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  u.searchParams.set("scope", OAUTH_SCOPES);
  u.searchParams.set("state", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
