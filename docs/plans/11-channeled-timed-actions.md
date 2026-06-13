# Channeled / Timed Actions — Cook, Use, and Reload Stop Being Instant

Status: design. Companion docs: 05 (items + crafting — owns the `use`/`craft` messages
and `cooksTo`/`RECIPES`; this doc wraps their instant completion behind a duration),
combat (owns reload + ammo + all damage/duration BALANCE numbers; this doc supplies only
the interruptible-cast wrapper and the magazine state shape), 07 (world + wildlife — owns
fishing; its M12 timed cast is the natural first consumer of this primitive), 03
(`PROTOCOL_VERSION` + the two-sided `proto` join gate this doc bumps and hard-depends on),
04 (`ServerConfig` — reserved hook if a per-server channel-duration multiplier is ever
wanted). Research grounding: `docs/plans/research/codebase-sim.md`,
`docs/plans/research/codebase-server.md`.

## Summary

Every action in the sim resolves the instant its message lands. `useItem` (eat / drink /
heal / **cook** / place a fire) applies and consumes synchronously on receipt
(`apps/game/src/server/GameRoom.ts:499-501` calls `useItem` inline, outside the tick);
ranged fire is one ammo item per trigger pull gated only by a fire-rate cooldown, with **no
magazine and no reload** (`apps/game/src/server/systems/combat.ts:293-311`); doc 07's interim
fishing is "an instant `FISH_CHANCE` roll on a cooldown". There is no channeled action
anywhere, and the most visible casualty is cooking: `useItem` checks `nearFire` **once** at
the instant `{t:"use"}` lands (`apps/game/src/server/systems/players.ts:349-369`) — inside
5m it silently cooks, outside it silently eats the venison raw for a `-RAW_VENISON_HP_PENALTY`
hp hit, with zero feedback about which side of the line you were on. A server notice on the
eat-raw path ships separately as a stopgap (already present at `players.ts:362-365`); this
doc **supersedes** it with the real mechanic.

