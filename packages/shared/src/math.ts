export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path interpolation between two angles in radians. */
export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function dist3D(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Axis-aligned box used for static collision. y0/y1 are the vertical extent. */
export interface Aabb {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y0: number;
  y1: number;
}

/**
 * Push a circle (px, pz, r) out of a 2D AABB. Returns corrected [x, z]
 * or null if there is no overlap.
 */
export function pushCircleOutOfAabb(
  px: number,
  pz: number,
  r: number,
  box: Aabb,
): [number, number] | null {
  const cx = clamp(px, box.minX, box.maxX);
  const cz = clamp(pz, box.minZ, box.maxZ);
  const dx = px - cx;
  const dz = pz - cz;
  const dSq = dx * dx + dz * dz;
  if (dSq >= r * r) return null;
  if (dSq > 1e-9) {
    const d = Math.sqrt(dSq);
    const push = (r - d) / d;
    return [px + dx * push, pz + dz * push];
  }
  // Center is inside the box: push out along the nearest face.
  const left = px - box.minX + r;
  const right = box.maxX - px + r;
  const near = pz - box.minZ + r;
  const far = box.maxZ - pz + r;
  const min = Math.min(left, right, near, far);
  if (min === left) return [box.minX - r, pz];
  if (min === right) return [box.maxX + r, pz];
  if (min === near) return [px, box.minZ - r];
  return [px, box.maxZ + r];
}

/** Push a circle out of another circle (tree trunks). Returns corrected [x, z] or null. */
export function pushCircleOutOfCircle(
  px: number,
  pz: number,
  r: number,
  ox: number,
  oz: number,
  or_: number,
): [number, number] | null {
  const dx = px - ox;
  const dz = pz - oz;
  const dSq = dx * dx + dz * dz;
  const minDist = r + or_;
  if (dSq >= minDist * minDist) return null;
  const d = Math.sqrt(dSq) || 1e-6;
  return [ox + (dx / d) * minDist, oz + (dz / d) * minDist];
}

/**
 * Ray vs 3D AABB slab test. Returns distance t along the (normalized) ray,
 * or null if no hit in (0, maxDist].
 */
export function rayAabb(
  origin: Vec3,
  dir: Vec3,
  box: Aabb,
  maxDist: number,
): number | null {
  let tMin = 0;
  let tMax = maxDist;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, box.minX, box.maxX],
    [origin.y, dir.y, box.y0, box.y1],
    [origin.z, dir.z, box.minZ, box.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin > 0 ? tMin : null;
}

/**
 * Ray vs vertical capsule approximated as an infinite cylinder clipped to
 * [cy0, cy1]. Good enough for hit detection on humanoids. Returns t or null.
 */
export function rayVerticalCylinder(
  origin: Vec3,
  dir: Vec3,
  cx: number,
  cz: number,
  cy0: number,
  cy1: number,
  r: number,
  maxDist: number,
): number | null {
  const ox = origin.x - cx;
  const oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-9) {
    // Vertical ray: hit only if we are inside the circle.
    if (ox * ox + oz * oz > r * r) return null;
    const t = dir.y > 0 ? cy0 - origin.y : origin.y - cy1;
    return t > 0 && t <= maxDist ? t : null;
  }
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - r * r;
  // Origin already inside the cylinder (point-blank shot): immediate hit if
  // the height overlaps — the entry-face root would be negative otherwise.
  if (c < 0 && origin.y >= cy0 && origin.y <= cy1) return 0.01;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t = (-b - sq) / (2 * a);
  if (t <= 0 || t > maxDist) return null;
  const hitY = origin.y + dir.y * t;
  if (hitY < cy0 || hitY > cy1) return null;
  return t;
}

/** Is target within a horizontal cone from (ax, az) facing `yaw`? */
export function inMeleeCone(
  ax: number,
  az: number,
  yaw: number,
  tx: number,
  tz: number,
  range: number,
  halfAngle: number,
): boolean {
  const dx = tx - ax;
  const dz = tz - az;
  const dSq = dx * dx + dz * dz;
  if (dSq > range * range) return false;
  if (dSq < 0.01) return true;
  // Forward vector for yaw: see yawToDir — (-sin(yaw), -cos(yaw)).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const d = Math.sqrt(dSq);
  const dot = (dx / d) * fx + (dz / d) * fz;
  return dot >= Math.cos(halfAngle);
}

/**
 * Convention: yaw 0 looks toward -Z, positive yaw turns left (counter-clockwise
 * when viewed from above), matching three.js object rotation order.
 * Forward = (-sin(yaw), -cos(yaw)) in the XZ plane.
 */
export function yawToDir(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** Full 3D look direction from yaw + pitch (pitch > 0 looks up). */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
