// Map projection: world XZ (ground plane, origin-centered, +Y up) -> square
// top-down image pixels. The map is NORTH-UP with north = +Z: +Z maps to
// image-up (iy=0, the top edge). +X maps to image-LEFT (and -X to the right) —
// this is a TRUE bird's-eye (viewed from +Y looking down), not a mirror. Why the
// X flip: the world's yaw is left-handed for a +Z-up image (at yaw 0 a player
// faces -Z and their right hand points +X — see PlayerCamera's right vector), so
// drawing +X on the right would mirror east/west and make a rotate-to-heading
// minimap turn the wrong way. Flipping X keeps east (-X) on the right where a
// north-up map expects it, and lets the minimap be a plain rotation of this base.
// The world extent (`size`) is ALWAYS passed in (default WORLD_SIZE at the call
// site) so this module never imports the constant — doc 07's size tiers and a
// future World.size are a one-line caller change.

export interface MapProjection {
  /** world half-extent in meters (size / 2). */
  readonly half: number;
  /** image pixel dimension (square). */
  readonly px: number;
  /** meters per pixel = size / px. */
  readonly mpp: number;
  /** world (x,z) -> image (ix,iy). North-up: +Z is image-up (iy=0); +X is image-LEFT (true overhead, not mirrored). */
  worldToImage(x: number, z: number): { ix: number; iy: number };
  /** inverse: image (ix,iy) -> world (x,z). */
  imageToWorld(ix: number, iy: number): { x: number; z: number };
}

export function makeProjection(size: number, px: number): MapProjection {
  // Validate the public-API inputs: a zero/negative/NaN px would make mpp a
  // div-by-zero or NaN and silently corrupt every coordinate downstream.
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError(`makeProjection: size must be positive and finite (got ${size})`);
  }
  if (!Number.isInteger(px) || px <= 0) {
    throw new RangeError(`makeProjection: px must be a positive integer (got ${px})`);
  }
  const half = size / 2;
  const mpp = size / px;
  return {
    half,
    px,
    mpp,
    worldToImage(x: number, z: number): { ix: number; iy: number } {
      return { ix: ((half - x) / size) * px, iy: ((half - z) / size) * px };
    },
    imageToWorld(ix: number, iy: number): { x: number; z: number } {
      return { x: half - (ix / px) * size, z: half - (iy / px) * size };
    },
  };
}
