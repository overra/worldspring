// Post-processing pipeline. Owns the actual frame render: PlayerCamera's
// priority-1 useFrame disables R3F auto-render and only moves the camera;
// this composer runs at renderPriority 2, so it renders AFTER the camera
// update each frame (RenderPass inside the composer draws the scene — fog
// and lighting apply there as usual).
//
// multisampling={0}: SMAA (last effect) replaces MSAA and keeps the N8AO
// pass cheap. The Canvas is `flat` (NoToneMapping) and no ToneMapping
// effect is added here, so the frame is never double-tonemapped.
//
// None of these effects suspend in @react-three/postprocessing 3.x (SMAA
// images are embedded, N8AO constructs synchronously), so the pipeline
// renders from the first frame.

import {
  EffectComposer,
  N8AO,
  Bloom,
  Vignette,
  HueSaturation,
  BrightnessContrast,
  SMAA,
} from "@react-three/postprocessing";

// Ambient occlusion — grounds the low-poly primitives.
const AO_RADIUS = 2.5;
const AO_INTENSITY = 2.8;

// Bloom — only genuinely bright sources (flames, muzzle flash) glow.
const BLOOM_THRESHOLD = 0.85;
const BLOOM_INTENSITY = 0.5;

// Vignette — subtle edge darkening.
const VIGNETTE_OFFSET = 0.25;
const VIGNETTE_DARKNESS = 0.55;

// Desaturated grade — the muted DayZ look. Subtle; don't crush it.
const GRADE_SATURATION = -0.12;
const GRADE_CONTRAST = 0.06;

export function PostFX(): React.ReactElement {
  return (
    <EffectComposer renderPriority={2} multisampling={0}>
      <N8AO
        aoRadius={AO_RADIUS}
        intensity={AO_INTENSITY}
        quality="medium"
        color="black"
      />
      <Bloom
        mipmapBlur
        luminanceThreshold={BLOOM_THRESHOLD}
        intensity={BLOOM_INTENSITY}
      />
      <Vignette
        eskil={false}
        offset={VIGNETTE_OFFSET}
        darkness={VIGNETTE_DARKNESS}
      />
      <HueSaturation saturation={GRADE_SATURATION} />
      <BrightnessContrast contrast={GRADE_CONTRAST} />
      <SMAA />
    </EffectComposer>
  );
}
