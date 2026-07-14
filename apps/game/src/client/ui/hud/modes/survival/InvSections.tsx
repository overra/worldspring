// Survival's sections of the shared inventory workspace: what the cold is doing
// to you, and what you can make. The workspace shell — storage grid, equipment,
// item popover, map — is engine-level (every mode has an inventory); vitals,
// insulation, core temp and a campfire-gated recipe list are this mode's rules,
// so they come through the seam instead (docs/plans/00).
//
// The shell mounts this slot ONCE and lets the active tab decide which half
// shows: .inv-cond is the condition strip under EQUIPMENT on the storage tab,
// .inv-craft fills the workspace on this mode's own tab. Both class names are
// the shell's contract — they live in inventory.css and the tab reveal keys on
// them. Renaming one here silently breaks the reveal.

import type { ReactElement } from "react";
import { MAX_FOOD, MAX_HP, MAX_WATER, TEMP_SHIVER } from "@worldspring/shared/constants";
import { RECIPES } from "@worldspring/shared/items";
import type { CraftRecipe, ItemStack } from "@worldspring/shared/items";
import { doCraft } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import { KIND_HUE, defOf, nearFireClient } from "../../../inventory/items";
import { Bar } from "../../parts/Bar";
import { ItemIcon } from "../../parts/ItemIcon";
import { countOf } from "../../parts/items";

type VitalKind = "hp" | "food" | "water" | "temp";

// 16px stroked glyphs, currentColor — survival.css gives each one its vital hue
// (.bar-icon--*). Duplicated from VitalsPanel: the HUD card and this strip are
// the two places survival draws a vital, and neither owns the other.
const ICON_PATHS: Record<VitalKind, string> = {
  hp: "M8 13.6 3.1 8.7a3.1 3.1 0 0 1 4.4-4.4l.5.5.5-.5a3.1 3.1 0 0 1 4.4 4.4Z",
  food: "M4.5 4.4v7.2c0 1 1.6 1.8 3.5 1.8s3.5-.8 3.5-1.8V4.4M4.5 4.4c0-1 1.6-1.8 3.5-1.8s3.5.8 3.5 1.8-1.6 1.8-3.5 1.8-3.5-.8-3.5-1.8Z",
  water: "M8 2.6c0 0 4 4.4 4 6.9a4 4 0 0 1-8 0c0-2.5 4-6.9 4-6.9Z",
  temp: "M9.5 9.5V3.6a1.5 1.5 0 0 0-3 0v5.9a3 3 0 1 0 3 0Z",
};

