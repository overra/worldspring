// /admin auth seam (doc 02 §7, M7). Doc 02 specifies the ADMIN_TOKEN cookie
// — deliberately NOT the #72 OAuth session, which ships in disabled mode
// until issue #66 sets its secrets; gating moderation on OAuth would couple
// it to an unlanded secret setup. The guard is one function (isAdmin) so a
// post-#66 extension can accept a valid ws_session whose sub is in an
// ADMIN_SUBS allowlist with a one-line addition.
//
// ADMIN_TOKEN is an OPTIONAL runtime secret (`wrangler secret put
// ADMIN_TOKEN`) in a hand-written interface — the REPORT_SALT / AuthEnv
// precedent: never in wrangler.jsonc, never in the generated Env types.
// Unset ⇒ /admin renders a disabled-mode info page (the auth.ts pattern).
//
// The cookie stores a DERIVED value (sha256 of a domain-separated token),
// not the token itself: an exfiltrated cookie jar still authenticates until
// rotation (it is the credential), but it can never be replayed into the
// login form or pasted into `wrangler secret put`, and casual exposure
// (screen share, devtools) doesn't leak the secret.

import { env } from "cloudflare:workers";
import { sha256Hex } from "@worldspring/shared/directory";
import { constantTimeEqual } from "@worldspring/shared/signedCookie";

export interface AdminEnv {
  ADMIN_TOKEN?: string;
}

export function adminEnv(): AdminEnv {
  return env as unknown as AdminEnv;
}

export const ADMIN_COOKIE = "ws_admin";
/** 7 days — a re-login per week is fine for a single-operator surface. */
export const ADMIN_COOKIE_MAX_AGE_S = 7 * 86_400;

const COOKIE_DOMAIN_SEP = "ws-admin-cookie:";

/** The value the ws_admin cookie must carry (derived, never the raw token). */
export function adminCookieValueOf(token: string): Promise<string> {
  return sha256Hex(`${COOKIE_DOMAIN_SEP}${token}`);
}

/** Login-form check: presented token vs the ADMIN_TOKEN secret. Both sides
 * are hashed first so the compare is fixed-length — constantTimeEqual's
 * byte-length early-return must not leak the token's length to a guesser. */
export async function isValidAdminLogin(presented: string, token: string): Promise<boolean> {
  return constantTimeEqual(await sha256Hex(presented), await sha256Hex(token));
}

/** Cookie check for every /admin request. Single-token ⇒ single actor; when
 * the OAuth path lands, extend here (and only here). */
export async function isAdmin(
  cookieValue: string | undefined,
  token: string,
): Promise<boolean> {
  if (!cookieValue) return false;
  return constantTimeEqual(cookieValue, await adminCookieValueOf(token));
}

let loggedDisabled = false;

/** One informational line per isolate when /admin is hit unconfigured. */
export function logAdminDisabledOnce(): void {
  if (loggedDisabled) return;
  loggedDisabled = true;
  console.info(
    "[admin] ADMIN_TOKEN is unset — /admin runs in disabled mode (deliberate until " +
      "`wrangler secret put ADMIN_TOKEN`).",
  );
}
