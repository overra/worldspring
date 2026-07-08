import { describe, expect, it } from "vitest";
import {
  applyBrowse,
  BROWSE_SORTS,
  type BrowseableServer,
  type BrowseSort,
  canonicalListCacheUrl,
  DEFAULT_PAGE_SIZE,
  isOutdated,
  LIST_MAX_ROWS,
  parseBrowseParams,
  regionOf,
  shapeServerDetail,
  type ServerDetailRow,
} from "./browse";

const q = (s: string): URLSearchParams => new URLSearchParams(s);

describe("parseBrowseParams — strict, bounded, never throws (doc 02 §8)", () => {
  it("defaults an empty query", () => {
    expect(parseBrowseParams(q(""))).toEqual({
      preset: null,
      sort: "score",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("whitelists sort, falling back to score", () => {
    expect(parseBrowseParams(q("sort=players")).sort).toBe("players");
    expect(parseBrowseParams(q("sort=uptime")).sort).toBe("uptime");
    expect(parseBrowseParams(q("sort=name")).sort).toBe("name");
    // bogus / injection attempts fall back, never error
    expect(parseBrowseParams(q("sort=DROP+TABLE")).sort).toBe("score");
    expect(parseBrowseParams(q("sort=")).sort).toBe("score");
    expect(parseBrowseParams(q("sort=Players")).sort).toBe("score"); // case-sensitive whitelist
  });

  it("whitelists preset, falling back to null (no filter)", () => {
    expect(parseBrowseParams(q("preset=driftwood")).preset).toBe("driftwood");
    expect(parseBrowseParams(q("preset=custom")).preset).toBe("custom");
    expect(parseBrowseParams(q("preset=not-a-preset")).preset).toBeNull();
    expect(parseBrowseParams(q("preset='; DROP")).preset).toBeNull();
    expect(parseBrowseParams(q("preset=")).preset).toBeNull();
  });

  const MAX_PAGE = Math.ceil(LIST_MAX_ROWS / DEFAULT_PAGE_SIZE);

  it("clamps page to [1, MAX_PAGE]; junk falls back to page 1", () => {
    expect(parseBrowseParams(q("page=3")).page).toBe(3);
    expect(parseBrowseParams(q("page=0")).page).toBe(1); // min 1
    expect(parseBrowseParams(q("page=-5")).page).toBe(1);
    expect(parseBrowseParams(q("page=abc")).page).toBe(1);
    expect(parseBrowseParams(q("page=2.5")).page).toBe(1); // non-integer → default
    // Absurd pages fold to the small MAX_PAGE ceiling (bounded cache-key space, §11),
    // NOT an unbounded value — this is what stops `?page=<huge>` cache-busting D1.
    expect(parseBrowseParams(q("page=99999999999")).page).toBe(MAX_PAGE);
    expect(parseBrowseParams(q(`page=${MAX_PAGE + 5}`)).page).toBe(MAX_PAGE);
  });

  it("fixes pageSize regardless of the query param (cache-key cardinality, §11)", () => {
    expect(parseBrowseParams(q("")).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseBrowseParams(q("pageSize=10")).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseBrowseParams(q("pageSize=99999")).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseBrowseParams(q("pageSize=1")).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseBrowseParams(q("pageSize=abc")).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("canonicalListCacheUrl — cache key includes query params (doc 02 §11)", () => {
  const base = "https://worldspring.games/api/v1/servers";

  it("is stable regardless of param order or junk params", () => {
    const a = canonicalListCacheUrl(`${base}?sort=players&preset=driftwood`);
    const b = canonicalListCacheUrl(`${base}?preset=driftwood&sort=players`);
    const withJunk = canonicalListCacheUrl(`${base}?preset=driftwood&sort=players&utm_source=x`);
    expect(a).toBe(b);
    expect(withJunk).toBe(a); // junk dropped → same entry
  });

  it("gives DIFFERENT keys to different filters (they must not collide)", () => {
    const drift = canonicalListCacheUrl(`${base}?preset=driftwood`);
    const iron = canonicalListCacheUrl(`${base}?preset=ironcoast`);
    const p1 = canonicalListCacheUrl(`${base}?page=1`);
    const p2 = canonicalListCacheUrl(`${base}?page=2`);
    const byScore = canonicalListCacheUrl(`${base}?sort=score`);
    const byPlayers = canonicalListCacheUrl(`${base}?sort=players`);
    expect(drift).not.toBe(iron);
    expect(p1).not.toBe(p2);
    expect(byScore).not.toBe(byPlayers);
  });

  it("normalizes a bogus query to the default cache key (no error, no fragmentation)", () => {
    const bogus = canonicalListCacheUrl(`${base}?sort=nope&preset=nope&page=-1`);
    const empty = canonicalListCacheUrl(base);
    expect(bogus).toBe(empty);
    expect(empty).toBe(`${base}?sort=score&page=1&pageSize=${DEFAULT_PAGE_SIZE}`);
  });

  it("folds out-of-range pages and any pageSize into a BOUNDED key space (§11)", () => {
    const maxPage = Math.ceil(LIST_MAX_ROWS / DEFAULT_PAGE_SIZE);
    // Every page past the real max collapses to the SAME key (not a fresh miss each) —
    // a client walking `?page=1e6` can't mint unbounded distinct cache entries.
    const atMax = canonicalListCacheUrl(`${base}?page=${maxPage}`);
    expect(canonicalListCacheUrl(`${base}?page=${maxPage + 1}`)).toBe(atMax);
    expect(canonicalListCacheUrl(`${base}?page=999999`)).toBe(atMax);
    // A caller-varied pageSize never fragments the cache — it isn't a real param.
    const none = canonicalListCacheUrl(base);
    expect(canonicalListCacheUrl(`${base}?pageSize=1`)).toBe(none);
    expect(canonicalListCacheUrl(`${base}?pageSize=100`)).toBe(none);
  });
});

// --- Official-pinned invariant under every sort (doc 02 §8) ------------------

function srv(over: Partial<BrowseableServer> & { name: string }): BrowseableServer {
  return {
    official: false,
    preset: "deadcoast",
    players: 0,
    uptimeRatio20d: 0,
    score: 0,
    ...over,
  };
}

const officialRow = srv({
  name: "Official",
  official: true,
  players: 0, // deliberately the WORST on every metric
  uptimeRatio20d: 0,
  score: -100,
  preset: "deadcoast",
});

const fleet: BrowseableServer[] = [
  officialRow,
  srv({ name: "Alpha", players: 24, uptimeRatio20d: 0.9, score: 30, preset: "driftwood" }),
  srv({ name: "Bravo", players: 12, uptimeRatio20d: 0.99, score: 20, preset: "ironcoast" }),
  srv({ name: "Charlie", players: 1, uptimeRatio20d: 0.5, score: 10, preset: null }),
];

describe("applyBrowse — official pinned regardless of sort (doc 02 §8)", () => {
  for (const sort of BROWSE_SORTS) {
    it(`pins official first under sort=${sort} even though it scores worst`, () => {
      const res = applyBrowse(fleet, {
        preset: null,
        sort: sort as BrowseSort,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      });
      expect(res.rows[0]?.official).toBe(true);
      expect(res.rows[0]?.name).toBe("Official");
    });
  }

  it("orders non-official rows by the chosen sort key", () => {
    const byPlayers = applyBrowse(fleet, {
      preset: null,
      sort: "players",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(byPlayers.rows.slice(1).map((s) => s.name)).toEqual(["Alpha", "Bravo", "Charlie"]);

    const byUptime = applyBrowse(fleet, {
      preset: null,
      sort: "uptime",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(byUptime.rows.slice(1).map((s) => s.name)).toEqual(["Bravo", "Alpha", "Charlie"]);

    const byName = applyBrowse(fleet, {
      preset: null,
      sort: "name",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    // Official still pinned; the rest alphabetical.
    expect(byName.rows.map((s) => s.name)).toEqual(["Official", "Alpha", "Bravo", "Charlie"]);
  });
});

describe("applyBrowse — filter + paginate (doc 02 §8/§11)", () => {
  it("filters by preset, treating null/'' as custom", () => {
    const res = applyBrowse(fleet, {
      preset: "custom",
      sort: "score",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(res.total).toBe(1);
    expect(res.rows[0]?.name).toBe("Charlie");
  });

  it("a preset filter can exclude the official row (explicit narrowing)", () => {
    const res = applyBrowse(fleet, {
      preset: "driftwood",
      sort: "score",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(res.rows.map((s) => s.name)).toEqual(["Alpha"]);
  });

  it("paginates by offset and clamps an out-of-range page", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      srv({ name: `S${String(i).padStart(3, "0")}`, score: 1000 - i }),
    );
    const page1 = applyBrowse(many, { preset: null, sort: "score", page: 1, pageSize: 50 });
    expect(page1.rows).toHaveLength(50);
    expect(page1.pageCount).toBe(3);
    expect(page1.rows[0]?.name).toBe("S000");

    const page3 = applyBrowse(many, { preset: null, sort: "score", page: 3, pageSize: 50 });
    expect(page3.rows).toHaveLength(20);
    expect(page3.page).toBe(3);

    const clamped = applyBrowse(many, { preset: null, sort: "score", page: 99, pageSize: 50 });
    expect(clamped.page).toBe(3); // clamped to pageCount, still a valid empty-safe page
    expect(clamped.rows).toHaveLength(20);
  });

  it("does not mutate the input array", () => {
    const input = fleet.slice();
    const snapshot = input.map((s) => s.name);
    applyBrowse(input, { preset: null, sort: "name", page: 1, pageSize: 2 });
    expect(input.map((s) => s.name)).toEqual(snapshot);
  });
});

describe("isOutdated — badge gate (doc 02 §8/§10)", () => {
  it("is true only when a known protocol is below latest", () => {
    expect(isOutdated(6, 7)).toBe(true);
    expect(isOutdated(7, 7)).toBe(false);
    expect(isOutdated(8, 7)).toBe(false); // ahead of us → not "outdated"
    expect(isOutdated(null, 7)).toBe(false); // unknown, never a false badge
  });
});

describe("regionOf — coarse colo→region hint (doc 02 §8)", () => {
  it("maps known colos to a continent", () => {
    expect(regionOf("DFW")).toBe("North America");
    expect(regionOf("ams")).toBe("Europe"); // case-insensitive
    expect(regionOf("SIN")).toBe("Asia");
    expect(regionOf("SYD")).toBe("Oceania");
  });

  it("falls back to the raw code for unmapped colos, null for absent", () => {
    expect(regionOf("ZZZ")).toBe("ZZZ");
    expect(regionOf(null)).toBeNull();
    expect(regionOf("")).toBeNull();
  });
});

describe("shapeServerDetail — pure detail view model (doc 02 §8)", () => {
  const now = 10_000 * 86400_000; // a round day boundary
  const baseRow: ServerDetailRow = {
    id: "01ABC",
    url: "https://play.example.workers.dev",
    name: "Example",
    motd: "hi",
    preset: "driftwood",
    version: "0.1.0",
    protocol: 7,
    players: 5,
    players_max: 24,
    colo: "DFW",
    source: "manual",
    created_at: now - 3 * 86400_000,
    last_heartbeat_at: now - 60_000,
    verified_at: now - 3 * 86400_000,
    last_probe_at: now - 120_000,
  };

  it("shapes a live community row (host, region, age, join through interstitial)", () => {
    const v = shapeServerDetail(baseRow, 0.97, now, 7);
    expect(v.host).toBe("play.example.workers.dev");
    expect(v.region).toBe("North America");
    expect(v.ageDays).toBe(3);
    expect(v.outdated).toBe(false);
    expect(v.official).toBe(false);
    expect(v.activeNow).toBe(true);
    expect(v.uptimePct).toBe(97);
    expect(v.joinExternal).toBe(false);
    expect(v.joinHref).toBe("/join/01ABC");
    expect(v.joinUrl).toBe("https://play.example.workers.dev"); // ping target + ?ref origin
  });

  it("flags outdated and clamps displayed players to max", () => {
    const v = shapeServerDetail(
      { ...baseRow, protocol: 6, players: 999, players_max: 24 },
      1,
      now,
      7,
    );
    expect(v.outdated).toBe(true);
    expect(v.players).toBe(24);
  });

  it("links the official row straight out (first-party) and pins its style", () => {
    const v = shapeServerDetail({ ...baseRow, source: "official" }, 1, now, 7);
    expect(v.official).toBe(true);
    expect(v.joinExternal).toBe(true);
    expect(v.joinHref).toBe("https://play.example.workers.dev/?ref=worldspring-directory");
  });

  it("keeps 'no probe data yet' distinct from 0% and idle distinct from active", () => {
    const v = shapeServerDetail(
      { ...baseRow, last_heartbeat_at: null, last_probe_at: 0 },
      null,
      now,
      7,
    );
    expect(v.uptimePct).toBeNull();
    expect(v.activeNow).toBe(false);
    expect(v.lastProbeAt).toBeNull(); // 0 sentinel → null
    expect(v.preset).toBe("driftwood");
  });

  it("renders null/empty preset as custom", () => {
    expect(shapeServerDetail({ ...baseRow, preset: null }, 1, now, 7).preset).toBe("custom");
    expect(shapeServerDetail({ ...baseRow, preset: "" }, 1, now, 7).preset).toBe("custom");
  });
});
