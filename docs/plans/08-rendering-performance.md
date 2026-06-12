# Rendering Performance: Device Tiers, Cheaper Ambient Occlusion, Frame Budget

## Summary

A measurement-driven rendering pass, written after a profiling session on an M3 Max /
ProMotion display (in-town, `quality:"high"`, native `devicePixelRatio` 2). The headline
finding reframes every other doc's perf reasoning: **the frame is post/fill/CPU-bound,
not geometry-bound.** Standing in Staroye the frame costs **~24 ms**; turning off the
N8AO ambient-occlusion pass alone drops it to **~12.8 ms** (so AO is ~11 ms, **~46 % of
the frame**), while freezing the matrix updates of all ~133 pooled character rigs, or
suppressing every zombie, moved frame time by **≈0 ms**. Draw calls and triangles were
measured at **< 1 ms** — the scene could carry several times its current geometry on
this GPU before geometry mattered.

That inverts the intuition the gameplay docs encode. Doc 06 (base building) and doc 07
(world tiers) reason about rendering in draw-calls and triangles and conclude their
features are "cheap"; on desktop they are right about the wrong axis. Three things
actually move this game's frame budget, and this doc owns all three:

1. **No device tiering exists.** `src/client/state/settings.ts` hardcodes
   `quality: "high"` for every device with **no auto-detect** (verified — no `detectGPU`,
   no `matchMedia`, no UA/hardwareConcurrency branch). Every phone that opens a community
   server boots into retina `dpr 2` + full-res N8AO + 2048 shadows. This is the single
   launch-blocking gap, and it is what makes the whole "anyone joins any server" pitch
   land badly on mobile.
2. **The N8AO line is half the frame** and is the same cost whether the scene has 50 or
   5,000 triangles, because it is screen-resolution work. The static world is
   deterministic, so most of what AO buys can be **baked into vertex colors at
   mesh-build** (client-side, determinism-neutral) and the dynamic pass dropped to
   half-res or off.
3. **Main-thread rig work is the second budget line** — invisible on an M3 Max (masked
   under GPU-bound frames) but the bottleneck on weaker GPUs and at the entity ceilings
   docs 04 and 07 introduce (120 zombies, up to 256 animals).

WebGPU is now default in mobile Safari (iOS 26) but is **scoped here as blocked R&D**,
not a fix: the entire dominant cost is the WebGL-only `@react-three/postprocessing` +
`n8ao` stack, so WebGPU would mean *rebuilding* the post chain, not accelerating it.

This doc is **measurement-gated and off the critical path.** It ships behind the
gameplay/platform spine; every milestone is A/B'd on real hardware with the harness in
`scripts/perf-probes.md` (committed in M1). Acceptance criteria measure **frame time and
main-thread ms**, never draw counts.

## Goals / Non-goals

**Goals**

- A device/GPU auto-tier so no client boots above its budget, with a persisted manual
  override (the existing Esc-menu quality switch stays the override UI).
- A genuinely playable **mobile tier** — the launch gate for the community-server pitch.
- Cut the ~11 ms AO line without the flat-shaded scene going visually flat, primarily via
  **baked static-world AO**.
- Bound main-thread rig cost at the preset ceilings docs 04/07 define (one shared budget
  line, three docs drawing on it).
- Keep the low-poly flat-shaded aesthetic intact — no textures, normal maps, or PBR.
- A permanent in-tab profiler (CPU/GPU/submit split + per-set census) so future gameplay
  milestones can self-check against frame budget.

**Non-goals**

- **Locked 120 fps as an acceptance gate.** 120 on a ProMotion M-series is a *target*;
  the contract is "every tier stays within its measured budget on its class of device,"
  not a universal fps floor. (Measured: a `dpr 1.5` + AO-off + shadow-throttle stack hit
  ~11 ms standing / ~12.7 ms moving in daylight — ~80–90 fps — on the M3 Max. Reaching a
  *locked* 8.3 ms there needs AO essentially gone, which is what baked AO enables.)
- **A WebGPU migration.** R&D entry only (§8); blocked on the pmndrs post ecosystem
  gaining WebGPU parity.
- **LOD / impostors / occlusion culling on desktop.** Geometry measured < 1 ms;
  optimizing it is optimizing a non-bottleneck. Revisit *only* for mobile, *only* if M3's
  measurements demand it.
- Rewriting the post chain or swapping renderers in this doc.
- Touching the deterministic sim. The AO bake reads world data but **adds no rng draws
  and does not change `heightAt`** — it is a client render-time computation, fingerprint-
  neutral by construction (§3).

## Current state

