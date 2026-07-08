// Preview-only testbed scenario registry (doc 10 M3). Static-imports the
// committed sets from apps/game/scenarios/*.json and parses each through the
// shared parseScenario (clamp-never-throw) at module load. The registry is a
// compile-time allowlist — Workers have no filesystem, so an unknown name can
// only fall back to the default. resolveScenario maps a join-supplied or
// deploy-time (env.SCENARIO) name to a Scenario; it is consulted by GameRoom
// ONLY when env.TESTBED is on, so prod never reaches it.

import { BUILTIN_SCENARIO, parseScenario, type Scenario } from "@worldspring/shared/scenario";
import combatJson from "../../../scenarios/combat.json";
import craftingJson from "../../../scenarios/crafting.json";
import physicsJson from "../../../scenarios/physics.json";
import survivalJson from "../../../scenarios/survival.json";

/** The set used when no name is supplied (or an unknown one is). */
export const DEFAULT_SCENARIO_NAME = "survival";

const SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze({
  survival: parseScenario(survivalJson),
  combat: parseScenario(combatJson),
  crafting: parseScenario(craftingJson),
  physics: parseScenario(physicsJson),
});

/** Every shipped set name — the M4 panel's set-switcher reads this. */
export function scenarioNames(): readonly string[] {
  return Object.keys(SCENARIOS);
}

/**
 * Resolve a requested set name (join-supplied, or the deploy-time env.SCENARIO
 * fallback) to a Scenario. Unknown/absent → the default survival set; if that is
 * somehow missing, the shared BUILTIN_SCENARIO. Never throws.
 */
export function resolveScenario(name: string | undefined): Scenario {
  // OWN-property lookup only. The wire charset for join.scenario ([a-z0-9_-])
  // admits prototype keys like "__proto__" and "constructor"; a bare
  // SCENARIOS[name] would return a prototype object for those, bypassing the
  // allowlist and handing provisionTestbed a non-scenario. hasOwnProperty.call
  // accepts only the real set names, so anything else falls through to default.
  const hit = name && Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? SCENARIOS[name] : undefined;
  return hit ?? SCENARIOS[DEFAULT_SCENARIO_NAME] ?? BUILTIN_SCENARIO;
}
