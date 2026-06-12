# Official Site & Server Directory

Design doc for `site/` — the deadcoast landing page that doubles as the flagship server
directory. Companion to doc-01 (hosted deploy flow), doc-03 (the `/api/server-info` +
heartbeat contract, `src/shared/serverInfo.ts`) and doc-04 (ServerConfig / presets,
`src/shared/config.ts`). Research grounding: `docs/plans/research/directory-prior-art.md`,
`research/codebase-server.md`, `research/cf-costs.md`, `research/cf-deploy.md`,
`research/cf-oauth.md`.

## Summary

A second Cloudflare Worker in `site/` (own `wrangler.jsonc` + `package.json`, deployed
independently of the game worker) serves SSR HTML via Hono + `hono/jsx` — no client
framework, one small progressive-enhancement script for client-measured ping and the
join interstitial. State lives in D1: `servers`, `owners`, `probes`, `stats_hourly`,
`reports`, `moderation_actions`. Registration issues a self-contained **server token**
(`dcd1.<serverId>.<secret>`); the doc-01 deploy flow injects it as a secret automatically,
wrangler-CLI deployers set it manually and prove URL control via a **challenge hash**
the directory reads back from the server's public `GET /api/server-info`. Liveness is
**probe-first** (cron every 5 min — a workers.dev game server is never "offline" while
idle, it wakes on join), with token-authed **heartbeats** every 60 s while a room is
actively ticking for fresh player counts. Ranking is a Luanti-style capped composite
(players capped at 24, 20-day uptime %, age — never raw player count, never votes).
The directory links OUT to each server's own origin behind a clearly-worded
interstitial; we explicitly do NOT attempt to verify third-party client builds —
research showed that is unenforceable theater. The official server is a pinned row,
probed like everyone else.

## Goals / Non-goals

**Goals**

- One place to discover community DEADCOAST servers; landing page = directory.
- Registration that takes < 5 minutes for a wrangler-CLI deployer and zero extra steps
  for someone who used the doc-01 hosted deploy flow.
- Honest liveness, player counts, and uptime — probe-verified where possible, capped and
  policy-backstopped where not.
- A trust boundary players can actually understand: "clicking Join leaves our site and
  loads that server's own copy of the game."
- Cheap to run: cached list, free-or-$5 Cloudflare plan, no per-visitor D1 reads.

**Non-goals**

- Verifying that a listed server runs unmodified DEADCOAST code (impossible off-site —
  see Trust model).
- A first-party join path (official client + `?server=wss://…`) — designed-for but not
  built in v1 (see Open questions).
- Votes, paid placement, sponsored slots — documented abuse engines
  (directory-prior-art.md §1, §5).
- Accounts for players. Only server owners have any identity here.
- In-site game embedding (iframe) — inherits all the third-party-code risk with extra
  clickjacking surface, rejected.

## Current state

Verified against this worktree:

- The game worker (`src/server/worker.ts:6-22`) routes exactly `/ws`,
  `/api/leaderboard`, `/api/health` to the single `GameRoom` DO
  (`env.GAME.getByName("main")`, worker.ts:13); everything else 404s (worker.ts:20).
  Static assets are served platform-first with
  `not_found_handling: "single-page-application"` (`wrangler.jsonc:6-8`), so browser
  *navigation* requests to non-asset paths get `index.html` without invoking the worker
  (codebase-server.md §1) — one reason the site must NOT live on the game worker.
- `/api/health` (`src/server/GameRoom.ts:175-197`) returns in-memory counts
  (`players`, `zombies`, …, `tickMsEma`, `uptime`) with
  `access-control-allow-origin: *` and deliberately never wakes the sim (comment at
  GameRoom.ts:173-174). This is the precedent `/api/server-info` follows.
- No `PROTOCOL_VERSION`, no `ServerConfig`, no `/api/server-info`, no `PRESETS` exist
  yet (grepped `src/` — zero hits). Doc-04 owns `ServerConfig`/`PRESETS` in
  `src/shared/config.ts` (doc-03 only stubs the file until doc-04 lands); this doc
  consumes them.
- The `welcome` message carries `seed` (`src/shared/protocol.ts:194-206`) — the existing
  transport for anything that must reach the client; `PROTOCOL_VERSION` rides here too.
- Sanitization precedent: `STRIP_TEXT_RE` (`src/server/systems/players.ts:41-44`) strips
  C0/C1 controls, zero-width (U+200B-200F), bidi embeddings/overrides/isolates,
  word-joiners, BOM; `sanitizeName` (players.ts:46-60) strips → trims → caps by **code
  points** (spread + slice, never splits surrogate pairs); chat additionally collapses
  whitespace (`GameRoom.ts:317-340`). The site reuses this exact recipe.
- Env surface of the game worker is exactly one binding, `GAME` (`wrangler.jsonc:9-16`);
  zero vars, zero secrets. `MAX_PLAYERS = 24`, `MAX_NAME_LENGTH = 16`
  (`src/shared/constants.ts:30-31`).
- Deploys: root `npm run deploy` = `vite build && wrangler deploy` through the Vite
  plugin's `.wrangler/deploy/config.json` redirect (codebase-server.md §4). A sibling
  `site/` worker deployed via `wrangler deploy -c site/wrangler.jsonc` is fully
  independent (codebase-server.md §6).
- Cost reality (cf-costs.md): heartbeats are unbilled subrequests for senders; a
  free-plan directory absorbs ~69 servers at 60 s heartbeats; directory-side probes are
  unbilled subrequests capped at 50/invocation on free, 10,000 on paid.

## Design

### 1. Architecture: the `site/` worker

```
site/
  wrangler.jsonc        # name: "deadcoast-site", D1 binding, cron, assets
  package.json          # hono only; own lockfile entry
  tsconfig.json         # jsx: "react-jsx", jsxImportSource: "hono/jsx", strict
  public/               # logo, CSS, ping.js (the one client script)
  src/
    index.tsx           # Hono app: routes + scheduled() cron handler
    db.ts               # typed D1 query helpers (no ORM)
    tokens.ts           # server-token mint/parse/hash, challenge hash
    sanitize.ts         # listing caps + sanitizeListingText (imports shared STRIP_TEXT_RE)
    probe.ts            # SSRF-guarded server-info fetch + validation
    rank.ts             # score(), region map
    pages/              # hono/jsx components: Landing, Browse, Detail, Join, Register, Admin
  migrations/           # D1 migration .sql files (wrangler d1 migrations)
```