function VitalIcon({ kind }: { kind: VitalKind }): ReactElement {
  return (
    <svg
      className={`bar-icon bar-icon--${kind}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[kind]} />
    </svg>
  );
}

// --- condition: the vitals, read-only, + what your gear is doing about it ---

/**
 * The strip under EQUIPMENT. The bars mirror the HUD's vitals card — deliberate:
 * the design reads them here as the CONDITION of the body you are dressing, and
 * the card is off-screen behind the workspace scrim while you do it.
 *
 * The design's ARMOR and MOBILITY stats are NOT here: the server has no armor
 * value and no movement modifier, and a readout the game cannot back is worse
 * than a missing one. INSULATION (the wear config the cold model actually reads)
 * and the pack's extra slots are the two it can.
 */
function ConditionSection(): ReactElement {
  const vitals = useUIStore((s) => s.vitals);
  const worn = useUIStore((s) => s.worn);
  const body = worn.body === null ? null : defOf(worn.body.type);
  const back = worn.back === null ? null : defOf(worn.back.type);
  const insulation = body?.wear?.insulation;
  const extraSlots = back?.wear?.extraSlots;
  const shivering = vitals.temp < TEMP_SHIVER;

  return (
    <section className="inv-sec inv-cond">
      <div className="inv-card inv-cond-vitals">
        <div className="inv-sec-head">
          <span className="ui-eyebrow">Condition</span>
        </div>
        <Bar
          icon={<VitalIcon kind="hp" />}
          label="Health"
          value={vitals.hp}
          max={MAX_HP}
          fillClass="bar-fill--hp"
          ticks
        />
        <Bar
          icon={<VitalIcon kind="food" />}
          label="Food"
          value={vitals.food}
          max={MAX_FOOD}
          fillClass="bar-fill--food"
          ticks
        />
        <Bar
          icon={<VitalIcon kind="water" />}
          label="Hydration"
          value={vitals.water}
          max={MAX_WATER}
          fillClass="bar-fill--water"
          ticks
        />
        <div className={shivering ? "inv-cond-temp inv-cond-temp--cold" : "inv-cond-temp"}>
          <VitalIcon kind="temp" />
          <span className="ui-label inv-cond-temp-label">Core temp</span>
          <span className="ui-num inv-cond-temp-value">{vitals.temp.toFixed(1)}°C</span>
          {shivering && (
            <span className="ui-chip ui-chip--solid inv-cond-shiver">Shivering</span>
          )}
        </div>
      </div>

      <div className="inv-card inv-cond-stats">
        <div className="inv-cond-stat">
          <span className="ui-label">Insulation</span>
          <span className={insulation === undefined ? "ui-num inv-stat--off" : "ui-num inv-stat--cold"}>
            {insulation === undefined ? "—" : `${Math.round(insulation * 100)}%`}
          </span>
        </div>
        <p className="ui-hint inv-cond-note">negates that share of the temperature fall</p>
        <div className="inv-cond-stat">
          <span className="ui-label">Pack slots</span>
          <span className={extraSlots === undefined ? "ui-num inv-stat--off" : "ui-num"}>
            {extraSlots === undefined ? "—" : `+${extraSlots}`}
          </span>
        </div>
      </div>
    </section>
  );
}

// --- crafting: flat, ordered, instant ---

interface CraftRowProps {
  recipe: CraftRecipe;
  index: number;
  inventory: (ItemStack | null)[];
  nearFire: boolean;
}

function CraftRow({ recipe, index, inventory, nearFire }: CraftRowProps): ReactElement {
  const inputs = recipe.inputs.map((input) => ({
    ...input,
    met: countOf(inventory, input.type) >= input.count,
  }));
  const toolMet = recipe.tool === undefined || countOf(inventory, recipe.tool) > 0;
  const stationMet = recipe.station !== "campfire" || nearFire;
  const enabled = inputs.every((input) => input.met) && toolMet && stationMet;

  const out = defOf(recipe.output.type);
  // Only the gates you are actually failing — a caution hint on a recipe you can
  // craft right now reads as a blocker that isn't one.
  const gates: string[] = [];
  if (recipe.tool !== undefined && !toolMet) gates.push(`needs ${defOf(recipe.tool).name}`);
  if (recipe.station === "campfire" && !stationMet) gates.push("needs campfire");

  return (
    <div className={enabled ? "inv-craft-row" : "inv-craft-row inv-craft-row--off"}>
      <span className="inv-craft-icon">
        <ItemIcon type={recipe.output.type} className="inv-craft-img" />
        <span className="ui-cell-stripe" style={{ color: KIND_HUE[out.kind] }} />
      </span>
      <div className="inv-craft-main">
        <div className="inv-craft-out">
          <span className="ui-title inv-craft-name">{out.name}</span>
          {recipe.output.count > 1 && (
            <span className="ui-num ui-num--sm">×{recipe.output.count}</span>
          )}
        </div>
        <div className="inv-craft-inputs">
          {inputs.map((input, n) => (
            <span
              key={n}
              className={input.met ? "inv-craft-chip" : "inv-craft-chip inv-craft-chip--short"}
            >
              {input.count}× {defOf(input.type).name}
            </span>
          ))}
          {gates.map((gate) => (
            <span key={gate} className="inv-craft-gate">
              {gate}
            </span>
          ))}
        </div>
      </div>
      <button className="ui-btn" disabled={!enabled} onClick={() => doCraft(index)}>
        Craft
      </button>
    </div>
  );
}

/**
 * Every recipe, always visible, gated where it should be. The design's category
 * rail, recipe search, detail pane and HOLD-TO-CRAFT progress bar are all
 * omitted: RECIPES is a flat list with no categories and no descriptions, and
 * crafting is INSTANT server-side — a hold-to-craft bar would be theatre over a
 * one-tick action.
 */
function CraftingSection({ inventory }: { inventory: (ItemStack | null)[] }): ReactElement {
  const nearFire = nearFireClient();
  return (
    <section className="inv-sec inv-craft">
      <div className="inv-sec-head">
        <span className="ui-eyebrow">Recipes</span>
        {nearFire && <span className="ui-chip">Campfire in reach</span>}
      </div>
      <div className="inv-craft-list">
        {RECIPES.map((recipe, i) => (
          <CraftRow key={i} recipe={recipe} index={i} inventory={inventory} nearFire={nearFire} />
        ))}
      </div>
    </section>
  );
}

/** Both sections, in the order the shell's grid places them. The panel hands the
 * slot no props — the store mirror of the server's inv message is the same
 * source the shell reads. */
export function SurvivalInvSections(): ReactElement {
  const inventory = useUIStore((s) => s.inventory);
  return (
    <>
      <ConditionSection />
      <CraftingSection inventory={inventory} />
    </>
  );
}