This doc owns ONE new primitive: a server-authoritative **channeled action**. A new
`ActiveAction` lives on `ServerPlayer`; the existing `{t:"use"}` (and combat's reload, and
later craft/fishing) **starts** a timed cast with a per-action `durationS`; the server ticks
its `remainingS` down in **game-time** inside a new `tickActiveActions(state, dt)` slotted
into the tick pipeline; the cast **interrupts** with no effect and no consumption on movement,
taking damage, changing the selected slot, opening chat, or death — and for cook specifically,
on leaving fire range (re-checked every tick); on **completion** it fires the SAME existing
completion path (`useItem`'s cook/eat/drink branch, combat's reload-refill, doc 05's
`craftItem`, doc 07's fishing cast). Progress rides on the snapshot self-state as an additive
`you.action` field so the HUD renders a cast bar — render-only, never predicted. The only
new ClientMsg vocabulary is the choice to **not** add one: cancel is purely server-driven, so
the existing verbs that start a channel are the entire client surface. One additive wire field
plus the new completion semantics is a wire-shape change under doc 03's rule, so this doc bumps
`PROTOCOL_VERSION` (owned by doc 03) in the milestone that lands the field, and hard-depends
on doc 03's join gate having landed first.

Reload is the combat instance of the primitive and forces a **magazine model** (weapons gain
a `magSize`; a per-slot current-rounds counter; reload is a channel that refills from the
ammo item). This doc scopes the magazine *state* and the channel that drives it, but **defers
every balance number** (mag sizes, reload durations, fire-rate interplay) to the combat owner.
Crafting *times* and the fishing channel are likewise enabled-but-deferred: doc 05 owns
`RECIPES`, doc 07 owns fishing — this doc supplies the substrate they cast on, it does not
redefine their content.

## Goals / Non-goals

**Goals**

- Add ONE reusable channeled-action primitive — start → tick-in-game-time → interrupt → complete/cancel — that any action can adopt without re-implementing timing or interrupts.
- Fix Adam's invisible-boundary pain concretely: a cook becomes a visible cast that only advances while `nearFire`, so stepping out of range cancels with feedback instead of silently eating raw.
- Make ranged reload exist at all, as the first combat consumer — which means defining the magazine state that reload refills, while leaving all balance to combat.
- Keep the wire change minimal and additive: one `you.action` snapshot field, zero new ClientMsg variants, one `PROTOCOL_VERSION` bump.
- Keep the channel **server-authoritative and game-time-deterministic**; the client only renders progress from snapshots and predicts nothing new.

**Non-goals**

- Redefining cooking, crafting, or fishing mechanics. This doc wraps doc 05's `use`/`craft` completion and references doc 07's fishing; it owns timing, not recipes or yields.
- Setting combat balance. Magazine sizes, reload durations, and the fire-rate/reload interplay are combat's; this doc only owns the magazine *shape* and the reload *channel*.
- A client-side cancel verb or predicted channel progress. Cancel is server-driven (§3); progress is render-only (§5).
- Per-item-instance durability or weapon condition. The magazine is a per-inventory-slot rounds counter, not a per-item-instance state model — `ItemStack` stays `{type, count}` (doc 05 Non-goals, same rule).
- A queued/buffered action input (press-during-cast → run after). Out of scope; a second `{t:"use"}` mid-cast is ignored (§3).

## Current state

All verified against source in this worktree.

- **`useItem` resolves synchronously, not on the tick.** The router calls `useItem(game, player, msg.slot)` inline on message receipt (`GameRoom.ts:499-501`); contrast `attack`, which only sets `player.wantsAttack = true` and defers resolution to the tick (`GameRoom.ts:488-498`, resolved at `GameRoom.ts:947-953`). Converting `use` to a channel means moving its *completion* onto the tick pipeline — a structural change `attack` already models but `use` does not.
- **The cook/eat split is an instant, near-invisible binary.** In `useItem`, `if (stack.type === "raw_venison")` (`players.ts:349`): `nearFire(...)` → cook (`consumeFromSlot` + `addToInventory("cooked_venison",1)` + a "venison cooked" notice, `players.ts:350-354`); else eat raw — `vitals.food += def.power`, `vitals.hp = Math.max(Math.min(vitals.hp,1), vitals.hp - RAW_VENISON_HP_PENALTY)`, consume, plus the stopgap notice (`players.ts:355-366`; notice block `players.ts:362-365`). Both sides resolve the instant `{t:"use"}` lands. This is the cook-channel adoption site.
- **`nearFire` is evaluated exactly once.** `nearFire(state, x, z)` tests `distSq2D <= FIRE_WARMTH_RADIUS²` over `state.fires` (`players.ts:313-319`); `FIRE_WARMTH_RADIUS` (= 5, `constants.ts:64`) is imported from `@worldspring/shared/constants` (`players.ts:8`). There is no notion of "leaving" anything mid-action anywhere in the sim — a per-tick predicate re-check is entirely net-new (see Drift, below).
- **The rest of `useItem` is an instant switch.** `switch (def.kind)`: `food`/`drink`/`heal` set vitals, `placeable` spawns a campfire into `state.fires`, default returns (weapons/ammo unusable) — `players.ts:371-398`. `consumeFromSlot` + `sendInventory` at `players.ts:399-400` are the apply-effect+consume points a channel defers to completion. `consumeFromSlot`/`addToInventory` live at `players.ts:279-309` and are reused by combat.
- **The per-player tick loop already counts game-time timers down.** Top of `applyQueuedInputs`: `if (player.attackCooldown > 0) player.attackCooldown -= dt;` and `attackAnimT -= dt` (`players.ts:227-228`), `dt = TICK_MS/1000`. This is the exact countdown pattern a channel's `remainingS` follows. Movement is applied *after*, setting `player.movedThisTick` (`players.ts:256`) and resetting it to `false` at the top of every tick (`players.ts:229`) — the interrupt-on-movement signal is computed in the same function, and ordering matters (see Drift).
- **Ranged fire has no magazine.** `fireRanged` finds ANY matching ammo stack in the inventory (`combat.ts:303-306`), gates only on `attackCooldown > 0` (set to `ranged.cooldownS`, `combat.ts:308`), then `consumeFromSlot` one round + `sendInventory` (`combat.ts:310-311`). Confirmed: no `magSize`, no current-rounds counter, no reload verb. `performAttack` entry at `combat.ts:169`; melee sets `attackCooldown = ATTACK_COOLDOWN_S` at `combat.ts:191`. Reload + magazine is net-new state.
- **`RangedConfig`/`ItemDef` are where `magSize`/`durationS` land.** `RangedConfig` = `range, cooldownS, pellets, spreadRad, ammo, sound` — no `magSize` (`packages/shared/src/items.ts:28-40`). `ItemDef` = `type, name, kind, stack, color, power, ranged?` (`items.ts:42-54`). `ItemKind` = `food|drink|heal|melee|ranged|ammo|placeable|tool` (`items.ts:17-25`); `RAW_VENISON_HP_PENALTY = 8` (`items.ts:100`).
- **`{t:"use"}`/`{t:"attack"}` already exist; no cancel/reload/craft verbs do.** `ClientMsg` union: `{t:"attack"; at?}` (`protocol.ts:80`), `{t:"use"; slot}` (`protocol.ts:81`). Per the cancel decision (§3), these existing verbs START a channel and NO new ClientMsg variant is needed.
- **`YouState` is the additive seam for progress.** `interface YouState extends Vitals { x, y, z, vy, grounded }` (`protocol.ts:198-204`) — carried in both `welcome.you` (`protocol.ts:235`) and `snap.you` (`protocol.ts:253`). It is built by `youState(player)` from `player.core` + `player.vitals` (`GameRoom.ts:1134-1148`), with `x/y/z` `round2`'d (`round2` at `GameRoom.ts:114`) and `vy`/vitals raw. Adding `action?` here is the in-progress field the HUD reads. Because `YouState` is sim/self-state the client consumes, doc 03's rule makes a shape change a `PROTOCOL_VERSION` bump (currently `1` — `protocol.ts:29`; bump rule in the doc block `protocol.ts:19-23` and `docs/plans/03-server-info-contract.md:111`).
- **`ServerPlayer` already holds transient combat timers.** `wantsAttack`, `wantsAttackAt`, `attackCooldown`, `attackAnimT`, `selectedSlot`, `movedThisTick` live on `ServerPlayer` (`apps/game/src/server/systems/state.ts:30-83`), constructed in `createPlayer` (`players.ts:108`), `restorePlayer` (`players.ts:155`), reset in `respawnPlayer` (`players.ts:185-208`). They are transient like `cmdQueue` — `CharacterState` persists only core/vitals/inventory/stats. A new `ActiveAction` field belongs here, in the same transient block, initialized at all three construction sites.
- **The tick orchestration is where a `tickActiveActions` slots in.** `tick()`: `dt = TICK_MS/1000` (`GameRoom.ts:913`) → `applyQueuedInputs` (`GameRoom.ts:944`) → resolve attacks (`GameRoom.ts:947-953`) → `tickZombies`/`tickSurvival`/… (`GameRoom.ts:955-965`) → `game.time += dt` (`GameRoom.ts:966`). `tickActiveActions(game, dt)` inserts right after `applyQueuedInputs` so it can read this tick's `movedThisTick`.
- **The client is render-only on `you`; prediction ignores `action`.** `onSnap` reconciles movement from `msg.you` (`apps/game/src/client/net/connection.ts:330`) then pushes `vitalsOf(msg.you)` into the store (`connection.ts:335`); `reconcile` reads ONLY the movement fields of `YouState` (`apps/game/src/client/net/prediction.ts:58-83`). A new `you.action` is invisible to prediction. The HUD `Bar` component (`HUD.tsx:45-56`) and `VitalsPanel` (`HUD.tsx:58-72`) are the ready-made progress-bar pattern; the `UIState` store carries `vitals` with a `setVitals` setter (`apps/game/src/client/state/store.ts:28-57`).

### Drift from the brief (resolved here)

- The brief says "leaving fire range cancels a cook" — but **there is no notion of leaving anything mid-action today**; `nearFire` is checked once (`players.ts:350`). The per-tick predicate re-check is net-new and the cook channel's defining feature.
- The brief assumes interrupt-on-movement can read a movement signal — it exists but is **not retained**: `movedThisTick` is reset to `false` every tick (`players.ts:229`) and recomputed (`players.ts:256`). `tickActiveActions` MUST run after `applyQueuedInputs` (it does — `GameRoom.ts:944` precedes the insert point) to read it within the same tick window.
- The brief treats `{t:"use"}` like `attack` (tick-deferred) — it is **not**; `use` resolves synchronously (`GameRoom.ts:499-501`). The channel conversion moves `use`'s completion onto the tick.
- The brief says reload "refills from the ammo item" implying a magazine — but **ammo is a plain `ItemStack {type,count}` with no weapon-bound rounds** (`combat.ts:303-310`). There is no current-rounds field to refill; the magazine is net-new state, keyed per inventory slot (weapons are `stack:1`, occupy one slot, are not individually identified).
- Interrupt-on-death + clear-on-respawn means the `ActiveAction` field must be reset in `respawnPlayer` (`players.ts:185-208`) and initialized in `createPlayer`/`restorePlayer` (`players.ts:108`, `players.ts:155`) — three sites, mirroring the `attackCooldown` init. Easy to miss one.
- `YouState` is sent every snap at full tick rate with `x/y/z` `round2`'d but `vy`/vitals raw (`GameRoom.ts:1134-1148`). A raw-float `remainingS` is a minor per-snap byte cost; §4 rounds it, partly for byte cost and partly because this project is determinism-fingerprint-sensitive and gratuitous raw floats on the wire are a smell even when render-only.

## Design

### 1. The channeled-action primitive

**This section owns the primitive.** Everything below — the `ActiveAction` type, the `channel`/`act` vocabulary, `tickActiveActions`, the interrupt rules, the `*_CHANNEL_S` constants — is doc 11's canonical definition; docs 05 / combat / 07 delegate their *completion* to it but keep their own data (recipes, ammo accounting, fish tables).

A channeled action is a transient field on `ServerPlayer` plus a tick function that advances it in game-time and resolves it. No new system file is strictly required — it can live in `players.ts` next to `useItem`, or in a small `systems/channel.ts` if it grows (decided per the milestone). The shape:

```ts
// packages/shared/src/protocol.ts (shared so YouState can reference the kind)
export type ChannelKind = "cook" | "use" | "reload" | "craft" | "fish";

// apps/game/src/server/systems/state.ts — transient, NOT persisted, sits in the
// same block as wantsAttack/attackCooldown (state.ts:30-83).
export interface ActiveAction {
  kind: ChannelKind;
  /** Inventory slot the cast is bound to. Reload binds to the weapon slot;
   * use/cook bind to the consumable slot; craft uses -1 (no source slot). */
  slot: number;
  /** Opaque per-kind payload resolved at completion (e.g. craft recipe index).
   * The primitive does not interpret it — the completion fn does. */
  arg: number;
  totalS: number;
  remainingS: number;
}

// ServerPlayer gains, alongside wantsAttack (state.ts):
//   action: ActiveAction | null;   // null = not channeling
```

Lifecycle, all server-authoritative:

1. **Start.** The dispatch path that used to resolve instantly instead calls `startChannel(player, kind, slot, arg, durationS)`. It early-returns (no-op) if `player.action !== null` (one cast at a time — a second `{t:"use"}` mid-cast is ignored, §3), if `!player.alive`, or if the start precondition fails (e.g. cook requires `raw_venison` in `slot` and `nearFire`; reload requires a ranged weapon equipped with a non-full magazine and ammo in inventory). On success it sets `player.action = { kind, slot, arg, totalS: durationS, remainingS: durationS }`. **No effect is applied and nothing is consumed at start.**
2. **Tick.** `tickActiveActions(state, dt)` iterates players with a non-null `action`, runs the §3 interrupt checks first (cancel → `player.action = null`, return, no effect), then `action.remainingS -= dt`. When `remainingS <= 0` it calls the kind's completion fn and clears `player.action`.
3. **Complete.** The completion fn is the EXISTING instant path, unchanged in behavior: `cook`/`use` re-enter the relevant branch of `useItem` (cook → `consumeFromSlot` + `addToInventory("cooked_venison",1)`; food/drink/heal → apply + consume; `players.ts:350-399`); `reload` runs combat's refill (§2); `craft` calls doc 05's `craftItem`; `fish` runs doc 07's cast roll. Completion re-validates its precondition (the slot may have changed contents during a long cast even without an interrupt — defensive, early-return on mismatch).
4. **Cancel.** On any §3 trigger the action is dropped with no effect, no consumption, no notice beyond the snapshot's `you.action` going absent (the bar disappears). Cook is the exception that earns a one-shot notice — "moved away from the fire" — because invisible cancellation is exactly the pain we are fixing.

`tickActiveActions` slots into `tick()` immediately after `applyQueuedInputs` (`GameRoom.ts:944`) and before the attack resolution, so it reads this tick's freshly-computed `movedThisTick` (`players.ts:256`). It runs in game-time (`dt = TICK_MS/1000`), is fully server-authoritative, and is deterministic on the server. It is **not** a worldgen/rng-stream concern: it draws no rng, never touches `world.ts`/`movement.ts`, and the client predicts none of it — so it sits entirely outside the determinism fingerprint the project gates on. The only rng any consumer draws (doc 07's fish-table roll) lives in that consumer's completion fn and is its own owner's determinism call (doc 07 already notes its cast roll is `Math.random`, server-only).

