// Sound asset manifest — the contract between the SFX generation pipeline
// (files in public/sfx/) and the audio engine. Filenames are fixed here;
// generation must produce exactly these.

export type SfxName =
  | "shot"
  | "shot_far"
  | "swing"
  | "hit_flesh"
  | "hit_thud"
  | "zombie_idle1"
  | "zombie_idle2"
  | "zombie_aggro"
  | "zombie_attack"
  | "zombie_die"
  | "step_grass1"
  | "step_grass2"
  | "eat"
  | "drink"
  | "bandage"
  | "campfire_place"
  | "pickup"
  | "fire_loop"
  | "wind_loop"
  | "waves_loop"
  | "crickets_loop"
  | "heartbeat"
  | "hurt1"
  | "hurt2"
  | "death";

export const SFX_FILES: Record<SfxName, string> = {
  shot: "/sfx/shot.mp3",
  shot_far: "/sfx/shot_far.mp3",
  swing: "/sfx/swing.mp3",
  hit_flesh: "/sfx/hit_flesh.mp3",
  hit_thud: "/sfx/hit_thud.mp3",
  zombie_idle1: "/sfx/zombie_idle1.mp3",
  zombie_idle2: "/sfx/zombie_idle2.mp3",
  zombie_aggro: "/sfx/zombie_aggro.mp3",
  zombie_attack: "/sfx/zombie_attack.mp3",
  zombie_die: "/sfx/zombie_die.mp3",
  step_grass1: "/sfx/step_grass1.mp3",
  step_grass2: "/sfx/step_grass2.mp3",
  eat: "/sfx/eat.mp3",
  drink: "/sfx/drink.mp3",
  bandage: "/sfx/bandage.mp3",
  campfire_place: "/sfx/campfire_place.mp3",
  pickup: "/sfx/pickup.mp3",
  fire_loop: "/sfx/fire_loop.mp3",
  wind_loop: "/sfx/wind_loop.mp3",
  waves_loop: "/sfx/waves_loop.mp3",
  crickets_loop: "/sfx/crickets_loop.mp3",
  heartbeat: "/sfx/heartbeat.mp3",
  hurt1: "/sfx/hurt1.mp3",
  hurt2: "/sfx/hurt2.mp3",
  death: "/sfx/death.mp3",
};

/** Sounds the engine should treat as seamless loops. */
export const SFX_LOOPS: readonly SfxName[] = [
  "fire_loop",
  "wind_loop",
  "waves_loop",
  "crickets_loop",
  "heartbeat",
];
