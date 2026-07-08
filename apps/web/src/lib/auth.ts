// OAuth + site-session seam (doc 01 §2/§6, M4; research/cf-oauth.md). The
// pure crypto (cookie sign/verify, PKCE S256, next-path guard) lives in
// @worldspring/shared/signedCookie where vitest covers it — same split as
// tokens.ts ↔ directory.ts. This module binds it to env, cookie names, and
// the Cloudflare OAuth endpoints.
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
import {
  randomBase64url,
  sanitizeNextPath,
  sha256Base64url,
  signCookiePayload,
  verifyCookiePayload,
} from "@worldspring/shared/signedCookie";

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
export const STATE_MAX_AGE_S = 600; // 10 min authorize round-trip budget
export const SESSION_MAX_AGE_S = 7 * 24 * 3600; // 7 d, enforced server-side via exp

// --- State cookie (login → callback) ----------------------------------------

export interface OauthState {
  nonce: string;
  pkceVerifier: string;
  next: string;
  iat: number;
}

export interface MintedState {
  cookieValue: string;
  nonce: string;
  /** RFC 7636 S256 challenge of the verifier (never `plain`). */
  challenge: string;
}

export async function mintState(hmacKey: string, nextRaw: unknown): Promise<MintedState> {
  const nonce = randomBase64url(32);
  const pkceVerifier = randomBase64url(32); // 43 chars — valid RFC 7636 length
  const state: OauthState = { nonce, pkceVerifier, next: sanitizeNextPath(nextRaw), iat: Date.now() };
  return {
    cookieValue: await signCookiePayload(hmacKey, state),
    nonce,
    challenge: await sha256Base64url(pkceVerifier),
  };
}

/** Verify + shape-check + freshness-check the state cookie; null on anything off. */
export async function readState(
  hmacKey: string,
  cookieValue: string | undefined,
  now: number = Date.now(),
): Promise<OauthState | null> {
  if (!cookieValue) return null;
  const raw = await verifyCookiePayload(hmacKey, cookieValue);
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.nonce !== "string" ||
    typeof s.pkceVerifier !== "string" ||
    typeof s.next !== "string" ||
    typeof s.iat !== "number"
  ) {
    return null;
  }
  if (now - s.iat > STATE_MAX_AGE_S * 1000 || s.iat > now + 60_000) return null;
  return { nonce: s.nonce, pkceVerifier: s.pkceVerifier, next: s.next, iat: s.iat };
}

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

// --- Session cookie (identity only, NO capability) --------------------------

export interface SessionAccount {
  id: string;
  name: string;
}

export interface Session {
  sub: string;
  exp: number;
  /** Random value for later state-changing POSTs (M5+); unused by M4 GETs. */
  csrf: string;
  /** Read-only {id, name} list from the one-time discovery — identity-shaped,
   * zero capability. M5 re-discovers at job creation. Capped to keep the
   * cookie well under the 4 KB header budget. */
  accounts: SessionAccount[];
}

const SESSION_ACCOUNTS_MAX = 8;

export async function mintSession(
  hmacKey: string,
  sub: string,
  accounts: SessionAccount[],
  now: number = Date.now(),
): Promise<string> {
  const session: Session = {
    sub,
    exp: now + SESSION_MAX_AGE_S * 1000,
    csrf: randomBase64url(16),
    accounts: accounts.slice(0, SESSION_ACCOUNTS_MAX),
  };
  return signCookiePayload(hmacKey, session);
}

/** Verify + shape-check + exp-check; null means "not signed in". */
export async function readSession(
  hmacKey: string,
  cookieValue: string | undefined,
  now: number = Date.now(),
): Promise<Session | null> {
  if (!cookieValue) return null;
  const raw = await verifyCookiePayload(hmacKey, cookieValue);
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.sub !== "string" || typeof s.exp !== "number" || typeof s.csrf !== "string") return null;
  if (!Array.isArray(s.accounts)) return null;
  if (s.exp <= now) return null;
  const accounts: SessionAccount[] = [];
  for (const entry of s.accounts) {
    if (typeof entry !== "object" || entry === null) return null;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "string" || typeof a.name !== "string") return null;
    accounts.push({ id: a.id, name: a.name });
  }
  return { sub: s.sub, exp: s.exp, csrf: s.csrf, accounts };
}

/** `sub` from the id_token payload — the ONLY documented claim (cf-oauth §4).
 * JWKS verification is deliberately skipped: the token arrives directly from
 * the token endpoint over TLS with client auth (OIDC Core 3.1.3.7 sanctions
 * this for the code flow). Revisit as M9 hardening if it's ever consumed off
 * the direct channel. */
export function idTokenSub(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4);
  try {
    const claims = JSON.parse(atob(b64)) as Record<string, unknown>;
    return typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : null;
  } catch {
    return null;
  }
}