### 2. What becomes channeled

| Action | Today's instant call site | `durationS` (proposed) | Cancel triggers | Completion fn |
| --- | --- | --- | --- | --- |
| **Cook venison** | `useItem` cook branch, `players.ts:350-354` | `COOK_CHANNEL_S` (≈3) | move / damage / slot-swap / chat / death / **leaves fire range** | cook branch (`consumeFromSlot` + `addToInventory("cooked_venison",1)`) |
| **Eat / drink / heal** | `useItem` switch, `players.ts:371-380` | `USE_CHANNEL_S` (≈1.2; bandage longer) | move / damage / slot-swap / chat / death | the matching `case` (apply vitals + `consumeFromSlot`) |
| **Eat raw (venison, no fire)** | `useItem` else-branch, `players.ts:355-366` | `USE_CHANNEL_S` | move / damage / slot-swap / chat / death | eat-raw branch (food + hp penalty + consume) |
| **Reload** | *(none — net-new)* off `attack`/equip | combat-owned (≈`RELOAD_CHANNEL_S`) | move? *(open Q)* / damage / slot-swap / chat / death | combat refill (§2) |
| **Craft** | doc 05 `craftItem` (doc 05 §2, `{t:"craft"}`) | doc-05-owned per recipe | move / damage / slot-swap / chat / death | doc 05's `craftItem` (unchanged) |
| **Deer harvest** | doc 05 M5 `{t:"gather", k:"corpse"}` | doc-05-owned (≈2) | move / damage / slot-swap / chat / death | doc 05's harvest handler |
| **Tree gather** | doc 05 M5 `{t:"gather", k:"tree"}` | doc-05-owned (≈1.5) | move / damage / slot-swap / chat / death | doc 05's gather handler |
| **Fishing cast** | doc 07 M12 (`fishingUntil`, `07-world-and-wildlife.md:505-517`) | doc-07-owned (4–10 already) | move (already) / damage / slot-swap / chat / death | doc 07's cast roll |

