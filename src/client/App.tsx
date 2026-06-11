import { Canvas } from "@react-three/fiber";
import { useUIStore } from "./state/store";
import { useSettingsStore, QUALITY_CONFIGS } from "./state/settings";
import { NetSystem } from "./net/NetSystem";
import { AudioSystem } from "./audio/AudioSystem";
import { DebugCollector } from "./render/post/DebugCollector";
import { PostFX } from "./render/post/PostFX";
import { SkyAndLighting } from "./render/world/SkyAndLighting";
import { Terrain } from "./render/world/Terrain";
import { WaterPlane } from "./render/world/WaterPlane";
import { Buildings } from "./render/world/Buildings";
import { Trees } from "./render/world/Trees";
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
import { MainMenu } from "./ui/MainMenu";
import { HUD } from "./ui/HUD";
import { DeathScreen } from "./ui/DeathScreen";
import { EscapeMenu } from "./ui/EscapeMenu";
import { DebugOverlay } from "./ui/DebugOverlay";
import { TouchControls } from "./ui/TouchControls";

function GameCanvas(): React.ReactElement {
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
      <Trees />
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

export function App(): React.ReactElement {
  const phase = useUIStore((s) => s.phase);

  if (phase === "menu" || phase === "connecting") {
    return <MainMenu />;
  }
  return (
    <div className="game-root">
      <GameCanvas />
      <HUD />
      <TouchControls />
      <DebugOverlay />
      <EscapeMenu />
      {phase === "dead" && <DeathScreen />}
    </div>
  );
}
