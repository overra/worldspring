# 03 — The Server Info Contract: `/api/server-info`, heartbeats, and cost-aware stats serving

Status: design, ready to implement. Depends on shared vocabulary from doc 01 (deploy flow —
bakes `DIRECTORY_TOKEN`/`DIRECTORY_URL` into community deploys) and doc 02 (directory worker
in `site/` — consumes heartbeats and probes). This doc is the contract both build on.

## Summary

Every Worldspring server — official or community — exposes **`GET /api/server-info`**: a
versioned, additive-only JSON document (`ServerInfo`, types in a new `packages/shared/src/serverInfo.ts`)
carrying identity (`name`, `motd`, `joinUrl`), compatibility (`gameVersion`,
`protocolVersion` — a new `PROTOCOL_VERSION` constant in `packages/shared/src/protocol.ts`, carried
in both `join` and `welcome` as a **two-sided** hard join gate: the server rejects
mismatched clients before touching any character state, the client refuses older
servers), rules badges (`rules: RulesSummary` derived
from `ServerConfig` in the new `packages/shared/src/config.ts`), and liveness (`players`/`maxPlayers`,
`status`, `uptimeS`, `worldAgeS`, optional `colo`). The existing `/api/health` is **kept
unchanged** as the unversioned ops endpoint; `/api/server-info` is the public contract.
Serving is **DO-with-cheap-read fronted by a per-isolate micro-cache in the Worker** — no new
bindings, never starts the tick, never keeps an idle DO awake; the Cache API is rejected
because its contents are colo-local (a DO-side put is invisible to every other colo), and
`*.workers.dev` — where community servers live — is absent from its documented
functional-support list besides. Freshness for
the directory comes from **push heartbeats** (`POST {DIRECTORY_URL}/api/heartbeat`, bearer
token): a `boot` beat when the tick starts, debounced `edge` beats on player-count change,
`periodic` beats every 60s ±10s jitter while occupied, and a final `quiet` beat when the room
goes idle — so the directory never needs to poll an occupied server and can suspend probing
idle ones. The token authenticates *who is updating a listing*, never *what is true*; truth
comes from directory-side probes of `/api/server-info` against the **registration-pinned
origin** (heartbeats cannot move `joinUrl`). Forward compatibility is contractual:
additive-only fields, mandatory unknown-field tolerance, `schemaVersion` bumps only on
breaking changes.

## Goals / Non-goals

**Goals**

- One boring, versioned, public endpoint any consumer (the `site/` directory, third-party
  list sites, a `curl` in a README) can hit to render a server card with live stats.
- A heartbeat protocol that gives the directory near-real-time player counts **without the
  directory polling occupied servers** and **without waking idle ones**.
- Zero new bindings, zero secrets beyond the directory token doc 01 already bakes, zero
  marginal cost that matters on the Cloudflare free plan (the math is in
  `docs/plans/research/cf-costs.md`).
- A `PROTOCOL_VERSION` that makes the deterministic-sim version gate real (the
  Factorio-precedent hard gate from `docs/plans/research/directory-prior-art.md` §3).
- Explicit forward-compat rules, because community servers update on their own schedule and
  the directory must keep rendering year-old deployments.

**Non-goals**

- The directory's own API, storage, ranking, eviction policy, probe scheduler — doc 02.
- Registration/token issuance flow and how the token gets into the deploy — doc 01.
- The full `ServerConfig`/`PRESETS` design (gameplay knobs, how they reach the client) —
  owned by the config doc; this doc only consumes a derived `RulesSummary` from it.
- Player-name samples, icons/favicons, password-protected servers — all additive later
  within `schemaVersion: 1` (see forward-compat rules).
- Fixing the `persistAll` write amplification or `INPUT_SEND_MS` (cf-costs.md levers 1–2) —
  separate work; this design just refuses to add to those bills.

## Current state

Verified against this worktree:

- **Worker routing** (`apps/game/src/server/worker.ts:6-22`): `/ws` (426 without Upgrade header),
  `/api/leaderboard`, `/api/health` forward to the single DO via `env.GAME.getByName("main")`;
  everything else 404s at `worker.ts:20`. Static assets are served platform-first; browser
  *navigation* requests to non-asset paths get `index.html` without invoking the Worker
  (SPA `not_found_handling`, `wrangler.jsonc:6-8`; gotcha documented in
  `docs/plans/research/codebase-server.md` §1).
- **`/api/health`** (`apps/game/src/server/GameRoom.ts:175-197`): returns
  `{players, zombies, animals, drops, corpses, loot, tickMsEma, tickMsMax, tick, uptime}`
  from in-memory state only, with the explicit comment "we never wake the sim to answer"
  (GameRoom.ts:173-174). CORS `*` (GameRoom.ts:191-195). Two consumer notes: `players` is
  `game.players.size`, which **includes offline lingering bodies**, and `uptime` is
  `game.time` — **world age, which persists across restarts via SQLite meta** — not process
  uptime. The loadtest harness consumes this endpoint verbatim (`apps/game/scripts/loadtest.mjs:331,
  394`), so its shape is load-bearing for tooling.
- **Tick lifecycle**: `startTicking()` is only called from `fetch` on a WebSocket upgrade
  (GameRoom.ts:209, 367-370). The tick stops via `stopAndPersist` (GameRoom.ts:613-622) from
  `dropSocket` (GameRoom.ts:562-569) or the tick's own zero-sockets/no-lingers check
  (GameRoom.ts:631-634). A plain HTTP request to the DO **does not start the tick** — it
  cold-starts the object (constructor runs `initSchema` + `pruneStaleCharacters`,
  GameRoom.ts:153-161) and bills one DO request (1:1, not the 20:1 WS ratio — cf-costs.md §1),
  after which the DO can be evicted again. This is the precedent the new endpoint extends.
- **Connected-player counting precedent**: `handleJoin`'s capacity check counts only
  non-offline players (GameRoom.ts:466-473) — the correct semantics for a public "players
  online" number.
- **Protocol**: JSON discriminated unions on `t` (`packages/shared/src/protocol.ts`); `welcome`
  carries `seed` (protocol.ts:194-206, sent at GameRoom.ts:514-524). **No wire version field
  exists anywhere** — `PROTOCOL_VERSION` must be created (gap flagged in
  `docs/plans/research/directory-prior-art.md` §9.4).
- **Sanitization precedent**: `STRIP_TEXT_RE` (`apps/game/src/server/systems/players.ts:41`) strips
  controls/zero-width/bidi; `sanitizeName` (players.ts:46) caps by code points. Names and
  chat both reuse it; server name and MOTD will too.
- **Env surface**: exactly one binding (`GAME`), zero vars, zero secrets
  (`wrangler.jsonc:9-16`; `worker-configuration.d.ts`). `packages/shared/src/` has no `config.ts`,
  `serverInfo.ts`, or `version.ts` yet (verified by listing).
- **Costs** (all from `docs/plans/research/cf-costs.md`): free plan = 100K DO requests/day,
  100K Worker requests/day, 13K GB-s duration/day; HTTP DO requests bill 1:1; outbound
  `fetch` from Worker or DO is an **unbilled subrequest**; DO alarms bill a request *and* a
  row written per fire; duration bills only while running or pinned in memory — an idle DO
  with no sockets and no timers is evictable and effectively free.

## Design

### 1. Version constants — three axes, never conflated

| Constant | Lives in | Type | Meaning | Bump when |
| --- | --- | --- | --- | --- |
| `PROTOCOL_VERSION` | `packages/shared/src/protocol.ts` | `number`, starts `1` | Wire + sim compatibility: a client and server with equal values can play together (messages parse, shared sim is deterministic-identical) | Any breaking change to `ClientMsg`/`ServerMsg` shapes or semantics, to `packages/shared/src/movement.ts`/`world.ts` behavior the client predicts, or to `ItemType` wire enums |
| `GAME_VERSION` | `packages/shared/src/version.ts` (new) | `string`, semver, starts `"0.1.0"` | Human-readable build label for display only. Never gate on it | Every release; hand-maintained one-liner |
| `SERVER_INFO_SCHEMA_VERSION` | `packages/shared/src/serverInfo.ts` (new) | `number`, starts `1` | Shape of the `ServerInfo` document and `HeartbeatBody` | Breaking schema change only (see §10) |