The deer-harvest / tree-gather / craft / fishing rows point at the *owning doc*, not a today's-code `file:line`, because those completion paths are themselves doc-05/07 design surface (not yet in the tree) — only the cook/eat/drink rows cite live call sites. The proposed durations in the cook/use/reload rows are *placeholders* that live in `packages/shared/src/constants.ts` (house rule — no system-local tunables; the `FIRE_WARMTH_RADIUS`/`ATTACK_COOLDOWN_S` precedent at `constants.ts:64`/`constants.ts:99`), named `COOK_CHANNEL_S`, `USE_CHANNEL_S`, etc. Per-action numbers that belong to another owner — craft times (doc 05), reload time + mag sizes (combat), fishing cast window (doc 07) — live in *their* data tables (`RECIPES`, `RangedConfig`, doc 07's fishing config), not here. This doc owns only the `*_CHANNEL_S` constants for the actions it itself adopts (cook + use), and the `ActiveAction` substrate the rest cast on.

**Reload + magazine model (combat consumer).** Reload is the combat instance of the primitive, and it forces a magazine. Today one ammo item == one trigger pull (`combat.ts:303-310`); there is no rounds-in-the-gun state. This doc scopes:

- `RangedConfig` gains `magSize: number` (`items.ts:28-40`) — combat owns the values.
- A per-inventory-slot current-rounds counter. Because weapons are `stack:1` and occupy exactly one slot and are not individually identified, the natural home is a `Map<number, number>` (slot → rounds) on `ServerPlayer` in `state.ts`, transient like `attackCooldown`, OR a parallel `mag?: number` on the weapon's `ItemStack` (a deliberate, scoped exception to "`ItemStack` stays `{type,count}`" — **defer this representation choice to combat**, Open Q5).
- `fireRanged` (`combat.ts:293-311`) gates on rounds-remaining instead of "any ammo in inventory"; an empty magazine fires nothing (and may surface a click). Reload is a `{kind:"reload"}` channel whose completion moves `min(magSize - current, ammoInInventory)` rounds from the ammo `ItemStack` into the magazine counter via `consumeFromSlot`-style accounting.
- **All balance — mag sizes, reload `durationS`, whether an empty mag auto-reloads — is combat's.** This doc owns the channel that drives reload and the *existence* of the magazine counter; combat owns every number and the fire-side accounting.

### 3. Cancellation & interruption rules

Server-authoritative, evaluated at the top of `tickActiveActions` before the countdown, with strict early-return discipline (first matching trigger cancels and returns; no effect runs):

- **Move.** `player.movedThisTick` is `true` this tick (`players.ts:256`). This is the default for cook/use/craft/harvest/gather. Whether *reload* cancels on move or merely the bar pauses is an open question (Open Q4) — recommendation below is **cancel** for consistency, but combat may override.
- **Take damage.** Set on the player by any damage application this tick. The cleanest signal is the existing per-victim `{e:"hurt"}` event the combat/zombie/survival paths already emit to the victim (`protocol.ts:221`); the channel reads a `tookDamageThisTick` flag set wherever hp is reduced (a one-line set alongside the existing hurt-event emit). Cancels every kind.
- **Swap selected slot.** `player.selectedSlot` changed since the cast started — equipping a different hotbar slot mid-cast. The cast is bound to `action.slot`; if `selectedSlot !== action.slot` (for slot-bound kinds) the cast cancels. `equipSlot` (`players.ts:404-409`) is the mutation point; the check lives in `tickActiveActions`, not in `equipSlot`, to keep one cancellation owner.
- **Chat open.** Opening the chat input is a client-side state, but the server sees its proxy: the client stops sending movement/input and the player goes idle. A dedicated signal is overkill — chat-open already gates client input emission (the `InputController` returns early when chat is focused, doc 05 §6 precedent for `KeyF` at `InputController.tsx:96-103`). If a hard guarantee is wanted, a `{t:"chat"}` send could carry a "chatting" hint, but that is a wire change this doc declines; **recommendation: rely on input-cessation + the move rule.**
- **Leave fire range (cook only).** Re-run `nearFire(state, player.core.x, player.core.z)` (`players.ts:313-319`) every tick the cook is active; `false` cancels with the "moved away from the fire" notice. This is the net-new per-tick predicate (Drift) and the whole point of the cook example.
- **Death.** `!player.alive` cancels and clears; also belt-and-braces cleared in `respawnPlayer` (`players.ts:185-208`).

