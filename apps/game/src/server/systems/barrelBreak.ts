// Authoritative barrel-break transaction, kept separate from prop placement so
// deterministic physics harnesses can exercise it without loading worldgen.

import { DROPPED_LOOT_TTL_S } from "@worldspring/shared/constants";
import { BARREL_LOOT_TABLE } from "@worldspring/shared/items";
import { rollFromTable } from "./loot.ts";
import type { GameState } from "./state.ts";

/** Capture the final physics pose, announce the cosmetic break, then remove the
 * body and spill server-owned loot. The event carries no gameplay authority. */
export function breakBarrel(state: GameState, id: number, fallbackX: number, fallbackY: number, fallbackZ: number): void {
  const pose = state.physics.bodyPose(id) ?? {
    x: fallbackX,
    y: fallbackY,
    z: fallbackZ,
    q: [0, 0, 0, 1] as [number, number, number, number],
  };
  // Queue before removal so every interested client receives the exact final
  // tipped/rolled pose for its interpolated Three Pinata debris.
  state.events.push({
    ev: { e: "break", id, kind: "barrel", x: pose.x, y: pose.y, z: pose.z, q: pose.q },
    x: pose.x,
    z: pose.z,
  });
  state.physics.removeBody(id);
  state.propHits.delete(id);
  const stack = rollFromTable(BARREL_LOOT_TABLE);
  const lootId = state.nextEntityId++;
  state.loot.set(lootId, {
    id: lootId,
    type: stack.type,
    count: stack.count,
    x: pose.x,
    y: state.world.groundHeight(pose.x, pose.z),
    z: pose.z,
    spawnId: null,
    ttl: DROPPED_LOOT_TTL_S,
  });
}
