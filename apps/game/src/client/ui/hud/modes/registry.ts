// Maps a resolved config.mode to its HUD module — the client mirror of the
// server's mode/registry.ts. Adding a GameModeId is a compile error here until
// it names a HUD (or an explicit null). Arena is a deliberate null: the seam
// exists, the skin does not.

import type { GameModeId } from "@worldspring/shared/config";
import { SURVIVAL_HUD } from "./survival/SurvivalHUD";
import type { ModeHud } from "./types";

const MODE_HUDS: Record<GameModeId, ModeHud | null> = {
  survival: SURVIVAL_HUD,
  arena: null,
};

/** null = this mode has no HUD module; the shared chrome renders alone. The
 * `?? null` also covers a mode id that somehow escaped clampConfig — the index
 * is total by type, not at runtime. */
export function modeHud(id: GameModeId): ModeHud | null {
  return MODE_HUDS[id] ?? null;
}
