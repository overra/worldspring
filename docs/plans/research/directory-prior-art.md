# Server Directory Prior Art — what successful games do, and what DEADCOAST should steal

Research for DEADCOAST's community server directory. Surveys Minecraft, FiveM/CitizenFX,
Factorio, Valve/Steam, Terraria/Rust list sites, and Luanti (Minetest) — then maps the
findings onto the decisions DEADCOAST has to make. Web-specific trust issues (join = click
a URL to a third-party origin) get their own section because **no studied system has this
problem**, and it is the most consequential decision in the whole feature.

Confidence labels: facts below are from primary docs/source unless marked *(reported)* =
secondary source, or *(inference)* = my read.

---

## 1. Minecraft — no official directory, protocol-level status query

Mojang never shipped a server list. Two things grew in the vacuum:

### Server List Ping (SLP) — the status protocol that proved the minimal field set

Client connects to the server directly, requests status, gets one JSON blob
([minecraft.wiki SLP spec](https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping)):

- `version: { name: string, protocol: number }` — human label + machine-checkable protocol
  number. The client compares `protocol` to its own and renders incompatible servers
  **grayed out but still visible**, showing the version mismatch. Players self-select.
- `players: { max, online, sample?: [{name, id}] }` — counts plus an optional small sample
  of player names (privacy: sample is optional and truncated).
- `description` — MOTD as a rich-text component (formatting allowed, but it's a constrained
  text-component schema, not HTML).
- `favicon` — base64 PNG, **hard-capped at 64×64**. Size-capping the image at the protocol
  level is what keeps the listing UI safe and fast.
- Separate ping/pong packet with an echoed payload → **latency is measured by each client,
  per client**, never self-reported by the server.

Fifteen years of third-party list sites run on exactly these fields. Treat this as the
proven minimum viable status schema: name, MOTD, version+protocol, online/max, capped icon,
client-measured latency.

### Third-party list sites — what happens without an official directory

