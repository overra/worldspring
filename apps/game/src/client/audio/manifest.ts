// Sound asset manifest — the contract between the SFX generation pipeline
// (files in public/sfx/) and the audio engine. Filenames are fixed here;
// generation must produce exactly these.

export type SfxName =
  | "shot"
  | "shot_far"
  | "rifle_shot"
  | "rifle_far"
  | "shotgun_shot"
  | "shotgun_far"
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
  | "death"
  | "rain_loop"
  | "plane_flyover"
  | "crate_thud"
  | "tree_fall"
  | "axe_wood"
  | "reload_start"
  | "reload_finish"
  | "dry_fire";

export const SFX_FILES: Record<SfxName, string> = {
  shot: "/sfx/shot.mp3",
  shot_far: "/sfx/shot_far.mp3",
  rifle_shot: "/sfx/rifle_shot.mp3",
  rifle_far: "/sfx/rifle_far.mp3",
  shotgun_shot: "/sfx/shotgun_shot.mp3",
  shotgun_far: "/sfx/shotgun_far.mp3",
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
  rain_loop: "/sfx/rain_loop.mp3",
  plane_flyover: "/sfx/plane_flyover.mp3",
  crate_thud: "/sfx/crate_thud.mp3",
  tree_fall: "/sfx/tree_fall.mp3",
  axe_wood: "/sfx/axe_wood.mp3",
  reload_start: "/sfx/reload_start.mp3",
  reload_finish: "/sfx/reload_finish.mp3",
  dry_fire: "/sfx/dry_fire.mp3",
};

/** Sounds the engine should treat as seamless loops. */
export const SFX_LOOPS: readonly SfxName[] = [
  "rain_loop",
  "fire_loop",
  "wind_loop",
  "waves_loop",
  "crickets_loop",
  "heartbeat",
];
