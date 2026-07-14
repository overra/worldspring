// Survival's sections of the shared inventory panel: what the cold is doing to
// you, and what you can make. The panel's shell — carry grid, equipment, detail
// card — is engine-level (every mode has an inventory); insulation, core temp
// and a campfire-gated recipe list are this mode's rules, so they come through
// the seam instead (docs/plans/00).
//
// .inv-cond* / .inv-craft* live in inventory.css with the shell: its
// narrow-screen tab reveal keys on those two class names.

import type { ReactElement } from "react";
import { TEMP_SHIVER } from "@worldspring/shared/constants";
import { RECIPES } from "@worldspring/shared/items";
import type { CraftRecipe, ItemStack } from "@worldspring/shared/items";
import { doCraft } from "@/client/net/connection";
import { useUIStore } from "@/client/state/store";
import { defOf, nearFireClient, usedSlots } from "../../../inventory/items";
import { countOf } from "../../parts/items";

// --- condition: insulation, slots, core temp. No armor, no weight, no mobility. ---

function ConditionSection({ used, capacity }: { used: number; capacity: number }): ReactElement {
  const vitals = useUIStore((s) => s.vitals);
  const worn = useUIStore((s) => s.worn);
  const body = worn.body === null ? null : defOf(worn.body.type);
  const insulation = body?.wear?.insulation;
  const shivering = vitals.temp < TEMP_SHIVER;
  return (
    <section className="inv-sec inv-cond">
      <div className="ui-eyebrow inv-sec-head">Condition</div>
      <div className="inv-cond-row">
        <span className="ui-label">Insulation</span>
        <span className={insulation === undefined ? "ui-num inv-num--off" : "ui-num inv-num--cold"}>
          {insulation === undefined ? "—" : `${Math.round(insulation * 100)}%`}
        </span>
      </div>
      <p className="ui-hint inv-cond-note">negates that share of the temperature fall</p>
      <div className="inv-cond-row">
        <span className="ui-label">Carry</span>
        <span className="ui-num">
          {used} / {capacity} slots
        </span>
      </div>
      <div className="inv-cond-row">
        <span className="ui-label">Core temp</span>
        <span className={shivering ? "ui-num inv-num--cold" : "ui-num"}>
          {vitals.temp.toFixed(1)}°C
        </span>
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
      <div className="inv-craft-main">
        <div className="inv-craft-out">
          {out.name}
          {recipe.output.count > 1 ? ` ×${recipe.output.count}` : ""}
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
          {gates.length > 0 && <span className="inv-craft-gate">{gates.join(" · ")}</span>}
        </div>
      </div>
      <button className="ui-btn" disabled={!enabled} onClick={() => doCraft(index)}>
        Craft
      </button>
    </div>
  );
}

function CraftingSection({ inventory }: { inventory: (ItemStack | null)[] }): ReactElement {
  const nearFire = nearFireClient();
  return (
    <section className="inv-sec inv-craft">
      <div className="ui-eyebrow inv-sec-head">Crafting</div>
      <div className="inv-craft-list">
        {RECIPES.map((recipe, i) => (
          <CraftRow key={i} recipe={recipe} index={i} inventory={inventory} nearFire={nearFire} />
        ))}
      </div>
    </section>
  );
}

/** Both sections, in side-column order. The panel hands the slot no props — the
 * store mirror of the server's inv message is the same source the shell reads. */
export function SurvivalInvSections(): ReactElement {
  const inventory = useUIStore((s) => s.inventory);
  return (
    <>
      <ConditionSection used={usedSlots(inventory)} capacity={inventory.length} />
      <CraftingSection inventory={inventory} />
    </>
  );
}