**Cancel is purely server-driven — no client cancel verb.** The brief's recommendation, adopted: the actions that *start* a channel (`{t:"use"}`, the reload trigger, `{t:"craft"}`, the gather/fishing verbs) are the entire client surface. To cancel, the player moves, swaps, or takes a hit — all already-modeled inputs. This keeps `ClientMsg` untouched except for whatever verb the consuming doc already owns, and keeps the cancellation logic in exactly one place (`tickActiveActions`). A future explicit cancel (e.g. right-click) is purely additive if it's ever wanted (Open Q4).

### 4. Protocol additions (complete list)

```ts
// ClientMsg additions: NONE.
// Cancel is server-driven (§3); the existing {t:"use"} (protocol.ts:81) and
// {t:"attack"} (protocol.ts:80), plus doc 05's {t:"craft"}/{t:"gather"} and
// doc 07's fishing verb, START a channel. No {t:"cancel"} / {t:"reload"} verb is
// added by this doc — reload is triggered off the equip/attack path the combat
// owner wires (Open Q4), not a new top-level verb.

// ServerMsg change — additive, on YouState (protocol.ts:198-204), carried in
// both welcome.you (protocol.ts:235) and every snap.you (protocol.ts:253):
//   action?: {
//     kind: ChannelKind;   // "cook" | "use" | "reload" | "craft" | "fish"
//     remainingS: number;  // round2'd — see below
//     totalS: number;      // round2'd; bar fill = 1 - remainingS/totalS
//   }
// Absent ⇒ not channeling ⇒ HUD hides the bar.

// inv message: optionally gains the magazine readout for the equipped weapon
// (combat-owned shape — e.g. `mag?: number`), so the HUD can show rounds. Defer
// the exact field to combat; it is additive either way.
```

`remainingS`/`totalS` are `round2`'d in `youState` (`GameRoom.ts:1134-1148`, `round2` helper at `GameRoom.ts:114`), matching the `x/y/z` treatment there — render-only precision is plenty for a bar, and it avoids gratuitous raw floats on a snapshot the project fingerprints elsewhere (Drift). `ChannelKind` is exported from `protocol.ts` so both `YouState` and `state.ts`'s `ActiveAction` reference one definition.

**Versioning.** Doc 03 owns `PROTOCOL_VERSION` and its bump rule: bump on "ANY breaking change to ClientMsg/ServerMsg shapes or semantics, to the `movement.ts`/`world.ts` behavior the client predicts, or to the `ItemType` wire enums" (`protocol.ts:19-23`; `docs/plans/03-server-info-contract.md:111`). Adding `action?` to `YouState` is a `ServerMsg` *shape* change, and — more pointedly — turning `use` from instant-resolve into a cast is a message *semantics* change (an old client sends `{t:"use"}` expecting an instant inventory delta and instead gets a multi-tick cast). Both clauses fire. So this doc **bumps `PROTOCOL_VERSION` 1→2** in the milestone that lands the wire field (M2 below), and hard-depends on doc 03's two-sided `proto` gate having landed first — exactly doc 05's "land doc 03's `PROTOCOL_VERSION` milestone first" framing. At v2+ an absent `join.proto` is rejected (currently accepted while `=== 1`, `protocol.ts:21-23`), so stale tabs straddling the deploy are refused cleanly rather than mis-rendering a cast. The field is additive on the wire (old clients destructure named `YouState` fields and ignore it, exactly like `welcome.config` at `protocol.ts:242-246`) — but additive-and-version-bumped are not in tension here: the *field* is additive, the *`use` semantics* are breaking, and it is the latter that forces the bump.

### 5. Client: input → progress ring → completion

The client does three things and predicts none of them:

- **Input (unchanged senders).** The button/keys that already send `{t:"use"}` — `doUse` (defined at `connection.ts:137`, imported into the HUD at `HUD.tsx:16`, wired to the Tab USE button at `HUD.tsx:239`), and doc 05 M1's `F` keybind — now *start* a channel server-side. No new sender. The reload trigger is whatever combat wires (Open Q4) — likely an edge-triggered `R` in `InputController.tsx` calling the same path combat chooses; that key, if it exists, is combat's to add. Edge-trigger discipline (the `e.repeat` filter doc 05 §6 cites at `InputController.tsx:96-103`) applies so holding the key doesn't spam channel-starts (which the server ignores anyway, since `action !== null` no-ops).
- **Progress (render-only).** `onSnap` (`connection.ts:317-342`) gains `ui.setAction(msg.you.action)` right next to the existing `ui.setVitals(vitalsOf(msg.you))` at `connection.ts:335`. `reconcile` (`prediction.ts:58-83`) is untouched — it reads only movement fields, so `you.action` is invisible to prediction. The `UIState` store (`store.ts:28-57`) gains a `channelAction: YouState["action"]` field + `setAction` setter, mirroring `vitals`/`setVitals`.
- **Completion.** There is nothing for the client to do on completion beyond the server's existing `inv` push (`sendInventory`) and the snapshot's `you.action` going absent. The cook's "venison cooked" notice (`players.ts:354`) already provides positive feedback; the eat-raw notice already explains the penalty. The bar simply fills and vanishes.

