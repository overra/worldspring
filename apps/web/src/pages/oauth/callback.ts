// /oauth/callback (doc 01 M4). Disabled mode → bare 404 (no body detail).
// Enabled: verify the signed state cookie (deleted either way), exchange the
// code (client_secret_basic + PKCE verifier), decode `sub` from the id_token,
// run the ONE-TIME accounts discovery, mint the identity-only session cookie,
// and 302 to the validated `next` path.
//
// The access token lives only in this handler's stack frame: used for exactly
// one GET /accounts, then discarded. It never enters a cookie, KV, D1, log
// line, error message, or response body (doc 01 §6). There is no refresh
// token — the client is registered without that grant (doc 01 decision 1).
import type { APIRoute } from "astro";
import { constantTimeEqual } from "@worldspring/shared/signedCookie";
import {
  authEnv,
  CF_ACCOUNTS_URL,
  idTokenSub,
  logAuthDisabledOnce,
  mintSession,
  OAUTH_REDIRECT_URI,
  OAUTH_TOKEN_URL,
  readState,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  STATE_COOKIE,
  type SessionAccount,
} from "../../lib/auth";

export const prerender = false;

/** Generic failure — never echoes upstream detail (it could carry the code). */
function failure(): Response {
  return new Response("Sign-in failed. Start again from /login.", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SESSION_HMAC_KEY } = authEnv();
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !SESSION_HMAC_KEY) {
    logAuthDisabledOnce();
    return new Response(null, { status: 404 });
  }

  // State cookie: read then delete EITHER WAY — a failed attempt must not
  // leave a reusable state lying around.
  const stateCookieValue = cookies.get(STATE_COOKIE)?.value;
  cookies.delete(STATE_COOKIE, { path: "/" });
  const state = await readState(SESSION_HMAC_KEY, stateCookieValue);

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!state || !code || !stateParam || !constantTimeEqual(stateParam, state.nonce)) {
    return failure();
  }

  // Code → token exchange: client_secret_basic (endpoint verified live to
  // accept it, cf-oauth §1) + the PKCE verifier from the signed state.
  const tokenRes = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: state.pkceVerifier,
    }),
  });
  if (!tokenRes.ok) {
    // Status only — the body may reference the code/token material.
    console.warn(`[auth] token exchange failed: HTTP ${tokenRes.status}`);
    return failure();
  }
  const tokenBody = (await tokenRes.json().catch(() => null)) as {
    access_token?: unknown;
    id_token?: unknown;
  } | null;
  const accessToken = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : null;
  const idToken = typeof tokenBody?.id_token === "string" ? tokenBody.id_token : null;
  if (!accessToken || !idToken) return failure();

  const sub = idTokenSub(idToken);
  if (!sub) return failure();

  // One-time accounts discovery (mechanism UNCONFIRMED-high-confidence,
  // cf-oauth §5) — tolerate failure with an empty list rather than blocking
  // sign-in; M5 re-discovers at job creation anyway. The token dies after
  // this call.
  let accounts: SessionAccount[] = [];
  try {
    const accountsRes = await fetch(CF_ACCOUNTS_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (accountsRes.ok) {
      const body = (await accountsRes.json().catch(() => null)) as {
        result?: unknown;
      } | null;
      if (Array.isArray(body?.result)) {
        accounts = body.result.flatMap((entry: unknown): SessionAccount[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const a = entry as Record<string, unknown>;
          return typeof a.id === "string" && typeof a.name === "string"
            ? [{ id: a.id, name: a.name }]
            : [];
        });
      }
    } else {
      console.warn(`[auth] accounts discovery failed: HTTP ${accountsRes.status}`);
    }
  } catch {
    console.warn("[auth] accounts discovery failed: network error");
  }

  cookies.set(SESSION_COOKIE, await mintSession(SESSION_HMAC_KEY, sub, accounts), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  return redirect(state.next, 302);
};
