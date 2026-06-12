# What it costs to run a DEADCOAST server on your own Cloudflare account

**Research date: 2026-06-11.** All pricing/limits below were fetched live from Cloudflare docs on this date (URLs inline). Cloudflare pricing changes; re-verify before publishing user-facing numbers. Note: **SQLite storage billing (rows read/written) went live January 2026** — older blog posts and forum threads that say "DO SQLite storage is free" are stale.

Sources:

- DO pricing: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- DO limits: <https://developers.cloudflare.com/durable-objects/platform/limits/>
- WS hibernation behavior: <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>

## TL;DR

| Scenario | Free plan | Paid ($5/mo Workers) |
| --- | --- | --- |
| (a) 3 friends, 2h/evening | **Breaks today** — rows-written cap blown ~80 min into each session. Viable only after a persistence fix (below). | **$5.00 flat** — everything inside included quotas |
| (b) 10 players, 6h/day | **No** — request cap dies ~2.7h in; rows-written cap 4.5× over | **≈ $5.85/mo** |
| (c) 30 players, 24/7 | **No** — request cap dies in ~54 min | **≈ $18–24/mo** worst case (30 concurrent all day); ~$13–18 at realistic average occupancy |

The surprise: **duration billing does NOT kill the free plan** — a single 24/7 room fits under the daily duration cap with 20% headroom. What kills it is (1) the **SQLite rows-written cap**, blown by `persistAll`'s wipe-and-reinsert pattern after ~80 active minutes/day, and (2) the **request cap**, which budgets ~26 player-hours/day of WebSocket traffic.

---

## 1. The billing model (verified facts)

### Free plan (Workers Free, $0)

Durable Objects ARE available on free — **SQLite-backed classes only** ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). DEADCOAST qualifies: `wrangler.jsonc` declares the GAME binding via `new_sqlite_classes` migration v1.

Daily caps, reset **00:00 UTC**. Per the docs: *"If you exceed any one of the free tier limits, further operations of that type will fail with an error."*

| Metric | Free daily cap |
| --- | --- |
| DO requests (incl. WS messages at 20:1, see below) | 100,000/day |
| DO duration | 13,000 GB-s/day |
| SQLite rows written | 100,000/day |
| SQLite rows read | 5,000,000/day |
| SQLite stored data | 5 GB total (account) |
| Worker requests (the front-door Worker: `/ws` upgrades, `/api/*`) | 100,000/day, Error 1027 past that |
| Worker CPU | 10 ms/invocation |
| Worker script size | 3 MB gzip (paid: 10 MB) — assets don't count toward this |

### Paid plan (Workers Paid, $5/mo minimum)

| Metric | Included / month | Overage |
| --- | --- | --- |
| DO requests | 1,000,000 | $0.15 / million |
| DO duration | 400,000 GB-s | $12.50 / million GB-s |
| SQLite rows written | 50,000,000 | $1.00 / million |
| SQLite rows read | 25,000,000,000 | $0.001 / million |
| SQLite stored data | 5 GB-month | $0.20 / GB-month |
| Worker requests | 10,000,000 | $0.30 / million |
| Worker CPU | 30,000,000 CPU-ms | $0.02 / million CPU-ms |

### Billing semantics that matter for this codebase