**The server is the authority.** Movement prediction is fully separate (`prediction.ts` reconciles position only); the channel is pure server-driven render. If the snapshot says you are 60% through a cook, you are — the client never advances the bar locally between snapshots beyond, at most, a cosmetic interpolation of `remainingS` against wall-clock (optional polish, not a prediction).

### 6. UI outline (the cast bar)

A center-screen cast bar mounts in the HUD root (`HUD.tsx:304-320`) alongside the crosshair, reading `channelAction` from the store via `useUIStore` (the `VitalsPanel` subscription pattern, `HUD.tsx:58-72`). It reuses the existing `Bar` primitive (`HUD.tsx:45-56`, `value`/`max`/`fillClass`) — `value = totalS - remainingS`, `max = totalS` — and renders only when `channelAction` is non-null.

```
                         (crosshair)

                  ┌─────────────────────────┐
                  │ Cooking…  ████████░░░░   │   ← <ChannelBar/>, center-low,
                  └─────────────────────────┘      label keyed off action.kind:
                                                    cook→"Cooking…"  reload→"Reloading…"
                                                    use→"Eating…"/"Drinking…"/"Bandaging…"
                                                    craft→"Crafting…"  fish→"Casting…"

  HP   ███████░░                                 ← existing VitalsPanel (HUD.tsx:58-72),
  FOOD █████░░░░                                    untouched
  WATER ████░░░░     [1][2][3]…[8] hotbar
```

The bar disappears the instant a snapshot arrives with `you.action` absent — which, on a cook cancel, is the visible "you stepped out of range" feedback the stopgap notice can only describe. Optional: a thin radial ring around the crosshair instead of a flat bar (same data, cosmetic).

## Implications

**Opens up**

- A single substrate every future timed action reuses: doc 05's craft/harvest/gather get interrupt rules and a progress bar for free by adopting `ActiveAction`; doc 07's fishing cast becomes the first real consumer (it already has a `fishingUntil` timer and a cancel-on-move intent — see Migration). New "channel something" features are a duration constant + a completion fn, not a new timing engine.
- Reload — and with it the magazine model — finally exists, which unblocks combat depth (per-weapon mag sizes, reload-cancel tension) without this doc owning the balance.
- The `you.action` field is a generic per-player "what am I doing" channel the HUD can grow (interrupt flashes, queued-action hints) additively.
- Doc 04's reserved per-server multiplier hook: a `ServerConfig` `channelDurationMult` could scale all `*_CHANNEL_S` at point-of-use with a one-line change, the same multiply-at-point-of-use shape as doc 04's other multipliers (`04-gameplay-presets.md:15`) — reserved, not built.

**Complicates**

- `useItem` stops being a synchronous apply-and-return: its branches split into a *start* (validate + open the channel) and a *complete* (the existing apply+consume body, called from `tickActiveActions`). The function grows a second entry point; if it crosses ~120 lines it splits, the same `useConsumable`/`useTool` threshold doc 05 already flags.
- A net-new per-tick sweep (`tickActiveActions`) and a net-new per-tick predicate (cook's `nearFire` re-check). Both are O(channeling players) — tiny — but they are the first per-tick predicate-tracking in the sim, so the loadtest tick-EMA gate applies (Accept below).
- Tick ordering becomes load-bearing: `tickActiveActions` MUST run after `applyQueuedInputs` (to read `movedThisTick`) and before attack resolution. A future reorder that moves it ahead of `applyQueuedInputs` silently breaks move-cancel — call it out in the code comment.
- The magazine model touches combat's `fireRanged` ammo accounting (`combat.ts:303-310`) and adds per-slot rounds state that must survive equip/drop/death sensibly (an emptied-and-dropped gun, a magazine on a weapon picked up by another player). Scoped here, owned-and-balanced by combat — a coordination seam, not a clean boundary.

**Breaks**

- `{t:"use"}` semantics change: instant → cast. An old client sending `use` and expecting an instant `inv` delta now gets a multi-tick cast. This is precisely why it's a `PROTOCOL_VERSION` bump (§4) — the two-sided gate refuses mismatched clients before any state is touched, so no old client ever sees the new behavior. Once doc 03's gate has landed (hard dependency), this is safe.
- Nothing in persisted state: `ActiveAction` and the magazine counter are transient (not in `CharacterState`), so a DO restart mid-cast simply drops the cast — the player re-presses. No `SCHEMA_VERSION` concern.
- The stopgap eat-raw notice (`players.ts:362-365`) is superseded: once cook is a channel, eating raw is the *result of never being in range to start a cook*, and the cook-cancel notice replaces the instant one. Remove/rework the stopgap in the same milestone that lands cook-as-channel, or the two notices fight.

**Threatens**

- A too-long cook/use duration makes the game feel sticky in exactly the moments (combat, a zombie closing) where you most want to heal — and a heal that cancels on damage is a real tension knob that can tip into frustrating. The durations are `constants.ts` tunables precisely so this is a playtest dial (Open Q1).
- Move-cancel on *reload* could make ranged combat feel awful (you can never reload while repositioning). This is why reload-cancel-on-move is deferred to combat (Open Q4) rather than inherited from the default.
- `you.action` rides every snap at full tick rate; two extra `round2`'d floats + a small string-or-enum per channeling player is negligible, but if a future "everyone is always channeling something" design emerges it would want a delta/interest filter like the snapshot's other arrays. Not a concern at current scope.

## Migration & compatibility

- **No `SCHEMA_VERSION` bump.** `ActiveAction` and the magazine rounds counter are transient `ServerPlayer` fields (the `attackCooldown`/`cmdQueue` class), never written to `CharacterState`. Existing characters, inventories, and the leaderboard carry through untouched; a save/restore across this work is a no-op for the channel state.
- **Wire change is additive but semantically breaking → `PROTOCOL_VERSION` 1→2.** The `you.action` field is additive (old clients destructure named `YouState` fields and ignore it), but the *meaning* of `{t:"use"}` changes from instant to cast, which doc 03's rule treats as a breaking semantics change. So this is a genuine bump, not a "field-only, no bump" case like `welcome.config` (`protocol.ts:242-246`). The bump lands in M2 (§4), in the same PR as the field and the cook/use conversion.
- **Rollback.** Rolling the worker back removes `tickActiveActions` and the `you.action` field; persisted state is unaffected (nothing channel-related was ever written). A client on the new `PROTOCOL_VERSION` is refused by an old server's gate (and vice-versa) — clean, by design. The only forward-only hazard is the magazine model if combat chose the `ItemStack.mag` representation and it reached persistence: scope that decision (Open Q5) to keep the rounds counter transient unless combat explicitly opts into persisting it, in which case combat owns the rollback note.
- **Doc-03 ordering.** This doc hard-depends on doc 03's two-sided `proto` gate having landed first (mirroring doc 05's same dependency): the bump is only safe once both sides gate on `proto`, otherwise a v2 server silently mis-serves a v1 tab a cast it can't render. The dependency-graph edge to add to the README: `D03 -.->|proto gate, channel-msg bump| D11`, plus the soft edges `D05 -.->|wraps use/craft completion| D11` and `D11 -.->|cast substrate for M12| D07`.
- **Canonical-vocabulary deferral.** Per the README ownership rule (`docs/plans/README.md:47-60`, settled-ownership rule at `README:351`): this doc OWNS the channeled-action primitive (`ActiveAction`, the server-driven cancel rule set, `tickActiveActions`, the `you.action` field, the `*_CHANNEL_S` constants) and adds the row `ActiveAction`/`act` field / channeled-action primitive | doc 11 | docs 05/combat/07 delegate completion to it, keep their own data. It BORROWS, owner's definition binding: **doc 05** owns item use + crafting (`use`/`craft`, `useItem`/`craftItem`, `cooksTo`, `RECIPES`, `05-items-scavenging-crafting.md:29-32`) — this doc wraps doc 05's instant completion behind a duration and does NOT redefine cooking/crafting; **combat** owns reload + ammo + balance — this doc owns only the interruptible-cast wrapper and the magazine *shape*; **doc 07** owns fishing (`07-world-and-wildlife.md:505-517`) — its M12 timed cast SHOULD build on `ActiveAction` rather than a bespoke `fishingUntil` field (coordination point: doc 07 owns the fishing mechanic + items, doc 11 owns the channel substrate it casts on), and doc 05 §4.3's interim instant-roll fishing is unaffected until doc 07 M12.

