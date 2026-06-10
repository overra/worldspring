import { Canvas } from "@react-three/fiber";
import { useUIStore } from "./state/store";
import { NetSystem } from "./net/NetSystem";
import { AudioSystem } from "./audio/AudioSystem";
import { PostFX } from "./render/post/PostFX";
import { SkyAndLighting } from "./render/world/SkyAndLighting";
import { Terrain } from "./render/world/Terrain";
import { WaterPlane } from "./render/world/WaterPlane";
import { Buildings } from "./render/world/Buildings";
import { Trees } from "./render/world/Trees";
import { Grass } from "./render/world/Grass";
import { InputController } from "./render/entities/InputController";
import { PlayerCamera } from "./render/entities/PlayerCamera";
import { RemotePlayers } from "./render/entities/RemotePlayers";
import { Zombies } from "./render/entities/Zombies";
import { LootItems } from "./render/entities/LootItems";
import { Corpses } from "./render/entities/Corpses";
import { Campfires } from "./render/entities/Campfires";
import { EffectsLayer } from "./render/entities/EffectsLayer";
import { MainMenu } from "./ui/MainMenu";
import { HUD } from "./ui/HUD";
import { DeathScreen } from "./ui/DeathScreen";

function GameCanvas(): React.ReactElement {
  return (
    <Canvas
      className="game-canvas"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 75, near: 0.1, far: 600 }}
      shadows="percentage"
      flat
    >
      <NetSystem />
      <AudioSystem />
      <InputController />
      <PlayerCamera />
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
      {phase === "dead" && <DeathScreen />}
    </div>
  );
}