- **Duration is wall-clock at a flat 128 MB assumption**: 1 active second = 0.125 GB-s, i.e. **450 GB-s per active hour**, regardless of actual memory or player count. Billed *"while actively running or idle in memory but unable to hibernate."*
- **The 15 Hz tick makes hibernation impossible.** Hibernation docs: *"Events such as alarms, incoming requests, and scheduled callbacks prevent hibernation. This includes `setTimeout` and `setInterval` usage."* `GameRoom` runs `setInterval(TICK_MS)` (≈66.7 ms, `TICK_RATE = 15` in `src/shared/constants.ts:16`) whenever anyone is connected — so the room bills wall-clock duration for the entire session. We use `ctx.acceptWebSocket()` (the hibernation API, `GameRoom.ts:207`), but hibernation itself is billing-irrelevant here. It stops billing only when the tick stops (room idle → `stopAndPersist` → `clearInterval`).
- **Incoming WebSocket messages bill as DO requests at 20:1** (*"a 20:1 ratio is applied to incoming WebSocket messages"* — applies to compute-request billing generally, not just hibernating objects). **Outgoing WS messages are free** — our 15 Hz snapshot broadcast costs $0. Each WS connection costs 1 Worker request + 1 DO request at upgrade.
- **Deletes count as rows written** (*"Deletes are counted as rows written"*). This is what condemns the current `persistAll` on free (Section 3).
- **Static assets are free and unlimited** on both plans (*"Requests to static assets are free and unlimited"* — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The client bundle costs nothing to serve.
- **Subrequests are not billed** (outbound `fetch` from Worker or DO). Limits: 50/request free, 10,000/request paid (per the live [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page).
- No bandwidth/egress charges appear anywhere on the Workers or DO pricing pages.

---

## 2. The DEADCOAST workload, grounded in code

| Driver | Value | Source |
| --- | --- | --- |
| Server tick | 15 Hz `setInterval` while any socket connected (or offline bodies linger) | `src/shared/constants.ts:16`, `GameRoom.ts:369` |
| Client input send rate | every 50 ms → **20 msgs/s/player** | `INPUT_SEND_MS = 50`, `constants.ts:18` |
| Client ping | every 2 s → 0.5 msgs/s/player | `PING_INTERVAL_MS = 2000`, `src/client/net/connection.ts:23` |
| Inbound WS total | **20.5 msgs/s/player** → 1.025 billed req/s/player at 20:1 | derived |
| Outbound snapshots | 15 Hz/player — **free** (outgoing) | `broadcastSnapshots` |
| Durable save | `persistAll` every 20 s of game time while ticking (plus on death/join/idle) | `WORLD_SAVE_INTERVAL_S = 20`, `constants.ts:178`; `GameRoom.ts:698-701` |
| Rows per `persistAll` | `DELETE FROM world_state` (W deletes) + W reinserts + 8 meta upserts + P character upserts ≈ **2W + 8 + P**; persistence.ts comments say W < 200, so ≈ **320–410 rows/save** with a few players | `src/server/persistence.ts:128-166, 251` |
| Rows read | world load on boot (~W + meta), trivial thereafter | `loadWorld` |
| DB size | world_state JSON + characters + capped leaderboard — single-digit MB | `persistence.ts` |

### Cost primitives (per active hour)

- **Duration: 450 GB-s/hour** the room is awake (player-count independent).
- **Requests: ~3,690 billed/player-hour** (20.5 msgs/s ÷ 20 × 3600).
- **Rows written: ~74,000/hour** at W=200, P=3 (180 saves/hour × 411 rows). At W=150 it's ~57,000/hour. **Player count barely matters — the world snapshot dominates.**

---

## 3. Where the free plan hard-stops the game

### Rows written: dead in ~80 minutes — even for scenario (a)

At ~20.6 rows written/second (411 rows ÷ 20 s), the 100,000/day cap is exhausted after **~81 active minutes** (W=200; ~105 min at W=150). Player count is irrelevant — three friends hit it as fast as thirty.

What failure looks like: `persistAll` → `transactionSync` throws **inside the tick**, every 20 s, for the rest of the UTC day. Transactions are atomic so the DB doesn't corrupt, but nothing saves: progress since the last good save is lost on the next eviction/restart, and `markCharacterDead` (`GameRoom.ts:586`) fails too — deaths can't be made durable. The current code has no catch around `persistAll`, so each failed save is an unhandled exception in the tick callback. **The free plan as-shipped means "saves silently break mid-session every evening."** Caps reset at 00:00 UTC (18:00 Central) — which lands right at US evening play time, so a session that straddles the reset gets a fresh budget mid-evening. Cute, but not a plan.

### Requests: a budget of ~26 player-hours/day

100,000 ÷ 3,690 ≈ **27 player-hours/day** (≈26 after WS upgrades, `/api/*` calls, and directory polls). Scenario (a) uses 6 — fine. Scenario (b) uses 60 — the cap dies ~2h40m into the evening: **new inbound WS messages start failing with errors, which the server's liveness sweep (`LIVENESS_TIMEOUT_MS`) will read as dead clients — players drop and cannot rejoin until 00:00 UTC.** Yes, the server dies mid-session.

### Duration: NOT the problem (genuinely surprising)

24/7 operation = 86,400 s × 0.125 GB = **10,800 GB-s/day < 13,000 cap**. One always-on room fits free with 20% headroom. Two simultaneously active rooms (or one room + heavy other DO usage on the account) would breach. Rows read (5M/day) and storage (5 GB vs. single-digit MB) never come close.

---

## 4. Scenario math (paid plan, 30-day month)

### (a) Host + 2 friends, 2 h/evening

| Metric | Monthly usage | Cost |
| --- | --- | --- |
| Requests | 3 × 3,690 × 2 × 30 = 664K | $0 (< 1M incl.) |
| Duration | 2 × 450 × 30 = 27,000 GB-s | $0 (< 400K) |
| Rows written | 148K/day × 30 = 4.4M | $0 (< 50M) |
| **Total** | | **$5.00 flat** |

### (b) 10 players, 6 h/day

| Metric | Monthly usage | Cost |
| --- | --- | --- |
| Requests | 10 × 3,690 × 6 × 30 = 6.64M | (6.64 − 1) × $0.15 = **$0.85** |
| Duration | 6 × 450 × 30 = 81,000 GB-s | $0 |
| Rows written | 451K/day × 30 = 13.5M | $0 |
| **Total** | | **≈ $5.85/mo** |

### (c) 30 players, 24/7 (worst case: full 30 concurrent all day)

| Metric | Monthly usage | Cost |
| --- | --- | --- |
| Requests | 30 × 3,690 × 24 × 30 = 79.7M | (79.7 − 1) × $0.15 = **$11.81** |
| Duration | 10,800 × 30 = 324K GB-s | $0 — just under the 400K included (other DO usage on the account tips it into $12.50/M GB-s overage; even fully unincluded it's only $4.05) |
| Rows written | 1.89M/day × 30 = 56.8M | (56.8 − 50) × $1.00 = **$6.76** |
| Rows read / storage / assets / Worker CPU | trivial | $0 |
| **Total** | | **≈ $23.6/mo worst case; ~$13–18 at a realistic ~15 avg concurrent** |

Sensitivity: requests scale linearly with concurrent player-hours; rows written scale with active hours only; duration with active hours only. The formula for creator docs: **$/mo ≈ $5 + $0.15 × (player-hours/mo × 3,690 − 1M)⁺/1M + $1.00 × (active-hours/mo × 74K − 50M)⁺/1M.**

---

## 5. Directory-side costs (official US directory)

Two designs, both cheap:

- **Heartbeats (recommended):** each community server POSTs to the directory every 60 s. Sender side: outbound `fetch` from the DO/Worker = unbilled subrequest. Directory side: 1,440 requests/day/server. A **free-plan** directory supports ~69 servers at 60 s cadence, ~347 at 5 min. Paid: 10M/mo included ≈ 230 servers at 60 s before $0.30/M overage even starts. Heartbeats also solve discovery (servers self-register) — polling requires already knowing the list.
- **Polling `/api/server-info`:** directory cron fans out N fetches — unbilled subrequests, but capped at 50/invocation on free (10,000 paid), so a free directory polls ≤50 servers per cron tick. Cost lands on the *community* server instead: 1,440 Worker requests/day at 1/min — 1.4% of their free daily Worker budget. Fine, but make the directory poll no faster than 1/min, and keep `/api/server-info` answered by the Worker (from a heartbeat-pushed cache or DO `id.name` metadata) rather than waking the DO, or each poll also bills a DO request and — worse — could keep an empty room's tick from ever mattering (the tick only runs with sockets connected, so polls won't keep it awake, but they do bill DO requests).

Either way, directory cost is noise: free plan covers hundreds of servers.

---

## 6. Engineering levers (change the math materially)

1. **Fix `persistAll` write amplification — the single change that makes free-plan hosting real.** The wipe-and-reinsert of `world_state` (`persistence.ts:128`) writes ~400 rows per save when typically a handful of entities changed. Options: (i) dirty-tracking + keyed upserts/deletes per entity, (ii) collapse the world snapshot into ONE row (single JSON blob — W×2 deletes+inserts become 1 write; 2 MB row cap is plenty for <200 small entities), or (iii) simply raise `WORLD_SAVE_INTERVAL_S` 20→60 (3× fewer writes; scenario (a) drops to ~49K rows/day — under cap — at the price of losing up to 60 s on unclean restart). Option (ii) is ~30 lines and cuts rows written ~50×; it also erases the $6.76 line in scenario (c). The "<200 rows is tiny" comment in persistence.ts was written before January 2026, when these writes had no price.
2. **Stop sending input faster than the server can use it.** `INPUT_SEND_MS = 50` (20 Hz) outruns the 15 Hz tick — the extra 5 msgs/s/player buy nothing. Setting it to 66 ms (15 Hz) cuts request billing ~24% for free, zero gameplay impact. Going to 100 ms (10 Hz, batched cmds — the protocol already batches) halves it, at +33 ms worst-case input delay. Tunable in `src/shared/constants.ts`, but it's a shared constant — client and server liveness expectations must move together.
3. **Don't add server-side pings or alarm-driven background work** to community-server code paths — every alarm invocation is a billed request and a billed row written (`setAlarm` = 1 row), and anything that keeps timers alive bills duration on an empty room. The current "tick only while sockets exist" design is exactly right; protect it.

---

## 7. Blunt recommendation

**Free-plan hosting is NOT viable as the code ships today — and we should not market it as viable until lever #1 lands.** Three friends for two hours blows the rows-written cap nightly, and failure mode is the ugliest kind: the game keeps running while saves silently fail. After the persistence fix (one-row world snapshot), the free plan honestly supports the "me and a few friends, evenings" case: the real budget becomes ~26 player-hours/day of WS traffic, all caps resetting 00:00 UTC.

**Tell server creators this, verbatim-ish:**

- *"Hosting DEADCOAST for a few friends costs $0 on Cloudflare's free plan (after vX.Y), with a hard budget of roughly 25 player-hours per day. If your server blows past that, players get disconnected until 7 PM Eastern / midnight UTC."*
- *"The $5/month Workers Paid plan removes the daily caps and flat-out covers a friends server. A busy public server costs the $5 plus pennies-to-$20 in usage — a full 30-slot server running 24/7 worst-cases around $25/month. You will never wake up to a surprise $500 bill: usage scales with player-seconds, and 100 player-hours costs about 6 cents in request overage."*
- The setup docs/UX should: (1) default-recommend Paid for anything public, (2) show the player-hours math, not vague "may incur charges" language, (3) warn that free-plan caps reset at 00:00 UTC — prime-time in the US — so breaches hit mid-session, and (4) never suggest disabling the tick-while-connected model to save money; duration was never the expensive part.

Open follow-ups: confirm the worker script stays under the 3 MB gzip free-plan cap as the server grows (currently far under; assets excluded); re-verify the 20:1 WS ratio and SQLite rates at doc-publish time; decide heartbeat cadence (60 s is comfortable everywhere).