Sites like minecraftservers.org and mcvoting.com rank **entirely by monthly vote count**,
reset on the 1st ([minecraftservers.org help](https://minecraftservers.org/help)). Votes
feed back in-game via the Votifier/NuVotifier webhook protocol so servers can pay players
in items for voting — a whole vote-incentive economy. Sites also sell **sponsored slots**
(star icon, top of every relevant page). Result: ranking reflects marketing budget and
vote-reward generosity, not server quality, and every list site fights vote-bot abuse
("abuse → votes reset to zero").

**Lesson:** the absence of an official directory doesn't prevent a directory — it
guarantees several worse ones. Run the official one from day one. Don't rank by votes.

## 2. FiveM / CitizenFX — central directory, account-tied keys, and the fake-player war

The strongest "central authority" model studied:

- **Server license key required to even boot.** Keys are issued at
  [keymaster.fivem.net](https://keymaster.fivem.net/), tied to a Cfx.re forum account and
  to the server's IP; mismatched IP → heartbeat rejected, server refuses to start; one key
  per live server *(reported:
  [rocketnode guide](https://rocketnode.com/help/fivem/how-to-generate-your-fivem-server-key-license/),
  [ouiheberg guide](https://www.ouiheberg.com/en/documentation/article/keymaster-fivem-guide))*.
  The account tie is the real point: it's a **revocation lever** and makes ban evasion cost
  something.
- Servers POST heartbeats to the Cfx ingress; listing changes propagate in minutes, "allow
  10–15 min" *(reported)*. Clients fetch the whole list from
  `servers-frontend.fivem.net/api/servers/streamRedir` (streamed), single servers from
  `/api/servers/single/{joinId}` ([community API docs](https://github.com/HAMz-Project/FiveM-Api)).
  Joining goes through short `cfx.re/join/{code}` URLs — the directory owns the join
  handle, not the raw IP *(inference from the single/{id} API shape)*.
- **Fake player counts are endemic anyway.** Default sort is by player count, so a paid
  industry of fake-player bots exists (e.g. cfx.bot sells exactly this). Cfx.re fights it
  with **policy, not protocol**: server bans citing "PLA violation / Fake Players" and
  takedowns of bot services, which then adapt and return
  ([Cfx.re forum thread](https://forum.cfx.re/t/cfx-community-must-stand-against-fake-players/5304029)).

**Lesson:** signed/authenticated heartbeats prove *who* is listing, never *what is true*.
If your default sort is raw player count, you have created the incentive; the directory
ends up doing moderation either way. Authentication's real value is identity + revocation.

## 3. Factorio — official matchmaking API, token-authed, exact-version gating

([wiki.factorio.com/Matchmaking_API](https://wiki.factorio.com/Matchmaking_API),
[wiki.factorio.com/Multiplayer](https://wiki.factorio.com/Multiplayer))

- Server publishes itself with the owner's **username + auth token** (token from the
  Factorio account; docs explicitly say prefer token over password). Undocumented-but-live
  endpoints: `create-game`, `post-game-heartbeat/{server_id}`, `remove-game` — i.e.
  register → heartbeat → explicit deregister. Heartbeat cadence and stale-eviction window
  are **not publicly documented**; the Server Description Object carries a
  `last_heartbeat` Unix timestamp, so staleness is at least exposed to clients.
- `get-games` (the full list) **requires a logged-in user's token even to read** — list
  access is gated to game owners. `get-game-details/{id}` is open.
- The listing schema is rich: name, description, version (+build/platform), player list,
  max players, **has_password flag**, **mod list with versions**, in-game time elapsed.
- Joining requires **exactly the same game version and mods** — hard gate, not a warning.

**Lesson:** register/heartbeat/deregister with an account token is the clean official-API
shape. Exposing `last_heartbeat` to the UI is cheap honesty. Factorio's hard version gate
works because the deterministic lockstep sim breaks on any mismatch — DEADCOAST's shared
deterministic sim (`src/shared/world.ts`, `src/shared/movement.ts`) has the same property,
so the hard-gate precedent applies directly.

## 4. Valve / Steam — master server + direct A2S queries (brief)

([Reactor's A2S guide](https://wiki.reactor-servers.com/docs/guides/steam-query-protocol/);
canonical spec at developer.valvesoftware.com/wiki/Server_queries, 403s to fetchers)

- Two-tier model: servers heartbeat to the **master server** (registration happens
  automatically via the Steam SDK on boot); clients get the address list from the master,
  then **query each server directly** over UDP — `A2S_INFO` (name, map, players, max,
  bots, OS, VAC, version), `A2S_PLAYER`, `A2S_RULES`. Ping is therefore client-measured.
- Because the query is UDP, it was a **reflection/amplification DDoS vector**: small spoofed
  request, big response to the victim. Valve retrofitted a 4-byte **challenge-response**
  (server sends a random challenge, client must echo it) onto A2S_INFO in 2020
  ([Valve RFC](https://steamcommunity.com/discussions/forum/14/2989789048633291344/)).
- Browser UX that survived 20 years: filter by not-full / not-empty / map / latency; sort
  by ping and players.

**Lesson:** the "directory gives addresses, client verifies each server itself" split keeps
the directory's data honest-ish (counts come from a live query, not a self-report) and
scales. The reflection-attack saga is a UDP problem — DEADCOAST is HTTPS/WSS, where source
addresses can't be spoofed, so challenge tokens for *that* purpose are unnecessary.
*(inference)*

## 5. Terraria / Rust community lists — probes, uptime, and blacklists

### terraria-servers.com (representative vote-list site)
([about](https://terraria-servers.com/about/), [help](https://terraria-servers.com/help/))

- The site **probes every listed server every 5 minutes** and keeps 20 days of status
  history → published **uptime %**. A server at 0% uptime that stays offline 50 days is
  auto-deleted. Stale-eviction is gradual and visible, not instant.
- Rank is vote-driven (same economy as Minecraft lists, same abuse rule: caught gaming
  votes → reset to zero, repeat → voting disabled).

### Rust / Facepunch
([CorrosionHour blacklist guide](https://www.corrosionhour.com/how-to-avoid-the-rust-server-blacklist/),
[Facepunch forum](https://forum.facepunch.com/f/rust/ewlf/Server-Blacklisting))

- Facepunch curates the in-game browser with a **blacklist** (public manifest, searchable
  by IP). Blacklistable: faking player counts or wipe dates (server-side plugins that lie
  in the A2S/list response), A2S caching tricks to fake low ping, redirecting joins to a
  different server, impersonating known server names.
- Detection: Facepunch runs **"reporting agents"** that independently measure population
  and ping; fake-pop servers also get spotted heuristically — they cluster in "noticeable
  clumps" with near-identical names, populations, and pings. Stalled-but-not-malicious
  servers fall off automatically within ~24h.

**Lesson:** **directory-side probes are the only mechanism that actually catches lying
servers** — and even probes get gamed (Rust servers lie *to the probe* with patched
responders), at which point you're back to heuristics + human blacklisting. Uptime-% from
probe history is a cheap, hard-to-fake ranking signal players understand.

## 6. Luanti (Minetest) — the closest open-source blueprint

The whole directory is ~600 lines of Python and is the best single artifact to crib from
([luanti-org/serverlist](https://github.com/luanti-org/serverlist),
[server.py](https://github.com/luanti-org/serverlist/blob/master/server.py)):

- **Announce API:** servers POST JSON to `/announce` with `action: start | update | delete`
  plus address, port, name, description, version, clients, etc. Engine default announce
  interval is 5 minutes *(I think — engine-side default, not confirmed in serverlist repo)*;
  list entries older than a configurable `PURGE_TIME` are evicted on a sweep.
- **Two-step verification on announce:** (1) resolve the announced address and compare to
  the requester's source IP — tracked as `verifyLevel` 0–3, with tolerance for v4/v6
  mismatch; (2) **connect back** to announced address:port with a real Minetest protocol
  handshake and verify the response. No response → not listed. Registration is open (no
  accounts), the probe is the gate.
- **Ranking formula** (`get_score()`) — concrete anti-gaming design: +1 per current client;
  **penalty above 80% capacity** (discourages "always looks almost-full"); +1 per month of
  server age, capped at 8; +0.5 per *average* client (historical), capped at 4; **−8 if
  `clients_max` > 200** (punishes absurd advertised capacity); −8 per second of probe ping
  over 0.4 s; ×0.6 for legacy-protocol servers. Every input is either probe-measured,
  history-derived, or capped.
- **Anti-abuse at the input layer:** request body capped at ~11 KB, address charset
  whitelist, rejects private/multicast IPs and punycode lookalike domains, strips control
  characters from free-text fields, `BANNED_IPS` / `BANNED_SERVERS` config lists.

**Lesson:** an open-registration directory survives without accounts *if* it probes on
announce and re-probes continuously, caps every self-reported number's influence, and
sanitizes ruthlessly. This is the right v1 skeleton for DEADCOAST.

---

## 7. Transferable design table

| Concern | Proven pattern | Source |
|---|---|---|
| Registration | Account-tied key (FiveM, Factorio) or open + probe-gated (Luanti). Key buys revocation; probe buys truth. Best systems want both. | §2, §3, §6 |
| Heartbeat cadence | ~1–5 min self-report; UI tolerates minutes of staleness; expose `last_heartbeat` | §2, §3, §6 |
| Stale eviction | Soft-hide after a few missed beats (minutes), hard-delete after weeks of downtime (terraria-servers: 50 days; Luanti: `PURGE_TIME`) | §5, §6 |
| Spoof resistance | Signed heartbeat = identity only. **Probe = truth.** Probes get gamed → heuristics (clump detection) + blacklist as backstop | §2, §5, §6 |
| Version gating | Carry `version` + numeric `protocol` in status; gray-out-incompatible (Minecraft) or hard-gate (Factorio; right for lockstep-deterministic sims) | §1, §3 |
| Latency | Always client-measured, never self-reported | §1, §4 |
| Ranking | Never raw player count, never votes. Luanti's capped composite (clients + uptime + age + ping, capacity penalties) is the best public formula | §1, §5, §6 |
| Moderation | Input sanitization at announce; ban list (account + host); public blacklist manifest (Rust) is a nice transparency move | §5, §6 |
| Player filter UX | not-full / not-empty / version-compatible / latency; sort by players and ping; uptime % builds trust | §4, §5 |

## 8. Web-specific: the part with no prior art

In every system above, "join" hands an `ip:port` to a **trusted client binary the player
already owns**. The worst a malicious listing can do is waste your time or crash your
game. DEADCOAST's stated model — directory links to individually-owned subdomains, each
serving **its own client build** — is categorically different: clicking "join" navigates
to a third-party origin running **arbitrary JavaScript**. That's not a server browser
entry; it's an app-store install with zero review. Concretely:

- A listed "server" can phish (fake login UI), fingerprint, mine, or serve exploit code.
  The directory's domain reputation launders trust onto whatever it links to.
- **Client-build verification is unenforceable off-site.** A probe can fetch the server's
  JS and hash it, but the origin can trivially serve different code to the probe than to
  players (UA/IP/timing cloaking). Do not build "verified build hash" for third-party
  origins; it's security theater. *(inference, high confidence)*
- The honest fork in the road:
  - **(a) First-party join path:** the official client (official origin) accepts a server
    endpoint — e.g. `play.deadcoast.example/?server=wss://their-host/ws` — and connects
    out. The browser trust model now matches every game studied: trusted client, untrusted
    server. The server's blast radius shrinks to "what the protocol allows." This requires
    the listed server's Worker to accept cross-origin WebSocket upgrades and to speak the
    exact shared protocol version (the `welcome` message in `src/shared/protocol.ts`
    already carries `seed`, so world handoff works). Custom *server-side* rules still work;
    custom *client* builds don't get the first-party treatment.
  - **(b) Off-site links:** if linking out is kept (it preserves "your subdomain, your
    client mods"), the directory must label entries as third-party, interstitial on first
    join ("you are leaving…"), and accept that moderation = reactive delisting on report.
  - These can coexist as tiers: probe-verified first-party-joinable servers ranked above
    "external" listings. *(inference — recommendation, not prior art)*
- Two web mechanics no studied system needed:
  - **Client-measured ping requires CORS.** For the browser client to ping listed servers
    Minecraft-style, every server's status endpoint (e.g. the existing `/api/health` in
    `src/server/worker.ts`) must send `Access-Control-Allow-Origin` for the directory and
    official-client origins. Bake this into the listing spec.
  - **Probes are easy here.** The directory (a Worker) can `fetch()` each listed server's
    `/api/health` and even complete a WS handshake — HTTPS means no source-spoofing games,
    and Worker-to-Worker fetches to `*.workers.dev` subdomains are routine. Luanti-style
    connect-back verification is *cheaper* for DEADCOAST than for any UDP game.

## 9. Decisions DEADCOAST must make (with recommendations)

1. **Trust model for join** — first-party join path (8a), off-site links (8b), or tiers.
   *Recommend tiers; default sort shows first-party-joinable servers.* This decision shapes
   everything else; make it first.
2. **Registration** — open announce (Luanti) vs registered token (FiveM/Factorio).
   *Recommend: registration endpoint that issues a per-server secret token (stored
   directory-side; sent in every heartbeat). Cheap to build on a Worker + D1/DO, and it's
   the revocation lever the FiveM/Rust experience says you'll need. Open announce can be
   the fallback tier.*
3. **Heartbeat + eviction numbers** — *Recommend: heartbeat POST every 60–120 s (a 15 Hz
   DO that's already ticking can trivially own this); soft-hide after 3 missed beats
   (~5 min); hard-delete after 30 days down. Probe `/api/health` + WS handshake on
   registration and roughly every 5 min thereafter (terraria-servers cadence); publish
   uptime % from probe history.*
4. **Status schema** — adopt the SLP-proven set: name, short description (plain text, length-capped),
   `version` + numeric `protocol`, `playersOnline`/`playersMax`, optional size-capped icon,
   `hasPassword`, `last_heartbeat`. **A `PROTOCOL_VERSION` constant does not exist yet in
   `src/shared/constants.ts` — it must be added** and carried in `welcome`, `/api/health`,
   and heartbeats. Hard-gate joins on it (Factorio precedent; deterministic sim makes
   mismatch fatal anyway).
5. **Ranking** — *Recommend a Luanti-style capped composite (current players capped, uptime %,
   age capped, client-measured ping) and exposing player-controlled sort/filter
   (players, ping, uptime, not-full/not-empty, version-compatible). No votes, no paid
   placement — both are documented abuse engines.*
6. **Moderation** — sanitize names/descriptions at announce (charset + length, Luanti
   rules); report button on listings; ban by token + hostname; reserve the right to delist
   for fake counts (Rust PLA-style policy text), since self-reported counts can't be fully
   verified even with probes.

## Open questions

- Where does the directory live — a new route on the existing Worker
  (`src/server/worker.ts`) with a D1 table, or a separate Worker/DO? (Heartbeat writes are
  tiny; D1 is probably fine. Out of scope for this doc.)
- Is "servers ship their own client build" actually a goal, or an accident of the
  deployment story? If it's negotiable, the first-party join path makes the whole trust
  problem tractable.
- Does the official instance (survival-game.adam-730.workers.dev) appear in the directory
  as a peer, or pinned? (Pinning is normal — Rust's "Official" tab — but mixes curation
  into ranking.)
- Factorio's gated-list-reads (token required to *read* `get-games`) — irrelevant for an
  open web directory, or useful anti-scraping? *(Probably irrelevant.)*

## Sources

- Minecraft SLP: https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
- Minecraft list-site mechanics: https://minecraftservers.org/help , https://mcvoting.com/
- FiveM keymaster: https://keymaster.fivem.net/ ,
  https://rocketnode.com/help/fivem/how-to-generate-your-fivem-server-key-license/ ,
  https://www.ouiheberg.com/en/documentation/article/keymaster-fivem-guide
- FiveM list API (community-documented): https://github.com/HAMz-Project/FiveM-Api
- FiveM fake players: https://forum.cfx.re/t/cfx-community-must-stand-against-fake-players/5304029
- Factorio: https://wiki.factorio.com/Matchmaking_API , https://wiki.factorio.com/Multiplayer
- Valve A2S: https://wiki.reactor-servers.com/docs/guides/steam-query-protocol/ ,
  https://steamcommunity.com/discussions/forum/14/2989789048633291344/ ,
  (canonical, blocks fetchers: https://developer.valvesoftware.com/wiki/Server_queries)
- Terraria: https://terraria-servers.com/about/ , https://terraria-servers.com/help/
- Rust blacklist: https://www.corrosionhour.com/how-to-avoid-the-rust-server-blacklist/ ,
  https://forum.facepunch.com/f/rust/ewlf/Server-Blacklisting
- Luanti serverlist: https://github.com/luanti-org/serverlist ,
  https://github.com/luanti-org/serverlist/blob/master/server.py