`PROTOCOL_VERSION` is enforced on **both ends of the wire** — a one-directional check is
not a gate:

- **Server side — the only enforcement that binds clients we don't ship.** `join` gains
  `proto?: number` (today it is `{ t: "join"; name: string; token: string }`,
  protocol.ts:45; `parseClientMsg` validates the new field as a finite number when
  present). `handleJoin` checks it **first** — before the token hash, before character
  create/restore, before any `persistAll` call or "joined" notice broadcast
  (GameRoom.ts:407-505) — and answers a mismatch with
  `{ t: "error", msg: "incompatible version" }` followed by a socket close. While
  `PROTOCOL_VERSION === 1`, an *absent* `proto` is accepted: pre-gate clients (stale
  cached bundles of the official instance, old fork builds) predate the field and are
  sim-compatible with version 1 by definition. The moment `PROTOCOL_VERSION` bumps to
  2+, absent `proto` is rejected like any other mismatch — those clients contain no
  gate code and can never be stopped client-side; the server check is the only closure.
  Rejecting before `handleJoin` does any work also means a refused client never
  creates/restores a character, never persists, and never leaves the defenseless
  offline body that a post-join disconnect lingers for `LOGOUT_LINGER_S`
  (dropSocket, GameRoom.ts:538-547; constants.ts:176).
- **Client side — the direction the server check cannot cover.** `welcome` gains
  `proto: number` (additive — today's client ignores unknown fields because it
  destructures named properties). The client compares `msg.proto !== PROTOCOL_VERSION`
  — treating *absent* as mismatch — and shows a hard "this server runs an incompatible
  version" error instead of building the world. This catches a new client joining an
  old server. Note the asymmetry honestly: by the time `welcome` arrives, an old server
  has already created/restored and persisted the character (welcome is sent at the end
  of its join handling, GameRoom.ts:444/486/502) — the client gate prevents the desync,
  not the server-side state. Only updating the server fixes that side.

Together these are the Factorio-style hard gate: the deterministic shared sim makes a
soft warning a lie — mismatched sims desync. `SCHEMA_VERSION` in
`apps/game/src/server/persistence.ts:34` is a fourth, *server-private* axis (SQLite shape +
worldgen wipes) and is deliberately not exposed.

### 2. `ServerInfo` — full types

New file `packages/shared/src/serverInfo.ts` (shared so the game worker, the `site/` directory
worker, and the client can all import it; the `site/` worker imports via relative path —
same repo):