**SSR, not SPA.** This is a content + browse site next to a 3D game; it must be
crawlable, instant on first paint, and cacheable at the edge. Hono + `hono/jsx`
(server-side JSX, auto-escaping, ~tiny, Workers-native; hono 4.x as of 2026-06 — pin at
implementation time) renders full HTML per request. Exactly one client script,
`public/ping.js` (~120 lines vanilla): measures per-server RTT against
`/api/server-info` (CORS `*` already the game-side precedent), fills the Ping column,
enables client-side re-sort by ping, and remembers interstitial opt-outs in
`localStorage`. **Ping fan-out is strictly bounded**, because every measurement is a
billed Worker request + billed DO request on the TARGET server's Cloudflare account
(§2b, §11): only rows currently in the viewport are pinged (IntersectionObserver), ≤6
in flight, one measurement per server per browser session (memoized in
`sessionStorage`), and pages past the first measure only on an explicit "measure ping"
click. Never ping every listed server — 500 listings must not mean 500 cross-origin
GETs per pageview. Filters and sorting are **query params rendered server-side** so
every filtered view is a cacheable URL. A React SPA here would mean a second bundle
pipeline, worse caching, and no benefit — rejected.

**Assets config:** `site/wrangler.jsonc` declares `assets: { directory: "./public" }`
with **no `not_found_handling`** — unmatched requests (all the SSR routes) fall through
to the worker. This avoids the SPA-navigation-swallowing gotcha documented for the game
worker (codebase-server.md §1).

```jsonc
// site/wrangler.jsonc
{
  "name": "deadcoast-site",
  "main": "src/index.tsx",
  "compatibility_date": "2026-06-01",
  "assets": { "directory": "./public" },
  "d1_databases": [
    { "binding": "DB", "database_name": "deadcoast-directory", "database_id": "<created at setup>" }
  ],
  "triggers": { "crons": ["*/5 * * * *"] },
  "observability": { "enabled": true }
  // secrets (wrangler secret put -c site/wrangler.jsonc): ADMIN_TOKEN, SESSION_SECRET
}
```

Root `package.json` gains `"deploy:site": "wrangler deploy -c site/wrangler.jsonc"`.
The site does NOT touch the root build redirect, the root tsconfigs, or the game deploy.

**Imports from the game tree — one rule, stated once.** `site/` may import
dependency-light (constants/types-only) modules from `src/shared/` via relative path
(`../src/shared/...`), and NEVER from `src/server/` or `src/client/`. This is the same
rule doc-03 already sets for `src/shared/serverInfo.ts` ("the `site/` worker imports
via relative path — same repo"). Concretely the site imports: `PROTOCOL_VERSION`
(`src/shared/protocol.ts` — its only import is `import type` from `./items`, erased at
compile, so nothing transitive reaches the bundle), `GAME_VERSION`
(`src/shared/version.ts`, new per doc-03 Open Q4), `ServerInfo`/`RulesSummary`
(`src/shared/serverInfo.ts`), the `PRESETS` registry (`src/shared/config.ts`, doc-04),
and `STRIP_TEXT_RE` (hoisted to `src/shared/text.ts` in M1 — §7). Mechanics: there are
no npm workspaces (root `package.json` has none) and none are added — wrangler's
esbuild happily bundles relative imports that reach outside `site/`, and
`site/tsconfig.json` sets `"include": ["src", "../src/shared"]` with no `rootDir` so
typechecking follows them. The site build stays free of the game's npm deps because
every imported module is constants/types only — enforced by review in v1 (Open
questions #6).

Doc-01's hosted deploy flow lives on this same worker (routes under `/host`); it shares
`owners`, sessions, and `tokens.ts`. That integration is doc-01's spec; this doc only
defines the registration call it makes (§5).

### 2. Shared contracts with the game worker

Three additions to the game repo (coordinate with doc-03, which owns the
`ServerInfo`/heartbeat contract, and doc-04, which owns `ServerConfig`/`PRESETS`):

**(a) `PROTOCOL_VERSION`** — `export const PROTOCOL_VERSION = 1;` in
`src/shared/protocol.ts`, bumped on any wire-protocol or sim-determinism break. Carried
in `welcome` (additive field), `/api/server-info`, and heartbeats. The directory compares
it against the latest release.

**(b) `GET /api/server-info`** — public, CORS `*`, answered by the DO (so
client-measured RTT includes the DO leg — the latency that actually predicts gameplay
feel, since the edge is always near the visitor but the DO is pinned somewhere). This
knowingly deviates from cf-costs.md §5, which recommends answering at the Worker layer
so polls don't bill DO requests. Deviation rationale: the Worker is stateless, so a
Worker-layer answer needs either a new KV binding on every community server (setup
friction + write costs + staleness) or a per-colo `caches.default` front — which would
make measured RTT reflect the edge instead of the DO, defeating the route's purpose.
The price is **one billed Worker request + one billed DO request per poll on the
LISTED server's account** (worker.ts:16-19 routes `/api/*` through `stub.fetch`; a DO
cold start also runs constructor SQL, GameRoom.ts:153-161). Directory cron probes are
negligible (288/day ≈ 0.3% of free caps); visitor pings are the real multiplier and
are strictly bounded in ping.js (§1); §11 budgets both.

Follows the `/api/health` precedent: never calls `ensureGame()`, counts read
`this.game ?? 0` (GameRoom.ts:175-197) — with ONE deliberate deviation: `players`
counts connected sockets (`this.socketByPlayer.size`, the broadcastSnapshots
convention, GameRoom.ts:711-713), NOT `game.players.size` as `/api/health` reports.
That set includes logged-out bodies lingering for `LOGOUT_LINGER_S` (60 s,
constants.ts:176) and would inflate directory counts after every disconnect. Route
added to the worker if-chain (worker.ts:16-19) and the DO fetch.

```ts
// The shared type is doc-03's ServerInfo (src/shared/serverInfo.ts) — doc-03
// owns this contract; an earlier sketch here with its own field names
// (protocol/version/playersMax/uptime/preset) is superseded. The directory
// consumes doc-03's fields: schemaVersion, gameVersion, protocolVersion,
// worldSeed, name, motd, rules (RulesSummary — preset/badge bands, doc-04's
// summarizeRules derivation), players, maxPlayers, status ("occupied"|"idle"),
// uptimeS, worldAgeS, colo, joinUrl — PLUS the one field this doc adds to
// doc-03's schema (additive-optional under its §10 rule 1):
//
//   directoryChallenge: string | null; // sha256 hex, only when DIRECTORY_TOKEN set
//
// Probe validation keys on doc-03's shape (schemaVersion a number, required
// fields present), not on a `game` discriminator — the earlier sketch's
// `game: "deadcoast"` field does not exist in the canonical type.
```

`colo`: obtained once per DO boot via `fetch("https://cloudflare.com/cdn-cgi/trace")`
from inside the DO and cached in memory. **UNCONFIRMED** that the trace colo always
equals the DO's execution colo (outbound fetches normally egress locally, but this is
not documented as a guarantee); implementer verifies on a deployed instance, and the
field is nullable so the directory tolerates absence. Region display falls back to
client-measured ping when null.

