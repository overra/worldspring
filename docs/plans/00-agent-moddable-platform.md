# 00 — Worldspring as an Agent-Moddable Platform (north star)

**Status:** direction set 2026-07-13. Reframes the numbered feature plans below it. Nothing here is built yet — this is the aim, not a spec.

## The turn

Worldspring started DayZ-inspired: a browser-native survival game. The bigger opportunity is the substrate underneath it. What we've actually built is a **multiplayer-3D-world engine** — authoritative Cloudflare Durable Object + deterministic shared sim + client prediction, a procedural world, physics, vehicles, building, and a self-host + directory platform — with survival systems layered on top (and already mostly optional via presets: `homestead`/`driftwood` are nearly non-survival).

North star: **Worldspring is a platform for browser-native, self-hostable multiplayer worlds. You fork it, point a coding agent at it ("make this a heist game / a racing league / a build-battle"), and deploy the result to your own Cloudflare. Survival is the flagship game and the first mode — not the ceiling.** The comp is Minecraft / Garry's Mod server modding, for the agent era: "write a Java plugin" becomes "tell an agent what you want." The authoring tool is a coding agent (which improves on its own); our job is to make the substrate the best possible thing for an agent to remix.

Why it's achievable and cheap: the hard 90% — netcode, world, physics — is done and genre-agnostic. The work is mostly **architecture + docs + tests**, all of which make the flagship better too. We do **not** build an in-engine authoring layer (the Roblox path).

## Decisions landed

1. **Full forks, not a sealed SDK.** A self-hosted server is self-contained — its client and DO ship from one fork and are compatible by construction (`PROTOCOL_VERSION` is an internal client↔DO check, trivially satisfied within a fork). So a community server syncs with the canonical engine **zero** for correctness; engine updates are opt-in improvements, not a treadmill. Optimize for mod *depth* and agent success: let the agent touch anything, including the engine, in one self-contained repo. (An SDK/package split would clean up updates we don't actually need; its downsides — API lock-in + migrations — are exactly what agents soften, so it's optional convenience at most.)
2. **The one canonical external contract is the directory listing/heartbeat** (see `03-server-info-contract`): name, players/max, version, region, uptime, rules, join URL. Keep it small, stable, versioned, backward-compatible — everything else is the host's. (Optional second contract: federated Worldspring identity, only if we offer official accounts; guest tokens need none.)
3. **Engine ⟷ game seam = an internal legibility + guardrail boundary,** not a wall. Consolidate "what makes this survival" behind clear module boundaries so an agent knows what's load-bearing (engine) vs freely editable (game/mode), and so guardrails can protect the engine invariants.
4. **A `GameMode` abstraction** is the core new primitive: win/lose conditions, scoring, round lifecycle, spawn/respawn rules, objectives — the scaffolding non-survival games need and survival barely has. Survival becomes one mode implementing it.
5. **Determinism is the trust layer.** It makes the netcode special and is what an agent is most likely to break invisibly (a stray `Math.random`/`Date.now`, map-iteration order → the known macOS↔Linux worldgen divergence). A one-command **`mod:check`** suite (determinism fingerprint + protocol round-trip + sim smoke + quick loadtest) turns silent breakage into fast feedback the agent self-corrects against. This is the single most important thing we provide that a bare agent + a random repo can't.
6. **Per-server clients; the directory links out.** The "zero sync" property holds *because* each server serves its own client — the directory is a **catalog, not a client**. A unified launcher (one client → any listed server) would reintroduce cross-server protocol coupling and lose it. Avoid it if mod-freedom is the priority.
7. **Example modes are executable documentation.** 2–3 modes built on the seam (build/creative + arena) prove breadth, force the seam to be real, and act as few-shot templates an agent pattern-matches against ("make it like this existing mode" >> "invent from scratch").
8. **The deploy on-ramp is Cloudflare's "Deploy to Cloudflare" button — it REPLACES doc 01's Deployer arc** (resolved 2026-07-14, below).

## Distribution & deploy

- **Source / fork layer:** GitHub forks today. **Cloudflare Artifacts** — Git-compatible versioned storage built for AI agents ("tens of millions of repos," "create 10,000 forks from a known-good starting point"; private beta 2026-04, public beta ~May, cheap) — is a strikingly on-point future home for the fork layer. Track it; don't build on it until GA. It is **not** a package registry.
- **Deploy layer: the Deploy-to-Cloudflare button, pointed at the repo root.** One click clones the repo into the visitor's **own** GitHub account, provisions the `GameRoom` DO from the root `wrangler.jsonc`, prompts for the `.dev.vars.example` secrets, and wires Workers Builds so *their* pushes redeploy *their* server. Cost: `wrangler.jsonc` + `.dev.vars.example` + a link.

  **RESOLVED: the button REPLACES doc 01's Deployer arc (M4–M8), it does not extend it.** The Deployer would custody deploy-capable OAuth tokens for every creator — doc 01 itself calls that "the single worst risk this feature can take on" — and it ships a *prebuilt artifact*: an opaque copy the user cannot mod, which is the exact opposite of the north star. The button inverts every term: Cloudflare holds the credential, the user gets a source fork they can point an agent at, and their fork's CI (not our Deployer DO) owns updates. It is also strictly less work. What survives from doc 01: the version/release discipline (M2), the env surface (M3, shipped), and the register-an-existing-server flow — the button cannot inject a `DIRECTORY_TOKEN`, so directory listing stays a post-deploy claim, which it already was for CLI deploys.

  The trade we accept: no push-button updates ("v0.5 available → one click"). A fork is a copy with no upstream link. That is the *correct* default here — a modded fork does not want our updates applied over it. Upstream changes are `git remote add upstream && git merge` (or an agent doing it), and decision 1 ("zero sync") says correctness never demands it.

