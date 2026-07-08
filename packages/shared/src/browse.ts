// Browse UX + ranking helpers (doc 02 M5 §8/§11), shared by apps/web's list
// endpoint (GET /api/v1/servers), the /servers SSR browse page, and the
// /servers/:id detail page. Everything here is a PURE function — no D1, no
// fetch, no `cloudflare:workers` import — so vitest covers it exactly like the
// rest of the directory core (browse.test.ts) without a workerd harness.
//
// The whole point of routing filters/sorts/pagination through query params is
// that every filtered view is a CACHEABLE URL (doc 02 §11 acceptance): the
// parse is strict and bounded (whitelist sort/preset, clamp page to a small
// ceiling, fix pageSize) so a hostile or malformed query can never error,
// unbound anything, OR mint unbounded distinct cache keys, and
// canonicalListCacheUrl derives a stable per-query cache key.

import { score } from "./directory.ts";

// --- Query-param vocabulary (doc 02 §8) -------------------------------------

/** Sort keys exposed as query params. "score" (Recommended) is the default;
 * ping is client-only (ping.js) and never a server-side sort. */
export const BROWSE_SORTS = ["score", "players", "uptime", "name"] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

/** Preset filter values — the closed RulesSummary.preset union plus "custom".
 * A listing whose preset is null/"" is treated as "custom". Anything outside
 * this set is ignored (no filter), never an error. */
export const BROWSE_PRESETS = [
  "deadcoast",
  "driftwood",
  "ironcoast",
  "warpath",
  "homestead",
  "nightfall",
  "custom",
] as const;
export type BrowsePreset = (typeof BROWSE_PRESETS)[number];

export const DEFAULT_PAGE_SIZE = 50; // doc 02 §11: 50 rows/page — the ONLY page size
// doc 02 §4/§11 hard list cap (mirrored by loadRankedList's `SELECT … LIMIT`). Exported
// so the web loader shares this single source of truth instead of re-declaring 500.
export const LIST_MAX_ROWS = 500;
// The browse surface serves at most LIST_MAX_ROWS rows at a FIXED DEFAULT_PAGE_SIZE, so
// there are only ever this many real pages. Clamping `page` to this small ceiling (not an
// absurd 1e6) is what keeps the per-query cache-key space BOUNDED: a hostile client walking
// `?page=1,2,3,…` mints at most MAX_PAGE distinct keys per filter, so the 30 s edge cache
// actually shields D1 instead of being trivially busted into a cold full-list read on every
// request (defeating §11's ~2-D1-reads/30s/colo cost model). pageSize is NOT a public param
// for the same reason — a caller-varied `?pageSize` would re-multiply the key space and
// re-open the identical cache-busting hole.
const MAX_PAGE = Math.ceil(LIST_MAX_ROWS / DEFAULT_PAGE_SIZE); // = 10

export interface BrowseParams {
  /** null = show all presets. */
  preset: BrowsePreset | null;
  sort: BrowseSort;
  /** 1-based, clamped to [1, MAX_PAGE]. applyBrowse re-clamps to the real pageCount. */
  page: number;
  /** Fixed at DEFAULT_PAGE_SIZE — not caller-variable (cache-key cardinality, §11). */
  pageSize: number;
}

function isBrowseSort(v: string | null): v is BrowseSort {
  return v !== null && (BROWSE_SORTS as readonly string[]).includes(v);
}

function isBrowsePreset(v: string | null): v is BrowsePreset {
  return v !== null && (BROWSE_PRESETS as readonly string[]).includes(v);
}

/** Parse a positive-integer query param, clamped to [min, max]; any
 * missing/NaN/non-integer/negative value falls back to `dflt`. Never throws. */
