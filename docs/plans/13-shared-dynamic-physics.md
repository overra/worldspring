# Shared dynamic physics: falling trees, props, and vehicles on a deterministic WASM engine

## Summary

Adam wants shared rigid-body dynamics (decided 2026-07-07): **falling trees** when you
chop them, **physics props** you can shove and throw, and eventually **vehicles**. This
doc adds the substrate those features stand on — a WASM physics engine stepped
**server-authoritatively** inside the `GameRoom` DO, with bodies synced to clients
through the existing interest-filtered snapshot path and rendered by interpolation.

Decisions, up front:

1. **Server-auth + client interpolation, no client physics in v1.** Clients do NOT step
   the engine; they interpolate body poses from snapshots exactly like they already do
   for zombies/animals. This keeps client cost ≈ 0 (doc 08's mobile budget untouched),
   avoids physics-state rollback entirely, and matches the trust model (the server is
   already the authority on everything but your own kinematic movement). Driving-feel
   prediction (M5) is explicitly deferred and may never be needed at typical pings.
2. **The player character stays KINEMATIC.** `stepPlayer`/`movement.ts` — the predicted,
   fingerprinted core — is untouched. Physics bodies push *around* players (a felled
   tree bounces off you along its own solve), players never become dynamic bodies. This
   is the line that keeps the existing prediction/reconcile loop and the worldgen
   fingerprint contract completely out of the blast radius.
3. **Engine: spike on Rapier now, keep Box3D as the tracked alternative.** Rapier
   (`@dimforge/rapier3d`) has an official WASM/JS distribution today and a
   cross-platform-determinism story (`enhanced-determinism`); Box3D (Catto's Box2D→3D,
   announced 2026-06, https://box2d.org/posts/2026/06/announcing-box3d/) is a better
   long-term fit on paper (heightfield-native, server-scale focus, record/replay,
   cross-platform determinism as a headline feature) but is **alpha with no WASM build
   yet**. M1's substrate hides the engine behind a thin step/snapshot seam so the choice
   is revisitable at Box3D v1.0-with-WASM without re-doing protocol or persistence.
4. **M0 is a GO/NO-GO gate, not a commitment.** If bit-identical determinism across
   macOS/Linux/browser/workerd or the tick-cost budget fails empirically, the plan
   stops at cosmetic client-side physics (ragdolls/debris — no substrate, no wire
   changes) and this doc gets parked with findings recorded.

## Goals / Non-goals

**Goals**

- One physics world per room, stepped in the server tick, bodies persisted with the
  world snapshot, synced under the existing interest/quantization regime.
- Falling trees as the tracer feature (chop → dynamic → settle → despawn/loot), then
  generic props, then vehicles v1 (server-auth driving, seats, fuel).
- A determinism/replay harness for the physics step in CI, extending the fingerprint
  discipline to the new subsystem.
- Engine-portable substrate (Rapier ↔ Box3D swappable behind one seam).

**Non-goals (v1)**

- Client-side prediction of ANY dynamic body, including the driven vehicle (M5, only
  if driving feel demands it).
- Players/zombies/animals as dynamic bodies — all characters stay kinematic.
- Soft bodies, cloth, fluids, destructible buildings (doc 06 owns structures; they
  stay static colliders).
- Physics on the minimap/map raster (doc 12 is untouched).

## Current state (verified against this tree)

- **The sim is kinematic and analytically deterministic.** `stepPlayer`
  (`packages/shared/src/movement.ts`) resolves movement against the worldgen
  heightfield + static AABBs; there is no physics engine anywhere in the repo.
- **Server tick** runs in the `GameRoom` DO (~15 Hz baseline; the scaling roadmap's
  30 Hz option is open). DOs bill on **duration** — a physics step adds CPU to every
  tick whether or not players are near dynamic bodies. Sleeping bodies and a hard
  body-count cap are cost features, not polish.
- **Snapshots** are interest-filtered per player and quantized (`round2`), with recent
  precedent for adding an entity array end-to-end (`portals`, PR #38): wire field +
  realm/interest filter + client pool renderer. Dynamic bodies follow the same recipe.
- **Persistence** is a single-row world snapshot (`persistAll`) with `SCHEMA_VERSION`
  (currently 2) + fail-closed fingerprint wipe (doc 04 M2). Dynamic body poses join the
  world snapshot; a physics-schema change is a `SCHEMA_VERSION` bump like any other.
- **Determinism contract**: the worldgen fingerprint is Linux-canonical because V8
  transcendentals diverge macOS↔Linux (CI README). A WASM engine is *stricter* than
  the JS sim here — WASM float semantics are IEEE-754-deterministic for the same
  binary, so the same `.wasm` must produce identical results everywhere. M0 proves
  this empirically instead of trusting it.
- **PROTOCOL_VERSION is 5**; the two-sided join gate makes the M1 bump routine.
- **Trees today** are worldgen statics (doc 05's gather faucet chops them for wood);
  buildings/structures are static AABBs, and doc 06's `StructureIndex` deliberately
  stays static — physics consumes all of these as fixed colliders, changing none of
  their owners' designs.

## Design

### 1. The seam: `PhysicsWorld`

One module in `packages/shared` (types) + `apps/game/src/server/systems/physics.ts`
(server-only stepping — the client never imports the engine in v1):

```ts
interface PhysicsWorld {
  step(dt: number): void;                          // fixed dt, called from the tick
  addBody(desc: BodyDesc): BodyId;                 // tree trunk, crate, vehicle hull
  removeBody(id: BodyId): void;
  applyImpulse(id: BodyId, impulse: Vec3): void;   // melee shove, explosion later
  poses(): Iterable<[BodyId, Pose]>;               // position + quaternion, for sync
  snapshot(): Uint8Array;                          // persistence + replay harness
  restore(bytes: Uint8Array): void;
}
```

Rapier implements this today; Box3D implements it later if v1.0 lands with WASM. The
engine, its WASM loading, and its unit conventions live entirely behind this seam.

Static collision is built ONCE per room from the same deterministic worldgen the sim
already trusts: terrain as a heightfield collider, buildings/trees/structures as
cuboids from the exact AABBs the statics queries use. No second source of truth.

### 2. Wire + client

- `WireBody { id, kind, x, y, z, q (quantized quaternion), asleep? }` — new snapshot
  array, interest-filtered and realm-filtered like `portals`, omitted when empty.
  Poses quantized like everything else (round2 positions; quaternion to ~10 bits/axis
  is a later optimization, plain round2 first).
- Client renders bodies with the same pooled-clone pattern as `LootItems`/`Portals`
  and interpolates between snapshots like remote players. Sleeping bodies stop being
  re-sent (snapshot delta comes free with the scaling roadmap's delta work later; v1
  just re-sends poses of awake bodies in interest range).
- `PROTOCOL_VERSION` +1 at M1 (additive ServerMsg shape). Vehicle input (M4) adds a
  ClientMsg shape → +1 again, owned by that milestone.

### 3. Tick integration and cost

Physics steps INSIDE the existing tick, after inputs / before snapshot build:
fixed-dt substeps accumulated from game time so replay is exact. Cost controls:

- **Hard cap on dynamic bodies per room** (config-tunable, default ~64): trees despawn
  to loot after settling (TTL), props sleep aggressively, the cap evicts oldest-settled
  first — same world-cap pattern as campfires/portals.
- Bodies asleep = zero step cost in both engines; the cap + sleep thresholds are the
  actual cost model. M0 measures the worst case (cap × awake) so the budget is a
  number, not vibes.
- If M0's measured cost threatens the tick, the fallback is stepping physics at half
  rate (7.5 Hz) with client interpolation hiding it — decided by data, not upfront.

### 4. Persistence + determinism harness

- The body registry serializes into the existing single-row world snapshot
  (`SCHEMA_VERSION` bump): for EVERY registered body, `BodyDesc + Pose +
  linear/angular velocity + asleep flag` — velocities so momentum resumes
  (a crate mid-arc keeps flying after a DO restart), the sleep flag so settled
  stacks restore asleep instead of causing a wake-storm cost spike and pose
  jitter on boot. Engine-native `snapshot()` bytes are NOT persisted across
  versions (engine upgrades would break them) — we rebuild the world from our
  own serialization on restore.
- CI harness (extends the fingerprint discipline): a scripted scenario (N bodies, K
  impulses, M steps) runs on Linux CI and hashes the final poses; the same scenario
  runs in the M0 spike across macOS/browser/workerd. Any hash drift on engine upgrade
  is a caught, deliberate event (like the worldgen fingerprint baseline), not a silent
  desync.

### 5. Feature order (tracer-bullet discipline)

Falling trees first because they are the *smallest end-to-end slice*: server-initiated
(no new client input), bounded (one body per felled tree, TTL to loot), and they touch
every substrate layer once — spawn dynamic, step, sync, render, settle, persist,
despawn. Props add impulse interactions (melee shove). Vehicles add seats, per-seat
input routing, and a driven-body controller — the only feature with new ClientMsg
surface, which is why they come last and after doc 07's bigger islands give them a
reason to exist.

## Implications

**Opens up**
- The DayZ trifecta the roadmap lacked: vehicles as the endgame retention feature,
  physics props for base-adjacent emergent play, felled trees making doc 05's gather
  loop *visible*.
- A bit-deterministic subsystem (WASM) on a project whose JS sim can't be — the replay
  harness pattern built here is reusable if the sim core ever migrates to WASM.
- Render-only client physics (ragdolls, debris) can ship any time as a playtester-joy
  slice — no dependency on this doc at all.

**Complicates**
- Every tick now carries a physics step: the scaling roadmap's spatial-index/30 Hz
  decisions become physics-coupled; DO duration cost gets a new line item (M0 measures
  it; the body cap bounds it).
- Worker bundle grows by the engine WASM (~1.5–2 MB for Rapier) — inside limits, but
  the release artifact and per-PR preview deploys both carry it.
- The single-row world snapshot grows; restore now rebuilds a physics world.
- Doc 06 vs doc 13 becomes a Wave 2 sequencing choice (they don't conflict
  technically — bases are static colliders — they compete for build slots).

**Breaks**
- Nothing shipped. M1 is additive on the wire (proto bump), additive in persistence
  (schema bump with the sanctioned wipe path), and `movement.ts` is untouched.

**Threatens**
- **Determinism across runtimes is claimed, not proven** — the whole plan gates on
  M0's empirical hash test. If the published Rapier WASM isn't built with
  `enhanced-determinism` (or workerd differs), M0 fails fast and cheap.
- **Alpha-engine temptation**: Box3D is a better fit on paper; adopting it pre-v1
  would strap a fingerprinted multiplayer sim to alpha C code. The seam exists so we
  don't have to be early.
- **Scope gravity**: "just make the player a ragdoll" / "predict the vehicle" are the
  two requests that would drag the kinematic-player and no-rollback decisions back
  open. Both are explicit non-goals until real play demands them.

## Migration & compatibility

- Existing worlds: M1's `SCHEMA_VERSION` bump wipes dynamic-world state via the
  sanctioned doc 04 path (characters keep the standard rules; leaderboard survives).
- Protocol: two bumps total (M1 bodies, M4 vehicle input), each two-sided-gated.
- Presets/config: body cap + physics on/off land in `ServerConfig` as a
  LIVE-class group (a "no physics" preset stays possible for potato servers).
  LIVE is deliberate and safe HERE: physics is server-authoritative and
  outside the client determinism contract (clients never step it), and the CI
  replay harness pins its own scenario constants rather than reading
  `ServerConfig` — so a cap change alters future gameplay (like zombie
  density does), never replay validity or client agreement. Explicit
  lowered-cap semantics: bodies over the new cap evict oldest-settled-first
  on the next tick, same policy as normal cap pressure. Doc 04's fingerprint
  classes still get the final WIPE-vs-LIVE call per field at M1.
- The deadcoast preset and all shipped gameplay behave identically with zero dynamic
  bodies spawned.

## Implementation plan

Ordering: M0 is a Wave 1.5 weekly slice (contained, GO/NO-GO). M1 is the anchored
Wave 2 big build if M0 passes. M2/M3 are weekly-slice-sized. M4 waits for doc 07
M1–M2 (world tiers — vehicles need somewhere to drive). Platform spine unaffected.

1. **M0 — determinism + cost spike** *(one session; GO/NO-GO)* — standalone harness
   (`apps/game/scripts/physics-spike/`): load Rapier WASM in (a) Node/macOS,
   (b) Node/Linux CI, (c) browser, (d) workerd (miniflare + a scratch deploy); run a
   fixed scenario (heightfield + 100 bodies + scripted impulses, 1000 steps); hash
   poses. Measure step cost at 25/50/100 awake bodies on workerd; record worker-bundle
   delta. Acceptance: identical hashes across all four runtimes, step cost fits the
   tick budget with margin, findings recorded IN THIS DOC (like the M1 spike runbook
   pattern); explicit GO/NO-GO line written.
2. **M1 — substrate** *(the big one; determinism + protocol + persistence)* —
   `PhysicsWorld` seam + Rapier impl; static colliders from worldgen; tick
   integration; `WireBody` sync (proto bump); persistence (schema bump); body
   cap/sleep config in `ServerConfig`; CI replay harness. Acceptance: a debug-spawned
   crate rolls downhill identically for two clients, survives a DO restart, and the
   replay hash is stable in CI across two consecutive runs.
3. **M2 — falling trees** — chop completion (doc 05's channel) fells a dynamic trunk;
   settle → TTL → wood drops; static tree collider swaps out. Acceptance: fell a tree
   onto a slope, watch it roll on two clients, loot the logs where it stopped.
4. **M3 — props** — spawnable crates/barrels in worldgen + loot tables; melee impulse.
5. **M4 — vehicles v1** *(after doc 07 M1–M2)* — driven-body controller server-side,
   seat protocol (ClientMsg bump), fuel from doc 05 items, enter/exit, damage on
   collision. No prediction.
6. **M5 — driving prediction** *(only if M4 playtests demand it)* — rollback for the
   driven vehicle only.

## M0 findings (run 2026-07-08) — **GO**

Harness: `apps/game/scripts/physics-spike/` (shared scenario, integer-derived
inputs only; FNV-1a over Float32 pose bytes — bit-exact comparison).
Rapier `@dimforge/rapier3d-compat` **0.19.3**, scenario v1, seed 1337,
100 bodies × 1000 steps at dt=1/15 on a 64×64 heightfield.

**Determinism: identical hash `d060ce23` on all seven runtime/arch combos:**

| Runtime | Arch | Hash |
| --- | --- | --- |
| Node 24, macOS | arm64 | `d060ce23` |
| Node 22, Linux (docker) | arm64 | `d060ce23` |
| Node 24, Linux (docker) | arm64 | `d060ce23` |
| Node 22, Linux (docker) | **x86_64** | `d060ce23` |
| workerd local (`wrangler dev`) | arm64 | `d060ce23` |
| Browser (Chromium, preview harness) | arm64 | `d060ce23` |
| **workerd DEPLOYED (real Cloudflare)** | prod | `d060ce23` |

**Cost: physics is in the tick's noise floor.** Node avg ms/step, measured
around the step loop only (setup/hash/free excluded) — 25 bodies: 0.021–0.033,
50: 0.031–0.057, 100: 0.054–0.084, 200: 0.107–0.184 (arm64 native → x86
emulated range). Deployed workerd wall-clock agrees (≤0.2 ms/step at 200
bodies; below network-jitter resolution at 25). At the proposed 64-body cap
that is **< 0.3% of the 66.7 ms tick**. The M1 fallback (half-rate stepping)
will not be needed.

**Platform finding (load-bearing for M1):** workerd **disallows WebAssembly
compilation from bytes** ("Wasm code generation disallowed by embedder"), so
rapier3d-compat's inlined-base64 `init()` cannot run on Workers as-is.
Instantiating a **precompiled module is allowed**, and wrangler imports
`.wasm` files as CompiledWasm modules — the spike shims
`WebAssembly.instantiate` to reroute compat's bytes to the package's own
`.wasm` imported as a module (same binary). It works deployed. **M1 must ship
a proper loader** (import the `.wasm` module + wire wasm-bindgen glue, or the
non-compat package with custom init) instead of the global shim; the shim
also wastes a ~2 MB base64 decode per isolate cold start.

**Bundle delta:** ~2.2 MB unminified JS+wasm (wasm ≈ 1.9 MB) — fits Worker
limits comfortably; gzip substantially smaller.

**Caveat recorded:** every tested runtime is V8-based (Node/Chromium/workerd)
— which is exactly the authoritative deployment surface (server = workerd;
clients don't step physics in v1). Safari/Firefox (JSC/SpiderMonkey) WASM
determinism is untested and only becomes relevant if M5 client prediction
ever happens; re-test then.

**GO line: determinism holds bit-exactly across seven combos including
deployed production workerd; step cost is negligible at the design cap.
Proceed to M1 with a module-import WASM loader.**

## M1 findings (built 2026-07-08)

- **No `SCHEMA_VERSION` bump was needed** — `bodies` is an additive
  `WorldSnapshot` array (older snapshots normalize to `[]`, older code ignores
  the key), the same forward-compat posture as the weather fields and doc 12's
  `explored`. §4's "schema bump" assumption was wrong in the happy direction:
  **existing worlds survive the M1 deploy.**
- **Sub-stepping is REQUIRED, not an optimization.** At the raw 1/15 s tick,
  Rapier contacts tunnel (a falling crate passes through terrain and even a
  1 m-thick cuboid floor — found by the replay harness's orientation probes,
  which exist precisely to catch this class of failure). The engine steps at
  dt/4 (≈16.7 ms) four times per tick — fixed count, deterministic, ~4× the M0
  per-step cost (still <1% of the tick at the cap). §3's "half-rate fallback"
  is dead: the rate can only go UP from the tick, never down.
- M0's spike scenario stepped at raw 1/15 — its determinism/cost findings
  stand (bit-identical is bit-identical), but its bodies were partly
  tunneling; the replay harness now asserts SETTLING, which the spike never did.
- The engine attaches ASYNC in the DO (wasm init); PhysicsSystem buffers
  restored bodies + early spawns until attach, and persistence passes the
  buffer through — a save before attach can never drop bodies.
- Rapier heightfield data is column-major (x→columns); the harness's
  slope-probes pin the orientation empirically.

## Open questions

1. ~~**Rapier's published WASM: is it the `enhanced-determinism` build?**~~
   **ANSWERED by M0 empirically**: whatever the build flags, 0.19.3's shipped
   WASM is bit-deterministic across every V8 runtime and across arm64/x86_64
   — including deployed Cloudflare hardware. (Pin the exact rapier version;
   any upgrade re-runs the spike + re-baselines the replay-harness hash.)
2. **Tick rate interplay**: step physics at tick rate or half rate? *Recommendation:
   measure in M0, decide in M1; interpolation hides either.*
3. **Body cap default** (cost ceiling vs fun): 64? 128? *Recommendation: pick from
   M0's cost curve; make it a preset dial.*
4. **Box3D re-evaluation trigger**: v1.0 tag + a WASM build + determinism claims
   holding in third-party reports. *Watch item — revisit at each Box3D release; the
   announcement is bookmarked at the top of this doc.*
5. **Quaternion quantization** on the wire: round2 floats first, or bit-pack at M1?
   *Recommendation: round2 first, optimize with the scaling roadmap's delta work.*
