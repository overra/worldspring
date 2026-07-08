import { describe, expect, it } from "vitest";
import {
  challengeHashOfToken,
  DIRECTORY_CHALLENGE_PREFIX,
  FAKE_COUNT_PROBE_STREAK,
  isFakeCountObservation,
  mintServerToken,
  normalizeServerUrl,
  parseHeartbeatBody,
  parseReportBody,
  parseServerInfoForDirectory,
  parseServerToken,
  probeServerInfo,
  REPORT_DETAIL_MAX,
  REPORT_FLAG_THRESHOLD,
  REPORT_LIMIT_PER_DAY,
  REPORT_REASONS,
  score,
  sha256Hex,
  ulid,
} from "./directory";
import { sanitizeListingText, SERVER_NAME_MAX } from "./text";
import type { ServerInfo } from "./serverInfo";

function makeInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    schemaVersion: 1,
    gameVersion: "0.1.0",
    protocolVersion: 6,
    worldSeed: 1337,
    name: "Test Server",
    motd: "hello",
    rules: {
      preset: "deadcoast",
      zombies: "normal",
      pvp: true,
      fullLoot: true,
      loot: "normal",
      vitals: "normal",
      night: "cycle",
      dayLengthMin: 20,
      worldSize: "standard",
      maxPlayers: 24,
      wipe: "never",
      map: "full",
    },
    players: 3,
    maxPlayers: 24,
    status: "occupied",
    uptimeS: 120,
    worldAgeS: 999,
    colo: null,
    joinUrl: "https://example.workers.dev",
    directoryChallenge: null,
    ...overrides,
  };
}

