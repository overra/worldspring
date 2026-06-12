// The entire three.js scene lives in this module so React.lazy in App.tsx can
// put three/R3F/drei/postprocessing in their own chunk — the menu/HUD shell
// paints without downloading any of it. Do not import this file statically
// from eager (menu-phase) code or the split is defeated.

import { Canvas } from "@react-three/fiber";
import { useSettingsStore, QUALITY_CONFIGS } from "./state/settings";
import { NetSystem } from "./net/NetSystem";
import { AudioSystem } from "./audio/AudioSystem";
import { DebugCollector } from "./render/post/DebugCollector";
import { PostFX } from "./render/post/PostFX";
import { SkyAndLighting } from "./render/world/SkyAndLighting";
import { Terrain } from "./render/world/Terrain";
import { WaterPlane } from "./render/world/WaterPlane";
import { Buildings } from "./render/world/Buildings";
import { BuildingTrim } from "./render/world/BuildingTrim";
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
import { EffectsLayer } from "./render/entities/EffectsLayer";

export function GameCanvas(): React.ReactElement {
  const quality = useSettingsStore((s) => s.quality);
  const config = QUALITY_CONFIGS[quality];
  return (
    <Canvas
      className="game-canvas"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 75, near: 0.1, far: 600 }}
      dpr={[1, config.maxDpr]}
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
      <WaterPlane />
      <Buildings />
      <BuildingTrim />
      <Trees />
      <Scatter />
      <Grass />
      <RemotePlayers />
      <Zombies />
      <LootItems />
      <Corpses />
      <Animals />
      <Airdrops />
      <RainLayer />
      <Campfires />
      <EffectsLayer />
    </Canvas>
  );
}