```ts
// packages/shared/src/serverInfo.ts
// The public server-info contract. Versioned and boring-stable: community
// servers update on their own schedule, so this file changes by ADDITION only
// within a schema version. See docs/plans/03-server-info-contract.md.

/** Bump ONLY on breaking changes (field removal/rename/retype/resemantic). */
export const SERVER_INFO_SCHEMA_VERSION = 1;

/**
 * Compact, render-ready rules summary. Derived from ServerConfig by
 * summarizeRules() in packages/shared/src/config.ts — the directory renders these as
 * badges and MUST NOT need to understand full ServerConfig. The FIELD SET is
 * owned by doc 04 §6 (which specs the banding thresholds, the closed preset
 * union, and the directory-side ingest whitelist rules); an earlier sketch
 * here (pvp/zombies booleans + raw multipliers) is superseded by doc 04's
 * banded, injection-resistant shape:
 */
export interface RulesSummary {
  /** Closed union over the shipped PRESETS keys, or "custom" — never free text. */
  preset: "deadcoast" | "driftwood" | "ironcoast" | "warpath"
    | "homestead" | "nightfall" | "custom";
  zombies: "off" | "sparse" | "normal" | "horde";
  pvp: boolean;
  fullLoot: boolean;
  loot: "scarce" | "normal" | "plentiful";
  vitals: "gentle" | "normal" | "harsh";
  night: "cycle" | "always" | "never";
  dayLengthMin: number;
  worldSize: WorldSizeTier;   // type-only import from packages/shared/src/config.ts
  maxPlayers: number;
  wipe: WipeSchedule;         // type-only import from packages/shared/src/config.ts
}

export type ServerStatus = "occupied" | "idle";

export interface ServerInfo {
  /** SERVER_INFO_SCHEMA_VERSION of the responding server. */
  schemaVersion: number;
  /** GAME_VERSION (semver string). Display only — never gate on it. */
  gameVersion: string;
  /** PROTOCOL_VERSION. Equality with the client's value is a hard join gate. */
  protocolVersion: number;
  /** World seed (already public — every welcome message carries it). */
  worldSeed: number;
  /**
   * Server display name, 1..MAX_SERVER_NAME_LENGTH code points. UNTRUSTED
   * operator-controlled text: sanitization strips controls/zero-width/bidi
   * only, NOT HTML metacharacters. Render as text, never HTML (§10 rule 8).
   */
  name: string;
  /**
   * Message of the day, 0..MAX_MOTD_LENGTH code points. Same trust posture
   * as `name`: untrusted text, render-as-text only (§10 rule 8).
   */
  motd: string;
  /** Rules badges (see RulesSummary). */
  rules: RulesSummary;
  /** CONNECTED players (excludes offline lingering bodies). 0 while idle. */
  players: number;
  /** MAX_PLAYERS of this build/config. */
  maxPlayers: number;
  /** "occupied" while the tick interval is running, else "idle". */
  status: ServerStatus;
  /** Wall-clock seconds since the current occupied session began; 0 if idle. */
  uptimeS: number;
  /** Total game-time seconds of this world (persists across restarts). */
  worldAgeS: number;
  /**
   * Cloudflare colo hint (IATA code, e.g. "DFW") for where the Durable
   * Object lives — a coarse region hint, NOT a latency promise. null when
   * unknown. Consumers must treat latency as client-measured (CORS is open
   * for exactly that reason).
   */
  colo: string | null;
  /**
   * Canonical https origin of this server's playable client, e.g.
   * "https://my-server.someone.workers.dev". The WebSocket endpoint is
   * always `wss://<host>/ws`. The directory pins the origin at registration
   * and IGNORES this field from BOTH channels — heartbeat values and probe
   * bodies alike (anti-redirect, §7/§9); only re-registration moves it.
   * Everyone else gets no such protection: UNTRUSTED like every string here.
   * Consumers MUST parse it, require protocol "https:" and a plausible
   * hostname, and discard it otherwise — never interpolate it into an href
   * unvalidated (§10 rule 8).
   */
  joinUrl: string;
  /**
   * Doc 02's URL-control proof: sha256hex("worldspring-directory-challenge:" +
   * DIRECTORY_TOKEN), computed once and cached module-level; null when
   * DIRECTORY_TOKEN is unset. Publishing it leaks nothing (preimage
   * resistance over a 256-bit secret) and grants nothing — heartbeat auth
   * requires the full token. The directory compares it against the
   * challenge_hash stored at mint (doc 02 §2/§5).
   */
  directoryChallenge: string | null;
}
```

Field sourcing (server side):

| Field | Source | Idle-safe? |
| --- | --- | --- |
| `schemaVersion`, `gameVersion`, `protocolVersion`, `worldSeed`, `maxPlayers`, `rules` | compile-time constants / `ServerConfig` | yes |
| `name`, `motd` | `env.SERVER_NAME` / `env.SERVER_MOTD` vars, falling back to built-in code defaults (`"Worldspring"` / `""` — doc 04's `ServerConfig` deliberately carries no name/motd fields); sanitized with `STRIP_TEXT_RE` + code-point caps at read. `STRIP_TEXT_RE` (players.ts:41) removes controls/zero-width/bidi **only** — `<` `>` `&` and quotes pass through, hence §10 rule 8 | yes |
| `players` | count of non-offline players in `this.game` (the GameRoom.ts:466-473 loop), `0` when `game === null` | yes |
| `status` | `this.tickHandle !== null ? "occupied" : "idle"` | yes |
| `uptimeS` | `Date.now() - this.activeSince` (new field set in `startTicking`, cleared in `stopTicking`); `0` when idle | yes |
| `worldAgeS` | `this.game?.time` if live, else one SQLite read of `meta.game_time` (rows read are nearly free — 5M/day free cap) | yes |
| `colo` | self-measured once per occupied session (see §8), persisted to `meta.colo`; `null` until known | yes |
| `joinUrl` | `this.publicOrigin`: the DO captures `new URL(request.url).origin` in `fetch` on **every** request it sees (WS upgrades and `/api/server-info` alike), keeping it in memory and mirroring it to a `meta.origin` row; a cold-started DO restores it from `meta.origin`. Heartbeats read the same field — beats fire only while occupied, and occupancy always begins with a WS upgrade through `fetch` (GameRoom.ts:209), so the origin is always known before any beat fires. The GET handler may equally use its own request's origin; the captured field exists for the request-less beat contexts (§6) | yes |
| `directoryChallenge` | `sha256hex("worldspring-directory-challenge:" + env.DIRECTORY_TOKEN)`, computed once per isolate and cached module-level; `null` when the secret is unset (doc 02 §2) | yes |

`name`/`motd` as vars is deliberate: they are cosmetic, server-only, and doc 01's deploy
flow can set them without a rebuild. Everything in `rules` derives from the resolved
deploy-time `ServerConfig` (doc 04's `GAME_CONFIG` var, resolved once in the GameRoom
constructor and shipped whole in `welcome.config` — config is NOT compile-time; doc 04 §4
owns that flow), so the badges always describe the rules the sim is actually running.

### 3. Endpoint spec — `GET /api/server-info`

- **Route**: added to the Worker's if-chain (`worker.ts:16-19` pattern) and the DO `fetch`
  (`GameRoom.ts:163-197` pattern). The DO handler **must not** call `ensureGame()` or
  `startTicking()` — same discipline as `/api/health`.
- **Method**: `GET`. `HEAD` passes through to the DO **uncached** — whether the platform
  strips response bodies for HEAD somewhere between the DO stub and the client is
  undocumented either way, so a HEAD must never populate the shared micro-cache entry: if
  bodies are stripped, the cached empty-body 200 would feed every GET consumer (directory
  probes included) a blank document for a full TTL, and one HEAD per 15s keeps it
  permanently poisoned — a cheap targeted delisting attack (§5 sketch enforces the method
  check). `OPTIONS` answered by the *Worker* with `204`,
  `access-control-allow-origin: *`, `access-control-allow-methods: GET`, without touching
  the DO. No preflight is ever required for the simple GET, but answering OPTIONS cheaply
  is polite.
- **Response**: always `200` with `content-type: application/json` and a complete
  `ServerInfo` body — **including while idle** (`players: 0, status: "idle"`). Idle is not
  an error. Target body size well under 4 KB.
- **Headers**: `access-control-allow-origin: *`;
  `cache-control: public, max-age=15, stale-while-revalidate=30` (advisory — browsers honor
  it; the workers.dev edge does not cache Worker responses, see §5).
- **SPA gotcha (documented, not fixed)**: typing the URL into a browser address bar returns
  the game's `index.html` (navigation requests bypass the Worker —
  codebase-server.md §1). All real consumers use `fetch`/`curl`, which work. Do **not** add
  `run_worker_first` for this.
- **Failure modes**: there are none worth special-casing — the DO answer is synchronous
  in-memory/SQLite reads. A `5xx` means the platform broke, and consumers should treat it
  like a timeout (server unreachable). The Worker micro-cache (§5) must never mask that
  signal: it caches **only `res.ok` responses** and passes non-OK DO responses through
  uncached with their real status — a cached error replayed as `200` would lie to every
  probe for a full TTL.

### 4. `/api/health` — keep both, do not merge

Decision: **keep `/api/health` exactly as is; add `/api/server-info` beside it.**

- `/api/health` is the *ops* endpoint: tick timing EMA/max, entity counts — internals that
  should stay free to evolve without a versioning ceremony. The loadtest harness depends on
  its current shape (`apps/game/scripts/loadtest.mjs:331, 394`); changing it buys nothing.
- `/api/server-info` is the *product* endpoint: versioned, additive-only, public contract.
  Directory, third parties, and the official client read this one.
- Merging would either freeze the ops shape under the compat rules (bad) or version the ops
  internals (pointless). Two endpoints, two stability promises, one DO handler file.
- One field of `/api/health` is corrected *in the new endpoint rather than in place*:
  `players` means *connected* in `ServerInfo` (health's includes lingering bodies), and
  world age gets an honest name (`worldAgeS` vs health's mislabeled `uptime`).

### 5. Cost-aware serving strategy

The constraint set: the GameRoom DO ticks only while players are connected
(GameRoom.ts:209, 631-634); directory/third-party polling must not keep idle community DOs
awake or wake them when avoidable; community deploys get **no extra bindings**; free-plan
caps are 100K DO req/day and 100K Worker req/day (cf-costs.md §1).

Options considered:

| Option | Verdict |
| --- | --- |
| **(A) DO cheap-read + per-isolate micro-cache in the Worker** | **Chosen.** No bindings; works on `*.workers.dev`; a poll costs 1 Worker request + at most 1 DO request per `SERVER_INFO_CACHE_TTL_S` per isolate; never starts the tick; idle answer is correct and cheap. |
| (B) Cache API (`caches.default`) in the Worker, DO pushes on change | **Rejected — disqualified by documented colo-locality alone.** The cache "do[es] not replicate outside of the originating data center" (<https://developers.cloudflare.com/workers/runtime-apis/cache/> — verified 2026-06-11), so a DO-side `cache.put` would never be visible to a Worker isolate answering in another colo; push-to-cache cannot work on this platform regardless of domain. Secondarily: the availability docs enumerate functional cache ops for Workers on custom domains and for Pages functions (incl. `*.pages.dev`); `*.workers.dev` — where community servers live (cf-deploy.md) — is conspicuously absent from that list and widely reported non-functional, but the page never states the no-op outright, so treat that part as inference-from-omission to verify empirically before ever relying on it either way. |
| (C) DO alarm pushes periodic stats somewhere | **Rejected.** Every alarm fire bills a DO request and a row written, and scheduled work on an idle room is exactly what cf-costs.md lever 3 says to never add. There is also nowhere to push *to* without a binding. |
| (D) KV/D1 stats mirror | **Rejected by constraint** — extra binding in every community deploy, plus KV writes bill. Fine for the official instance someday; not the contract. |

The chosen shape, concretely:

```ts
// apps/game/src/server/worker.ts — micro-cache in module scope (per-isolate; that's fine,
// each isolate refreshes at most once per TTL and isolates are bounded).
interface InfoCacheEntry {
  body: string;
  expiresAt: number;
}
const infoCache = new Map<string, InfoCacheEntry>(); // keyed by origin

async function serveServerInfo(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    // HEAD (and anything else): pass through, never cache. Whether the
    // platform strips bodies for HEAD at the DO-stub boundary is
    // undocumented — if it does, caching this response would poison the
    // shared origin-keyed entry with an empty body for every GET consumer
    // (directory probes included) for a full TTL. See §3.
    return env.GAME.getByName("main").fetch(request);
  }
  const origin = new URL(request.url).origin;
  const cached = infoCache.get(origin);
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=15, stale-while-revalidate=30",
  };
  if (cached && Date.now() < cached.expiresAt) {
    return new Response(cached.body, { headers }); // only 200s are ever cached
  }
  const stub = env.GAME.getByName("main");
  const res = await stub.fetch(request);
  const body = await res.text();
  if (!res.ok) {
    // Never cache or mask a failure: §3/§7 read non-200 as unreachability,
    // and replaying an error as a fresh 200 would lie to probes for the TTL.
    return new Response(body, { status: res.status, headers });
  }
  infoCache.set(origin, {
    body,
    expiresAt: Date.now() + SERVER_INFO_CACHE_TTL_S * 1000,
  });
  return new Response(body, { headers });
}
```

Why this satisfies the constraints:

- **Idle DOs stay idle.** A cache miss wakes the DO for one cold-start request
  (constructor + synchronous reads — no `ensureGame`, no tick, GameRoom.ts:173-174
  precedent), after which it is evictable again. Duration cost is milliseconds of the
  13K GB-s/day budget. And §6 means the directory rarely polls at all.
- **The math** (cf-costs.md): a directory probing every 5 minutes costs a community server
  288 DO requests/day — 0.3% of the free cap. Even a rude third-party poller at 1/min is
  1,440/day (1.4%), and the micro-cache collapses anything faster. The binding limit on
  poll abuse is the *Worker* request cap (100K/day) — see §9.
- **Honesty about the micro-cache**: it is per-isolate and per-colo, so worst-case DO load
  is `(number of isolates) / TTL`, not `1 / TTL`. Isolate counts for a low-traffic worker
  are small; this is a burst absorber, not a precision rate limiter, and that is enough.

New constants (`packages/shared/src/constants.ts`, new `// --- Server info & directory ---` section,
per the all-tunables-in-constants contract):

