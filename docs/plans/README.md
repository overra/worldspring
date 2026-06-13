# Worldspring — Plans Roadmap

Read this first. It is the map for the seven design docs in this directory: what each
owns, what gates what, the order to build in, and the decisions still waiting on Adam.
`ARCHITECTURE.md` at the repo root remains the binding contract for the codebase; these
docs amend it explicitly where they must, and several milestones ship the amendment in
the same PR as the code.

## Vision

Worldspring is an open-source, browser-native DayZ-like: a low-poly procedural island,
zombies, hunger and cold, full-loot PvP — running as a React Three Fiber client against
an authoritative Durable Object server with a shared deterministic sim. No launcher, no
install. The repo deploys with one command, and the deterministic worldgen contract
(seeded rng streams, identical on client and server) is what keeps a 34 KB worker and a
browser tab agreeing about every wall and tree.

The platform bet: anyone can run their own server on their own Cloudflare account — for
$0–$5/month — without touching a terminal. Doc 01 turns "Create Server" into an OAuth
bounce plus a replayed CI-built artifact landing in *their* account; docs 02/03 give
every server a public, versioned identity (`/api/server-info`, heartbeats) and a
directory that ranks honestly and never pretends to verify code it cannot see. The CLI
path (`git clone && npm run deploy`) stays first-class forever; the site flow is sugar.

Presets are what make this more than a clone. Doc 04's `ServerConfig` makes "no zombies
on my server", permanent night, hardcore scarcity, or a PvP war server a deploy-time
choice, not a fork — and docs 05/06/07 grow the game itself: a real scavenge→craft→gear
arc, bases that persist and get raided, bigger islands with rivers, wolves, and fishing.
A directory full of servers with *personalities* is the product.

## Doc index

