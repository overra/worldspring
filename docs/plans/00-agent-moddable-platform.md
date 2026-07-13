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

## Distribution & deploy

- **Source / fork layer:** GitHub forks today. **Cloudflare Artifacts** — Git-compatible versioned storage built for AI agents ("tens of millions of repos," "create 10,000 forks from a known-good starting point"; private beta 2026-04, public beta ~May, cheap) — is a strikingly on-point future home for the fork layer. Track it; don't build on it until GA. It is **not** a package registry.
- **Deploy layer:** the host's fork CI → their own Cloudflare (the `01-create-server-deploy` Deployer arc). **OPEN:** does the GitHub-fork route *extend* or *replace* that arc? Decide before building the fork loop.

## First moves (build order)

1. **Carve the internal engine/game seam** — `@worldspring/engine` + `@worldspring/mode-survival` as a workspace-package split (internal, unpublished). Forces the seam, defines the future API surface, dogfoods the host boundary.
2. **Define the `GameMode` boundary;** re-express survival as a mode on it.
3. **Build one example mode** (build/creative *or* arena — either is fine) as a second consumer: proof + agent template + reveals remaining entanglement.
4. **Harden + version the directory contract** (`03`) — the one canonical surface.
5. **`mod:check`** — wire the existing guardrails (Linux-canonical worldgen fingerprint, snap-codec round-trip, sim smoke, loadtest) into one command.
6. **Fork/deploy loop** — GitHub connect → fork template → CI guardrails → deploy to their Cloudflare (extends `01`).

## Deferred / not now

- In-engine authoring layer / visual editor / rules DSL (the Roblox rung) — indefinitely.
- Publishing the engine as a versioned SDK — only if a real need for clean shared updates emerges; not load-bearing given "zero sync."
- Unified launcher / cross-server shared client — avoid; it breaks mod-freedom.

## Implication for in-flight work

- The **game-UI design overhaul** must go modular: the survival HUD (vitals / hunger / temperature) is **one mode's skin**, not the core. Design the HUD as per-mode, with a shared chrome.
- The **website / directory** becomes the platform storefront — more central than any single game's UI.