```ts
export const SERVER_INFO_CACHE_TTL_S = 15;
export const MAX_SERVER_NAME_LENGTH = 32;
export const MAX_MOTD_LENGTH = 140;
export const HEARTBEAT_INTERVAL_S = 60;
export const HEARTBEAT_JITTER_S = 10;
// The floor between ANY two beats from one sender: edge beats are debounced
// to one per this window, and every sent beat reschedules the periodic timer
// (§6) — so this is also the cap on legal sustained send rate (3/min). Must
// stay above the directory intake refill period (§9: 15s) with headroom — a
// compliant sender must never be able to trip the directory's rate limit,
// and §9's sizing arithmetic depends on the reschedule rule.
export const HEARTBEAT_EDGE_DEBOUNCE_S = 20;
```

### 6. Heartbeats — push-primary

Community servers (and the official one) push state to the directory; the directory polls
only to verify. Sender-side **billing** cost is zero: outbound `fetch` from a DO is an
unbilled subrequest (cf-costs.md §1). Billing is not the only budget, though —
**UNCONFIRMED** (mirroring §8's colo marker): the free plan also caps subrequests at 50
per *invocation* (10,000 paid), and neither the Workers limits page, the DO limits page,
nor the DO FAQ documents which invocation budget a fetch fired from a `setInterval`
callback in a long-lived DO counts against (checked 2026-06-11). If the runtime
attributes interval-driven fetches to one long-lived context (e.g. the WS upgrade that
started the tick), a 2-hour occupied session (~120 periodic beats + edge beats + the §8
trace fetch) blows the 50-cap mid-session and beats start throwing "Too many
subrequests" — exactly on the free-plan community servers this design targets. M3's
acceptance therefore includes a ≥2h occupied soak.

If the soak fails, the fallback is to defer beat sends into event-handler invocations
instead of the interval callback — named here so the implementer is not making an
architectural decision mid-milestone, with honesty about what it does and does not cover:

- **Its premise is exactly as UNCONFIRMED as the primary risk.** "Each incoming
  WS-message delivery gets a fresh subrequest budget" appears in no Cloudflare doc
  either (same three pages, same 2026-06-11 check). M3 includes a 30-minute spike that
  verifies it empirically *before* the fallback is built.
- **The `boot` beat is safe under either model**: `startTicking` runs inside `fetch`
  (GameRoom.ts:209) — an unambiguously fresh invocation.
- **`periodic` and `edge` beats defer cleanly**: while sockets are connected a WS
  message arrives every ~50ms, and `webSocketMessage` can drain the same
  dirty-flag/`nextBeatAt` state the tick would have.
- **The `quiet` beat is the hard case, and a naive deferral strands it.** The dominant
  end-of-session path never sees another WS message: when the last leaver is alive,
  `dropSocket` marks them offline and the room enters a zero-socket linger
  (GameRoom.ts:538-547; up to `LOGOUT_LINGER_S` = 60s, constants.ts:176), and the tick
  later finds zero sockets + no lingers and calls `stopAndPersist` from inside the
  interval callback (GameRoom.ts:631-634 → 613-622) — no message-handler invocation is
  left to defer into. Only the rarer dead-player disconnect reaches `stopAndPersist`
  inside a `webSocketClose` invocation (GameRoom.ts:568). The fallback therefore
  **moves** the quiet beat: send it from whichever `dropSocket` call takes the room to
  zero sockets (a `webSocketClose` invocation in both branches), constructing the body
  as the quiet shape (`players: 0`, `status: "idle"`, `uptimeS: 0`) as an explicit
  promise of imminent idleness rather than the §2 live derivation (the tick is still
  running at that moment when a linger begins) — semantics: "quiet within
  ≤`LOGOUT_LINGER_S`". During the message-less linger window no further beats can be
  sent; acceptable, because the quiet beat already fired and connected `players` is
  already 0. One contract consequence, binding on doc 02 and stated in §7: **any
  accepted beat ends quiet-suspension, not just `boot`** — a reconnect during the
  linger never fires `boot` (`startTicking` is already running), so the first
  post-quiet beat may be an `edge`. The rule is harmless under the primary design and
  required under the fallback.
- **The verified last resort**, if the spike disproves per-message budgets too: drop
  push for periodic freshness and let the directory poll *occupied* servers over the
  §7 poll-secondary channel (5-minute cadence = 288 DO req/day per polled server — §5
  math, cf-costs.md §5), keeping the `boot` beat (safe per above) as the occupancy
  signal. Worse freshness, known cost, zero reliance on undocumented platform
  behavior.

**Transport**: `POST {env.DIRECTORY_URL}/api/v1/heartbeat` (doc 02's versioned API
namespace) with `Authorization: Bearer {env.DIRECTORY_TOKEN}` and a JSON body. Both env
values are optional vars/secrets baked by doc 01's flow; **when either is unset, the
heartbeat subsystem is completely inert** (the official instance before registration,
local dev, forks that opt out). Token format (doc 02 §2 owns it):
`dcd1.<serverId>.<secretHex>` — `serverId` a 26-char ULID identifying the listing,
`secretHex` 32 random bytes hex; self-contained (one secret to set, no separate ID var),
issued by the directory at registration. The same token is what the server hashes into
the public `directoryChallenge` field (§2; doc 02 §2's challenge scheme).

```ts
// packages/shared/src/serverInfo.ts (continued)

export type HeartbeatEvent = "boot" | "edge" | "periodic" | "quiet";

export interface HeartbeatBody {
  /** SERVER_INFO_SCHEMA_VERSION of the sender. */
  schemaVersion: number;
  /** Why this beat was sent (directory uses it for staleness bookkeeping). */
  event: HeartbeatEvent;
  /** Sender wall clock, epoch ms. Directory rejects beats older than 5 min
   *  or older than the newest beat it has accepted for this listing. */
  sentAt: number;
  /** Same document /api/server-info serves. joinUrl comes from the captured
   *  origin (`this.publicOrigin`, §2 sourcing table — beats have no Request
   *  in scope). joinUrl and colo are advisory: the directory pins origin at
   *  registration and may override colo with what it observes. */
  info: ServerInfo;
}
```

**When beats fire** (all from inside the already-running tick or its lifecycle hooks — no
timers, no alarms, nothing that can keep an idle room billable):

| Event | Trigger | Notes |
| --- | --- | --- |
| `boot` | `startTicking()` transitions idle→occupied (GameRoom.ts:367-370) | Tells the directory "I woke up"; resumes its trust in push freshness |
| `edge` | Connected-player count changed — i.e. **any `handleJoin`/`dropSocket` mutation of the connected set**: the three join paths (GameRoom.ts:461, 487, 503), `dropSocket` marking an alive leaver offline (GameRoom.ts:542-547), and `dropSocket` deleting a dead-but-connected player (death-screen disconnect: `offline === false`, `alive === false` — the `else` branch at GameRoom.ts:548-552 removes a player the §2 count was including, so the dirty flag must be set in **both** branches or the directory shows a count one too high until the next periodic). Linger expiry (GameRoom.ts:643-650) is **not** a trigger — it removes only already-`offline` bodies, which the §2 connected count already excludes, so it can never change `players` | Debounced: set a dirty flag; the tick sends at most one edge beat per `HEARTBEAT_EDGE_DEBOUNCE_S` (trailing edge, so the final count wins) |
| `periodic` | Tick checks `now >= nextBeatAt`; reschedules `nextBeatAt = now + HEARTBEAT_INTERVAL_S + uniform(-HEARTBEAT_JITTER_S, +HEARTBEAT_JITTER_S)`. **Every sent beat of any event type performs the same reschedule** — a beat carries the full `ServerInfo`, so a periodic right behind an edge adds nothing, and the reset is what caps the legal sustained send rate at 1 beat per `HEARTBEAT_EDGE_DEBOUNCE_S` (§9's intake sizing depends on it) | Jitter prevents thundering-herd alignment at the directory (Math.random is fine — this is infra, not sim; never touch the seeded worldgen streams) |
| `quiet` | `stopAndPersist` (GameRoom.ts:613-622), **after** `stopTicking()` — the beat call is appended as the new last line of `stopAndPersist`, so the §2 derivations naturally read post-stop values. (Primary design only — the §6 fallback above relocates this beat to `dropSocket`, with an explicitly constructed body) | `info.players === 0`, `info.status === "idle"`, `info.uptimeS === 0` (firing before `stopTicking` would self-contradict: `tickHandle` is still set and `activeSince` uncleared, yielding "occupied" with nonzero uptime). The "going-quiet" promise: an idle server is *intentionally* quiet, not dead |

**Sender contract (what the directory may rely on)**: while occupied, the gap between
accepted beats is at most `HEARTBEAT_INTERVAL_S + HEARTBEAT_JITTER_S + slack ≈ 90s`. After
a `quiet` beat, silence is normal and indefinite. Any accepted beat ends the silence —
normally a `boot`, possibly an `edge` under the fallback (§7's suspension rule matches).

**Sender implementation sketch** (`apps/game/src/server/heartbeat.ts`, called from GameRoom):

```ts
// Fire-and-forget: a heartbeat must never block or break the tick.
export function sendHeartbeat(env: Env, body: HeartbeatBody): void {
  const url = env.DIRECTORY_URL;
  const token = env.DIRECTORY_TOKEN;
  if (!url || !token) return;
  void fetch(`${url}/api/v1/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (res.status === 401 || res.status === 410) {
        // Revoked/delisted: log loudly and disarm until next DO restart —
        // retrying an invalid token is just noise at the directory.
        console.error(`directory rejected heartbeat: ${res.status}`);
      }
      return undefined;
    })
    .catch((err: unknown) => {
      console.warn(`heartbeat failed: ${String(err)}`);
    });
}
```

Failure handling: on network failure or `5xx`, exponential backoff on the periodic cadence
(60s → 120s → … cap 15 min), reset on success; `edge` beats are suppressed while backing
off. On `429`, honor `Retry-After`. The in-flight fetch briefly holds the DO alive during
the `quiet` beat — acceptable (sub-second) and unavoidable without an alarm, which would
cost more.

### 7. Push-primary / poll-secondary — how they interact

The two channels answer different questions:

- **Heartbeats = freshness.** While occupied, the directory's `players`/`motd`/`status`
  for a listing is whatever the last beat said; no polling needed at all.
- **Polls (probes) = truth + reachability.** The directory probes
  `GET {registeredOrigin}/api/server-info` (a) at registration (Luanti connect-back
  precedent — no successful probe, no listing), (b) when heartbeat data looks wrong
  (players > maxPlayers, protocol mismatch with the beat, Rust-style clump heuristics —
  doc 02's domain), and (c) on staleness: an *occupied* server missing ~3 beats (no beat
  for 5 min, given the ≤90s promise) gets probed; probe says `occupied` → directory
  re-syncs from the probe body; probe fails → soft-hide (doc 02 policy).
- **The quiet beat is the cost shield**: after `quiet`, the directory suspends probing
  except a slow reachability check (recommended ≤1 per 6h for idle listings) so dead
  servers eventually fall off without idle DOs being woken every few minutes. **Any
  accepted beat cancels the suspension instantly** — normally a `boot`, but the rule is
  deliberately not boot-specific: under the §6 fallback a reconnect during the logout
  linger never fires `boot` (the tick never stopped), so the first post-quiet beat can
  be an `edge`. Binding on doc 02.
- **Precedence rule, stated once — with precision about what a probe measures.** Where
  a fresh probe and a fresh heartbeat disagree, the probe wins. But only reachability,
  TLS origin, latency, and (if doc 02 adds one) a real protocol handshake are
  *measurements*. The probe's response **body** is still a self-report by whatever code
  answers at the pinned origin: against a stolen-token forger the probe is truth (it
  bypasses the forger entirely — this is the case the precedence rule exists for);
  against a malicious server *operator* running modified code, probe-read
  `players`/`rules`/`status` are exactly as forgeable as a heartbeat — the cited prior
  art says so outright (directory-prior-art.md §5: Rust servers lie *to the probe* with
  patched responders). Consequence for doc 02: cap the ranking influence of
  self-reported numbers **regardless of which channel delivered them** (Luanti-style
  caps + Rust clump heuristics + blacklist backstop, directory-prior-art.md §6-7).
  And one field is exempt from probe re-sync entirely: **`joinUrl` is pinned at
  registration against BOTH channels** — heartbeat values and probe-body values are
  equally ignored, because a probe body is itself a self-report by whatever code
  answers at the pinned origin, and letting it move the join target would reopen
  through the probe channel the redirect attack §9 closes on the heartbeat channel.
  Only re-registration moves `joinUrl`. Binding on doc 02's re-sync logic.

Worst-case poll load on a community server is therefore: registration probe + rare
verification probes + ≤4 reachability probes/day while idle. Effectively zero against the
100K/day caps.

### 8. The `colo` hint

The meaningful region is where the **DO** lives (the Worker runs everywhere; the DO is
pinned). No first-class API exposes it, so:

- Primary: once per occupied session, on the first tick after `startTicking`, the DO does a
  single unbilled subrequest to `https://www.cloudflare.com/cdn-cgi/trace`, parses the
  `colo=XXX` line, stores it in memory and `meta.colo`. **UNCONFIRMED**: that a DO's
  outbound fetch egresses from the DO's own colo (widely reported, not formally
  documented). Milestone 4 verifies on the deployed official instance; if it reports the
  *requester-side* colo instead, drop the self-probe and rely on the fallback.