Measured 2026-06-11/12 on Adam's machine. **Caveats:** single machine (M3 Max), single
in-town spot, standing still, `high` tier, ProMotion-quantized rAF (frame times snap to
8.33 ms multiples; treat as directional, re-measure per change). GPU-pass timer readings
via `EXT_disjoint_timer_query_webgl2` over-count on Apple's tile GPU, so **frame-time
deltas are the ground truth below**, not per-pass timers.

**Measured lever deltas (in-town, high, dpr 2, standing):**

| Lever (A/B vs baseline) | Frame | Δ | Note |
| --- | --- | --- | --- |
| Baseline | ~24.0 ms | — | 53→~50 fps; ~110 draws standing |
| N8AO off | ~12.8 ms | **−11.2** | the single biggest lever; ~46 % of frame |
| N8AO half-res | ~22.1 ms | −1.8 | disappointing — composite/upsample stay full-res |
| N8AO half-res + Performance | ~22.0 ms | −1.9 | sample count isn't the bottleneck; bandwidth is |
| `dpr` 2 → 1 | ~17.1 ms | **−6.9** | framebuffer 4112×2128 → 2056×1064 |
| Bloom off | ~21.6 ms | −2.3 | pricier than the code estimate at dpr 2 |
| SMAA off | ~22.5 ms | −1.4 | — |
| Shadow pass off (`sun.castShadow=false`) | ~21.8 ms | −2.6 | ~140 draws; **renders all night at sun intensity 0** |
| Shadow map @15 Hz throttle | ~22.9 ms | −1.0 | less than full-off; still re-renders periodically |
| Trees/trim/scatter out of shadow pass | ~23.8 ms | −0.6 | small |
| Rig shadows off | ~23.9 ms | −0.5 | small |
| Hidden-slot matrix freeze (198 groups) | ~24.0 ms | **≈0** | **not CPU-matrix-bound on this GPU** |
| Zombie subsystem suppressed | ~24.0 ms | **≈0** | rig/AI cost masked under GPU-bound frames |
| **Stack: dpr 1.5 + AO off + shadow 15 Hz** | **~11.2 ms** | — | ~89 fps standing, ~12.7 ms / ~79 fps moving daylight |

**Render config (verified):**

- `src/client/state/settings.ts` — `QUALITY_CONFIGS`: `low {maxDpr 1, postFx false,
  shadows false, grassDensity 0.35}`, `medium {1.5, true, 1024, 0.7}`, `high {2, true,
  2048, 1}`. **Default `quality: "high"` unconditionally; no device detection anywhere.**
  Live-switchable via the Esc menu (`src/client/ui/EscapeMenu.tsx`); persisted to
  `localStorage` key `dc_settings`. Not exposed on `window`.
