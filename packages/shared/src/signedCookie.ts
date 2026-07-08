// Signed-cookie codec + OAuth-flow primitives for the site's auth cookies
// (doc 01 §2/§6, M4). Pure webcrypto — identical in workerd and Node — so
// vitest covers it here; apps/web/src/lib/auth.ts is the seam that binds
// these to env, cookie names, and the Cloudflare OAuth endpoints (same
// split as tokens.ts ↔ directory.ts).
//
// Cookie value format: `base64url(json) + "." + base64url(hmacSha256(key, base64url(json)))`.
// The signature covers the ENCODED body, so verify never parses unauthenticated JSON.

const encoder = new TextEncoder();

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null on any character outside the base64url alphabet or bad padding math. */
export function base64urlDecode(value: string): Uint8Array | null {
  if (!BASE64URL_RE.test(value)) return null;
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 32 bytes → 43 chars: the state nonce, PKCE verifier, and csrf value shapes. */
export function randomBase64url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** RFC 7636 S256 challenge: base64url of the RAW sha-256 digest bytes (NOT
 * hex — sha256Hex in directory.ts is the wrong shape for PKCE). */
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return base64urlEncode(new Uint8Array(digest));
}

/** Constant-time string equality (for the state↔nonce check; HMAC comparison
 * goes through crypto.subtle.verify, which is constant-time internally). */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/** Serialize + sign a JSON payload into a cookie value. */
export async function signCookiePayload(secret: string, payload: unknown): Promise<string> {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(sig))}`;
}

/** Verify + parse a cookie value; null on ANY malformation or bad signature.
 * The JSON is only parsed after the HMAC passes. */
export async function verifyCookiePayload(secret: string, value: string): Promise<unknown | null> {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  if (!BASE64URL_RE.test(body)) return null;
  const sig = base64urlDecode(value.slice(dot + 1));
  if (!sig) return null;
  const key = await hmacKey(secret, "verify");
  const ok = await crypto.subtle.verify("HMAC", key, sig as BufferSource, encoder.encode(body));
  if (!ok) return null;
  const bodyBytes = base64urlDecode(body);
  if (!bodyBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
  } catch {
    return null;
  }
}

/** Longest `next` we'll carry in the state cookie. Anything bigger risks
 * pushing the Set-Cookie past the ~4 KB browser per-cookie limit, which
 * browsers DROP SILENTLY — the victim would finish the OAuth round-trip only
 * to hit "no state cookie" at the callback. No real path here is this long. */
const NEXT_PATH_MAX = 512;

/** Open-redirect guard for `/login?next=…` — same-origin absolute paths only,
 * length-capped. Anything else (schemes, scheme-relative `//host`, backslash
 * tricks, header injection bytes, oversized paths) drops to `/`. Doc 01
 * doesn't state it; it's required. */
export function sanitizeNextPath(next: unknown): string {
  if (typeof next !== "string" || next === "") return "/";
  if (next.length > NEXT_PATH_MAX) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  if (next.includes("\\")) return "/";
  if (/[\r\n\0]/.test(next)) return "/";
  return next;
}