function intParam(raw: string | null, dflt: number, min: number, max: number): number {
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/**
 * Strict, bounded, never-throwing parse of the browse query string (doc 02 §8).
 * Unknown/malformed `sort` and `preset` fall back to defaults (score / no
 * filter); `page` is clamped to [1, MAX_PAGE] and `pageSize` is FIXED. This is
 * the whole cacheability contract: the same logical query always parses to the
 * same BrowseParams AND the parsed space is bounded (sorts × presets × MAX_PAGE),
 * so the per-query cache-key space is bounded too — the cache can't be walked into
 * a cold D1 read per request (doc 02 §11).
 */
export function parseBrowseParams(params: URLSearchParams): BrowseParams {
  const sortRaw = params.get("sort");
  const presetRaw = params.get("preset");
  return {
    preset: isBrowsePreset(presetRaw) ? presetRaw : null,
    sort: isBrowseSort(sortRaw) ? sortRaw : "score",
    page: intParam(params.get("page"), 1, 1, MAX_PAGE),
    // FIXED, never read from the query: a caller-varied `?pageSize` would multiply
    // the cache-key cardinality and let `?pageSize=N` cache-bust the list into D1 (§11).
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

/**
 * Canonical cache-key URL for GET /api/v1/servers (doc 02 §11). Re-parses the
 * query through parseBrowseParams and re-serializes the whitelisted params in a
 * FIXED order, so:
 *   - `?sort=players&preset=driftwood` and `?preset=driftwood&sort=players`
 *     collapse to ONE cache entry (param order is not semantic);
 *   - junk params (`?utm=…`) are dropped so they can't fragment the cache;
 *   - genuinely different filters (`?preset=driftwood` vs `?preset=ironcoast`,
 *     `?page=1` vs `?page=2`) map to DIFFERENT entries (they must not collide).
 */
export function canonicalListCacheUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const p = parseBrowseParams(u.searchParams);
  const out = new URLSearchParams();
  if (p.preset !== null) out.set("preset", p.preset);
  out.set("sort", p.sort);
  out.set("page", String(p.page));
  out.set("pageSize", String(p.pageSize));
  return `${u.origin}${u.pathname}?${out.toString()}`;
}

// --- Filter / sort / paginate (doc 02 §8, official pinned) ------------------

/** The fields applyBrowse reads. Callers pass richer rows; the generic keeps
 * every extra display field intact through filter/sort/paginate. */
export interface BrowseableServer {
  official: boolean;
  /** null/"" both mean "custom" for the preset filter. */
  preset: string | null;
  players: number;
  uptimeRatio20d: number;
  name: string;
  score: number;
}

export interface BrowseResult<T> {
  /** The current page's rows (already filtered + sorted). */
  rows: T[];
  /** Total rows AFTER filtering (before pagination). */
  total: number;
  /** Effective page, clamped into [1, pageCount]. */
  page: number;
  pageCount: number;
  pageSize: number;
}

/** A row's preset normalized for filtering: null/"" → "custom". */
function presetOf(preset: string | null): string {
  return preset && preset !== "" ? preset : "custom";
}

/**
 * Apply a BrowseParams to an already-scored list (doc 02 §8): filter by preset,
 * sort with the OFFICIAL row pinned first under EVERY sort, then offset-paginate.
 * Pure and total — an out-of-range page yields an empty page, never an error.
 */
export function applyBrowse<T extends BrowseableServer>(
  all: readonly T[],
  params: BrowseParams,
): BrowseResult<T> {
  const filtered =
    params.preset === null ? all.slice() : all.filter((s) => presetOf(s.preset) === params.preset);

  const sort = params.sort;
  filtered.sort((a, b) => {
    // Pinned regardless of sort (doc 02 §8: the official row is always row #0).
    if (a.official !== b.official) return a.official ? -1 : 1;
    if (sort === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (sort === "players" && b.players !== a.players) return b.players - a.players;
    if (sort === "uptime" && b.uptimeRatio20d !== a.uptimeRatio20d) {
      return b.uptimeRatio20d - a.uptimeRatio20d;
    }
    // "score" default + deterministic tiebreak for players/uptime ties.
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(Math.max(1, params.page), pageCount);
  const start = (page - 1) * params.pageSize;
  return {
    rows: filtered.slice(start, start + params.pageSize),
    total,
    page,
    pageCount,
    pageSize: params.pageSize,
  };
}

// --- Version skew (doc 02 §8/§10) -------------------------------------------

/** The "outdated" badge + score penalty gate: the listing reports a protocol
 * AND it is below the directory's build-time latest. A null protocol (never
 * probed / pre-contract server) is NOT outdated — it is unknown. */
export function isOutdated(protocol: number | null, latestProtocol: number): boolean {
  return protocol !== null && protocol < latestProtocol;
}

// --- Region hint (doc 02 §8: static IATA→region table) ----------------------

// Cloudflare colos are IATA airport codes. This is a COARSE region hint, never
// a latency promise (latency is client-measured by ping.js — that's why
// /api/server-info is CORS-open). Curated common colos map to a continent;
// anything unmapped falls back to the raw code so enthusiasts still see it.
const COLO_REGION: Record<string, string> = {
  // North America
  ATL: "North America", BOS: "North America", DFW: "North America", DEN: "North America",
  EWR: "North America", IAD: "North America", LAX: "North America", MIA: "North America",
  ORD: "North America", SEA: "North America", SJC: "North America", YYZ: "North America",
  YUL: "North America", YVR: "North America", MCI: "North America", PHX: "North America",
  SLC: "North America", TPA: "North America", DTW: "North America", MSP: "North America",
  // Europe
  AMS: "Europe", ARN: "Europe", ATH: "Europe", BCN: "Europe", BRU: "Europe", BUD: "Europe",
  CDG: "Europe", CPH: "Europe", DUB: "Europe", DUS: "Europe", FRA: "Europe", HAM: "Europe",
  HEL: "Europe", LHR: "Europe", LIS: "Europe", MAD: "Europe", MAN: "Europe", MRS: "Europe",
  MUC: "Europe", MXP: "Europe", OSL: "Europe", PRG: "Europe", VIE: "Europe", WAW: "Europe",
  ZRH: "Europe",
  // Asia
  BOM: "Asia", DEL: "Asia", HKG: "Asia", ICN: "Asia", KIX: "Asia", KUL: "Asia", MAA: "Asia",
  NRT: "Asia", SIN: "Asia", TPE: "Asia", BLR: "Asia", CGK: "Asia", HYD: "Asia", BKK: "Asia",
  // Middle East
  DXB: "Middle East", TLV: "Middle East", RUH: "Middle East", DOH: "Middle East",
  // Oceania
  AKL: "Oceania", BNE: "Oceania", MEL: "Oceania", PER: "Oceania", SYD: "Oceania",
  // South America
  EZE: "South America", GIG: "South America", GRU: "South America", SCL: "South America",
  BOG: "South America", LIM: "South America",
  // Africa
  CPT: "Africa", JNB: "Africa", LOS: "Africa", NBO: "Africa", CAI: "Africa",
};

/** Coarse region label for a colo, or the raw code when unmapped; null in → null out. */
export function regionOf(colo: string | null): string | null {
  if (colo === null || colo === "") return null;
  const key = colo.toUpperCase();
  return COLO_REGION[key] ?? key;
}

// --- Detail-page data-shaping (doc 02 §8, pure + unit-tested) ---------------

/** The non-secret `servers` columns the detail page reads (NEVER token_hash /
 * challenge_hash / ip_hash — those never leave the DB, doc 02 §7). */
export interface ServerDetailRow {
  id: string;
  url: string;
  name: string;
  motd: string;
  preset: string | null;
  version: string | null;
  protocol: number | null;
  players: number;
  players_max: number;
  colo: string | null;
  source: string;
  created_at: number;
  last_heartbeat_at: number | null;
  verified_at: number | null;
  last_probe_at: number | null;
}

export interface ServerDetailView {
  id: string;
  name: string;
  motd: string;
  /** Verbatim destination hostname (doc 02 §8: URL host shown verbatim). */
  host: string;
  /** null/"" → "custom" (doc 02 §8). */
  preset: string;
  version: string | null;
  protocol: number | null;
  outdated: boolean;
  /** Display-clamped to maxPlayers (doc 02 §7). */
  players: number;
  maxPlayers: number;
  official: boolean;
  activeNow: boolean;
  region: string | null;
  colo: string | null;
  createdAt: number;
  ageDays: number;
  /** null = no non-verify probe history yet (render "no data", never a false 0%). */
  uptimePct: number | null;
  lastProbeAt: number | null;
  verifiedAt: number | null;
  /** The registration-pinned normalized https origin — used for the ?ref
   * straight-out link and the client-measured ping target (never a probe/beat
   * value, doc 03 §7). */
  joinUrl: string;
  /** Where the Join button points. Official is first-party → straight out;
   * everyone else routes through the /join/:id interstitial (doc 02 §9). */
  joinHref: string;
  joinExternal: boolean;
}

const ACTIVE_WINDOW_MS = 5 * 60_000; // doc 02 §6/§8: heartbeat recency = "active now"

/**
 * Pure detail-page view model (doc 02 §8). Composes isOutdated + regionOf +
 * the display clamps so the .astro template stays declarative and this logic
 * is unit-testable. `uptimeRatio20d` is null when there is no non-verify probe
 * history (kept distinct from 0%).
 */
export function shapeServerDetail(
  row: ServerDetailRow,
  uptimeRatio20d: number | null,
  now: number,
  latestProtocol: number,
): ServerDetailView {
  let host: string;
  try {
    host = new URL(row.url).hostname;
  } catch {
    host = row.url;
  }
  const official = row.source === "official";
  const players = Math.min(row.players, row.players_max);
  return {
    id: row.id,
    name: row.name,
    motd: row.motd,
    host,
    preset: presetOf(row.preset),
    version: row.version,
    protocol: row.protocol,
    outdated: isOutdated(row.protocol, latestProtocol),
    players,
    maxPlayers: row.players_max,
    official,
    activeNow: row.last_heartbeat_at !== null && now - row.last_heartbeat_at < ACTIVE_WINDOW_MS,
    region: regionOf(row.colo),
    colo: row.colo,
    createdAt: row.created_at,
    ageDays: Math.max(0, Math.floor((now - row.created_at) / 86400_000)),
    uptimePct: uptimeRatio20d === null ? null : Math.round(uptimeRatio20d * 100),
    lastProbeAt: row.last_probe_at && row.last_probe_at > 0 ? row.last_probe_at : null,
    verifiedAt: row.verified_at,
    // row.url is the registration-pinned normalized https origin (doc 03 §7).
    joinUrl: row.url,
    joinHref: official ? `${row.url}/?ref=worldspring-directory` : `/join/${row.id}`,
    joinExternal: official,
  };
}

// --- List-row data-shaping (doc 02 §8) --------------------------------------

/** The non-secret `servers` columns the list reads. */
export interface ListRow {
  id: string;
  url: string;
  name: string;
  motd: string;
  preset: string | null;
  version: string | null;
  protocol: number | null;
  players: number;
  players_max: number;
  colo: string | null;
  source: string;
  created_at: number;
  last_heartbeat_at: number | null;
}

export interface ListedServer extends BrowseableServer {
  id: string;
  name: string;
  motd: string;
  /** = the registration-pinned normalized https origin (never a probe/beat value). */
  joinUrl: string;
  host: string;
  preset: string | null;
  version: string | null;
  protocol: number | null;
  players: number;
  maxPlayers: number;
  colo: string | null;
  region: string | null;
  official: boolean;
  activeNow: boolean;
  outdated: boolean;
  /** false = no non-verify probes yet → render "—", never a false 0%. */
  hasUptime: boolean;
  uptimeRatio20d: number;
  createdAt: number;
  score: number;
}

/**
 * Pure list-row view model (doc 02 §8). `uptimeRatio20d` is undefined when the
 * server has no non-verify probe history yet (distinct from a real 0%).
 */
export function shapeListedServer(
  row: ListRow,
  uptimeRatio20d: number | undefined,
  now: number,
  latestProtocol: number,
): ListedServer {
  const ratio = uptimeRatio20d ?? 0;
  const players = Math.min(row.players, row.players_max); // display clamp (doc 02 §7)
  let host: string;
  try {
    host = new URL(row.url).hostname;
  } catch {
    host = row.url;
  }
  return {
    id: row.id,
    name: row.name,
    motd: row.motd,
    joinUrl: row.url,
    host,
    preset: row.preset,
    version: row.version,
    protocol: row.protocol,
    players,
    maxPlayers: row.players_max,
    colo: row.colo,
    region: regionOf(row.colo),
    official: row.source === "official",
    activeNow: row.last_heartbeat_at !== null && now - row.last_heartbeat_at < ACTIVE_WINDOW_MS,
    outdated: isOutdated(row.protocol, latestProtocol),
    hasUptime: uptimeRatio20d !== undefined,
    uptimeRatio20d: ratio,
    createdAt: row.created_at,
    score: score(
      {
        players,
        players_max: row.players_max,
        protocol: row.protocol,
        created_at: row.created_at,
        uptimeRatio20d: ratio,
      },
      latestProtocol,
      now,
    ),
  };
}