## Implementation plan

Order: M1 → M2 → M3 → (M4) → M5. M4 (fishing-cast adoption) is owned by doc 07's M12 and listed here only as the coordination point; it ships under doc 07, not this doc. Each milestone ends with `npm run typecheck` clean and a manual two-client smoke test via `npm run dev` (`apps/game/scripts/loadtest.mjs` for tick-EMA regression after M1, which adds the only new per-tick sweep).

1. **M1 — The primitive, server-only, no wire** *(Opus 4.8 — tick-ordering + interrupt-rule correctness)*.
   Files: `apps/game/src/server/systems/state.ts` (`ActiveAction` type, `action: ActiveAction | null` on `ServerPlayer`), `apps/game/src/server/systems/players.ts` (`startChannel`/`tickActiveActions`; init `action = null` in `createPlayer` `players.ts:108`, `restorePlayer` `players.ts:155`, clear in `respawnPlayer` `players.ts:185-208`; split the cook branch into start+complete), `apps/game/src/server/GameRoom.ts` (call `tickActiveActions(game, dt)` right after `applyQueuedInputs` at `GameRoom.ts:944`; route `use` to `startChannel` instead of inline `useItem` at `GameRoom.ts:499-501`), `packages/shared/src/constants.ts` (`COOK_CHANNEL_S`, `USE_CHANNEL_S`), the `tookDamageThisTick` flag set alongside the existing `{e:"hurt"}` emit (`protocol.ts:221`).
   Depends: none (pure server). Scope: cook + all `useItem` consumables become channels; interrupt on move/damage/slot-swap/death + cook's `nearFire` re-check; **no wire field yet** — verify entirely server-side (logging) so the protocol bump is isolated to M2. Remove/rework the stopgap eat-raw notice's instant path as cook becomes a cast.
   Accept: starting a cook within fire range completes in `COOK_CHANNEL_S` and yields cooked venison; walking out mid-cook cancels with the "moved away from the fire" notice and consumes nothing; taking a zombie hit mid-heal cancels with no hp restored and no item consumed; swapping the selected slot mid-cast cancels; a second `{t:"use"}` mid-cast is ignored; loadtest tick EMA within budget; typecheck clean.