- `src/client/render/post/PostFX.tsx` — pmndrs `EffectComposer` is the sole renderer
  (R3F auto-render disabled by PlayerCamera's positive-priority `useFrame`). Chain
  (medium/high, identical — only `dpr` differs between the tiers): RenderPass → N8AO
  (`quality="medium"` = 16 AO / 8 denoise samples, **`halfRes` default false**) → merged
  EffectPass [Bloom mipmapBlur + Vignette + HueSaturation + BrightnessContrast] → SMAA.
  **WebGL-only stack** (`postprocessing` + `n8ao`); `multisampling={0}` already set.
- `src/client/GameCanvas.tsx` — `gl={{ antialias: true, powerPreference:
  "high-performance" }}`. `antialias: true` allocates a 4×-MSAA backbuffer that only ever
  receives the composer's final fullscreen blit (SMAA is the real AA) — wasted resolve;
  context-creation flag, so toggling needs a Canvas remount.
- `src/client/render/world/SkyAndLighting.tsx` — one shadow-casting `DirectionalLight`
  (the sun), `shadow.mapSize` 2048 on high, `shadowMap.autoUpdate` default true (full
  re-render every frame), shadow ortho box camera-centered (110×110 m), **`castShadow`
  stays true at night** while `intensity` ramps to 0 — the whole shadow pass renders for
  an invisible sun (hours 21–5).
- `src/client/render/world/Terrain.tsx` — one `PlaneGeometry(WORLD_SIZE, 200, 200)`,
  40,401 verts, already vertex-colored from height + central-difference slope
  (`:39–53`). **This is the existing hook for baked AO** — an extra darkening term on an
  existing vertex-color pipeline, no new material.
- ~133 always-resident character rigs (24 remote players + 60 zombies + 48 corpses + 1
  local, plus 14 deer) — `~6` skins/survivor, `~9`/zombie. On the M3 Max their per-frame
  matrix + skeleton work is **masked under GPU-bound frames** (matrix-freeze A/B ≈0); on a
  weaker GPU, or at doc 04's `zombieDensity:2` (120) and doc 07's `ANIMAL_POOL_MAX 64 × 4
  species` (256) ceilings, it surfaces.

**Determinism note:** the static world (terrain heightfield, town/building layout, trees,
rocks) is produced by deterministic seeded worldgen (`src/shared/world.ts`). Vertex AO is
computed **on the client at mesh-build time** from that already-resolved geometry; it
reads world data, writes only vertex colors, and **touches no rng stream and no
`heightAt`** — so `scripts/worldgen-fingerprint.ts` (doc 07 M1) is unaffected. Stated
explicitly to preempt the determinism worry.

## Design

### 1. Device & GPU auto-tier (the launch gate)

A first-run tier pick, persisted, overridable. Heuristic (cheap, no WebGL probe needed
for v1): `matchMedia('(pointer: coarse)')` → `mobile` tier; else a coarse desktop-GPU
read via the WebGL `WEBGL_debug_renderer_info` `UNMASKED_RENDERER` string + `dpr` +
`hardwareConcurrency` → `low | medium | high`. Apple-silicon / discrete-GPU renderer
strings and `dpr ≥ 2` → `high`; integrated/unknown → `medium`; coarse-pointer or weak
strings → `mobile`/`low`. **The override is sacred:** if the user has ever changed quality
in the Esc menu (a flag in `dc_settings`), never re-detect over their choice. `settings.ts`
gains `detectTier()` and the default becomes the detected tier, not the literal `"high"`.

### 2. Mobile tier

A new profile distinct from `low` (which today is a desktop fallback). `mobile`: `maxDpr`
≤ 1.25, N8AO **off** (or half-res if M5 proves it cheap enough), shadows **off**,
`grassDensity` ≤ 0.35, Bloom off, SMAA → cheaper/none. Mobile already has touch controls
and screen-space HUD (shipped); this is the render profile that makes the community-server
pitch viable on a phone. Acceptance is **a real mid-tier phone**, not a desktop emulation.

### 3. Baked static-world ambient occlusion (the big AO win)

The static world never moves, so its AO can be precomputed once per world into vertex
colors and cost **0 ms/frame forever, on every device.** Flat-shaded low-poly + vertex
colors is the ideal medium for it.

- **Terrain:** at chunk/mesh build, add a large-scale occlusion term from the heightfield
  — sample neighboring heights over a small kernel; concave/valley verts darken, ridges
  stay lit. Folds into the existing `Terrain.tsx` vertex-color pass (`:39–53`).
- **Buildings / trim:** contact-and-corner darkening at the per-material merge step
  (buildings are already merged; trim is instanced) — darken verts near ground contact and
  interior corners, where N8AO does its most visible work today.
- **Dynamic entities** (players, zombies, loot) get a cheap **blob shadow** (one radial-
  gradient quad under each rig) or nothing — they are small and moving; losing crisp
  contact AO on them is near-invisible.

With static AO baked, the dynamic N8AO pass can drop to half-res or off (§4) **without the
scene reading flat**, which is the verdict Adam couldn't reach in the live session (it was
night, and he died of exposure mid-test). This is the highest-value item in the doc.

### 4. Dynamic AO: half-res, cheaper, or off per tier

Once §3 carries the static grounding, dynamic AO becomes a per-tier nicety: `high` →
N8AO half-res (`halfRes` prop the wrapper already plumbs — measured to need pairing with
§3 since half-res alone only saved ~1.8 ms), or an investigation into a cheaper GTAO/
half-res-temporal AO targeting the ~11 ms line directly; `medium` → off or quarter-res;
`mobile`/`low` → off. Add `aoHalfRes` / `ao` knobs to `QualityConfig`.

### 5. Shadow budget

Three measured-cheap, quality-neutral wins, all per-tier knobs: (a) `shadowMap.autoUpdate
= false` + `needsUpdate` at ~15–20 Hz with camera-move/texel-snap triggers (−1 to −2.6 ms;
the sun drifts only ~0.28°/s so per-frame updates are pure waste); (b) **skip the shadow
pass entirely at night** (`castShadow = false` when sun elevation < horizon — it currently
renders all night for a 0-intensity sun, free −2.6 ms for hours 21–5); (c) tighter forward-
biased ortho box + 1024 map on high (the box is camera-centered today, half of it behind
the player). Hysteresis on the night toggle to avoid a dawn/dusk material-recompile flap.

### 6. Main-thread rig budget