- Fallback: the directory observes the heartbeat request's `request.cf?.colo` /
  measured RTT and stores its own region hint per listing, overriding the advisory field
  (the `HeartbeatBody` comment above already licenses this).
- Contract posture: `colo` is `string | null`, explicitly a hint. Consumers wanting real
  latency measure it client-side against `/api/server-info` — which is exactly why CORS is
  `*` (directory-prior-art.md §8).
- **Privacy: `colo` geo-locates the operator.** Durable Objects are created in a data
  center near the first request that names them
  (<https://developers.cloudflare.com/durable-objects/reference/data-location/>), and in
  both deploy flows that first request comes from or near the operator (cf-deploy.md §9:
  the create-server flow's health poll / the operator's first visit). The published IATA
  code is therefore effectively the operator's metro region — exposed in a public
  CORS-`*` document, mirrored in every heartbeat, and persisted (`meta.colo`). For a solo
  operator that is a disclosure, not just a latency hint. Two consequences: the creator
  docs (M5) must say this plainly, and suppression must be supported — an optional
  `SERVER_HIDE_COLO` var that skips the self-probe and leaves `colo: null` (the field is
  already nullable, so suppression is schema-compatible by construction).

### 9. Spoof resistance, CORS, rate limits

**Threat model for heartbeats.** The bearer token authenticates *which listing* a beat may
update — identity and revocation, never truth (the FiveM/Factorio lesson,
directory-prior-art.md §2-3, §7).

A forged/stolen-token heartbeat **can**: deface that one listing's `name`/`motd`; lie about
`players`/`rules`/`status` until a probe disagrees; spam within its rate limit. It
**cannot**: move the listing's join target (`joinUrl` is pinned at registration; heartbeat
and probe-body values are alike ignored, §7 — the Rust-blacklist "join redirection" attack
is closed by construction on both channels, for the directory; third-party consumers must
validate it themselves, §10 rule 8); touch any other listing (token ↔ listing is 1:1);
meaningfully game ranking
(doc 02 must cap self-reported inputs Luanti-style and prefer probe-measured values);
affect game clients (nothing in this contract flows into the sim). Replay of a captured
beat is neutralized by `sentAt` monotonicity + the 5-minute window, and is low-stakes
anyway (stale data, overwritten by the next real beat). Remediation for a leaked token is
directory-side rotation (doc 01/02); the game server just gets a new secret.

