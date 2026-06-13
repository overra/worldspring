// =============================================================================
// THROWAWAY STUB — doc 03 M2 ships this; doc 04 M1 REPLACES it wholesale.
//
// Do NOT build features on this file. It exists only so doc 03 M2's
// serverInfo.ts and GameRoom.buildServerInfo() have the type-level surface and
// a stock RulesSummary to compile and serve. Doc 04 M1 owns the REAL
// ServerConfig / PRESETS (all six) / resolveServerConfig / clampConfig and the
// banded summarizeRules thresholds (doc 04 §1 / §6). The type names and string
// unions here match doc 04 §1 (lines 135-136) so that doc-04 work is a drop-in
// superset, not a rename.
//
// Canonical-vocab note: "Doc 03 M2 ships a stub config.ts; doc 04 M1 replaces
// it." Keep this file minimal — every addition here is debt doc 04 must unwind.
// =============================================================================

import { DAY_DURATION_S, MAX_PLAYERS } from "./constants";
import type { RulesSummary } from "./serverInfo";

// The cross-import with serverInfo.ts is TYPE-ONLY in both directions (config
// imports the RulesSummary *type*; serverInfo imports WorldSizeTier/WipeSchedule
// *types* via `import type`), so it is erased and isolatedModules-safe — no
// runtime cycle.

/** World map size tier. Names/values per doc 04 §1 (drop-in superset later). */
export type WorldSizeTier = "standard" | "large" | "huge";

/** World wipe cadence. Names/values per doc 04 §1 (drop-in superset later). */
export type WipeSchedule = "never" | "weekly" | "biweekly" | "monthly";

/**
 * Minimal stand-in for doc 04's ServerConfig — only the fields this stub's
 * summarizeRules() reads. Doc 04 M1 replaces this with the full knob set.
 */
export interface ServerConfig {
  preset: RulesSummary["preset"];
}

/** Stock deadcoast defaults — the only config this stub knows about. */
export const DEFAULT_CONFIG: ServerConfig = {
  preset: "deadcoast",
};

/**
 * Shipped presets. Doc 03 M2 carries only the default key; doc 04 M1 adds the
 * other five (driftwood/ironcoast/warpath/homestead/nightfall) with real knobs.
 */
export const PRESETS: Record<string, Partial<ServerConfig>> = {
  deadcoast: {},
};

/**
 * Map a ServerConfig to render-ready rules badges. STUB: returns the stock
 * deadcoast badge values regardless of input (doc 04 M1 implements the real
 * banded mapping over actual config knobs, doc 04 §6). dayLengthMin is derived
 * from DAY_DURATION_S so the badge tracks the constant (16 today).
 */
export function summarizeRules(config: ServerConfig): RulesSummary {
  void config; // stub ignores input; doc 04 M1 reads real knobs here
  return {
    preset: "deadcoast",
    zombies: "normal",
    pvp: true,
    fullLoot: true,
    loot: "normal",
    vitals: "normal",
    night: "cycle",
    dayLengthMin: DAY_DURATION_S / 60,
    worldSize: "standard",
    maxPlayers: MAX_PLAYERS,
    wipe: "never",
  };
}
