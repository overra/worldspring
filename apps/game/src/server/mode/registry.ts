// Maps a resolved config.mode to a GameMode instance (docs/plans/00). The engine
// host (GameRoom) calls this once at boot. Survival is a stateless singleton;
// arena is instantiated per room because it carries round state. Adding a mode
// is a fork touching exactly this switch + the mode's own file — the seam the
// whole abstraction exists to provide.
import type { ServerConfig } from "@worldspring/shared/config";
import type { GameMode } from "./GameMode";
import { survivalMode } from "./survivalMode";
import { createArenaMode } from "./arenaMode";
import { createHordeMode } from "./hordeMode";

export function makeMode(config: ServerConfig): GameMode {
  switch (config.mode) {
    case "arena":
      return createArenaMode();
    case "horde":
      return createHordeMode();
    case "survival":
    default:
      return survivalMode;
  }
}
