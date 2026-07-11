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
  FXAA,
} from "@react-three/postprocessing";
import { UnsignedByteType } from "three";
import { QUALITY_CONFIGS, useSettingsStore } from "@/client/state/settings";

// Ambient occlusion — grounds the low-poly primitives.
const AO_RADIUS = 2.5;
const AO_INTENSITY = 2.8;

// Bloom — only genuinely bright sources (flames, muzzle flash) glow.
const BLOOM_THRESHOLD = 0.85;
const BLOOM_INTENSITY = 0.5;

// Vignette — subtle edge darkening.
const VIGNETTE_OFFSET = 0.25;
const VIGNETTE_DARKNESS = 0.55;

// Desaturated grade — the muted, washed-out survival look. Subtle; don't crush it.
const GRADE_SATURATION = -0.12;
const GRADE_CONTRAST = 0.06;

/** n8ao ships no types — the two members of N8AOPostPass we poke via ref. */
interface N8aoPassLike {
  autoDetectTransparency: boolean;
  configuration: { transparencyAware: boolean };
}

// Kill n8ao's transparency auto-detect: the sky discs / name-label sprites are
// transparent from frame 1, so detection flips transparencyAware on and every
// frame pays 2 extra full-res scene renders + 2 depth copies (n8ao
// renderTransparency). Must go through the pass instance — the r3f wrapper
// exposes no transparencyAware prop. Order matters: the configuration proxy
// only acts when the value CHANGES, so clear the detect flag directly first,
// then undo detection if it already fired (frees the two render targets).
function disableTransparencyAware(pass: N8aoPassLike | null): void {
  if (!pass) return;
  pass.autoDetectTransparency = false;
  pass.configuration.transparencyAware = false;
}

export function PostFX(): React.ReactElement {
  // Subscribe (not getState) so quality changes re-render the chain live.
  const quality = useSettingsStore((s) => s.quality);

  // Low quality: the composer MUST stay mounted — it is the scene's only
  // renderer (R3F auto-render is disabled by PlayerCamera) — so we keep it
  // with just AA instead of unmounting the whole pipeline. No HDR effect
  // lives in this branch (no bloom/AO), so an 8-bit framebuffer halves
  // bandwidth vs the wrapper's HalfFloatType default; mobile additionally
  // swaps 3-pass SMAA for single-pass FXAA.
  if (!QUALITY_CONFIGS[quality].postFx) {
    return (
      <EffectComposer
        renderPriority={2}
        multisampling={0}
        frameBufferType={UnsignedByteType}
      >
        {quality === "mobile" ? <FXAA /> : <SMAA />}
      </EffectComposer>
    );
  }

  return (
    <EffectComposer renderPriority={2} multisampling={0}>
      <N8AO
        ref={disableTransparencyAware}
        aoRadius={AO_RADIUS}
        intensity={AO_INTENSITY}
        quality="medium"
        halfRes={quality === "medium"}
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
