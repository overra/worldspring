import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  randomBase64url,
  sanitizeNextPath,
  sha256Base64url,
  signCookiePayload,
  verifyCookiePayload,
} from "./signedCookie";

const KEY = "test-hmac-key-32-bytes-minimum-length!!";

describe("base64url codec", () => {
  it("round-trips every byte value", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const encoded = base64urlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64urlDecode(encoded)).toEqual(bytes);
  });

  it("rejects characters outside the alphabet", () => {
    expect(base64urlDecode("ab+c")).toBeNull();
    expect(base64urlDecode("ab/c")).toBeNull();
    expect(base64urlDecode("ab=c")).toBeNull();
    expect(base64urlDecode("ab.c")).toBeNull();
  });
});

describe("sha256Base64url (PKCE S256)", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    // verifier → challenge from the spec's worked example.
    expect(await sha256Base64url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("randomBase64url", () => {
  it("is 43 chars for 32 bytes (valid PKCE verifier length) and unique", () => {
    const a = randomBase64url(32);
    expect(a).toHaveLength(43);
    expect(a).not.toBe(randomBase64url(32));
  });
});

describe("constantTimeEqual", () => {
  it("compares correctly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("signCookiePayload / verifyCookiePayload", () => {
  it("round-trips a state-shaped payload", async () => {
    const state = { nonce: "n1", pkceVerifier: "v1", next: "/account", iat: 1234567890 };
    const cookie = await signCookiePayload(KEY, state);
    expect(await verifyCookiePayload(KEY, cookie)).toEqual(state);
  });

  it("round-trips a session-shaped payload", async () => {
    const session = { sub: "user-1", exp: 999, csrf: "c", accounts: [{ id: "a1", name: "Acme" }] };
    const cookie = await signCookiePayload(KEY, session);
    expect(await verifyCookiePayload(KEY, cookie)).toEqual(session);
  });

  it("rejects a tampered body", async () => {
    const cookie = await signCookiePayload(KEY, { sub: "alice" });
    const forged = await signCookiePayload(KEY, { sub: "bob" });
    const [forgedBody] = forged.split(".");
    const [, realSig] = cookie.split(".");
    expect(await verifyCookiePayload(KEY, `${forgedBody}.${realSig}`)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const cookie = await signCookiePayload(KEY, { sub: "alice" });
    // Flip a char in the MIDDLE of the sig — the final char's low bits are
    // padding that base64 decoding drops, so flipping it can be a no-op.
    const dot = cookie.indexOf(".");
    const i = dot + 5;
    const flipped = cookie.slice(0, i) + (cookie[i] === "A" ? "B" : "A") + cookie.slice(i + 1);
    expect(await verifyCookiePayload(KEY, flipped)).toBeNull();
  });

  it("rejects the wrong key", async () => {
    const cookie = await signCookiePayload(KEY, { sub: "alice" });
    expect(await verifyCookiePayload("some-other-key-entirely-here!!!!!!!!!!!", cookie)).toBeNull();
  });

  it("rejects malformed values", async () => {
    expect(await verifyCookiePayload(KEY, "")).toBeNull();
    expect(await verifyCookiePayload(KEY, "no-dot")).toBeNull();
    expect(await verifyCookiePayload(KEY, ".leading-dot")).toBeNull();
    expect(await verifyCookiePayload(KEY, "trailing-dot.")).toBeNull();
    expect(await verifyCookiePayload(KEY, "not+b64url.sig")).toBeNull();
  });
});

describe("sanitizeNextPath", () => {
  it("allows same-origin absolute paths", () => {
    expect(sanitizeNextPath("/account")).toBe("/account");
    expect(sanitizeNextPath("/servers?sort=players#top")).toBe("/servers?sort=players#top");
  });

  it("drops everything else to /", () => {
    expect(sanitizeNextPath(undefined)).toBe("/");
    expect(sanitizeNextPath(null)).toBe("/");
    expect(sanitizeNextPath("")).toBe("/");
    expect(sanitizeNextPath("account")).toBe("/");
    expect(sanitizeNextPath("//evil.example")).toBe("/");
    expect(sanitizeNextPath("https://evil.example/")).toBe("/");
    expect(sanitizeNextPath("javascript:alert(1)")).toBe("/");
    expect(sanitizeNextPath("/\\evil.example")).toBe("/");
    expect(sanitizeNextPath("/ok\r\nSet-Cookie: x=1")).toBe("/");
  });

  it("caps length so the state cookie stays under the ~4 KB browser limit", () => {
    expect(sanitizeNextPath(`/${"a".repeat(511)}`)).toBe(`/${"a".repeat(511)}`);
    expect(sanitizeNextPath(`/${"a".repeat(512)}`)).toBe("/");
  });
});
