---
name: testbed
description: Author a Worldspring preview-QA testbed scenario (apps/game/scenarios/<name>.json) and its human smoke-test checklist from a diff, PR, or change description. Use when preparing QA for a gameplay change so the in-game QA panel, the headless agent harness, and the manual checklist all read ONE schema-validated artifact and can never drift.
---

# /testbed — author a QA scenario + checklist from a change

A Worldspring preview deploy (`worldspring-pr-<N>.…workers.dev`) runs with `TESTBED=1`. On join, the server provisions the player from a **Scenario** (kitted loadout, vitals, a position, an optional lit fire) so a change can be exercised immediately, and the in-game **QA panel** lets a human RESET / switch sets. This skill turns a code change into the matching `Scenario` artifact.

**The artifact is one source of truth.** `Scenario.checklist[]` is rendered verbatim by the QA panel AND emitted by this skill as the "Manual smoke tests needed" markdown AND (later) asserted by the M6 agent harness — author it once, here, so the three never drift.

The schema lives in `packages/shared/src/scenario.ts` (`parseScenario`, total + never-throws). Examples: `apps/game/scenarios/survival.json`, `combat.json`.

## Inputs

Take whatever describes the change-under-test: a PR number (`gh pr diff <N>`), a branch/diff (`git diff origin/main...HEAD`), a list of files, or a prose description. If none is given, default to the current branch's diff vs `origin/main`.

## Procedure

1. **Scope the change.** Get the diff and list the changed server systems (`apps/game/src/server/systems/*`), shared data (`packages/shared/src/{items,constants,protocol}.ts`), and any new wire fields. Identify the player-visible behaviors it adds or changes — those are what the checklist exercises.

2. **Lift the ground truth from the code — do not invent it.**
   - **Item ids:** use the REAL `ItemType` strings from `packages/shared/src/items.ts` (`ITEM_DEFS`). Never guess an id.
   - **Verbatim strings:** grep the changed code for `{ t: "notice", msg: … }` and `{ t: "error", msg: … }` and copy the exact text (e.g. `"needs a campfire"`, `"Stand within 5m of a fire to cook it"`). Template literals: resolve the constant (e.g. `FIRE_WARMTH_RADIUS` = 5) so the checklist reads literally.
   - **Expected deltas:** read the numbers from the code (`def.power`, a `rawPenaltyHp`, a recipe's inputs/outputs, a `*_CHANNEL_S` duration) so "food up a little, hp drops 8" is what the code actually does.

3. **Choose provisioning** — an ORDERED `provision[]` walked in sequence. Use only the LIVE kinds (the reserved ones parse but no-op):

   | kind | shape | use |
   | --- | --- | --- |
   | `position` | `{ zone: "coastal"\|"inland"\|"military", face: "ocean"\|"inland" }` | where + which way the player spawns. `coastal`+`ocean` = the standard coast station (inland/military default to coastal until their geometry is wired). Put this FIRST. |
   | `fire` | `{ atFeet: true }` | a lit campfire at the player's feet — needed for any cook/boil/campfire-station test. |
   | `loadout` | `{ items: [{ type, count }, …] }` | the items the change exercises. The hotbar is 8 slots — keep ≤ 8 meaningful stacks; extras spill to the floor. |
   | `vitals` | `{ hp?, food?, water?, temp? }` | set so the change is observable: low `hp` (e.g. 50) to test a heal, low `water` to test drinking, `temp` 37 = normal. Clamped 0–100 (temp 20–60). |
   | `clearCooldowns` | `{ which: ["attack"\|"respawn"\|"item"\|"fish"] }` | zero cooldowns so the action lands on the first try. |

   Reserved-but-inert (safe to omit; don't rely on them to actually spawn anything yet): `spawnZombie`, `spawnAnimal`, `setTime`, `setWeather`, `config`.

4. **Write `checklist[]`** — the human + agent source of truth. One line per observable behavior, each stating the ACTION and the EXPECTED outcome with the verbatim strings + real deltas from step 2. First line should orient ("Spawn at the coast facing the ocean with a lit fire at your feet"). Cover the happy path AND the guarded/failure paths the change introduces (out-of-range, missing input, wrong tool, mid-cast cancel) — those are where bugs hide.

5. **(Optional) `steps[]` + `assert[]`** for the future M6 headless harness. They're carried in the schema now (not executed yet), so add them when the assertions are crisp: an `Assert` is `{on:"inv",type,atLeast}` / `{on:"vitals",field,cmp:"lte"|"gte",value}` / `{on:"notice",contains}` / `{on:"error",contains}` / `{on:"snap",path,equals}`. Lift `contains` strings verbatim. If unsure, ship just `checklist[]` — it's the only required behavior surface.

6. **Write and validate.** Save to `apps/game/scenarios/<name>.json` (lowercase id-ish name, kebab-case, matching `Scenario.name`). Then run:

   ```
   node --experimental-strip-types apps/game/scripts/validate-scenario.mjs apps/game/scenarios/<name>.json
   ```

   It must report **`✓ round-trips through parseScenario unchanged`** — if it shows `✗ … dropped/clamped something`, a provision is malformed or a number is out of range; fix it and re-run. Treat `⚠ unknown item ids` as a likely typo (verify against `ITEM_DEFS`); `⚠ no icon yet` is an expected cosmetic gap to surface, not a failure.

7. **Emit the deliverables.** Print:
   - The path to the written scenario.
   - The **"Manual smoke tests needed"** markdown — a bullet list that IS `Scenario.checklist[]` verbatim (so it matches the QA panel exactly).
   - Any **missing-icon ids** the validator flagged (so the tester knows a swatch ≠ a bug).
   - One line on how to QA it: open the preview, JOIN, pick this set in the QA panel (or it's the default), walk the checklist.

## Conventions & gotchas

- **One source of truth:** never write the human checklist separately from `Scenario.checklist[]` — they must be the same array, or the panel and the manual test drift (the whole point of the schema).
- **Real ids + verbatim strings only.** A checklist that says "you should see a confirmation" is useless; "shows the notice `crafted Rope`" is testable. Lift both from the changed code.
- **Forward-compat:** loadout `type` is a free string by design — naming an item a not-yet-merged PR adds is allowed (it no-ops until the id exists). The validator warns so you can tell intent from typo.
- **Don't over-kit.** 8 hotbar slots. A focused scenario beats a maximal one; author a *new set* per concern (the QA panel's SET-SWITCHER lists them all) rather than one giant loadout.
- **Determinism / safety:** scenarios are data; they only ever drive `provisionTestbed` behind the `TESTBED=1` gate. Nothing here touches prod or the wire beyond the gated `scenario?` join field.

## Worked example (the built-in `survival` set)

`apps/game/scenarios/survival.json` — coast + fire + a consumables loadout, vitals knocked down so heals/eats/drinks are observable, cooldowns cleared, and a checklist that names each action + its delta. Read it as the template; a new scenario is the same shape narrowed to the change under test.