### A server is a DEPLOY, not a route (the mode/subdomain model)

The worker routes every request to a single Durable Object named `"main"`, configured once from the worker-wide `GAME_CONFIG` env var. So the unit is fixed: **one worker deploy = one DO = one config = one game.** `play.worldspring.games` is an account-side alias on the one prod `worldspring` worker. This IS the fork model — fork, deploy, your one server — and it decides three things:

1. **Mode is a per-deploy config field** (`config.mode`, resolved from `GAME_CONFIG`), LIVE-class — it changes the gameplay layer, never worldgen, so it never taints a persisted world. A first-party arena server is just a second deploy of the same binary with `mode:"arena"` (the `arena` preset). Hosting several modes inside one worker would need named rooms + per-room config, which fights "one server = one game" — don't.
2. **Subdomains don't scale servers — the directory does.** First-party modes are directory entries with stable join URLs, not a subdomain each; reserve a vanity subdomain (`arena.`) only for a mode we actively market. Community servers own their domains; the directory links out. `play.` stays the survival flagship alias (⚠️ character tokens are origin-scoped — verify identity continuity before ever repointing it). **(Amended 2026-07-15 by [doc 15](15-official-servers-and-server-types.md): the *first-party* policy moves — all three official modes (survival/arena/horde) get a standard subdomain each, not marketing-only. The mechanism (deploy + account-side custom domain) is unchanged; "subdomains don't scale *community* servers — the directory does" still holds. Never repoint an existing origin without an identity-migration story.)**
3. **Previews don't multiply per mode.** Per-mode *correctness* is gated by headless probes (`arena-probe.mjs` and kin) + tests — no deploy. Human QA of a mode = inject a `GAME_CONFIG`/mode `--var` on the single per-PR preview worker (the `TESTBED` var pattern); only spin a second preview worker when a PR must show two modes at once. **(Amended 2026-07-15 by [doc 15](15-official-servers-and-server-types.md): for the *official* fleet this reverses — the per-PR preview now multiplies per official mode (`worldspring-<mode>-pr-<N>`) via a manifest-driven CI matrix, so arena/horde get real human QA per PR as their own products. Community/one-off modes still follow the single-worker `--var` pattern.)**

## First moves (build order)

1. ✅ **Carve the internal engine/game seam** — done as an *internal* seam (a `GameMode` object owning per-tick composition, seeding, and the player lifecycle; survival tunables split into `constants/survival.ts`), not yet a workspace-package split. The package split (`@worldspring/engine` + `@worldspring/mode-survival`) stays deferred until a real need for clean shared updates emerges.
2. ✅ **Define the `GameMode` boundary;** survival re-expressed as a mode on it (`server/mode/`).
3. ✅ **Build one example mode** — **arena** (round-based frag deathmatch) shipped as the second consumer: proof the seam is real + an agent template. Its `arena-probe.mjs` doubles as executable documentation.
4. **Harden + version the directory contract** (`03`) — the one canonical surface.
5. ✅ **`mod:check`** — shipped as `pnpm mod:check` (`scripts/mod-check.mjs`): types → worldgen determinism (self-consistency: generate twice + assert identical, so it's platform-independent; the byte-exact Linux reference stays CI's gate) → protocol round-trip + sim smoke (`pnpm test`, incl. every GameMode probe) → build, with a modder-facing pass/fail summary.
6. **Fork/deploy loop** — a **Deploy to Cloudflare** button (repo root `wrangler.jsonc` + `.dev.vars.example` + `docs/SELF_HOSTING.md`, wired from `/host` and the README) is the whole loop: click → their GitHub fork → their Cloudflare → Workers Builds redeploys on their pushes. Then: point an agent at the fork, `pnpm mod:check` before deploying the mod. Supersedes doc `01`'s Deployer arc. **Not yet click-tested end-to-end against a virgin account** — the monorepo build under Workers Builds is the open risk.

## Deferred / not now

- In-engine authoring layer / visual editor / rules DSL (the Roblox rung) — indefinitely.
- Publishing the engine as a versioned SDK — only if a real need for clean shared updates emerges; not load-bearing given "zero sync."
- Unified launcher / cross-server shared client — avoid; it breaks mod-freedom.

## Implication for in-flight work

- The **game-UI design overhaul** must go modular: the survival HUD (vitals / hunger / temperature) is **one mode's skin**, not the core. Design the HUD as per-mode, with a shared chrome.
- The **website / directory** becomes the platform storefront — more central than any single game's UI.