A token is never exposed by the game server: it exists only as a deploy secret and an
`Authorization` header on outbound beats. `/api/server-info` carries no secrets — every
field is already public to anyone who can open the game (the seed rides every `welcome`,
GameRoom.ts:517).

**CORS posture.**

- `GET /api/server-info`: `access-control-allow-origin: *`, no credentials, no extra
  exposed headers. Required so the directory frontend and the official client can measure
  ping and render live cards from the browser (directory-prior-art.md §8). Same posture as
  `/api/health` and `/api/leaderboard` today (GameRoom.ts:168-170, 191-195) — read-only
  public data, wildcard is correct, not lazy.
- Heartbeat receiving endpoint: server-to-server only; CORS irrelevant (doc 02 should not
  add permissive CORS there).

**Rate limits.**

- Game-server side: the §5 micro-cache is the rate limiter for DO load; no 429 logic on
  `/api/server-info` (stateless Workers can't do better without bindings, and the data is
  cheap). Residual honest risk: a hostile poller can burn the **Worker** request cap
  (100K/day free — Error 1027 past it, cf-costs.md §1), taking `/ws` upgrades down with
  it. Unfixable without WAF/custom-domain tooling outside this contract; the paid plan
  ($5/mo, 10M req) makes it a non-issue and is already the recommendation for anything
  public (cf-costs.md §7).
- Published polling etiquette (contractual for the directory, advisory for others):
  ≥30s between polls per consumer; the directory follows §7's probe schedule.
- **Browser-based consumers are a traffic amplifier the per-consumer etiquette cannot
  bound** — CORS is open precisely so browsers can measure ping (above), but every
  directory pageview is a *new* consumer: a directory page that pings all listed
  servers on render charges each listed server 1 Worker request per pageview. At 20K
  directory pageviews/day that is 20K req/day — 20% of every listed free-plan server's
  100K/day Worker cap, the same cap whose exhaustion takes `/ws` down (see Threatens).
  That load is first-party-designed, not a hostile poller. Binding rule for first-party
  browser consumers (doc 02's frontend, the official client's server browser): ping
  only on explicit user interaction or for cards actually in the visible viewport, at
  most the visible top-N once per page load, never in an auto-refresh loop; the
  official client's browser throttles and round-robins pings. M5's consumer doc states
  the same rule for third parties.
- Directory-side heartbeat intake (binding on doc 02): a **token bucket per token —
  capacity 3, refill 1 per 15s** (sustained 4/min), `429` + `Retry-After` when empty.
  This is sized so a fully §6-compliant sender can never be rejected — but the claim
  is only true *because of* §6's every-beat-reschedules rule, so do the arithmetic
  with it: with the reschedule, the legal sustained rate is capped at one beat per
  `HEARTBEAT_EDGE_DEBOUNCE_S` (20s) = 3/min, under the 4/min refill with real
  headroom, and the burst capacity of 3 absorbs legitimate adjacency (a `quiet`
  followed seconds later by a `boot` when a player rejoins). Without the reschedule
  the sizing would be arithmetically false: 1/20s edge (3/min) **plus** worst-jitter
  periodic at 50s gaps (1.2/min) = 4.2/min sustained exceeds the refill, and the
  capacity-3 bucket buffers the 0.2/min deficit for only ~15 minutes before
  legitimate beats from the busiest, most-visible servers start drawing 429s. A
  simple fixed-floor limiter ("1 beat per 20s") would 429 sequences §6 explicitly
  permits — e.g. the quiet→boot bounce — and §6's backoff would then suppress exactly
  the fresh player-count data the push design exists to deliver. Body cap 8 KB
  (Luanti's ~11KB precedent, directory-prior-art.md §6); strict shape validation in the
  `parseClientMsg` style (protocol.ts:245-315); re-sanitize `name`/`motd` on receipt —
  never trust sender-side sanitization, and remember sanitization is not HTML-safety
  (§10 rule 8).

### 10. Forward-compatibility rules (the "boring-stable" contract)

These rules bind every future change to `ServerInfo`/`HeartbeatBody`:

1. **Additive-only within a schema version.** New fields MUST be optional
   (`field?: T`) with a documented default, appended to the interface. Existing fields
   are frozen: never removed, renamed, retyped, re-unit-ed, or re-semanticized while
   `SERVER_INFO_SCHEMA_VERSION` holds.
2. **Unknown-field tolerance is mandatory for consumers.** The directory and any client
   MUST ignore fields they don't recognize (destructure/pick named fields — the codebase
   already does this everywhere; never validate with a closed/strict schema that rejects
   extras).
3. **Required fields are always present.** A v1 responder always emits every non-optional
   v1 field, even when idle (`players: 0`, `uptimeS: 0`, `colo: null`). Consumers never
   need existence checks on required fields *of a version they support*.
4. **`schemaVersion` bumps only for breaking changes** — and a bump is an event, not a
   habit: the directory must then accept both `N` and `N-1` for at least 6 months
   (community servers update on their own schedule; doc 02 should render unknown-future
   versions as "incompatible listing" rather than erroring).
5. **Version-gating uses `protocolVersion` exclusively.** `gameVersion` is decoration;
   `schemaVersion` is about *this document*, not joinability. The three axes never proxy
   for each other.
6. **Heartbeats and the GET body evolve in lockstep** — `HeartbeatBody.info` IS
   `ServerInfo`; there is one schema, versioned once.
7. **Enum-ish strings grow, never shrink.** New `ServerStatus` or `HeartbeatEvent` values
   are additive; consumers MUST treat unrecognized values as "unknown" and keep rendering
   the rest of the document.