| Doc | One line |
| --- | --- |
| [01-create-server-deploy.md](01-create-server-deploy.md) | One-click deploy into the user's own Cloudflare account: confidential OAuth client, CI release artifacts in R2, a Deployer DO replaying the multipart Script Upload API, ephemeral tokens, update/delete flows. |
| [02-server-directory.md](02-server-directory.md) | Official site + server directory: Astro app `apps/web` (landing + Starlight docs + directory SSR over D1) plus a standalone `apps/prober` cron Worker, `dcd1.` server tokens + challenge-hash URL proof, probe-first liveness, capped Luanti-style ranking, honest leave-our-site join interstitial. |
| [03-server-info-contract.md](03-server-info-contract.md) | The contract everything builds on: `PROTOCOL_VERSION` + two-sided `proto` join gate, versioned `GET /api/server-info` (DO cheap-read + Worker micro-cache), push-primary heartbeats, forward-compat rules. |
| [04-gameplay-presets.md](04-gameplay-presets.md) | `ServerConfig` in `packages/shared/src/config.ts`: constants stay defaults, config multiplies at point of use, `GAME_CONFIG` var → fail-closed `world_fingerprint` wipes, six presets, whole-config-in-welcome, admin v1. |
| [05-items-scavenging-crafting.md](05-items-scavenging-crafting.md) | Minutes 10–120: 16 new data-driven items, searchable containers on a new hash-salted rng stream, tree gather nodes, deer corpses + knife harvest, flat `RECIPES` crafting, jacket/backpack wear slots. |
| [06-base-building.md](06-base-building.md) | Base building v1: mutable shared `StructureIndex` merged into the statics queries (zero movement.ts changes), snap-to-grid `canPlace`, global `sFull`/`sAdd` deltas, single-blob persistence, code locks, melee raiding, decay. |
| [07-world-and-wildlife.md](07-world-and-wildlife.md) | World expansion: standard/large/huge tiers, chunked LOD terrain (fog-bounded), carve-in-heightfield rivers/ponds + wading + fishing, Deer→Animal species framework (rabbit/boar/wolf packs), fingerprint harness CI gate. |
| [08-rendering-performance.md](08-rendering-performance.md) | Measured frame budget (the scene is post/fill-bound, not geometry-bound): device/GPU auto-tier + a real mobile tier (the launch gate), baked static-world vertex AO to kill the ~46%-of-frame N8AO line, shadow/rig budgets, WebGPU scoped as blocked R&D. |
| [09-monorepo-migration.md](09-monorepo-migration.md) | **Infrastructure, do first:** pnpm workspace + Turborepo → `apps/game` (Vite, identity preserved), `apps/web` (Astro + Starlight + directory SSR/D1 — supersedes doc 02's Hono), `apps/prober` (cron Worker), `packages/shared` (`@worldspring/shared`, determinism-gated extraction). Lands before any feature milestone. |
| `research/` | Ground truth the docs cite: `cf-costs.md` (billing math — read this one regardless), `cf-deploy.md`, `cf-oauth.md`, `codebase-server.md`, `codebase-sim.md`, `directory-prior-art.md`. |

### Canonical vocabulary (who owns what)

Parallel-written docs share these names; the owner's definition is binding:

| Thing | Owner | Notes |
| --- | --- | --- |
| `PROTOCOL_VERSION`, `join.proto` / `welcome.proto` two-sided gate | doc 03 | The wire field is `proto`. Bump rule: breaking msg shapes/semantics, predicted sim behavior (`movement.ts`/`world.ts`), or `ItemType` wire-enum growth. |
| `ServerInfo`, `RulesSummary` (type), `HeartbeatBody`, heartbeat sender, `/api/server-info` serving design | doc 03 | DO cheap-read behind a 15s per-isolate Worker micro-cache — deliberate, do not "optimize" to pure-Worker serving (live fields need the DO). |
| `ServerConfig`, `PRESETS`, `GAME_CONFIG` var, `resolveServerConfig`/`clampConfig`, `summarizeRules` derivation, `world_fingerprint` | doc 04 | Doc 03 M2 ships a stub `config.ts`; doc 04 M1 replaces it. |
| Server token `dcd1.<serverId>.<secretHex>`, challenge hash, registration, `POST /api/v1/heartbeat` intake | doc 02 | Doc 03's sender POSTs to doc 02's versioned route with the bearer token. |
| `wood`/`scrap` items, tree-gather faucet, fishing/canteen items | doc 05 | Doc 06 consumes them verbatim; doc 07 M12 replaces only doc 05's *interim fishing mechanic*, never the items. |
| `cOpen`/`cMove`/`cont` container protocol, `hammer`, `BuildingConfig` semantics | doc 06 | Doc 04 §1 carries the amended `BuildingConfig {enabled, pieceCapPerPlayer, decayHours, offlineRaidMult}`. |
| `WorldSizeTier` value set (standard/large/huge), tier tables, `waterAt`, `WORLDGEN_VERSION`, species framework | doc 07 | Doc 04's M6 tier work is **subsumed by doc 07 M1–M2** — implement once, through doc 07. |
| Client render tiers: `QualityConfig` knobs, `detectTier`, `mobile` profile, baked-AO vertex pass, the `?debug=1` frame profiler | doc 08 | Doc 04's presets dial *server* entity counts; doc 08 owns *client* render quality. The two meet only at doc 08 M6's worst-case test scene (doc 04 `zombieDensity:2` + doc 07 species ceilings). |

## Dependency graph

```mermaid
graph TD
    P["persistAll single-row fix<br/>~30 lines, no owning doc — standalone PR"]
    D03["03 server-info contract<br/>PROTOCOL_VERSION + /api/server-info + heartbeats"]
    D04["04 ServerConfig + presets<br/>GAME_CONFIG + fingerprint + PRESETS"]
    D01["01 create-server deploy<br/>OAuth + artifacts + Deployer DO"]
    D02["02 site + directory<br/>apps/web (Astro) + apps/prober + D1 + ranking"]
    D05["05 items + scavenging + crafting"]
    D06["06 base building"]
    D07["07 world + water + wildlife"]
    D08["08 rendering performance<br/>auto-tier + mobile + baked AO"]

    D03 -->|release gate needs PROTOCOL_VERSION + route| D01
    D03 -->|probes + heartbeat contract| D02
    D04 -->|PRESETS + GAME_CONFIG var| D01
    D04 -->|badge summary + PRESETS import| D02
    D03 -.->|join gate hard-gates non-standard tiers| D04
    D03 -.->|PROTOCOL_VERSION bumps M1/M2/M4/M5/M6| D05
    D03 -.->|PROTOCOL_VERSION bump| D06
    D03 -->|proto gate, M7 bump| D07
    D04 -->|config plumbing + fingerprint M1+M2| D07
    D04 -.->|BuildingConfig fields, stub OK| D06
    D05 -->|wood/scrap + tree faucet| D06
    D05 -.->|fishing items for M12| D07
    D02 -.->|registration API for M5/M8| D01
    P -.->|free-plan copy gate M6| D01
    P -.->|community-host gate M4| D05
    P -.->|large/huge viability| D07
    D04 -.->|entity-count ceilings = M6 worst-case scene| D08
    D07 -.->|render milestones share the frame budget| D08
    D08 -.->|mobile tier gates the community-server launch| D02
```

Solid arrows are hard dependencies; dotted arrows are gates on specific milestones
(stub-able or sequencing-only). The two chokepoints are **doc 03 M1–M2** and **doc 04
M1–M2**: between them they gate doc 01's release artifacts, doc 02's entire contract
surface, doc 07's M1, and the version-gate story every gameplay doc leans on. The
gameplay docs (05/06/07) are otherwise **independent of the platform docs (01/02)** —
the game can grow while the hosting story is built in parallel. **Doc 08 has no hard
dependency** — it is client render code that can start any time; its only couplings are
soft (its acceptance scenes use doc 04/07 ceilings, and its mobile tier gates a credible
public launch).

## Client frame budget (the binding render anchor)

Every gameplay doc that adds something to the screen is spending against a measured
budget, and that budget does **not** live where the docs assume. Profiled on an M3 Max /
ProMotion display, in-town, `high` tier (doc 08 has the full table): the frame costs
**~24 ms and is post/fill/CPU-bound** — N8AO ambient occlusion alone is **~11 ms (~46 %
of the frame)**, shadows ~2.6 ms, `dpr`-2 fill is most of the rest; **draw calls and
triangles together measured < 1 ms.** Three rules fall out, binding on docs 04/06/07:

1. **Acceptance criteria measure frame-time and main-thread-ms, not draw counts.** Doc
   07's chunked terrain ("~32K verts, ≤45 draws") and doc 06's instancing ("≤14 draws")
   are correctly *optimizing a non-bottleneck on desktop* — keep them (they matter for
   mobile and upload spikes), but gate them on measured **frame ms** plus a **mid-tier
   device** check, not draw/triangle counts.
2. **Main-thread rig updates are the one shared budget line.** Doc 04 (`zombieDensity:2` =
   120 zombies), doc 07 (up to 256 animals), and doc 06 (per-delta matrix rewrites) all
   draw on it. It is masked under GPU-bound frames on an M3 Max but surfaces on weaker
   GPUs — doc 08 M6 owns bounding it, with those ceilings as the worst-case test scene.
3. **No client device/GPU auto-detect exists** (`settings.ts` hardcodes `quality:"high"`)
   — every phone boots dpr-2 + full-res AO. This is a **launch-blocking gap** for the
   "anyone joins any server" pitch, owned by doc 08 M2–M3.

Doc 08 is measurement-gated and **off the critical path** — it ships behind the spine, but
the gameplay docs must write their perf acceptance criteria in this vocabulary.

## Recommended build order

Model guidance is pulled from each doc's own milestone annotations: **Opus 4.8** for
determinism-, protocol-, persistence-, and security-sensitive milestones; **Sonnet 4.8**
for mechanical/table-driven/UI work. One milestone per session.

### Wave 0 — the spine (3–4 parallel sessions)

Everything else fans out from here.

1. **Doc 03 M1–M2** — version constants, two-sided `proto` gate, `ServerInfo` +
   `GET /api/server-info`, micro-cache. *(M1 Opus 4.8 — protocol; M2 Sonnet 4.8.)*
2. **Doc 04 M1–M2** — `packages/shared/src/config.ts`, presets, validation, fail-closed
   fingerprint persistence, the repo's first test harness (vitest). *(Both Opus 4.8 —
   determinism + data-loss-adjacent wipe semantics.)*