describe("ulid", () => {
  it("is 26 Crockford chars and time-ordered", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe("token mint/parse/hash", () => {
  it("round-trips and computes both hashes per doc 02 §2", async () => {
    const minted = await mintServerToken();
    expect(minted.token).toBe(`dcd1.${minted.serverId}.${minted.token.split(".")[2]}`);
    const parsed = parseServerToken(minted.token);
    expect(parsed).not.toBeNull();
    expect(parsed!.serverId).toBe(minted.serverId);
    // token_hash = sha256(secret part ONLY); challenge = sha256(prefix + FULL token)
    expect(await sha256Hex(parsed!.secretHex)).toBe(minted.tokenHash);
    expect(await sha256Hex(DIRECTORY_CHALLENGE_PREFIX + minted.token)).toBe(
      minted.challengeHash,
    );
    expect(await challengeHashOfToken(minted.token)).toBe(minted.challengeHash);
    expect(minted.tokenHash).not.toBe(minted.challengeHash);
  });

  it("rejects malformed tokens", async () => {
    const minted = await mintServerToken();
    expect(parseServerToken("")).toBeNull();
    expect(parseServerToken("dcd1.short.deadbeef")).toBeNull();
    expect(parseServerToken(minted.token.replace("dcd1", "dcd2"))).toBeNull();
    expect(parseServerToken(minted.token + "ff")).toBeNull();
    expect(parseServerToken(minted.token.toUpperCase())).toBeNull(); // secret must be lowercase hex
  });
});

describe("normalizeServerUrl", () => {
  it("normalizes to a bare https origin", () => {
    expect(normalizeServerUrl("https://My-Server.Someone.Workers.dev/some/path?q=1")).toBe(
      "https://my-server.someone.workers.dev",
    );
  });
  it("rejects doc 02 §7 violations", () => {
    expect(normalizeServerUrl("http://example.com")).toBeNull(); // https only
    expect(normalizeServerUrl("https://example.com:8443")).toBeNull(); // default port only
    expect(normalizeServerUrl("https://1.2.3.4")).toBeNull(); // IP literal
    expect(normalizeServerUrl("https://[::1]")).toBeNull(); // IPv6
    expect(normalizeServerUrl("https://xn--e1awd7f.example")).toBeNull(); // punycode
    expect(normalizeServerUrl("https://localhost")).toBeNull(); // single label
    expect(normalizeServerUrl("https://user:pw@example.com")).toBeNull(); // credentials
    expect(normalizeServerUrl("not a url")).toBeNull();
    expect(normalizeServerUrl("https://-bad.example.com")).toBeNull();
  });
});

describe("heartbeat body validation", () => {
  it("accepts a valid body and tolerates unknown fields", () => {
    const body = {
      schemaVersion: 1,
      event: "periodic",
      sentAt: Date.now(),
      info: { ...makeInfo(), futureField: "ignored" },
      alsoUnknown: 42,
    };
    expect(parseHeartbeatBody(body)).not.toBeNull();
  });
  it("rejects bad envelopes and bad info shapes", () => {
    const good = { schemaVersion: 1, event: "boot", sentAt: 1, info: makeInfo() };
    expect(parseHeartbeatBody(good)).not.toBeNull();
    expect(parseHeartbeatBody(null)).toBeNull();
    expect(parseHeartbeatBody({ ...good, event: "restart" })).toBeNull();
    expect(parseHeartbeatBody({ ...good, sentAt: "now" })).toBeNull();
    expect(parseHeartbeatBody({ ...good, info: { ...makeInfo(), players: "3" } })).toBeNull();
    expect(parseHeartbeatBody({ ...good, info: { ...makeInfo(), rules: null } })).toBeNull();
    expect(
      parseServerInfoForDirectory({ ...makeInfo(), schemaVersion: "1" }),
    ).toBeNull();
  });
});

describe("probeServerInfo", () => {
  const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });

  it("passes on shape + matching challenge (either of two rotation hashes)", async () => {
    const info = makeInfo({ directoryChallenge: "abc" });
    const res = await probeServerInfo("https://x.example.com", {
      expectedChallenges: ["other", "abc"],
      fetchFn: async () => jsonResponse(info),
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(res.info?.players).toBe(3);
  });

  it("fails challenge-mismatch when challenge vanished or differs", async () => {
    for (const challenge of [null, "wrong"]) {
      const res = await probeServerInfo("https://x.example.com", {
        expectedChallenges: ["abc"],
        fetchFn: async () => jsonResponse(makeInfo({ directoryChallenge: challenge })),
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("challenge-mismatch");
    }
  });

  it("fails on redirect (manual), non-200, wrong content-type, oversize, bad shape", async () => {
    const cases: Array<[Response, string]> = [
      [new Response(null, { status: 302, headers: { location: "https://evil" } }), "bad-status"],
      [new Response("nope", { status: 500 }), "bad-status"],
      [new Response("{}", { status: 200, headers: { "content-type": "text/html" } }), "bad-shape"],
      [jsonResponse({ nope: true }), "bad-shape"],
      [
        new Response("x".repeat(17 * 1024), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "bad-shape",
      ],
    ];
    for (const [response, expected] of cases) {
      const res = await probeServerInfo("https://x.example.com", {
        fetchFn: async () => response,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(expected);
    }
  });

  it("aborts a chunked body past 16 KB without buffering the stream", async () => {
    // No content-length header (chunked): the cap must be enforced while
    // STREAMING, not after a full res.text() buffer.
    let pulls = 0;
    const chunk = new Uint8Array(1024).fill(0x78); // 'x'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await probeServerInfo("https://x.example.com", {
      fetchFn: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad-shape");
    expect(pulls).toBeLessThan(64); // stopped at the 16 KB cap, not stream end
  });

  it("reports timeout on network failure and never throws", async () => {
    const res = await probeServerInfo("https://x.example.com", {
      fetchFn: async () => {
        throw new TypeError("network down");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout");
  });

  it("only ever GETs <origin>/api/server-info", async () => {
    let seen = "";
    await probeServerInfo("https://x.example.com", {
      fetchFn: async (input) => {
        seen = String(input);
        return jsonResponse(makeInfo());
      },
    });
    expect(seen).toBe("https://x.example.com/api/server-info");
  });
});

describe("score (doc 02 §8 exact formula)", () => {
  const base = {
    players: 10,
    players_max: 24,
    protocol: 6,
    created_at: 0,
    uptimeRatio20d: 1,
  };
  const now = 200 * 86400_000; // 200 days in ms → age term saturates at 6

  it("caps players at 24 and age at 6", () => {
    expect(score({ ...base, players: 500 }, 6, now)).toBe(24 + 8 + 6);
  });
  it("penalizes absurd capacity and outdated protocol", () => {
    expect(score({ ...base, players_max: 33 }, 6, now)).toBe(10 + 8 + 6 - 8);
    expect(score({ ...base, protocol: 5 }, 6, now)).toBe(10 + 8 + 6 - 4);
    expect(score({ ...base, protocol: null }, 6, now)).toBe(10 + 8 + 6);
  });
  it("age term uses epoch milliseconds", () => {
    // 15 days in ms → 0.5 on the 30-days-per-point ramp
    expect(score({ ...base, created_at: now - 15 * 86400_000 }, 6, now)).toBe(10 + 8 + 0.5);
  });
});

describe("sanitizeListingText", () => {
  it("strips controls/zero-width/bidi, collapses whitespace, caps code points", () => {
    expect(sanitizeListingText("  a​‮b   c  ", 10)).toBe("a b c");
    expect(sanitizeListingText("x".repeat(100), SERVER_NAME_MAX)).toHaveLength(
      SERVER_NAME_MAX,
    );
    expect(sanitizeListingText("​​ ", 48)).toBe("");
  });
});

describe("parseReportBody", () => {
  it("accepts every migration-0002 reason and sanitizes detail", () => {
    for (const reason of REPORT_REASONS) {
      expect(parseReportBody({ reason })).toEqual({ reason, detail: "" });
    }
    expect(parseReportBody({ reason: "broken", detail: "  fake​ counts  " })).toEqual({
      reason: "broken",
      detail: "fake counts",
    });
  });
  it("caps detail at 500 code points", () => {
    const parsed = parseReportBody({ reason: "other", detail: "x".repeat(2000) });
    expect(parsed).not.toBeNull();
    expect([...(parsed as { detail: string }).detail]).toHaveLength(REPORT_DETAIL_MAX);
  });
  it("rejects non-objects, unknown reasons, and non-string detail", () => {
    expect(parseReportBody(null)).toBeNull();
    expect(parseReportBody("broken")).toBeNull();
    expect(parseReportBody({})).toBeNull();
    expect(parseReportBody({ reason: "rude" })).toBeNull();
    expect(parseReportBody({ reason: "BROKEN" })).toBeNull();
    expect(parseReportBody({ reason: "broken", detail: 7 })).toBeNull();
  });
  it("tolerates unknown extra fields", () => {
    expect(parseReportBody({ reason: "broken", extra: true })).toEqual({
      reason: "broken",
      detail: "",
    });
  });
});

describe("report/moderation thresholds", () => {
  it("pins the doc 02 §7 numbers", () => {
    expect(REPORT_LIMIT_PER_DAY).toBe(5);
    expect(REPORT_FLAG_THRESHOLD).toBe(3);
    expect(FAKE_COUNT_PROBE_STREAK).toBe(3);
  });
});

describe("isFakeCountObservation", () => {
  it("flags only observations under HALF the claim", () => {
    expect(isFakeCountObservation(9, 20)).toBe(true); // 9*2=18 < 20
    expect(isFakeCountObservation(10, 20)).toBe(false); // exactly half is honest
    expect(isFakeCountObservation(0, 1)).toBe(true);
    expect(isFakeCountObservation(0, 0)).toBe(false); // zero-claim never counts
    expect(isFakeCountObservation(null, 20)).toBe(false); // failed probe reports nothing
  });
});