8. **Every `ServerInfo` string is untrusted operator input — all of them, not just the
   obvious two.** A community server is someone else's deployment of forkable code
   (§7's own threat model); nothing the contract says about server-side sanitization
   binds what a hostile responder actually emits. Per-field consumer rules:
   - **`name`/`motd` — render as text only** (`textContent`/framework auto-escaping,
     never `innerHTML`/Markdown parsing). "Sanitized" in this contract means
     controls/zero-width/bidi stripped (`STRIP_TEXT_RE`, players.ts:41) and
     length-capped — it does **not** touch `<`, `>`, `&`, or quotes; an
     operator-controlled `SERVER_MOTD` of `<img src=x onerror=…>` survives every
     sanitization step here by construction. Interpolating these into HTML or Markdown
     ships stored XSS laundered through the directory.
   - **`joinUrl` — validate before it goes anywhere near an `href`.** This is the field
     a status badge or list site most wants to make clickable, and exactly the one a
     malicious or modified server weaponizes (`javascript:`/`data:` URIs, phishing
     origins) in its own `/api/server-info` body. Consumers MUST parse it (`new URL`),
     require `protocol === "https:"` and a plausible hostname, and discard the field
     otherwise — never interpolate it unvalidated. The directory's registration pinning
     (§7/§9) protects only the directory; a third party reading the endpoint directly
     gets no such shield.
   - **`preset`, `gameVersion`, and every other string (current or future)** — text or
     badge-label rendering only; never a key into HTML templates, URLs, or code paths.
   Binding rule for all of the above: treat the document as data, not markup or links,
   until validated. Directory intake SHOULD additionally strip `<` from free-text
   fields as defense in depth. Also out of scope for sanitization: homoglyph
   impersonation (cyrillic "Officiаl Worldspring" passes untouched) — that is a doc 02
   moderation lever, flagged here so nobody assumes it handled.

## Implications

**Opens up**

- Doc 02's directory can be built against a precise, probe-able contract — listing cards,
  badges, version gating, uptime tracking all have defined sources.
- Doc 01's deploy flow has its exact env surface: `SERVER_NAME`, `SERVER_MOTD`,
  `SERVER_HIDE_COLO` (vars), `DIRECTORY_URL` (var), `DIRECTORY_TOKEN` (secret) — all
  optional, all inert when unset.
- `PROTOCOL_VERSION` + the two-sided gate (`join.proto` / `welcome.proto`) makes the
  first-party join path (`?server=wss://…/ws`) safe to design: an up-to-date server
  refuses an incompatible client before creating or restoring any character state, and
  the official client refuses servers older than itself. (Against a *pre-contract*
  server the client gate still fires only after that server has created state — see
  Migration; gating earlier on someone else's old deployment is not possible.)
- Anyone can build tooling (status badges, Discord bots, uptime monitors) against
  `/api/server-info` without talking to us.

**Complicates**

- Every future wire/sim change now carries a "did this break `PROTOCOL_VERSION`?" review
  question. That's the point, but it's a new standing tax on protocol PRs.
- `GAME_VERSION` in `packages/shared/src/version.ts` can drift from `package.json` `version`
  (0.1.0 today). Hand-maintained constant chosen for boring-ness; drift is cosmetic.
- The micro-cache means `/api/server-info` can lag reality by up to
  `SERVER_INFO_CACHE_TTL_S` (15s) per isolate — fine for listings, worth one sentence in
  consumer docs.
- `rules` depends on `ServerConfig`/`PRESETS` existing; until the config doc lands,
  milestone 2 ships a minimal stub (default preset, stock values) — flagged below.

**Breaks**

- Nothing existing. `/api/health`, `/api/leaderboard`, the wire protocol, saves, and the
  loadtest are untouched. `welcome.proto` is additive (current client destructures named
  fields and ignores extras — verified in `connection.ts` handling per
  codebase-server.md §3).

**Threatens**

- **Worker request cap on free plan**: any public endpoint invites pollers; a determined
  abuser can exhaust 100K req/day and take the whole server (including `/ws`) offline
  until 00:00 UTC — prime time US Central (cf-costs.md §3, §7). Mitigation is the paid
  plan, already the recommendation for public servers; say it in creator docs.
- **Token leakage** by community operators (pasted into a public repo's wrangler config
  instead of a secret) → listing defacement. Doc 01 must bake it as a *secret*, and doc 02
  needs rotation. Blast radius is one listing's cosmetics — by design.
- **Lying servers**: this contract authenticates identity, not truth. If doc 02 ranks by
  raw self-reported players, we recreate FiveM's fake-player economy
  (directory-prior-art.md §2). The contract gives doc 02 the probe lever; doc 02 must use
  it and cap self-reported influence.
- **The DO-restart wedge** (codebase-server.md §2 sharp edge): after a deploy with open
  sockets, the frozen room sends no beats and answers probes as `idle` while players sit
  wedged — the directory will *under*-report, never over-report. Acceptable; the real fix
  is the rejoin handshake, out of scope here.

## Migration & compatibility

- **Existing worlds/saves**: zero impact. No SQLite schema change beyond two new `meta`
  rows — `colo` (§8) and `origin` (§2 joinUrl capture), both written opportunistically —
  `meta` is `key TEXT PK, value TEXT` (persistence.ts), so no `SCHEMA_VERSION` bump and
  no wipe.
- **Wire protocol**: `welcome.proto` and `join.proto` are both additive, and the rollout
  story is stated honestly rather than as a feature. Pre-gate clients (stale cached
  bundles of the official instance, old fork builds) contain no gate code and send no
  `join.proto` — they can never be gated client-side. While `PROTOCOL_VERSION === 1`
  the server accepts absent `proto` (those clients are sim-compatible with v1 by
  definition), so nothing breaks during rollout. When `PROTOCOL_VERSION` bumps to 2+,
  the server rejects absent `proto` along with every explicit mismatch — server-side
  enforcement is the only mechanism that closes the gate on clients that predate it.
  New client vs old server: `welcome.proto` is `undefined` → treat as mismatch → hard
  gate; the old server will already have created/restored the character before the
  client disconnects (a one-time lingering body on pre-contract servers — acceptable,
  and it fixes itself as servers update). For the official instance the same-bundle
  atomic deploy (cf-deploy.md) makes mismatches rare but not impossible: a stale cached
  client bundle vs a freshly deployed server is precisely the case the server-side
  check covers.
- **Deployed community servers** (pre-contract builds): expose only `/api/health`. The
  directory treats absence of `/api/server-info` (404 from `worker.ts:20`) as "below
  minimum listable version" — they predate the directory, so nothing regresses.
- **`/api/health` consumers** (loadtest): untouched by decision §4.
- **Env vars**: all new env entries optional with code defaults; existing deploys without
  them behave exactly as today (no beats, default name). `worker-configuration.d.ts`
  regenerates via `npm run cf-typegen` after wrangler.jsonc gains the vars.
- **Determinism**: nothing in this contract feeds worldgen or the shared sim. Heartbeat
  jitter uses `Math.random()` in server-infra code only — the seeded rng streams in
  `packages/shared/src/world.ts` are not touched. `worldSeed` in `ServerInfo` is read-only exposure
  of an already-public value.

## Implementation plan

Milestone dependencies: M1 → M2 → M3; M4 independent after M2; M5 after M2.

1. **M1 — version constants + two-sided join gate** *(Opus 4.8 —
   protocol/determinism-sensitive)*
   - Scope: `PROTOCOL_VERSION = 1` in `packages/shared/src/protocol.ts`; `GAME_VERSION` in new
     `packages/shared/src/version.ts`; add `proto?: number` to the `join` variant and its
     validation in `parseClientMsg` (protocol.ts:255-260 — finite number when present);
     server-side gate at the **top** of `handleJoin` (GameRoom.ts:407-505): explicit
     mismatch → `{ t: "error", msg: "incompatible version" }` + close, before token
     hashing, character create/restore, `persistAll`, or any broadcast; absent `proto`
     accepted while `PROTOCOL_VERSION === 1` (§1); client sends `proto` in its join and
     gates on `welcome.proto` in `apps/game/src/client/net/connection.ts`'s welcome handler
     (friendly fatal error UI on mismatch or absence, before `createWorld`); add
     `proto: number` to the `welcome` variant (protocol.ts:194-206) and `sendWelcome`
     (GameRoom.ts:514-524).
   - Acceptance: typecheck both tsconfigs; local dev joins normally. The mismatch path
     CANNOT be exercised by editing the shared constant in dev — client and worker
     compile from the same `packages/shared/src/protocol.ts` (vite.config.ts:7, one source tree
     via `@cloudflare/vite-plugin`), so both sides move together. Instead: temporarily
     invert one comparison (e.g. server-side `proto === PROTOCOL_VERSION` → reject, or
     client-side gate on `msg.proto !== PROTOCOL_VERSION + 1`) or point a locally
     edited dev client at the deployed official instance. Verify both directions: the
     server reject closes the socket **without** creating a character row or a
     lingering body (check `/api/health` players and the SQLite characters table), and
     the client gate shows the error UI instead of building the world.
2. **M2 — `ServerInfo` + `GET /api/server-info`** *(Sonnet 4.8; depends M1)*
   - Scope: new `packages/shared/src/serverInfo.ts` (types + `SERVER_INFO_SCHEMA_VERSION` exactly
     as §2); constants section in `packages/shared/src/constants.ts` (§5); `buildServerInfo()` +
     route in `GameRoom.fetch` (no `ensureGame`, idle-safe per §2 table; `activeSince`
     field in `startTicking`/`stopTicking`); origin capture per the §2 `joinUrl` row
     (`this.publicOrigin` set in `GameRoom.fetch`, mirrored to/restored from
     `meta.origin`); Worker route + micro-cache (cache `res.ok` **GET** responses only —
     HEAD and errors pass through uncached, §3/§5 sketch) + OPTIONS (§3, §5);
     `SERVER_NAME`/`SERVER_MOTD` vars
     (optional) with `STRIP_TEXT_RE` sanitization; **stub** `packages/shared/src/config.ts` with
     a minimal `ServerConfig`, `PRESETS = { deadcoast: … }` (doc 04's default preset
     key), and `summarizeRules()`
     returning stock values — clearly commented as the config doc's to replace.
   - Acceptance: `curl` returns schema-valid JSON occupied and idle; after going idle,
     polling `/api/server-info` 50× leaves `/api/health`'s `tick` unchanged (proof the sim
     never wakes); repeated polls within 15s hit the micro-cache (count DO fetches in
     local dev logs); loadtest still passes.
3. **M3 — heartbeat sender** *(Sonnet 4.8; depends M2)*
   - Scope: `apps/game/src/server/heartbeat.ts` (§6 sketch); `DIRECTORY_URL` var +
     `DIRECTORY_TOKEN` secret in Env (optional); beat triggers wired into `startTicking`,
     the tick (periodic + edge-debounce via a dirty flag set in **both** `dropSocket`
     branches and all three join paths — §6 edge row), and `stopAndPersist`; every sent
     beat reschedules `nextBeatAt` (§6 periodic row — §9's intake sizing depends on it);
     backoff state in GameRoom memory; inert when env unset.
   - Acceptance: against a local mock directory (10-line Node server), a session produces
     `boot` → `edge`(join) → `periodic`×N (gaps 50–70s) → `edge`(leave) → `quiet`, with
     correct `players` at each step and `status: "idle"`/`uptimeS: 0` on the quiet beat;
     a dead player disconnecting from the death screen produces an `edge` beat (§6 edge
     row, `dropSocket` else-branch); killing the mock mid-session produces warnings and
     backoff, never a tick error; with env unset, zero outbound requests.
   - **Soak (guards §6's UNCONFIRMED subrequest-attribution risk)**: a ≥2h continuously
     occupied session — local AND on the deployed official instance — delivers 100+
     periodic beats with none failing on "Too many subrequests". The deployed leg has a
     prerequisite nothing else provides at M3 time (docs 01/02 have not shipped, and
     `wrangler.jsonc` has zero vars/secrets today): stand up a publicly reachable beat
     sink — a throwaway 20-line sink worker, or the local mock behind a tunnel — and set
     `DIRECTORY_URL` (var) + `DIRECTORY_TOKEN` (secret) on the official instance for the
     soak, removing both afterward. Alternatively skip the sink and count outbound beat
     fetches via `wrangler tail`. If beats start failing on "Too many subrequests", run
     the spike below, then implement the §6 fallback before shipping M3.
   - **Spike (guards the fallback's own UNCONFIRMED premise, §6)**: ~30 minutes — a
     scratch DO that fires >50 outbound fetches spread across incoming WS messages on
     one long-lived connection, confirming the per-message-delivery budget reset the
     fallback assumes. Run it **before** building the fallback. If the spike fails too,
     do not build the fallback — take §6's verified last resort (directory polls
     occupied servers, boot beat kept) instead.
4. **M4 — colo self-probe spike** *(Sonnet 4.8; depends M2; small)*
   - Scope: one-shot `cdn-cgi/trace` fetch on first tick of an occupied session; persist
     `meta.colo`; surface in `ServerInfo`; skip the probe entirely and leave `colo: null`
     when the optional `SERVER_HIDE_COLO` var is set (§8 privacy note — the field
     geo-locates the operator). Verify the UNCONFIRMED egress-colo claim (§8)
     on the deployed official instance; if false, delete the probe and leave
     `colo: null` (directory fallback covers it).
   - Acceptance: deployed `/api/server-info` shows a plausible IATA code after a session,
     or the probe is removed with a note in the code.
5. **M5 — consumer doc** *(Sonnet 4.8; depends M2)*
   - Scope: `docs/server-info.md` — endpoint reference, polling etiquette (including
     §9's browser-consumer rule: ping on interaction/visible cards only, never in an
     auto-refresh loop), forward-compat rules (§10 verbatim — rule 8's render-as-text
     requirement for `name`/`motd` and its parse-and-require-`https:` requirement for
     `joinUrl` are the two a badge author is most likely to violate; give each its own
     warning callout), example response; the §8 colo privacy note and
     `SERVER_HIDE_COLO` in the creator-facing section; linked from README.
   - Acceptance: a third party could build a status badge from the doc alone — without
     shipping stored XSS when a server's MOTD contains `<script>`, and without shipping
     href-injection when a hostile server's `joinUrl` is `javascript:alert(1)` or a
     phishing origin (the badge must validate or drop the link, per §10 rule 8).

## Open questions

1. **Expose `worldSeed`?** Recommendation: **yes** (as designed). It is already sent to
   every client in `welcome` (GameRoom.ts:517), so omitting it is fake secrecy; exposing
   it enables directory map previews. Pull it only if you ever want seed-secret servers —
   that would be a `ServerConfig` flag and a schema-v1-compatible `worldSeed?: number`.
2. **`name`/`motd` as env vars vs compile-time `ServerConfig`?** Recommendation: **vars
   with config defaults** (as designed) — rename/MOTD changes shouldn't need a rebuild,
   and doc 01's flow already writes vars. Push back if you want the config file to be the
   single source of truth more than you want cheap edits.
3. **Player-name samples in `ServerInfo`** (Minecraft SLP's `players.sample`)?
   Recommendation: **no for v1** — privacy and abuse surface for zero listing value;
   additive `sample?: string[]` later if wanted.
4. **`GAME_VERSION` source — hand-maintained constant vs importing `package.json`?**
   Recommendation: hand-maintained `packages/shared/src/version.ts` (boring, no resolveJsonModule
   in two tsconfigs); accept the drift risk. Cheap to revisit.
5. **Heartbeat numbers**: 60s ±10s periodic, 20s edge debounce (which, with §6's
   every-beat-reschedules rule, is also the hard cap on sustained send rate), ≤90s
   promised gap, token-bucket directory intake (capacity 3, refill 1/15s per token —
   sized in §9 *given* the reschedule rule; without it the "compliant senders are never
   429'd" claim is arithmetically false, see §9). Recommendation: ship these; they sit
   inside every prior-art range (directory-prior-art.md §7). Budget honesty, because
   the arithmetic matters and beats are not only periodic: per occupied server the
   legal range runs from ~1,440 beats/day (quiet occupancy, 60s cadence) up to
   ~4,320/day (maximum legal churn at the 20s floor — a busy 24-slot server in prime
   time), so the free-plan directory's 100K req/day cap supports **~23–69
   simultaneously occupied servers depending on churn** (cf-costs.md §5's ~69 figure is
   the quiet end only; its ~347 figure is for a 5-minute cadence this design does not
   use). Beats fire only while occupied, so ~350 *listings* fit only if average
   occupancy stays at or below ~20% — plausible for hobby servers, but it is an
   assumption, not headroom. Key the paid-plan trigger on **measured daily beat
   volume**, not occupied-server count (churn moves the per-server cost 3×): plan on
   the $5 paid plan for the directory (10M req/mo ≈ 77–230 concurrently occupied
   servers across the same churn range) once daily intake approaches ~70% of the free
   cap; the directory is first-party infrastructure, so this is Adam's $5, not a
   community operator's. Only Adam can decide if directory freshness should be
   tighter — don't go below 30s periodic without redoing this math.
6. **Should the official instance's `/api/server-info` ship before docs 01/02 land?**
   Recommendation: **yes** — M1+M2 are independently useful (version gate, public stats)
   and give doc 02 a live endpoint to develop against.
7. **Worker-layout assumption check**: research supports the prescribed layout — directory
   as a separate `site/` worker, game worker untouched except this endpoint + sender
   (codebase-server.md §6 reached the same conclusion independently). No pushback.
