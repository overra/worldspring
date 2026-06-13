# 120fps pass — live-tab measurement harness

Run these in Adam's **focused, visible** tab on prod (or dev) with `?debug=1`. The probe
snippets below are the permanent tool; the predictions were code-derived (2026-06-11,
workflow wf_b19de628-924, 6 agents) and the **Measured results** section is what the live
session actually found — trust the latter where they disagree.

Two baselines, don't conflate them: the **handoff screenshot** was 53 fps / 18.8 ms / 365
draws / 482.6k tris (a particular in-town framing). The **live A/B baseline** below is
standing still in Staroye center, `high` tier, dpr 2 — **~24 ms / ~110 draws**. Different
spot, different number; the lever *deltas* are what matter and they were all A/B'd against
the ~24 ms local baseline seconds apart.

## Measured results (M3 Max / ProMotion, 2026-06-11/12, in-town, high, standing)

Frame-time deltas are ground truth (the `EXT_disjoint_timer_query` per-pass timer
over-counts on Apple's tile GPU). ProMotion-quantized; directional, re-measure per change.

| Lever (A/B vs baseline) | Frame | Δ | Note |
| --- | --- | --- | --- |
| Baseline | ~24.0 ms | — | ~50 fps standing |
| **N8AO off** | ~12.8 ms | **−11.2** | the single biggest lever; ~46% of frame |
| N8AO half-res | ~22.1 ms | −1.8 | composite/upsample stay full-res — modest |
| N8AO half-res + Performance | ~22.0 ms | −1.9 | sample count isn't the bottleneck; bandwidth is |
| **dpr 2 → 1** | ~17.1 ms | **−6.9** | framebuffer 4112×2128 → 2056×1064 |
| Bloom off | ~21.6 ms | −2.3 | pricier than the ≤0.8 code estimate |
| SMAA off | ~22.5 ms | −1.4 | — |
| Shadow pass off | ~21.8 ms | −2.6 | ~140 draws; **renders all night at sun intensity 0** |
| Shadow map @15 Hz | ~22.9 ms | −1.0 | less than full-off; still re-renders periodically |
| Trees/trim/scatter out of shadow pass | ~23.8 ms | −0.6 | small |
| Rig shadows off | ~23.9 ms | −0.5 | small |
| Hidden-slot matrix freeze (198) | ~24.0 ms | **≈0** | **NOT CPU-matrix-bound on this GPU** |
| Zombie subsystem suppressed | ~24.0 ms | **≈0** | rig/AI cost masked under GPU-bound frames |
| **Stack: dpr 1.5 + AO off + shadow 15 Hz** | **~11.2 ms** | — | ~89 fps standing, ~12.7 ms / ~79 fps moving daylight |

Verdict: the frame is **post/fill/CPU-bound, not geometry-bound** (draws+tris < 1 ms). The
big levers are AO (~11), dpr (~7), shadow (~2.6), bloom (~2.3), SMAA (~1.4). The CPU levers
the code model predicted (matrix freeze, rig shadows, zombie suppress) measured ≈0 on the
M3 Max — they surface only on weaker GPUs / at preset entity ceilings. See
`docs/plans/08-rendering-performance.md` for the plan these feed.

## Reading the overlay correctly

- F3 overlay `frameMs` is an EMA (alpha 0.1, ~10-frame settle, 250ms refresh).
- ProMotion quantizes rAF to 8.33ms multiples → 18.8ms avg = mixed 16.7/25ms frames.
  Steady 120fps needs EVERY frame < 8.33ms; fps snaps between 60/80/90/120 plateaus.
- `gl.info` (and the overlay draws/tris) accumulate across shadow pass + scene + post
  (DebugCollector resets at priority 1, composer renders at 2, reads at 3). The 365/482.6k
  baseline already includes the shadow pass.
- Settings store is NOT window-exposed in prod. Dev tab:
  `(await import('/src/client/state/settings.ts')).useSettingsStore`. Prod: Esc menu, or
  `window.__scene.__r3f.root.getState()` for the R3F root store (setDpr etc).

## 0. Preflight (ALWAYS — the throttled-tab gotcha burned us 3x)

```js
document.visibilityState
(()=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<1000)requestAnimationFrame(f);else console.log('rAF Hz ~',n)};requestAnimationFrame(f)})()
// must be 'visible' and ~60-120Hz. Then confirm tier:
JSON.parse(localStorage.getItem('ws_settings')).state.quality  // expect 'high'
__gl.getPixelRatio()                                            // expect 2
__gl.getContext().getContextAttributes()                        // expect antialias:true (the waste we'll remove)
```

## 1. CPU-vs-submit blame splitter (read the live overlay — arbitrates everything)

Under `?debug=1` (or any DEV build) the in-tab overlay already installs the
`gl.render` wrap + standalone-rAF loop and shows **frame / JS / submit ms** live
(`DebugCollector` → `perfSplitter.ts`; F3 toggles the panel). Only one wrap can own
the renderer instance, so read the live numbers from the console instead of
installing a second one:

```js
window.__perfSplit                                  // { frameMs, jsMs, submitMs } live getters
const s = window.__perfSplit; ({ frame: +s.frameMs.toFixed(2), js: +s.jsMs.toFixed(2), submit: +s.submitMs.toFixed(2) })
```

Reading it:
- **JS small + frame ≈ vsync → GPU/fill-bound** (dpr + postfx levers win).
- **submit (gl.render CPU) dominant → submit/matrix-bound** (draw-count + matrix levers win).
- `frame − JS` ≈ GPU/vsync wait.

GPU per-pass time over-counts on Apple's tile GPU, so the overlay reports CPU/submit,
not a GPU row. For the one GPU pass that actually matters (AO is ~46% of the frame)
use §3's `__fx.n8ao.lastTime`.

## 2. Visibility census — ground-truth per-set share (L0)

```js
(async()=>{const S=window.__scene,GL=window.__gl;const mn=o=>Array.isArray(o.material)?'':(o.material&&o.material.name||'');const TREE=new Set(['pine_green','pine_dark','leaf_green','leaf_dark','log_brown']),TRIM=new Set(['wood_weathered','wood_weathered_light','brick','brick_dark']);const underBone=o=>{for(let p=o.parent;p;p=p.parent)if(p.isBone)return true;return false};const g={};const add=(k,o)=>(g[k]||(g[k]=[])).push(o);S.traverse(o=>{if(o.isInstancedMesh){if(o.geometry.getAttribute('aBend'))return add('grass',o);const n=mn(o);if(TREE.has(n))return add('trees',o);if(TRIM.has(n))return add('trim',o);return add('scatter',o)}if(o.isSkinnedMesh)return add('characters',o);if(o.isMesh&&o.name.startsWith('buildings-'))return add('buildings',o);if(o.isMesh&&o.castShadow&&!underBone(o))return add('props_loot_etc',o)});const fr=n=>new Promise(r=>{let c=0;const f=()=>(++c>=n?r():requestAnimationFrame(f));requestAnimationFrame(f)});const sample=async(n=60)=>{await fr(5);const t0=performance.now();await fr(n);return{ms:(performance.now()-t0)/n,calls:GL.info.render.calls,tris:GL.info.render.triangles}};const base=await sample();const rows=[];for(const[k,list]of Object.entries(g)){const prev=list.map(o=>o.visible);list.forEach(o=>o.visible=false);const s=await sample();list.forEach((o,i)=>o.visible=prev[i]);rows.push({set:k,meshes:list.length,dCalls:base.calls-s.calls,dTris:base.tris-s.tris,dMs:+(base.ms-s.ms).toFixed(2)})}console.table(rows);console.log('baseline',base)})();
// Stand still ~10s. dMs < ~0.4 is vsync noise — trust dCalls/dTris, rerun for ms.
```

## 3. PostFX handles + measured N8AO cost

```js
window.__fx??=(()=>{const fx={effects:{}};__scene.traverse(o=>{const ks=o.__r3f?.children;if(!ks)return;for(const c of ks){const k=c.object;if(!k)continue;if(k.configuration&&k.setQualityMode)fx.n8ao=k;else if(k.blendMode&&k.name)fx.effects[k.name]=k}});return fx})();
__fx.n8ao.enableDebugMode();          // then read repeatedly:
__fx.n8ao.lastTime                    // measured N8AO GPU ms (EXT_disjoint_timer_query)
```

## 4. Lever A/Bs (one at a time; revert between; note overlay ms + splitter numbers)

### 4a. DPR 2 → 1.5 (est 3.5–5.5ms — biggest single lever)
```js
(() => {
  const st = window.__scene.__r3f.root.getState(); st.setDpr(1.5);
  // composer only resizes targets on CSS-size change — force one or the A/B LIES:
  const el = window.__gl.domElement.parentElement; const prev = el.style.height;
  el.style.height = (el.clientHeight - 1) + 'px'; setTimeout(() => { el.style.height = prev; }, 100);
})();
// verify __gl.getPixelRatio()===1.5 ; revert: same with setDpr(window.devicePixelRatio)
// (a window resize also re-applies the Canvas dpr prop and undoes this)
```

### 4b. N8AO halfRes (est 2–3.5ms)
```js
__fx.n8ao.configuration.halfRes=true;   // revert: =false  (rebuilds targets live)
```

### 4c. N8AO quality Medium → Performance (est 0.8–1.5ms, stacks with 4b)
```js
__fx.n8ao.setQualityMode('Performance'); // revert: setQualityMode('Medium')
```

### 4d. N8AO off entirely (bounds its true total, est 3–5ms)
```js
__fx.n8ao.enabled=false;                 // revert: =true
```

### 4e. Shadow throttle to ~15Hz (est 1.5–3ms)
```js
(() => { const gl = window.__gl; gl.shadowMap.autoUpdate = false; window.__shadowTick = setInterval(() => { gl.shadowMap.needsUpdate = true; }, 66); })()
// revert: clearInterval(window.__shadowTick); __gl.shadowMap.autoUpdate = true
```

### 4f. Whole shadow pass off (daytime ground truth; at night = pure waste measurement)
```js
(() => { let sun; __scene.traverse(o => { if (o.isDirectionalLight && o.castShadow) sun = o; }); window.__sun = sun; sun.castShadow = false; })()
// revert: __sun.castShadow = true   (expect a one-frame recompile hitch each way)
```

### 4g. Tree/trim/scatter out of shadow pass (ceiling for the chunked-instancing fix)
```js
__scene.traverse(o=>{if(o.isInstancedMesh&&!o.geometry.getAttribute('aBend'))o.castShadow=!o.castShadow});
// run again to revert. Trees-only variant: filter material name in TREE set from §2.
```

### 4h. Rig shadows off (zombies are 9 shadow draws / 5.3k tris EACH)
```js
(() => { const hit = []; __scene.traverse(o => { if (o.isSkinnedMesh && o.castShadow) { hit.push(o); o.castShadow = false; } }); window.__rigShadows = hit; })()
// revert: __rigShadows.forEach(m => m.castShadow = true)
```

### 4i. Hidden-pool-rig matrix freeze (est 0.6–1.5ms CPU; ~100 of 133 rigs are idle slots)
```js
(() => {
  let slots = 0; __scene.traverse((o) => {
    if (o.type === 'Group' && o.visible === false && o.parent && o.parent.parent === window.__scene) {
      o.matrixWorldAutoUpdate = false; slots++;
    }
  }); console.log('froze', slots, 'hidden pool slots');
})();
// UNDO promptly (spawning entities would land in frozen slots): __scene.traverse(o => { o.matrixWorldAutoUpdate = true; })
```

### 4j. SMAA stub (bounds its 3 passes, est 0.8–1.4ms)
```js
const s=__fx.effects.SMAAEffect;s.__u??=s.update.bind(s);s.__bf??=s.blendMode.blendFunction;s.update=()=>{};s.blendMode.blendFunction=9;
// revert: s.update=s.__u;s.blendMode.blendFunction=s.__bf
```

### 4k. Bloom stub (est 0.5–0.8ms; 17 of post's 26 draws)
```js
const b=__fx.effects.BloomEffect;b.__u??=b.update.bind(b);b.__bf??=b.blendMode.blendFunction;b.update=()=>{};b.blendMode.blendFunction=9;
// revert: b.update=b.__u;b.blendMode.blendFunction=b.__bf
```

### 4l. Grass kill switch (ceiling for ALL grass levers — expected small, 0.3–0.7ms)
```js
(()=>{const g=[];__scene.traverse(o=>{if(o.isInstancedMesh&&o.geometry?.attributes?.aBend)g.push(o)});window.__grass=g;g.forEach(m=>m.visible=false)})()
// restore: __grass.forEach(m=>m.visible=m.count>0). Re-hides only until a 16m chunk-boundary crossing.
```

### 4m. Zombie subsystem off (end-to-end cost of densest entity class)
```js
(() => { const m = new Map(); m.set = () => m; window.__game.clientWorld.zombies = m; })()
// revert: __game.clientWorld.zombies = new Map()  // refills next snapshot. You CANNOT see what's eating you while this is on.
```

## Code-derived budget model (PRE-measurement predictions — superseded above)

Kept for the reasoning/file:line anchors. Corrections from the live session: N8AO measured
~11 ms (predicted 3–5 within a 5–8 total); Bloom ~2.3 ms (predicted ≤0.8); the CPU column
measured ≈0 on the M3 Max (masked under GPU-bound frames), not 4–9 ms.

| Component | Est ms | Draws | Tris | Key fact |
|---|---|---|---|---|
| PostFX total | 5–8 | ~26 | ~0 | N8AO full-res 16-tap at 6.4MP is 3–5ms of it |
| Shadow pass | 2.5–4.5 | ~140 | ~190k | re-renders ALL 700 trees every frame, runs all night at sun intensity 0 |
| Main-pass scene | fill-dominated | ~170–190 | ~280k | trees 98.3k tris (frustumCulled=false), terrain 80k |
| CPU total | 4–9 | — | — | 133 pooled rigs always pay matrix updates; 6 skins/survivor, 9/zombie multiply draws+skeleton updates |

Targets after the pass: post ≤2–2.5ms, shadow ≤1ms avg, dpr question settled by 4a.

## Known pre-existing bug (fix during implementation)

`@react-three/postprocessing` composer resizes its targets only on CSS-size change —
a live dpr change (incl. Esc-menu medium↔high, whose identical postfx chain skips the
pass rebuild) leaves all passes rendering at the OLD resolution until a window resize.
Real fix: call `composer.setSize` on `viewport.dpr` change in PostFX.tsx.