3. **persistAll single-row world snapshot** (research/cf-costs.md §6 lever 1) — ~30
   lines, no owning doc, gates free-plan marketing (01 M6), community-host builds
   (05 M4), and large/huge viability (07). *(Opus 4.8 — save-path atomicity.)*
4. **Doc 01 M1 spike** — scratch-account OAuth/deploy-API spike; zero repo deps; burns
   down six UNCONFIRMED platform behaviors plus `keep_bindings` semantics and the
   Workers-Logs measurement. *(Sonnet 4.8.)*

### Wave 1 — fan-out (two independent tracks)

**Platform track** (needs Wave 0 items 1–2; sequential within, parallel to gameplay):

5. **Doc 03 M3–M5** — heartbeat sender (+2h soak), colo spike, consumer doc.
   *(Sonnet 4.8.)*
6. **Doc 02 M2→M7** — site scaffold, registration/verification/heartbeat ingest,
   prober, browse/ranking, join interstitial, moderation. *(M3 Opus 4.8 — the trust
   boundary; everything else Sonnet 4.8.)*
7. **Doc 01 M2–M4** — release pipeline (Sonnet), game-worker env surface (Opus —
   determinism-sensitive seed threading), `site/` OAuth (Opus — security-sensitive).

**Gameplay track** (needs Wave 0 items 1–2 only):