Invisible on the M3 Max, real on weaker GPUs and at preset ceilings. Dirty-flag and skip
mixer + matrix updates for off-screen and idle-pose rigs; cap concurrently *animated*
rigs (pose-freeze the surplus); set `matrixWorldAutoUpdate = false` on hidden pool slots
(the A/B was ≈0 on M3 Max but the work is pure-loss and surfaces under load). **The
worst-case test scene is the contract:** doc 04 `zombieDensity:2` (120 zombies) + doc 07
4-species ceilings, measured on a mid-tier device — not the M3 Max where it reads ~0. This
is the budget line docs 04, 06, and 07 all draw on; this milestone owns bounding it.

### 7. The profiler as a permanent tool

The session's harness (`scripts/perf-probes.md`: instance-wrapped CPU/GPU/submit splitter,
per-set visibility census, n8ao GPU timer, per-lever A/B kit) becomes a committed dev
tool. Wire the splitter's frame/JS/submit numbers into `DebugCollector` behind `?debug=1`
and add two rows to the on-screen overlay, so every future gameplay milestone can read its
own frame cost. ~30 lines, zero cost when the overlay is hidden.

### 8. WebGPU — scoped R&D, blocked

WebGPU is default in mobile Safari (iOS 26) and all major browsers. It is **not** motivated
by any plan in this roadmap and is **gated by the very thing that costs the most**: the
N8AO + Bloom + SMAA chain is the pmndrs WebGL-only stack, with no drop-in WebGPU
equivalent today. A migration = rebuilding the post chain on three's TSL node post stack
(which does have GTAO/Bloom/FXAA/TRAA nodes — a real landing zone, eventually) + porting
the grass-wind `onBeforeCompile` and water shaders to TSL + maintaining WebGL2 fallback
for older devices. The one genuine upside is **compute-shader skinning** moving the §6 rig
work off the JS thread — which is exactly the budget line the expansion grows most, so
that, not geometry, is the motivation if it's ever pursued. Track it as a spike, explicitly
contingent on pmndrs WebGPU post parity. **Do not frame WebGPU as a geometry or AO fix —
it is neither.**

## Implications

**Opens up:** a real mobile audience for the community-server pitch (today's `high`-on-
everything makes that audience bounce); a frame-budget vocabulary the gameplay docs can
write acceptance criteria in; baked AO that makes *every* device cheaper at once, not just
the top tier; a permanent profiler that turns "is this milestone too heavy?" into a number.

