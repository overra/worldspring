// The entire three.js scene lives in this module so React.lazy in App.tsx can
// put three/R3F/drei/postprocessing in their own chunk — the menu/HUD shell
// paints without downloading any of it. Do not import this file statically
// from eager (menu-phase) code or the split is defeated.

import { Canvas } from "@react-three/fiber";
import { useSettingsStore, QUALITY_CONFIGS } from "./state/settings";
import { useUIStore } from "./state/store";
import { clientWorld } from "./runtime";
import { NetSystem } from "./net/NetSystem";
import { AudioSystem } from "./audio/AudioSystem";
import { DebugCollector } from "./render/post/DebugCollector";
import { PostFX } from "./render/post/PostFX";
import { SkyAndLighting } from "./render/world/SkyAndLighting";
import { Terrain } from "./render/world/Terrain";
import { WaterPlane } from "./render/world/WaterPlane";
import { Buildings } from "./render/world/Buildings";
import { BuildingTrim } from "./render/world/BuildingTrim";
import { Structures } from "./render/world/Structures";
import { Containers } from "./render/world/Containers";
import { Trees } from "./render/world/Trees";
import { Scatter } from "./render/world/Scatter";
import { Grass } from "./render/world/Grass";
import { RainLayer } from "./render/world/RainLayer";
import { InputController } from "./render/entities/InputController";
import { PlayerCamera } from "./render/entities/PlayerCamera";
import { RemotePlayers } from "./render/entities/RemotePlayers";
import { Zombies } from "./render/entities/Zombies";
import { LootItems } from "./render/entities/LootItems";
import { Corpses } from "./render/entities/Corpses";
import { Animals } from "./render/entities/Animals";
import { Airdrops } from "./render/entities/Airdrops";
import { Campfires } from "./render/entities/Campfires";
import { Portals } from "./render/entities/Portals";
import { PhysicsBodies } from "./render/entities/PhysicsBodies";
import { Vehicles } from "./render/entities/Vehicles";
import { BuildPreview } from "./render/entities/BuildPreview";
import { EffectsLayer } from "./render/entities/EffectsLayer";

export function GameCanvas(): React.ReactElement {
  const quality = useSettingsStore((s) => s.quality);
  const qualityCfg = QUALITY_CONFIGS[quality];
  // Realm gates the overworld-only set dressing: in the red realm the island's
  // water, buildings, trees, grass, scatter and rain are hidden so only the
  // (red-tinted) terrain and the wild sky remain. Low-rate store value, so this
  // re-renders only on a portal crossing.
  const realm = useUIStore((s) => s.realm);
  // clientWorld.config is written by onWelcome before the canvas is ever mounted
  // (App.tsx only unmounts the menu once phase becomes "playing"), so this read
  // is always post-welcome. The config never changes while the canvas is mounted
  // (disconnect returns to menu, no auto-reconnect), so a single capture here is
  // stable for the lifetime of this mount.
  const cfg = clientWorld.config;
  return (
    <Canvas
      className="game-canvas"
      // antialias: false — the EffectComposer (always mounted, SMAA-only on
      // low tiers) is the sole renderer and SMAA is the AA; an MSAA default
      // framebuffer would just add a per-frame resolve on the final blit,
      // pure bandwidth waste on the fill-bound devices the mobile tier targets.
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov: 75, near: 0.1, far: 600 }}
      dpr={[1, qualityCfg.maxDpr]}
      shadows="percentage"
      flat
    >
      <NetSystem />
      <AudioSystem />
      <InputController />
      <PlayerCamera />
      <DebugCollector />
      <PostFX />
      <SkyAndLighting />
      <Terrain />
      {realm !== "red" && (
        <>
          <WaterPlane />
          <Buildings />
          <BuildingTrim />
          <Containers />
          {/* doc 06 — player structures + the hammer ghost. Overworld-only
              like worldgen buildings; collision (shared World) exists in both
              realms, matching that precedent. */}
          <Structures />
          <BuildPreview />
          <Trees />
          <Scatter />
          <Grass />
          <RainLayer />
          <PhysicsBodies />
          <Vehicles />
        </>
      )}
      <RemotePlayers />
      {cfg.threats.zombies && <Zombies />}
      <LootItems />
      <Corpses />
      {cfg.wildlife.deerDensity > 0 && <Animals />}
      <Airdrops />
      <Campfires />
      <Portals />
      <EffectsLayer />
    </Canvas>
  );
}
