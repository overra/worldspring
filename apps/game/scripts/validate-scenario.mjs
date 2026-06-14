#!/usr/bin/env node
// Validate a testbed scenario JSON (used by the /testbed skill — see
// skills/testbed/SKILL.md — to self-check what it generates):
//
//   node --experimental-strip-types apps/game/scripts/validate-scenario.mjs <scenario.json>
//
// Three checks:
//   1. ROUND-TRIP — parseScenario is total + clamps/drops silently (it never
//      throws). If the file doesn't survive it byte-for-byte (canonically), the
//      scenario has an invalid provision / clamped number / truncated string the
//      author should see. This is the hard failure (exit 1).
//   2. UNKNOWN IDS — loadout `type`s not in ITEM_DEFS. A WARNING, not a failure:
//      the forward-compat rule no-ops unknown ids at provision time (so a
//      scenario can name an item a future PR adds), but usually it's a typo.
//   3. ICON GAPS — loadout ids with no apps/game/public/icons/<type>.png. A FLAG
//      (cosmetic: the HUD shows a colour swatch). Doc 10 M5 wants these surfaced.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEM_DEFS } from "@worldspring/shared/items";
import { parseScenario } from "@worldspring/shared/scenario";

const file = process.argv[2];
if (!file) {
  console.error("usage: validate-scenario.mjs <scenario.json>");
  process.exit(2);
}
const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

let input;
try {
  input = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`validate-scenario: ${file} is not valid JSON — ${e.message}`);
  process.exit(1);
}

/** Recursively sort object keys so the round-trip compare ignores key order
 * (parseScenario rebuilds objects in its own field order). */
function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = canon(x[k]);
    return out;
  }
  return x;
}

const parsed = parseScenario(input);
const roundTrips = JSON.stringify(canon(input)) === JSON.stringify(canon(parsed));

console.log(`validate-scenario: ${file}`);
console.log(`  name: ${parsed.name} | provisions: ${parsed.provision.length} | checklist: ${parsed.checklist.length}`);

// --- 1. round-trip ---
if (roundTrips) {
  console.log("  ✓ round-trips through parseScenario unchanged");
} else {
  console.log("  ✗ parseScenario CHANGED the scenario — it dropped/clamped something:");
  const inProv = Array.isArray(input.provision) ? input.provision.length : 0;
  if (inProv !== parsed.provision.length) {
    console.log(`      provisions: ${inProv} authored → ${parsed.provision.length} survived (invalid ones were dropped)`);
  }
  console.log("    --- as authored ---");
  console.log(JSON.stringify(canon(input), null, 2).split("\n").map((l) => "    " + l).join("\n"));
  console.log("    --- after parseScenario ---");
  console.log(JSON.stringify(canon(parsed), null, 2).split("\n").map((l) => "    " + l).join("\n"));
}

// --- 2 + 3. loadout id checks ---
const ids = parsed.provision
  .filter((p) => p.kind === "loadout")
  .flatMap((p) => p.items.map((i) => i.type));
const unique = [...new Set(ids)];
const unknown = unique.filter((t) => ITEM_DEFS[t] === undefined);
const iconless = unique.filter((t) => ITEM_DEFS[t] !== undefined && !existsSync(join(iconsDir, `${t}.png`)));

if (unknown.length) console.log(`  ⚠ unknown item ids (no-op at provision; typo?): ${unknown.join(", ")}`);
if (iconless.length) console.log(`  ⚠ no icon yet (swatch fallback): ${iconless.join(", ")}`);
if (!unknown.length && !iconless.length && ids.length) console.log("  ✓ all loadout ids are known and have icons");

process.exit(roundTrips ? 0 : 1);