**(c) Heartbeat sender** — two optional env additions to the game worker
(`Env` regenerated via `npm run cf-typegen`): `DIRECTORY_URL?: string` (var, defaults
unset; the doc-01 flow and docs set `https://deadcoast-site.<sub>.workers.dev`) and
`DIRECTORY_TOKEN?: string` (secret). When both are set, the tick sends beats per
**doc-03 §6's sender protocol, which owns cadence, events, and body shape**: `boot` on
idle→occupied, debounced `edge` beats on player-count change, `periodic` every
`HEARTBEAT_INTERVAL_S = 60` ±`HEARTBEAT_JITTER_S = 10` jitter, and a final `quiet` beat
when the room goes idle (constants in `src/shared/constants.ts`, doc-03 §5 — an earlier
draft's single `DIRECTORY_HEARTBEAT_S` modulo cadence is superseded).
Fire-and-forget from the tick: `void fetch(...).catch(log)` — never awaited, never
throws into the tick, an unreachable directory must not affect gameplay. Outbound
fetches from the DO are unbilled subrequests (cf-costs.md §1). Idle rooms (no tick) send
nothing — by design; probes cover idle servers (§6).

```ts
// Doc-03 §6 owns this shape (src/shared/serverInfo.ts). Auth is the full
// server token in an `Authorization: Bearer dcd1.<serverId>.<secretHex>`
// header — never in the body (an earlier flat body sketch here is superseded).
type HeartbeatEvent = "boot" | "edge" | "periodic" | "quiet";
interface HeartbeatBody {
  schemaVersion: number;   // SERVER_INFO_SCHEMA_VERSION of the sender
  event: HeartbeatEvent;   // staleness bookkeeping (§6 lifecycle)
  sentAt: number;          // epoch ms; directory rejects >5 min old or non-monotonic
  info: ServerInfo;        // the same document /api/server-info serves
}
```

The directory reads `name`/`motd`/`players`/`maxPlayers`/`protocolVersion`/
`gameVersion`/`rules.preset`/`uptimeS` out of `info` and identifies the listing by the
`serverId` embedded in the bearer token.

**Server token format**: `dcd1.<serverId>.<secretHex>` — `serverId` is a 26-char ULID,
`secretHex` is 32 random bytes hex. Self-contained (one secret to set, no separate ID
var). The plaintext token exists at the directory only inside the mint request; what
persists is **two hashes, both computed by `tokens.ts` at mint time**:

- `token_hash = sha256hex(secretHex)` — compared against the token presented in
  heartbeats and owner DELETEs.
- `challenge_hash = sha256hex("deadcoast-directory-challenge:" + token)` — the value
  verification probes expect back from `/api/server-info.directoryChallenge`. This MUST
  be precomputed and stored at mint: once the token is returned to the owner and
  discarded, the directory can never derive the challenge from `token_hash` — that is
  the same preimage resistance the scheme relies on.

The game server computes the identical challenge from its `DIRECTORY_TOKEN` once and
caches it module-level. Storing and publishing the challenge hash leaks nothing
(preimage resistance, 256-bit secret) and grants nothing — heartbeat and DELETE auth
require the full token, and the game server already serves the challenge publicly. It
is per-registration, so a reverse-proxy of someone else's `/api/server-info` can never
validate a different URL's registration (their challenge ≠ your token).

### 3. D1 schema

D1 (not a DO) because the workload is relational reads + tiny writes with zero
coordination needs, and it keeps the directory's DO bill at literal zero. Pricing
caveat: D1 free tier is 100K rows written/day, 5M read/day — re-verify at
<https://developers.cloudflare.com/d1/platform/pricing/> before launch (cf-costs.md
verified the DO-SQLite twins of these numbers; D1's own page was not probed).

```sql
CREATE TABLE owners (
  id          TEXT PRIMARY KEY,            -- ulid
  cf_sub      TEXT UNIQUE,                 -- Cloudflare OAuth sub (cf-oauth.md: userinfo exposes only sub)
  created_at  INTEGER NOT NULL
);

CREATE TABLE servers (
  id          TEXT PRIMARY KEY,            -- ulid; public handle, also in the token
  url         TEXT NOT NULL UNIQUE,        -- normalized https origin, no path/port
  token_hash  TEXT NOT NULL,               -- sha256(secretHex); heartbeat/DELETE auth
  challenge_hash TEXT NOT NULL,            -- sha256("deadcoast-directory-challenge:" + token),
                                           -- precomputed at mint (§2) — underivable later
  owner_id    TEXT REFERENCES owners(id),  -- NULL = token-only registration
  source      TEXT NOT NULL CHECK (source IN ('deploy','manual','official')),
  -- listing content, refreshed from heartbeats/probes, sanitized on every write:
  name        TEXT NOT NULL,
  motd        TEXT NOT NULL DEFAULT '',
  preset      TEXT,
  version     TEXT,
  protocol    INTEGER,
  players     INTEGER NOT NULL DEFAULT 0,
  players_max INTEGER NOT NULL DEFAULT 24,
  colo        TEXT,
  -- lifecycle:
  status      TEXT NOT NULL CHECK (status IN ('pending','live','unreachable','hidden','banned')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  verified_at        INTEGER,
  last_heartbeat_at  INTEGER,
  last_probe_at      INTEGER,
  unreachable_since  INTEGER,
  flagged            INTEGER NOT NULL DEFAULT 0,  -- needs human review
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_servers_status ON servers(status);

CREATE TABLE probes (                       -- pruned to PROBE_HISTORY_DAYS = 20
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  rtt_ms     INTEGER,
  players    INTEGER,
  error      TEXT                           -- 'timeout' | 'bad-status' | 'bad-shape' | 'challenge-mismatch'
);
CREATE INDEX idx_probes_server_at ON probes(server_id, at);

CREATE TABLE stats_hourly (                 -- written once/hour from heartbeat highs; powers charts
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  hour         INTEGER NOT NULL,            -- unix hour
  peak_players INTEGER NOT NULL,
  PRIMARY KEY (server_id, hour)
);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN
                ('fake-counts','offensive-content','malware-phishing','impersonation','broken','other')),
  detail      TEXT NOT NULL DEFAULT '',     -- sanitized, ≤500 code points
  ip_hash     TEXT NOT NULL,                -- sha256(ip + daily salt); rate-limit + dedupe key
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE moderation_actions (           -- append-only audit log
  id         TEXT PRIMARY KEY,
  server_id  TEXT,
  action     TEXT NOT NULL,                 -- 'hide','unhide','ban','unban','delete','resolve-report'
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE banned_hosts (                 -- blocks re-registration after a ban
  host       TEXT PRIMARY KEY,              -- exact hostname
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE attempts (                     -- rate-limit ledger for unauthenticated POSTs
  ip_hash    TEXT NOT NULL,                 -- sha256(ip + daily salt), same recipe as reports
  route      TEXT NOT NULL CHECK (route IN ('register','verify')),
  at         INTEGER NOT NULL
);
CREATE INDEX idx_attempts_ip_route_at ON attempts(ip_hash, route, at);
```

**Timestamp units, everywhere**: every `*_at` / `at` column is epoch **milliseconds**
(`Date.now()`); `stats_hourly.hour` is `Math.floor(Date.now() / 3_600_000)`. This is
load-bearing: `rank.ts` (§8) divides age by `86400_000` — store seconds anywhere and
the age term silently rounds to ~0 forever with no error.

**Rate-limit storage**: registration's 5/h/IP and verify's limit (§4) are counted in
`attempts` — every attempt, accepted or rejected, INSERTs one row; the handler COUNTs
the window first. Rows older than 24 h are pruned by the daily housekeeping run (§6).
Reports need no ledger — every report already inserts a `reports` row keyed by
`ip_hash`. The Workers rate-limiting binding was rejected for v1: still beta behind the
`unsafe` config namespace (re-verify at implementation if that changed); two D1 ops per
attempt at these volumes is nothing.

"Latest release" is NOT a table: `site/` imports `PROTOCOL_VERSION`
(`src/shared/protocol.ts`) and `GAME_VERSION` (`src/shared/version.ts`) at build time
under the §1 import rule. Releasing the game = redeploy the site too (one npm script,
documented). A `releases` table is deferred until release cadence makes build-time
import painful.

### 4. HTTP API (site worker)

All `/api/v1/*` responses are JSON with `access-control-allow-origin: *`. Request bodies
capped at 4 KB (half the game's `parseClientMsg` 8 KB precedent, protocol.ts:245-315).

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/servers` | none (rate-limited 5/h/IP via `attempts`, §3) | Begin registration. Body `{ url }`. Returns `{ serverId, token, verifyUrl }` exactly once. Row inserted as `pending`. |
| `POST /api/v1/servers/:id/verify` | none (rate-limited 10/h/IP via `attempts`, §3) | Trigger an immediate verification probe instead of waiting for cron. Returns probe outcome. |
| `POST /api/v1/heartbeat` | `Authorization: Bearer <token>` (doc-03 §6 body: `{schemaVersion, event, sentAt, info}`) | Update counts/listing fields; `204`. `401` on bad token, `410` if banned (signal to stop sending). Intake rate limit: token bucket per token, capacity 3, refill 1/15s (doc-03 §9, binding). |
| `DELETE /api/v1/servers/:id` | `Authorization: Bearer <token>` | Owner delist (immediate, hard delete). |
| `GET /api/v1/servers` | none, cached 30 s | The list: all `live` servers, ranked, capped at 500 rows. |
| `GET /api/v1/servers/:id` | none, cached 60 s | Detail + 20-day uptime series + hourly peak players. |
| `POST /api/v1/servers/:id/report` | none (rate-limited 5/day/IP, deduped per ip_hash+server) | File a report. |
| `GET /api/v1/latest` | none, cached | `{ version, protocol }` of the current release (build-time constants). Game clients/servers may use this for "update available" UI later. |

HTML routes (SSR): `/` (landing = hero + official server card + top-10 table + CTA
links), `/servers` (full browse, filters via query params), `/servers/:id` (detail),
`/join/:id` (interstitial), `/register` (manual claim wizard), `/policy` (listing
policy), `/admin` (moderation, gated by `ADMIN_TOKEN` cookie). Doc-01 adds `/host/*`.

### 5. Registration paths

**Path A — automatic (doc-01 hosted deploy).** The deploy flow already knows the worker
URL it is about to create and holds the user's OAuth session:

1. Site mints `{ serverId, token }`, inserts the `servers` row (`source='deploy'`,
   `status='pending'`, `owner_id` = the OAuth user's owner row).
2. The deploy includes `DIRECTORY_TOKEN` as a `secret_text` binding and `DIRECTORY_URL`
   as a `plain_text` binding in the multipart upload metadata (cf-deploy.md confirms
   both binding types in the same array).
3. After the deploy flow's existing health poll succeeds, the site runs the verification
   probe (below). Match → `status='live'`. The user did nothing extra.

**Path B — manual claim (wrangler-CLI deployers).** Self-serve on `/register`, also
fully scriptable via the API:

1. Owner submits their server URL. Site validates + normalizes it (§7), checks
   `banned_hosts`, mints `{ serverId, token }`, shows the token **once** with copy-paste
   instructions:
   ```
   npx wrangler secret put DIRECTORY_TOKEN    # paste the token
   npx wrangler deploy                        # vite build && wrangler deploy per README
   ```
   (`DIRECTORY_URL` ships as a default var pointing at the official directory in the
   game's `wrangler.jsonc` once this lands — see Open questions #4.)
2. Owner clicks "Verify now" (`POST /api/v1/servers/:id/verify`) or waits for cron.
3. **Verification probe**: the site fetches `https://<host>/api/server-info` (SSRF
   guard, §7) and requires (a) a doc-03-shaped `ServerInfo` body (numeric
   `schemaVersion`, required fields present), (b) `directoryChallenge` equal
   to the row's stored `challenge_hash` (precomputed at mint, §2 — the directory no
   longer holds the token and cannot recompute it).
   Match proves whoever controls that origin holds the token we issued for that URL —
   control of URL + possession of secret, the same property doc-01's flow gets
   implicitly. → `status='live'`, `verified_at=now`.
4. Token lost = delist via support (admin) and re-register. No token recovery in v1.
   OAuth-signed-in registrants get the server attached to their owner row and can
   delist from a future "my servers" page; token-only registrants manage via API.

Registration deliberately collects **only the URL**. Name, MOTD, preset, version, counts
all flow from the server itself (heartbeats + probes) — the listing can never drift from
what the server says it is, and there is no second place to moderate.

The official instance (`worldspring.adam-730.workers.dev`) registers through Path B
like everyone else, with `source='official'` set by hand — it heartbeats, gets probed,
and shows real uptime. Pinning is presentation-only.

### 6. Liveness: probes first, heartbeats for freshness

The serverless twist (this is where DEADCOAST differs from every studied directory): an
idle workers.dev game server has zero sockets, no tick, sends no heartbeats — and is
still perfectly joinable; the platform cold-starts the DO on the next `/ws`. So
**absence of heartbeats means "empty", never "offline"**. Truth about reachability comes
from directory-side probes (the prior-art synthesis: heartbeats = identity, probes =
truth, policy = backstop).

**Cron prober** (`scheduled()`, every 5 min — terraria-servers cadence):

- Probes `live` and `pending` servers' `/api/server-info` **on doc-03 §7's schedule
  (binding)**, with the 5-min cron as the scheduler granularity: occupied servers
  (fresh beats) are probed only on staleness (~3 missed beats / 5 min of silence) or
  when beat data looks wrong; after a `quiet` beat, probing is suspended down to a slow
  reachability check (≤1 per 6h) so idle DOs are not woken every 5 minutes — any
  accepted beat (not just `boot`; doc-03's fallback can resume with an `edge`) ends the
  suspension; `unreachable` servers back off to every 60 min. Probes are unbilled
  subrequests; on the free plan they cap
  at 50/invocation, paid 10,000 (cf-costs.md §5) — run the official directory on Workers
  Paid ($5) and batch with `Promise.allSettled` in chunks of 20.
- Per probe, on success: append `probes` row (ok, rtt, players), reset
  `consecutive_failures`, overwrite `players`/`players_max`/`version`/`protocol`/
  `preset`/`name`/`motd`/`colo` from the response (sanitized again, §7), and re-check
  `directoryChallenge` against the stored `challenge_hash` (§2) — a vanished or
  mismatched challenge counts as a failed probe
  with `error='challenge-mismatch'` (catches domain transfers, secret rotation, and
  origin takeovers; FiveM's revocation-lever lesson).
- On failure (timeout 5 s, non-200, >16 KB, bad shape): append failed `probes` row,
  `consecutive_failures++`.
- State machine:
  - `pending` → `live` on first passing probe; `pending` rows older than 7 days with no
    passing probe are deleted (abandoned registrations).
  - `live` → `unreachable` at `consecutive_failures >= 3` (~15 min); hidden from the
    default browse view. `unreachable_since = now`.
  - `unreachable` → `live` on any passing probe.
  - `unreachable` for 30 days → row deleted (cascades probes/stats). Owners re-register;
    URL uniqueness makes this painless.
  - `hidden`/`banned` are moderation states; banned URLs' hosts go to `banned_hosts`.
- Housekeeping (daily, inside the same cron on the 00:xx run): prune `probes` older than
  20 days, prune `attempts` older than 24 h, roll `stats_hourly` from the past hour's
  max observed players, delete resolved reports older than 90 days.

**Heartbeats** freshen `players`/`uptime` between probes (60 s vs 5 min) and prove
ongoing token possession. They update the row in place — one D1 write each. A `live`
server with a recent heartbeat shows "active now"; one with passing probes but no
heartbeats shows "idle — wakes on join" (an honest, novel-to-this-platform state that
the UI treats as joinable, because it is).

Write budget at 200 listed servers, ~20% active — a deliberate worst-case bound that
ignores doc-03's quiet-beat probe suspension (which cuts the idle-server share of probe
writes by ~70×); counted in **billed rows written**,
where an INSERT into an indexed table bills one extra row per index touched (D1
pricing, fetched 2026-06-11): each successful probe writes ~3 rows (`probes` INSERT +
its `idx_probes_server_at` row + the `servers` UPDATE) → 200 × 288 × 3 ≈ **173 K
rows/day**; heartbeats are one `servers` UPDATE each → 40 × 1,440 ≈ **58 K rows/day**;
plus stats/pruning/attempts noise. Total ≈ **230 K rows/day** — D1 free (100 K/day) is
breached outright at roughly **85–115 listed servers**, not merely "uncomfortable" at
200. Run the directory on Workers Paid from day one (Open questions #1).

### 7. Trust & abuse model

**Sanitization (site-side twin of the game's).** Never trust server-supplied text —
servers are open source and freely modifiable. `site/src/sanitize.ts`:

M1 hoists `STRIP_TEXT_RE` from `src/server/systems/players.ts:41-44` (today it lives
inside the game-state-coupled server tree) to a new dependency-free
`src/shared/text.ts`; `players.ts` imports it from there — a pure move, zero behavior
change. The site then imports the one true regex under the §1 rule instead of keeping
a copy-sync hazard:

```ts
// STRIP_TEXT_RE is imported from src/shared/text.ts (hoisted there in M1; importing
// src/server/systems/players.ts directly stays forbidden — it drags game-state types).
import { STRIP_TEXT_RE } from "../../src/shared/text";

export const SERVER_NAME_MAX = 48;   // code points
export const SERVER_MOTD_MAX = 140;

export function sanitizeListingText(raw: string, maxCodePoints: number): string {
  const cleaned = [...raw.normalize("NFC").replace(STRIP_TEXT_RE, " ").replace(/\s+/g, " ").trim()]
    .slice(0, maxCodePoints)
    .join("")
    .trim();
  return cleaned;
}
// Empty-after-sanitize server names fall back to the URL's hostname.
```

Applied on every write path (registration, heartbeat, probe refresh). Rendering is
`hono/jsx`, which escapes by default — no `dangerouslySetInnerHTML` equivalents, no
HTML/markdown in MOTD, no favicons/images in v1 (image hosting is its own abuse
surface; presets get built-in icons instead).

**URL rules** (registration + every probe): `https:` only, default port only, hostname
matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`, ≤253 chars,
no IP literals, no `xn--` labels (punycode lookalikes rejected in v1 — Luanti
precedent; ASCII covers workers.dev and virtually all custom domains), normalized to
bare origin. Probe client (`probe.ts`): `redirect: "manual"` (any redirect = fail),
5 s timeout via `AbortSignal.timeout`, response read capped at 16 KB, must be
`content-type: application/json`. This is the SSRF guard — the prober only ever GETs
`<stored-origin>/api/server-info`.

**Fake player counts — pragmatic v1.** Both heartbeat counts and probe counts are
self-reported by server code the owner controls; a modified server can lie to both
consistently, and no probe can prove otherwise (Rust's arms race, prior-art §5).
What v1 does:

- Probe values overwrite heartbeat values on conflict (probes are on our schedule, not
  theirs).
- Displayed `players` is clamped to `players_max`; `players_max > 32` is displayed
  as-is but score-penalized (official code hard-caps at `MAX_PLAYERS = 24`,
  constants.ts:31 — advertising 100 slots is itself a "modified server" signal).
- Heuristic flag, not auto-ban: if three consecutive probes each report `players` less
  than half the latest heartbeat's claim, set `flagged=1` for human review.
- Ranking caps the player term (§8) so inflation buys almost nothing — remove the
  incentive instead of fighting the arms race (the single strongest prior-art lesson:
  default-sort-by-players created FiveM's bot industry).
- The backstop is policy: `/policy` states plainly that fabricated counts, impersonation
  of other servers, or malicious listing content get delisted and the host banned
  (Rust PLA precedent). Reports + admin actions are the enforcement loop.

**What the directory vouches for — and what it does not.** This goes on `/policy` and
under every Join button, because it is the honest core of the whole feature:

> Listed servers are community-run copies of DEADCOAST at their own web addresses. We
> verify that the owner controls the address and that it answers as a DEADCOAST server.
> **We do not review or control the code it runs** — it may be modified, and its
> version of the game (including its login screen and everything you type there) is
> served by that operator, not by us.

Version-hash "unmodified build" verification is explicitly NOT built: a probe can hash
served JS, but an origin trivially cloaks (serve clean code to the probe, anything to
players) — research flagged this as unenforceable security theater
(directory-prior-art.md §8), and a green "verified unmodified" badge we cannot stand
behind is worse than no badge. The only architecture that makes build verification real
is the first-party join path (official client connecting out to `?server=wss://…`),
which is designed-for here (score tiers, `ServerInfo.protocol`) but deferred (Open
questions #3).

**Reporting/delisting.** Report button on every detail page → `reports` row; reasons
enumerated (§3 schema). Rate limit 5/day per `ip_hash` (sha256 of IP + daily-rotating
salt — no raw IPs at rest), duplicates per (ip_hash, server) collapsed. Reports never
auto-hide (brigading a rival server off the list must not work); ≥3 unique reporters
sets `flagged=1`. Admin page (`/admin`, `ADMIN_TOKEN` cookie) lists flagged servers and
open reports with hide/unhide/ban/delete actions, each writing `moderation_actions`.
Owner-initiated delist is immediate via `DELETE /api/v1/servers/:id` with the token.

### 8. Ranking & browse UX

**Score** (Luanti-adapted, every input capped, probe-derived, or history-derived —
`rank.ts`):

```ts
export function score(s: ServerRow, latestProtocol: number, now: number): number {
  const players = Math.min(s.players, 24);                       // cap = official MAX_PLAYERS
  const uptime = s.uptimeRatio20d * 8;                           // 0..8, from probes
  const age = Math.min((now - s.created_at) / (30 * 86400_000), 6); // 0..6
  const absurdCapacity = s.players_max > 32 ? -8 : 0;
  const outdated = s.protocol !== null && s.protocol < latestProtocol ? -4 : 0;
  return players + uptime + age + absurdCapacity + outdated;
}
```

No votes, no paid placement, no raw-player-count default sort. Client-measured ping is
per-viewer and never enters the stored score.

**Browse table** (`/servers`, top-10 of the same data on `/`):

| Column | Source | Notes |
| --- | --- | --- |
| Name + MOTD subline | sanitized listing | "Official" badge on the pinned row; "active now" / "idle — wakes on join" dot from heartbeat recency |
| Preset | `preset` | badge; `null` renders as "custom" |
| Players | `players`/`players_max` | small bar; from latest heartbeat-or-probe |
| Version | `version` + `protocol` | "outdated" badge when `protocol < latest` (build-time constant) |
| Region / Ping | `colo` → region map + `ping.js` | static IATA→region table (DFW→NA, AMS→EU, …); ping fills in client-side, "—" until measured |
| Uptime | `uptimeRatio20d` | % from probe history; tooltip shows window |

Filters (server-rendered query params): preset, "has space" (`players < players_max`),
"up to date", "show idle" (default on), name search (LIKE, sanitized). Sorts:
Recommended (score, default), Players, Uptime, Newest; "Ping" sort is client-side only
(ping.js re-orders rows after measuring). The official server renders as a pinned card
above the table on `/` and row #0 on `/servers`, excluded from ranking.

Detail page (`/servers/:id`): full MOTD, URL host shown verbatim, preset + its config
summary (from doc-04's `PRESETS` registry, imported build-time), 20-day uptime strip
(one cell per day from `probes`), hourly peak-players sparkline (`stats_hourly`),
created/age, last-probe timestamp (Factorio's cheap-honesty precedent), Join button,
Report link.

### 9. Join flow

Join = leave our site. Every Join button routes through `/join/:id` (SSR interstitial)
unless the visitor previously checked "don't warn me again for this server"
(`localStorage` key on the site origin, checked by ping.js, which then rewrites the
button to link straight out).

Interstitial content: server name, the literal destination host in large type, age +
uptime %, the vouch/no-vouch paragraph (§7), and:

- **Continue** — `<a rel="noopener noreferrer" href="https://<host>/?ref=deadcoast-directory[&name=<urlencoded>]">`.
- Optional name field (prefilled from the site's own `localStorage["dcd_name"]`):
  appends `?name=`. Requires a small game-client change — the menu prefills its name
  input from `location.search` `name` param (sanitized client-side; the server re-runs
  `sanitizeName` at join regardless, players.ts:46-60). Convenience only.
- What is deliberately NOT passed: the player's `dc_token`. Identity is per-origin by
  design — a community operator must never receive a credential that resumes the
  player's character elsewhere, and `localStorage` isolation already enforces this.
  The interstitial says so ("you'll have a separate character on each server").

The official pinned card links directly to the official instance without the
interstitial — it is first-party.

### 10. Version skew

Each community server serves its own matched client+server build, so skew **never
breaks a join** — a v3 server with a v3 client is self-consistent. Skew matters as
information: the directory (built from this repo) knows the latest `GAME_VERSION` +
`PROTOCOL_VERSION` at its own build time and renders an "outdated" badge + score
penalty for `protocol < latest`. The badge tooltip: "runs an older version of
DEADCOAST — content and fixes may be missing." A hard version gate (Factorio precedent)
only becomes relevant with the first-party join path, where the official client would
refuse `welcome.proto !== PROTOCOL_VERSION` (doc-03 §1's field name); `welcome` carries `proto` from M1 so
that gate is already plumbed when the tier arrives.

### 11. Caching & pagination

- `GET /api/v1/servers` builds the full ranked list (≤500 rows, ~100 KB JSON worst
  case) once per 30 s: `caches.default` keyed on the URL, `Cache-Control: public,
  max-age=30, stale-while-revalidate=120`. All SSR list/detail pages render from the
  same cached payload (internal helper, not a second D1 read), HTML cached 60 s.
  `caches.default` is **per-data-center** — cached content does not replicate between
  colos (Workers Cache API docs, re-fetched 2026-06-11) — so visitor traffic costs
  ~2 D1 reads per 30 s **per colo with traffic**, NOT globally, and a spike from a new
  region always takes one cold read. Worst case (hundreds of active colos) is a few
  hundred K reads/day — still <10% of D1 free's 5 M/day read cap — but never size
  anything against a single global "2 reads per 30 s" figure.
- HTML pagination on `/servers` is offset-based over the cached list, 50 rows/page —
  at ≤500 listed servers cursor pagination is complexity with no payoff. The 500-row cap
  is asserted in code with a loud comment; if the directory ever approaches it,
  revisit (keyset pagination + per-page cache).
- `POST` routes (`heartbeat`, registration, reports) are never cached; heartbeat is a
  single prepared `UPDATE … WHERE id = ? AND token_hash = ?`.
- Static assets (CSS, ping.js, logo) are platform-served and free (cf-costs.md §1).
- **Costs the directory imposes on LISTED servers** (their accounts, not ours): every
  cron probe and every ping.js measurement is one billed Worker request + one billed DO
  request at the target — worker.ts:16-19 routes `/api/*` through `stub.fetch`, and a
  DO cold start also runs constructor SQL (GameRoom.ts:153-161). Probes: 288/day,
  ~0.3% of a free plan's 100 K/day request caps — noise. Visitor pings: bounded by §1's
  viewport-only rule to roughly one request per pageview-where-visible, so a top-10
  server at 5 K front-page views/day spends ~5% of its free DO-request budget — the
  same budget cf-costs.md found is the binding constraint (~26 player-hours/day) —
  purely on being popular in the list. The hosting docs must say this plainly: being
  listed costs request quota in proportion to directory traffic, and busy public
  servers should be on Workers Paid anyway (cf-costs.md's own conclusion).

## Implications

**Opens up**

- Community hosting becomes discoverable — the doc-01 deploy flow ends with "your server
  is live AND listed," which is the whole growth loop.
- `/api/server-info` + `PROTOCOL_VERSION` are the foundation for the future first-party
  join path (`?server=wss://`), server-pick UI in the official client, and update
  nagging — all without re-architecture.
- `stats_hourly`/`probes` give Adam fleet observability (how many servers, how healthy)
  for free.
- The owners table + OAuth sub plugs straight into doc-01's account model; "my servers"
  dashboard is additive.

**Complicates**

- Two deploy targets in one repo: releasing the game now implies redeploying the site
  (build-time `latest` constants) — one extra npm script, but a real cadence coupling.
- The game worker gains its first env vars/secrets (`DIRECTORY_URL`, `DIRECTORY_TOKEN`)
  — `Env` typegen, README, and doc-01's metadata templates all need them.
- Heartbeat sender adds outbound I/O to the tick path; it is fire-and-forget, but it is
  the first non-game side effect inside `timedTick` and must stay exception-proof.
- `site/` imports constants/types-only modules from `src/shared/` (§1 rule), so the
  site build is coupled to the game tree: a game-side refactor that drags a heavy
  runtime import into `protocol.ts`/`text.ts`/`version.ts`/`config.ts` breaks or bloats
  the site build. Cheap to police, but real — review-enforced in v1 (see Open
  questions #6).

**Breaks**

- Nothing existing in code. All game-side changes are additive (new route, new optional
  envs, new `welcome` field old clients ignore, new shared constants; the
  `STRIP_TEXT_RE` hoist to `src/shared/text.ts` is a pure move). No `SCHEMA_VERSION`
  bump, no worldgen impact, no rng-stream changes. One honest qualifier: LISTING a
  server is not cost-neutral for its owner — probes and visitor pings consume the
  listed server's own Worker/DO request quotas (§11) — so "additive" describes the
  codebase, not a community host's free-tier budget.

**Threatens**

- **Reputation laundering**: our domain ranks listings we cannot code-review. The
  interstitial + policy language is mitigation, not elimination — one phishing incident
  on a listed server lands on deadcoast's name. The malware-phishing report category and
  fast admin delisting are the response path; accept this risk consciously or don't
  ship a directory.
- **Count-faking arms race**: v1's capped ranking removes most incentive but a lying
  server still shows fake numbers to humans. Budget moderation time; the heuristic flag
  will have false positives (probe hits during a player exodus).
- **D1 free-tier write caps**: at roughly ~100 listed servers the probe+heartbeat write
  volume (including per-index write amplification) breaches free D1 (§6 math). Run the
  directory on Workers Paid from day one or accept silent write failures — same failure
  class cf-costs.md found in the game.
- **Cron prober as single point of staleness**: if cron stops (deploy error), listings
  freeze and `unreachable` evictions stall. Health check: `/api/v1/servers` response
  includes `generatedAt`; alert if stale (manual for v1).

## Migration & compatibility

- **Existing worlds/saves**: untouched. No persistence schema change, no
  `SCHEMA_VERSION` bump, no worldgen config. Determinism contract unaffected — nothing
  here feeds world gen.
- **Wire protocol**: `welcome` gains `proto: number` (doc-03 §1's field name; additive; current clients
  ignore unknown fields — JSON discriminated unions, protocol.ts). `PROTOCOL_VERSION`
  starts at 1 ≙ today's protocol. No wire version existed before; this creates it.
- **Deployed official instance**: keeps working untouched; gains `/api/server-info` on
  next regular deploy; gets listed when Adam sets its `DIRECTORY_TOKEN`.
- **Community servers deployed before M1**: cannot register — verification requires
  `/api/server-info` with the challenge field. The `/register` page detects this
  (probe returns 426/404) and says "update your server: git pull && npm run deploy".
  Acceptable: today there are approximately zero community deploys.
- **Token/secret rotation**: rotating `DIRECTORY_TOKEN` on a server breaks the challenge
  → probes fail with `challenge-mismatch` → `unreachable` → owner re-registers. Crude
  but safe; proper re-keying is post-v1.
- **Renaming/moving a server**: URL is the unique key; a moved server re-registers and
  loses uptime history (age resets). Documented on `/register`; intentional — history
  must be earned at an address (anti-impersonation property).

## Implementation plan

Milestone deps: M1 → M3 → M4 → M5 → M6/M7 → M8; M2 only needs the repo. M1 should
coordinate with doc-04's first milestone (ServerConfig) — if doc-04 hasn't landed,
stub `name`/`motd`/`preset` from optional vars with a TODO referencing doc-04. Where M1
overlaps doc-03's M1–M3 (version gate, `/api/server-info`, heartbeat sender), doc-03's
spec is canonical — implement once, against it.

1. **M1 — Game-side contracts** *(Opus 4.8 — protocol + tick-path changes)*.
   Add `PROTOCOL_VERSION = 1` to `src/shared/protocol.ts` and the `ServerInfo` type per
   doc-03 (`src/shared/serverInfo.ts`; `GAME_VERSION` in `src/shared/version.ts`);
   hoist `STRIP_TEXT_RE` from `src/server/systems/players.ts:41-44` to a new
   dependency-free `src/shared/text.ts` (pure move; `players.ts` imports it from
   there); `proto` field in `join`/`welcome` (doc-03 §1's two-sided gate); doc-03 §5's
   heartbeat constants (`HEARTBEAT_INTERVAL_S` etc.) in
   `src/shared/constants.ts`;
   `/api/server-info` route in `src/server/worker.ts` + `GameRoom.fetch` (never wakes
   sim, CORS `*`, challenge hash cached, colo via cdn-cgi/trace with null fallback —
   verify the colo trick on a real deploy, it is UNCONFIRMED); heartbeat sender in the
   tick (fire-and-forget, only when `DIRECTORY_URL` + `DIRECTORY_TOKEN` set); `Env`
   typegen. Acceptance: `npm run typecheck` green; local `curl /api/server-info`
   returns the documented shape idle AND with a connected client; loadtest
   (`scripts/loadtest.mjs`) unchanged-green; tick EMA unchanged with heartbeats enabled
   against a mock directory.
2. **M2 — Site scaffold** *(Sonnet 4.8)*. `site/` per §1: wrangler.jsonc, package.json
   (hono pinned), tsconfig (strict, hono/jsx), D1 migrations for the §3 schema,
   `sanitize.ts` + unit tests (zero-width/bidi/surrogate cases mirrored from the game's
   precedent), layout shell + static landing page, `deploy:site` root script.
   Acceptance: `wrangler dev -c site/wrangler.jsonc` serves `/`; migrations apply
   clean; sanitize tests pass.
3. **M3 — Registration, verification, heartbeat ingest** *(Opus 4.8 — this is the trust
   boundary)*. `tokens.ts` (mint/parse; computes BOTH `token_hash` and `challenge_hash`
   at mint time — §2, the challenge is underivable later), `probe.ts` (SSRF guard per
   §7, challenge compared against the stored `challenge_hash`),
   `POST /api/v1/servers`, `/verify`, `/heartbeat`, `DELETE`, URL validation,
   `banned_hosts` check, `attempts`-table rate limits (§3), `/register` wizard page.
   Acceptance: end-to-end
   local test — register a `wrangler dev` game server, set secret, verify, heartbeat
   updates the row; proxy-attack test (second registration pointing at the first
   server's URL copy) fails with `challenge-mismatch`; redirects and >16 KB responses
   rejected.
4. **M4 — Prober + lifecycle** *(Sonnet 4.8)*. Cron handler: probe fan-out with backoff,
   state machine (§6), `probes`/`stats_hourly` writes, pruning, pending-expiry,
   30-day eviction. Acceptance: simulated probe failures walk a server
   live→unreachable→live; history prunes at 20 days; idle server (reachable, 0 players)
   stays `live`.
5. **M5 — Browse UX + ranking** *(Sonnet 4.8)*. `rank.ts` (+ region map), cached list
   endpoint + `caches.default` (§11), `/`, `/servers`, `/servers/:id` SSR with
   filters/sorts/pagination, `ping.js`, official-pinned rendering, outdated badge.
   Acceptance: filters are pure query params (cacheable URLs); list endpoint serves
   from cache within TTL (assert via `generatedAt`); ping column fills against two
   local servers.
6. **M6 — Join flow** *(Sonnet 4.8)*. `/join/:id` interstitial, don't-warn-again,
   `?ref`/`?name` pass-through, game-client menu prefill from `?name=` (small change in
   `src/client/ui`, name still re-sanitized server-side). Acceptance: interstitial
   wording matches §7 verbatim-or-better; name survives the hop into the join message;
   no token or other storage crosses origins.
7. **M7 — Reports + moderation** *(Sonnet 4.8)*. Report endpoint + form, ip_hash rate
   limiting, flag heuristics (§7), `/admin` (ADMIN_TOKEN cookie) with
   hide/unhide/ban/delete + audit log, `/policy` page. Acceptance: ≥3 unique reporters
   flags; reports never auto-hide; every admin action lands in `moderation_actions`;
   banned host cannot re-register.
8. **M8 — Launch wiring** *(Sonnet 4.8; depends on doc-01 for the auto-registration
   hook)*. Register the official instance (`source='official'`), expose the §5
   registration call for doc-01's deploy flow, README + in-repo hosting docs (include
   cf-costs.md's player-hours language), deploy `deadcoast-site`, post-deploy smoke
   script (register→verify→heartbeat→list against production). Acceptance: official
   server visible and pinned on the live landing page with real uptime after 24 h.

## Open questions

1. **Workers Paid for the directory account?** Free-tier D1 writes are breached
   outright around ~100 listed servers (§6 math, including index write amplification),
   and the 50-subrequest cron cap binds at 50. **Recommendation: yes, $5/mo from
   day one** — it also removes the probe-batching constraint.
2. **Custom domain now or later?** The directory works fine on
   `deadcoast-site.<sub>.workers.dev`, but cf-oauth.md found public OAuth-client
   visibility (needed for doc-01's "any Cloudflare user" login) hard-requires a
   TXT-verifiable custom domain, and a directory that ranks community servers should
   not itself live on a workers.dev subdomain forever. **Recommendation: buy the domain
   now; ship v1 on workers.dev only if the name isn't settled.**
3. **First-party join tier in scope for v1?** The official client accepting
   `?server=wss://host/ws` would give a verified-build tier above off-site links
   (prior-art §8) but drags in protocol hard-gating and per-server world-seed handoff
   testing. **Recommendation: defer; M1's `protocol` plumbing keeps it cheap later.
   Decide before any "verified" wording ships — v1 must not imply build verification.**
4. **Default `DIRECTORY_URL` in the game's wrangler.jsonc?** Shipping the official
   directory URL as a default var means every fork heartbeats at us by merely setting
   a token (good funnel, slight surprise factor). **Recommendation: yes, ship the
   default; heartbeats are inert without a token.**
5. **Token-only registration allowed, or require Cloudflare OAuth sign-in?**
   OAuth-gating manual registration adds a revocable identity (FiveM lesson) but
   public-visibility OAuth is blocked on Q2's domain anyway. **Recommendation: allow
   token-only at launch (Luanti's openness + our probe gate); add optional OAuth
   attachment when doc-01's login lands.**
6. **How hard to police the `src/shared/` import boundary?** The §1 rule (site imports
   constants/types-only modules from `src/shared/`, never `src/server/`/`src/client/`)
   is review-enforced in v1; an ESLint `no-restricted-imports` rule or a tsconfig
   project reference would make it mechanical. **Recommendation: review-only for v1;
   add lint enforcement the first time someone breaks it.** (An earlier draft instead
   kept a verbatim `STRIP_TEXT_RE` copy to avoid importing from `src/` at all — that
   contradicted the build-time `PROTOCOL_VERSION`/`PRESETS` imports §3/§8 already
   required and doc-03's shared `serverInfo.ts`; superseded by the M1 hoist to
   `src/shared/text.ts`.)
7. **Name pass-through privacy stance**: `?name=` leaks the chosen display name to the
   destination server in the URL (referrer-adjacent). It is opt-in per join and the
   name is about to be typed there anyway. **Recommendation: keep it, opt-in field on
   the interstitial, never auto-filled from anything the destination couldn't already
   learn.**
