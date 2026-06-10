// Ocean: one big translucent plane at WATER_LEVEL with a gentle vertical bob.

import { useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import type * as THREE from "three";
import { WATER_LEVEL, WORLD_SIZE } from "@/shared/constants";

const WATER_SIZE = WORLD_SIZE * 1.6;
const BOB_AMPLITUDE = 0.05;
const BOB_SPEED = 0.45; // rad/s

export function WaterPlane(): ReactElement | null {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.position.y = WATER_LEVEL + Math.sin(state.clock.elapsedTime * BOB_SPEED) * BOB_AMPLITUDE;
  });

  return (
    <mesh
      ref={meshRef}
      rotation-x={-Math.PI / 2}
      position={[0, WATER_LEVEL, 0]}
      frustumCulled={false}
    >
      <planeGeometry args={[WATER_SIZE, WATER_SIZE, 1, 1]} />
      <meshStandardMaterial
        color="#2a4d5e"
        transparent
        opacity={0.82}
        emissive="#16313f"
        emissiveIntensity={0.25}
        flatShading
      />
    </mesh>
  );
}
