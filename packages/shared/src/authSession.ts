// Pure state/session-cookie codecs + id_token claim parsing for the site's
// OAuth flow (doc 01 §2/§6, M4). Everything here is request-shaped but pure
// (key + value + now in, value out) — no env, no cookie names — so vitest
// covers it alongside signedCookie.ts; apps/web/src/lib/auth.ts is the env
// seam that binds these to cookie names and the Cloudflare endpoints.
//
// Both cookies are signed with the SAME HMAC key, so every signed payload
// carries a `t` discriminant ("state" | "session") that the readers require.
// That makes the state/session separation structural: a validly-signed
// session cookie replayed into readState fails on `t`, not on incidental
// shape disjointness.

import {
  base64urlDecode,
  randomBase64url,
  sanitizeNextPath,
  sha256Base64url,
  signCookiePayload,
  verifyCookiePayload,
} from "./signedCookie";

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
  const state = { t: "state", nonce, pkceVerifier, next: sanitizeNextPath(nextRaw), iat: Date.now() };
  return {
    cookieValue: await signCookiePayload(hmacKey, state),
    nonce,
    challenge: await sha256Base64url(pkceVerifier),
  };
}

/** Verify + shape-check + freshness-check the state cookie; null on anything
 * off. `next` is re-sanitized on the way out, so callers can trust it even if
 * a historically-signed payload predates (or a future mint path skips) the
 * mint-time guard. */
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
    s.t !== "state" ||
    typeof s.nonce !== "string" ||
    typeof s.pkceVerifier !== "string" ||
    typeof s.next !== "string" ||
    typeof s.iat !== "number"
  ) {
    return null;
  }
  if (now - s.iat > STATE_MAX_AGE_S * 1000 || s.iat > now + 60_000) return null;
  return { nonce: s.nonce, pkceVerifier: s.pkceVerifier, next: sanitizeNextPath(s.next), iat: s.iat };
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
   * zero capability. M5 re-discovers at job creation. Count- and name-length-
   * capped to keep the cookie well under the 4 KB header budget. */
  accounts: SessionAccount[];
}

const SESSION_ACCOUNTS_MAX = 8;
/** Display-only, so truncation is safe; ids stay verbatim (fixed-length CF ids). */
const SESSION_ACCOUNT_NAME_MAX = 64;

export async function mintSession(
  hmacKey: string,
  sub: string,
  accounts: SessionAccount[],
  now: number = Date.now(),
): Promise<string> {
  const session = {
    t: "session",
    sub,
    exp: now + SESSION_MAX_AGE_S * 1000,
    csrf: randomBase64url(16),
    accounts: accounts
      .slice(0, SESSION_ACCOUNTS_MAX)
      .map((a) => ({ id: a.id, name: a.name.slice(0, SESSION_ACCOUNT_NAME_MAX) })),
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
  if (s.t !== "session") return null;
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

// --- id_token ---------------------------------------------------------------

/** `sub` from the id_token payload — the ONLY documented claim (cf-oauth §4).
 * JWKS verification is deliberately skipped: the token arrives directly from
 * the token endpoint over TLS with client auth (OIDC Core 3.1.3.7 sanctions
 * this for the code flow). NEVER call this on a token from any other channel
 * (front-channel, browser-supplied, storage) — it does not validate the
 * signature, iss, aud, or exp. Revisit as M9 hardening if it's ever consumed
 * off the direct channel. */
export function idTokenSub(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const payloadBytes = base64urlDecode(parts[1]);
  if (!payloadBytes) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    return typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : null;
  } catch {
    return null;
  }
}