2. **M2 — Wire the progress bar + `PROTOCOL_VERSION` bump** *(Opus 4.8 — protocol + version gate)*.
   Files: `packages/shared/src/protocol.ts` (`ChannelKind` export, `action?` on `YouState` per §4 at `protocol.ts:198-204`, `PROTOCOL_VERSION` 1→2 with the bump rationale comment at `protocol.ts:29`), `apps/game/src/server/GameRoom.ts` (`youState` populates `action` with `round2`'d `remainingS`/`totalS`, `GameRoom.ts:1134-1148`), `apps/game/src/client/net/connection.ts` (`ui.setAction(msg.you.action)` next to `setVitals` at `connection.ts:335`), `apps/game/src/client/state/store.ts` (`channelAction` + `setAction`, `store.ts:28-57`), `apps/game/src/client/ui/HUD.tsx` (`<ChannelBar/>` mounted at `HUD.tsx:304-320`, reusing `Bar` `HUD.tsx:45-56`), `ARCHITECTURE.md` (amend the protocol contract lines to add the `you.action` field + `ChannelKind`, and the NET/InputController contract lines — `snap.you` reconciliation at `ARCHITECTURE.md:64`, `parseClientMsg` at `ARCHITECTURE.md:155` — noting `use` now starts a server-driven cast. The amendment ships in the SAME PR as the code, or the next session will "fix" the work back to the stale contract — README:341-343, the doc 05 M4 precedent).
   Depends: M1, and doc 03's two-sided `proto` gate (hard — bump is unsafe before the gate, see Migration). Scope: render the cast bar; bump the version; no new ClientMsg.
   Accept: the cast bar fills and empties for cook/eat/drink/heal and matches the server's `remainingS`; an old client (pre-bump) is refused at join with the version-mismatch error rather than mis-rendering; bar disappears the instant a cancel snapshot arrives; reconcile/prediction unaffected (movement smoke test clean); typecheck clean.
3. **M3 — Reload + magazine model (combat consumer)** *(Opus 4.8 — combat ammo-accounting + magazine state; balance deferred)*.
   Files: `packages/shared/src/items.ts` (`magSize` on `RangedConfig` `items.ts:28-40`), `apps/game/src/server/systems/state.ts` (per-slot rounds counter, representation per Open Q5), `apps/game/src/server/systems/combat.ts` (`fireRanged` gates on rounds, `combat.ts:293-311`; reload completion refills from ammo), `apps/game/src/server/systems/players.ts` (`startChannel` reload precondition), the reload trigger key in `apps/game/src/client/render/entities/InputController.tsx` (edge-triggered, doc 05 §6 pattern at `InputController.tsx:96-103`) + its `connection.ts` sender, optionally `inv.mag?` for the HUD rounds readout, `constants.ts`/`RangedConfig` for `RELOAD_CHANNEL_S`/mag sizes (combat-owned values).
   Depends: M1, M2. **Combat-balance gate:** mag sizes, reload duration, and whether reload cancels on move (Open Q4) are the combat owner's call and ship under combat's review, not this doc's — M3 lands the *mechanism* with placeholder numbers flagged for combat to tune.
   Accept: an equipped weapon holds ≤ `magSize` rounds; firing decrements rounds, not raw inventory ammo; an empty magazine fires nothing; reload is a cast that refills from inventory ammo and is interruptible per §3; HUD shows rounds-in-mag; typecheck clean.
4. **M4 — Fishing-cast adoption** *(owned by doc 07 M12 — listed for coordination only)*.
   Files: doc 07's fishing system. Scope: doc 07 M12 builds its timed cast on `ActiveAction` (`{kind:"fish"}`) instead of a bespoke `fishingUntil` field, inheriting the §3 interrupt rules and the cast bar for free. Depends: M2; doc 07 M12. This doc supplies the substrate; doc 07 owns the fishing mechanic + items.
   Accept: (under doc 07) fishing cast renders the standard cast bar, cancels on move per the existing intent, completes into doc 07's roll.
5. **M5 — Polish + tuning pass** *(Sonnet 4.8 — follows M2's HUD pattern)*.
   Files: `HUD.tsx` (optional radial-ring variant, per-kind labels), `constants.ts` (duration tuning from playtest), optional wall-clock interpolation of `remainingS` between snapshots in the store. Depends: M2, M3.
   Accept: durations feel right in a play session (heal-under-fire is tense not frustrating, cook is quick); cast labels read correctly per kind; no regression in the M1/M2/M3 accept criteria.

## Open questions

1. **Which actions channel, and how long?** Cook + the consumables are the obvious wins; bandage-style heals arguably want a *longer* cast than instant food. Reload/craft/harvest/fishing inherit the primitive but their durations belong to their owners. **Recommendation:** channel cook (≈3s) + all consumables (≈1.2s, bandage longer) in M1; let combat/doc 05/doc 07 set their own durations as they adopt; tune all in M5 from playtest.
2. **Cook example: does the channel REQUIRE the player to start in range, or can it start anywhere and only progress in range?** Starting-in-range is simpler and matches intent (you walk to the fire, hold to cook). **Recommendation:** require `nearFire` to *start* (precondition) AND to *progress* (per-tick cancel) — starting out of range is an immediate ignore with the same "stand within Nm of a fire" notice the stopgap already writes (`players.ts:362-365`), so the feedback is identical whether you never started or stepped out.
3. **One cast at a time, or a queue?** A buffered "press during cast → run next" is a known QoL pattern but adds state and edge cases. **Recommendation:** one cast at a time; a second start while `action !== null` is a silent no-op (§1). Revisit only if playtest shows people fighting the input.
4. **Does movement CANCEL a cast, or just PAUSE/BLOCK it — especially reload?** Cancel is simplest and most legible for cook/use. For *reload*, cancel-on-move could make ranged combat miserable (you can never reload while repositioning). **Recommendation:** cancel-on-move as the primitive's default (cook/use/craft); **defer reload's move behavior to combat** — combat may choose "reload continues while moving, cancels only on damage." The primitive supports both: the move check is per-kind, not global.
5. **Magazine representation: per-slot `Map<number, number>` on `ServerPlayer`, or `mag?` on the weapon's `ItemStack`?** The Map keeps `ItemStack` pure `{type,count}` (doc 05's invariant) but loses the rounds when the gun moves slots or is dropped/picked-up; `ItemStack.mag` travels with the gun but is a scoped exception to the pure-stack rule and, if persisted, becomes a forward-only `SCHEMA_VERSION` hazard. **Recommendation:** **defer to the combat owner**, with a lean toward `ItemStack.mag` kept *transient* (re-derived to full or empty on pickup) so a dropped-and-recovered gun behaves predictably without touching persistence — but combat owns the call and the rollback note if it persists.
6. **Doc-03 ordering.** M2 wants the `PROTOCOL_VERSION` bump, which is only safe once doc 03's two-sided `proto` gate has landed. **Recommendation:** hard-sequence M2 after doc 03's gate milestone — exactly doc 05's framing; until then, M1 (server-only, no wire) is fully shippable and delivers the cook fix's logic, just without the HUD bar.