**Complicates:** `QualityConfig` grows several knobs (`aoHalfRes`, `ao`, `shadowHz`,
`tier`), and the Esc-menu preset list + the tier union must stay in sync (three edit sites
today: the union, the table, `EscapeMenu`'s hardcoded list). The auto-tier introduces a
"detected vs chosen" state that must never stomp a user's manual pick.

**Breaks:** nothing in the sim or wire. Two cosmetic changes for existing players: the
auto-tier may pick something other than `high` on next load (mitigated — only when no
manual choice was ever saved), and baked AO subtly restyles static surfaces (it should
*improve* grounding, but it is a visible art change — Adam signs off the look).

**Threatens:** the AO bake is the load-bearing assumption — if baked vertex AO + half-res/
off dynamic AO does not read as well as full-res N8AO on building interiors, `high` either
keeps a (cheaper) dynamic AO pass or accepts ~16 ms / ~75–90 fps rather than locked 120.
The `simplex-noise: "^4.0.3"` caret range (flagged in doc 07's review) is a latent
determinism hazard *adjacent* to any terrain-AO work touching `world.ts` neighbor sampling
— pin it to `4.0.3` exact before M4 reads heights for the bake.

## Migration & compatibility

No protocol, no persistence, no `PROTOCOL_VERSION` bump — this is client render code and a
`localStorage` settings-shape extension. The `dc_settings` blob gains `tier` /
`userOverrodeQuality`; absent keys default safely (detect on first load). The Esc-menu
quality switch remains the manual override and keeps working unchanged. Amend
`ARCHITECTURE.md`'s render-ownership section in the same PR as M2 (the tier system is new
shared client surface).

## Implementation plan

One milestone per session; A/B every render change on real hardware via M1.

1. **Profiler as a committed tool** — *Sonnet 4.8*. Promote `scripts/perf-probes.md` into
   a `?debug=1` overlay: instance-wrap `gl.render` for submit-ms, rAF-gap for frame-ms,
   optional GPU-timer row, plus the documented per-set visibility-census and per-lever A/B
   snippets kept as a committed console kit. No gameplay deps. *Acceptance:* overlay shows
   frame / JS / submit ms live; toggling it costs ≈0; census + A/B snippets run from the
   console against a prod `?debug=1` tab.
2. **Device/GPU auto-tier + persisted override** — *Sonnet 4.8*. `detectTier()` in
   `settings.ts`; default becomes detected; `userOverrodeQuality` flag set on any Esc-menu
   change and never re-detected over. New `tier` union member wired through the table, the
   union, and `EscapeMenu`'s list. Amend `ARCHITECTURE.md`. *Acceptance:* fresh profile on
   a coarse-pointer device boots `mobile`/`low`; on the M3 Max boots `high`; a manual pick
   survives reload and is never overridden; no sim/wire change.
3. **Mobile tier** — *Sonnet 4.8*. Depends on 2. New `mobile` profile (dpr ≤1.25, AO off,
   shadows off, grass min, Bloom off). *Acceptance:* **measured on a real mid-tier phone**
   — sustained playable frame time (target ≤ ~16 ms), documented in this doc; visual
   sanity check that the scene still reads.
4. **Baked static-world vertex AO** — *Opus 4.8* (render-correctness + must prove
   determinism-neutrality). Heightfield AO term in `Terrain.tsx`; contact/corner darkening
   at the building merge + trim instancing; optional blob shadow for dynamic rigs.
   *Acceptance:* `worldgen-fingerprint.ts` **bit-identical before/after** (proves the bake
   added no rng draw and changed no height); building interiors at dawn/dusk read grounded
   with dynamic AO **off**; frame-time delta measured via M1; Adam signs off the look.
   *(Pin `simplex-noise` to `4.0.3` exact in this PR.)*
5. **Dynamic AO retune + shadow budget** — *Sonnet 4.8* (Opus spike option for a GTAO
   swap). Depends on 4. Per-tier `aoHalfRes`/`ao` knobs; N8AO half-res on `high`, off
   below; shadow `autoUpdate` throttle + night-skip + tighter forward-biased box + 1024 on
   high; `antialias:false` on the Canvas (keyed remount). *Acceptance:* `high` frame time
   measured down toward the budget with §4's grounding holding the look; no shadow stepping
   on a moving caster at the chosen throttle; night frames drop the shadow pass cleanly.
6. **Main-thread rig budget** — *Opus 4.8* (hot render loop + pooled-rig interaction).
   Off-screen/idle rig mixer+matrix skip; cap concurrent animated rigs; `matrixWorldAuto-
   Update=false` on hidden slots. *Acceptance:* the worst-case scene (doc 04 `zombie-
   Density:2` = 120 zombies + doc 07 4-species ceilings) measured on a **mid-tier device**;
   main-thread ms bounded under a documented cap; no animation popping on rigs entering
   view; correctness of pooled-slot assignment preserved.
7. **WebGPU spike (R&D, not gated)** — *Opus 4.8 spike*. Measure-only: stand up a
   `WebGPURenderer` branch behind a flag, port one shader (grass wind) to TSL, prototype
   compute skinning for the rig pool, and **measure rig-work offload** — explicitly NOT a
   geometry or AO fix, explicitly blocked on pmndrs WebGPU post parity for the real
   migration. *Acceptance:* a written go/no-go with measured rig-thread numbers and a
   parity-tracking note; no production wiring.

## Open questions for Adam

1. **Ship target for `high` on desktop** — is `high` ≈ 90 fps acceptable (dpr 1.5 +
   half-res AO + baked AO), or must `high` hit *locked* 120 (which forces dynamic AO
   essentially off, leaning entirely on the §3 bake)? **Rec: `high` = dpr 1.5 + baked AO +
   half-res dynamic AO, target ~90–110 fps; add an opt-in `ultra` (dpr 2, full dynamic AO)
   for those who want max fidelity over frame rate.**
2. **Baked AO — go?** It is the doc's load-bearing bet and a visible (improving) art
   change to static surfaces. **Rec: yes — it is the only thing that makes AO cheap on
   every device at once; M4 gates on your look sign-off.**
3. **Auto-tier default on the M3 Max** — detection picks `high`, which on a 254-ppi panel
   means dpr 2 unless you override. **Rec: detect `high` but ship `high` = dpr 1.5 per Q1,
   so the default is already the cheaper profile; `ultra` is the opt-in to native retina.**
4. **WebGPU R&D priority** — spike now, or park until pmndrs ships WebGPU post parity?
   **Rec: park; revisit when the post ecosystem moves or when the §6 mobile rig budget
   proves to need compute offload. None of the gameplay docs force it.**
5. **`simplex-noise` pin** — caret `^4.0.3` is a determinism hazard independent of this
   doc. **Rec: pin to `4.0.3` exact in M4's PR (or sooner, standalone).**
