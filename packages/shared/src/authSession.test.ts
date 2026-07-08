import { describe, expect, it } from "vitest";
import { idTokenSub, mintSession, mintState, readSession, readState, STATE_MAX_AGE_S } from "./authSession";
import { base64urlEncode, signCookiePayload } from "./signedCookie";

const KEY = "test-hmac-key-32-bytes-minimum-length!!";
const OTHER_KEY = "some-other-key-entirely-here!!!!!!!!!!!";

const encode = (payload: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));

describe("mintState / readState", () => {
  it("round-trips, sanitizing next at mint time", async () => {
    const { cookieValue, nonce, challenge } = await mintState(KEY, "/account");
    expect(nonce).toHaveLength(43);
    expect(challenge).toHaveLength(43);
    const state = await readState(KEY, cookieValue);
    expect(state).not.toBeNull();
    expect(state!.nonce).toBe(nonce);
    expect(state!.next).toBe("/account");
  });

  it("drops a hostile next to / at mint time", async () => {
    const { cookieValue } = await mintState(KEY, "https://evil.example/");
    expect((await readState(KEY, cookieValue))!.next).toBe("/");
  });

  it("re-sanitizes next at read time even if the signed payload holds a bad value", async () => {
    // Simulates a historically-signed (or future-refactor) payload whose next
    // skipped mint-time sanitization: the reader must not pass it through.
    const forged = await signCookiePayload(KEY, {
      t: "state",
      nonce: "n",
      pkceVerifier: "v",
      next: "//evil.example",
      iat: Date.now(),
    });
    expect((await readState(KEY, forged))!.next).toBe("/");
  });

  it("rejects missing, tampered, and wrong-key cookies", async () => {
    const { cookieValue } = await mintState(KEY, "/");
    expect(await readState(KEY, undefined)).toBeNull();
    expect(await readState(KEY, `${cookieValue}x`)).toBeNull();
    expect(await readState(OTHER_KEY, cookieValue)).toBeNull();
  });

  it("rejects stale and future-dated states", async () => {
    const { cookieValue } = await mintState(KEY, "/");
    const now = Date.now();
    expect(await readState(KEY, cookieValue, now + STATE_MAX_AGE_S * 1000 + 1)).toBeNull();
    expect(await readState(KEY, cookieValue, now - 120_000)).toBeNull(); // iat > now + 60 s skew
    expect(await readState(KEY, cookieValue, now + 1000)).not.toBeNull();
  });

  it("rejects a validly-signed session cookie presented as state (t discriminant)", async () => {
    const sessionCookie = await mintSession(KEY, "user-1", []);
    expect(await readState(KEY, sessionCookie)).toBeNull();
    // ...even if the payload carries every state-shaped field.
    const overlap = await signCookiePayload(KEY, {
      t: "session",
      nonce: "n",
      pkceVerifier: "v",
      next: "/",
      iat: Date.now(),
    });
    expect(await readState(KEY, overlap)).toBeNull();
  });
});

describe("mintSession / readSession", () => {
  it("round-trips with exp enforced server-side", async () => {
    const now = Date.now();
    const cookie = await mintSession(KEY, "user-1", [{ id: "a1", name: "Acme" }], now);
    const session = await readSession(KEY, cookie, now);
    expect(session).not.toBeNull();
    expect(session!.sub).toBe("user-1");
    expect(session!.accounts).toEqual([{ id: "a1", name: "Acme" }]);
    expect(session!.csrf).toHaveLength(22); // 16 random bytes
  });

  it("rejects an expired session", async () => {
    const now = Date.now();
    const cookie = await mintSession(KEY, "user-1", [], now);
    expect(await readSession(KEY, cookie, now + 8 * 24 * 3600 * 1000)).toBeNull();
  });

  it("rejects missing, tampered, and wrong-key cookies", async () => {
    const cookie = await mintSession(KEY, "user-1", []);
    expect(await readSession(KEY, undefined)).toBeNull();
    expect(await readSession(KEY, `${cookie}x`)).toBeNull();
    expect(await readSession(OTHER_KEY, cookie)).toBeNull();
  });

  it("rejects a validly-signed state cookie presented as session (t discriminant)", async () => {
    const { cookieValue } = await mintState(KEY, "/");
    expect(await readSession(KEY, cookieValue)).toBeNull();
  });

  it("rejects malformed account entries in a signed payload", async () => {
    const forged = await signCookiePayload(KEY, {
      t: "session",
      sub: "u",
      exp: Date.now() + 60_000,
      csrf: "c",
      accounts: [{ id: "a1", name: 42 }],
    });
    expect(await readSession(KEY, forged)).toBeNull();
  });

  it("caps accounts at 8 entries and names at 64 chars", async () => {
    const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: "n".repeat(200) }));
    const session = await readSession(KEY, await mintSession(KEY, "u", accounts));
    expect(session!.accounts).toHaveLength(8);
    for (const a of session!.accounts) expect(a.name).toHaveLength(64);
  });
});

describe("idTokenSub", () => {
  const jwt = (claims: unknown) => `${encode({ alg: "RS256" })}.${encode(claims)}.${encode("sig")}`;

  it("extracts sub across padding lengths", () => {
    // Payload byte lengths hitting every mod-4 case of the base64url padding math.
    for (const sub of ["a", "ab", "abc", "abcd", "abcde"]) {
      expect(idTokenSub(jwt({ sub, aud: "x" }))).toBe(sub);
    }
  });

  it("rejects malformed tokens", () => {
    expect(idTokenSub("")).toBeNull();
    expect(idTokenSub("one.two")).toBeNull();
    expect(idTokenSub("a.b.c.d")).toBeNull();
    expect(idTokenSub("head.not+b64url!.sig")).toBeNull();
    expect(idTokenSub(`h.${encode("not-an-object")}.s`)).toBe(null);
    expect(idTokenSub(jwt({ sub: "" }))).toBeNull();
    expect(idTokenSub(jwt({ sub: 42 }))).toBeNull();
    expect(idTokenSub(jwt({ aud: "x" }))).toBeNull();
  });
});