8. **Doc 04 M3–M5** — systems consume config, client variant handling, admin v1.
   *(All Sonnet 4.8 — table-driven.)*
9. **Doc 05 M1→M7** — items catalog → crafting → containers → harvesting → wear →
   balance. *(M2/M3/M4/M6 Opus 4.8 — protocol/determinism/inventory surgery; M1/M5/M7
   Sonnet 4.8. M4 must not reach community-host builds before the persistAll fix.)*

### Wave 2 — the big builds

10. **Doc 01 M5–M8** — Deployer DO state machine, create UI, update flow with migration
    chaining + token-rotation overlap, delete/register-existing. *(M5/M7 Opus 4.8;
    M6/M8 Sonnet 4.8. Needs doc 02's registration call — stub acceptable.)*
11. **Doc 06 M1→M8** — StructureIndex (Opus), protocol/persistence (Opus), build
    UI/gather/doors/crates (Sonnet), raiding + config wiring (Opus), load validation
    (Sonnet). *(Needs doc 05's `wood`/`scrap` rows — whichever lands first adds them
    with doc 05's exact ids.)*
12. **Doc 07 M1–M7** — config consumption + fingerprint harness (Opus), `createWorld`
    parameterization (Opus — subsumes doc 04 M6, implement once here), chunked terrain
    (Opus), tier content (Sonnet), river carve (Opus — THE risky determinism
    milestone), water render (Sonnet), wading + `PROTOCOL_VERSION` bump (Opus).

### Wave 3 — finish and launch

13. **Doc 07 M8–M12** — wildlife framework, boars/wolves, visuals + birds (plus an Adam
    Blender session), huge-tier loadtest, fishing (supersedes doc 05 §4.3's interim
    mechanic). *(All Sonnet 4.8.)*
14. **Doc 02 M8 + Doc 01 M9** — launch wiring, official-instance registration,
    SELF_HOSTING docs, the one-way public-OAuth promotion. *(Sonnet 4.8 + Adam manual
    steps. Hard-blocked on the custom-domain decision.)*

### Doc 08 — rendering (no hard deps; weave through the waves)

Client-render-only, so it slots wherever there's a free session rather than gating
anything. Suggested placement: **M1 profiler early in Wave 1** (cheap, and every later
gameplay milestone can then self-check its frame cost); **M4 baked AO in Wave 2 alongside
doc 07's chunked-terrain milestone** (both touch the terrain vertex pipeline — sequence
M4 right after doc 07 M3/M4 to share context); **M5 AO/shadow retune and M6 rig budget in
Wave 2–3** (M6's worst-case scene needs doc 04's `zombieDensity:2` and doc 07's species
ceilings to exist); **M2–M3 auto-tier + mobile as a Wave 3 launch gate** (the mobile tier
is a prerequisite for a credible public launch, item 14). **M7 WebGPU is parked R&D** —
not scheduled. *(M4/M6 Opus 4.8 — render-correctness + hot loop; M1/M2/M3/M5 Sonnet 4.8.)*

## Open questions for Adam

Deduped across all seven docs; each carries the owning doc's recommendation. Grouped by
when the answer is needed.

### Needed for Wave 0–1 (platform foundations)

1. **Custom domain** *(docs 01+02, dedup)* — public OAuth client visibility requires DNS
   TXT verification, impossible on workers.dev; the directory also shouldn't live on
   workers.dev forever. Blocks doc 01 M9 (strangers using Create Server), not
   development. **Rec: buy one domain now; put only the site on it for v1; game stays on
   workers.dev.**
2. **Gate launch on the persistAll fix?** *(doc 01 Q4; doc 05 M4 gate; doc 07 capacity
   math)* — free-plan servers break saves ~80 min into a session as shipped. **Rec:
   yes — land the single-row snapshot in Wave 0, keep the cost-panel gate as
   belt-and-braces.**
3. **Workers Paid ($5/mo) for the directory account** *(doc 02 Q1 + doc 03 Q5)* — free
   D1 writes breach around ~100 listed servers; heartbeat volume math says key the
   trigger on measured daily beats. **Rec: yes, paid from day one.**
4. **Ephemeral OAuth tokens — confirm** *(doc 01 Q2)* — costs one OAuth bounce per
   ~monthly update; caps breach blast radius at jobs-in-flight. **Rec: ephemeral; revisit
   only if fleet auto-update becomes a real ask, as a separate opt-in consent.**
5. **Enforce the `worldspring-` script-name prefix?** *(doc 01 Q3)* — clobber guard +
   self-identification vs vanity URLs. **Rec: enforce.**
6. **Site storage split** *(doc 01 Q5)* — shared site D1 (directory tables) + private
   Deployer-DO job table. Doc 02 independently chose D1. **Rec: keep the split.**
7. **R2 primary / GitHub Releases mirror as deploy source** *(doc 01 Q6)*. **Rec: as
   designed.** **Artifact signing** *(doc 01 Q7)*: **defer post-launch.**
   **Workers-for-Platforms managed tier** *(doc 01 Q8)*: **park until demand.**

### Needed for the directory (Wave 1)

8. **First-party join path in v1?** *(doc 02 Q3)* — official client accepting
   `?server=wss://…` would enable a real verified tier. **Rec: defer; the `proto`
   plumbing keeps it cheap later. Decide before any "verified" wording ships.**
9. **Ship a default `DIRECTORY_URL` in the game's wrangler.jsonc?** *(doc 02 Q4)* —
   every fork heartbeats at the official directory by merely setting a token. **Rec:
   yes; beats are inert without a token.**
10. **Token-only registration, or require Cloudflare OAuth?** *(doc 02 Q5)*. **Rec:
    token-only at launch; optional OAuth attachment when doc 01's login lands.**
11. **`?name=` pass-through on join** *(doc 02 Q7)* + **import-boundary policing**
    *(doc 02 Q6)*. **Rec: keep name pass-through opt-in; review-only import rule until
    someone breaks it.**

### Needed for the server-info contract (Wave 0–1)

12. **Expose `worldSeed` in `/api/server-info`?** *(doc 03 Q1)* — it already rides every
    `welcome`. **Rec: yes; omitting it is fake secrecy.**
13. **`name`/`motd` as env vars (not config/compile-time)** *(doc 03 Q2)*. **Rec: vars
    with code defaults — rename/MOTD edits shouldn't need a rebuild.**
14. **Player-name samples in ServerInfo** *(doc 03 Q3)*: **no for v1.**
    **`GAME_VERSION` hand-maintained vs package.json** *(doc 03 Q4)*: **hand-maintained
    constant; accept cosmetic drift.** **Heartbeat cadence numbers** *(doc 03 Q5)*:
    **ship 60s ±10s / 20s debounce / capacity-3 token bucket as specced.**
    **Ship `/api/server-info` on the official instance before docs 01/02?** *(doc 03
    Q6)*: **yes — gives doc 02 a live endpoint to develop against.**

### Needed for presets (Wave 1, before directory badges print)

15. **Preset names** *(doc 04 Q1)* — deadcoast/driftwood/ironcoast/warpath/homestead/
    nightfall; cheap to rename until doc 02 prints them. **Rec: keep.**
16. **`zombieDensity` ceiling 2** *(doc 04 Q2)*: **ship 2 (120 zombies), raise only
    after a loadtest.** **Keep-inventory semantics** *(doc 04 Q3)*: **corpse spawns
    empty, respawn restores — no item duplication.** **Whole config in welcome** *(doc
    04 Q4)*: **whole (~700 B, drift-proof).** **`zombies=false` keeps military loot
    independent** *(doc 04 Q5)*: **independent — presets express intent.**
17. **Admin live whitelist = 4 fields** *(doc 04 Q6)*: **ship the four; add
    `loot.airdrops` in v1.1 if owners ask.**
18. **Scheduled wipes land at 00:00 UTC ≈ prime time Central** *(doc 04 Q7)* — for
    monitored servers the wipe executes effectively at the boundary. **Rec: accept for
    v1, documented; revisit with an alarm at a quiet hour if operators object.**

### Needed for gameplay docs (Wave 1–2)

19. **Ghost (collision-less) containers** *(doc 05 Q1)*: **ghost now — solid requires a
    schema-v3 wipe; revisit at the next unavoidable wipe.** **Backpack over a global
    slot bump** *(doc 05 Q2)*: **backpack — capacity as an earned item.**
    **E-interact tree gathering, axe stays a pure weapon** *(doc 05 Q3, doc 06
    defers)*: **E-interact.** **Infinite torch** *(doc 05 Q4)*: **ship infinite, dim.**
    **Fishing in M1 scope** *(doc 05 Q5)*: **yes — cut first if M1 sprawls; doc 07 M12
    later replaces only the cast mechanic.** **Bare-hand deer yield** *(doc 05 Q7)*:
    **1 venison bare-handed, pelts knife-only.**
20. **Crates don't collide** *(doc 06 Q1)*: **no collision in v1.** **`offlineRaidMult`
    default 0.25** *(doc 06 Q2)* and **`decayHours` default 168** *(doc 06 Q3)*: **as
    recommended.** **No demolish refund** *(doc 06 Q4)*: **none.** **Keep gates** *(doc
    06 Q5)*: **keep.** **Owner-only decay refresh** *(doc 06 Q7)*: **owner-only v1; fix
    with a team system.**

### Needed for the world expansion (Wave 2–3)

21. **Official server world after doc 07 ships** *(doc 07 Q1)* — staying standard keeps
    all characters; flipping shows everything off. **Rec: ship milestones against
    standard, then announce a "new continent" wipe to riverlands post-M7 (the `proto`
    gate must be live first).**
22. **Wading slowdown applies to ocean shallows everywhere** *(doc 07 Q2)* — a feel
    change on ALL worlds the moment M7 deploys. **Rec: accept universally; ship in its
    own deploy with the version bump.**
23. **One "Raw Meat" item for all land species** *(doc 07 Q3)*: **consolidate (display
    rename only — the persisted type string never changes).** **Birds client-only**
    *(doc 07 Q4)*: **yes.** **Airdrop HUD bearing marker at 2x/4x** *(doc 07 Q5)*:
    **add the small HUD tick.** **Wolf daytime posture** *(doc 07 Q7)*: **wary-neutral.**
    **Fog far stays 320m on all tiers** *(doc 07 Q8)*: **keep.** **No sub-1x tier**
    *(doc 07 Q9)*: **drop; cheap to add later.**
24. **Ship `huge`/`frontier` at launch?** *(doc 07 Q6)* — pre-persistAll-fix, 24/7 huge
    is ~$90–100/mo on paid; post-fix ~$15–24/mo. **Rec: hold behind "experimental";
    ship standard + large, validate huge via M11 after the fix.**

### Needed for rendering (Wave 1–3)

25. **Ship target for `high` on desktop** *(doc 08 Q1)* — `high` ≈ 90 fps (dpr 1.5 +
    baked + half-res AO) vs *locked* 120 (forces dynamic AO essentially off). **Rec:
    `high` = ~90–110 fps; add opt-in `ultra` (dpr 2, full AO) for fidelity-over-fps.**
26. **Baked static-world AO — go?** *(doc 08 Q2)* — the doc's load-bearing bet; a visible
    (improving) restyle of static surfaces, gated on your look sign-off at M4. **Rec:
    yes — it is the only thing that makes AO cheap on every device at once.** **Pin
    `simplex-noise` to `4.0.3` exact** *(doc 08 Q5; also a doc 07 determinism finding)*:
    **yes, the caret range is a latent client/server desync hazard.**
27. **WebGPU R&D priority** *(doc 08 Q4)* — spike now or park until the pmndrs post stack
    ships WebGPU parity (the migration is blocked on it; it is *not* a geometry/AO fix).
    **Rec: park; revisit when the post ecosystem moves or the mobile rig budget needs
    compute offload. No gameplay doc forces it.**

## How to use these docs with Claude

- **One milestone per session.** Every doc's implementation plan is cut into PR-sized
  milestones with model recommendations and acceptance criteria — pick one, finish it,
  run its acceptance checks. Don't span milestones in a session.
- **Start each session by reading the doc end-to-end, plus the research files it
  cites** (at minimum `research/cf-costs.md` for anything touching persistence,
  requests, or hosting copy; `research/codebase-sim.md` for anything near worldgen or
  the wire). The docs cite exact `file:line` anchors — verify them against the tree
  before editing; line numbers drift.
- **ARCHITECTURE.md still binds.** Several milestones explicitly amend it (doc 04 M1,
  doc 05 M4, doc 07 M1/M3) — ship the amendment in the same PR as the code, or the next
  session will "fix" your work back to the stale contract.
- **Determinism is sacred.** Existing rng stream draw order never changes; new
  generation uses new hash-salted streams; `scripts/worldgen-fingerprint.ts` (doc 07
  M1) is the CI gate — run it on anything that goes near `packages/shared/src/world.ts`.
- **UNCONFIRMED means unconfirmed.** Docs 01–03 mark platform behaviors that must be
  verified on a live Cloudflare account before code relies on them (doc 01 M1 is the
  dedicated spike). Don't promote an UNCONFIRMED to fact from training data — check
  current docs or measure.
- **Cross-doc ownership is settled** (see the canonical-vocabulary table above). If two
  docs seem to disagree, the owner's definition wins; the consistency sweep of
  2026-06-11 aligned the known conflicts in place — if you find a new one, fix the
  non-owning doc and note it there.
