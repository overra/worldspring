// Map projection: world XZ (ground plane, origin-centered, +Y up) -> square
// top-down image pixels. North is -Z and maps to image-up (iy=0), matching the
// yaw-0-faces-(-Z) convention in math.ts. The world extent (`size`) is ALWAYS
// passed in (default WORLD_SIZE at the call site) so this module never imports
// the constant — doc 07's size tiers and a future World.size are a one-line
// caller change, not an edit here.

export interface MapProjection {
  /** world half-extent in meters (size / 2). */
  readonly half: number;
  /** image pixel dimension (square). */
  readonly px: number;
  /** meters per pixel = size / px. */
  readonly mpp: number;
  /** world (x,z) -> image (ix,iy). North (-Z) is image-up (iy=0). */
  worldToImage(x: number, z: number): { ix: number; iy: number };
  /** inverse: image (ix,iy) -> world (x,z). */
  imageToWorld(ix: number, iy: number): { x: number; z: number };
}

export function makeProjection(size: number, px: number): MapProjection {
  const half = size / 2;
  const mpp = size / px;
  return {
    half,
    px,
    mpp,
    worldToImage(x: number, z: number): { ix: number; iy: number } {
      return { ix: ((x + half) / size) * px, iy: ((half - z) / size) * px };
    },
    imageToWorld(ix: number, iy: number): { x: number; z: number } {
      return { x: (ix / px) * size - half, z: half - (iy / px) * size };
    },
  };
}
