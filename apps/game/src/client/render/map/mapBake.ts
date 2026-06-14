// doc 12 M4 — the baked static map base (client). The world is immutable per
// seed, so we rasterize the biome base + POIs to an offscreen canvas ONCE and
// memoize it by world identity; the full map and the minimap both blit sub-rects
// of this one canvas. Pure 2D canvas — NO three.js (UI contract). The heavy
// heightAt sampling runs here, once, off the server tick and off the rAF frame.

import { WATER_LEVEL, WORLD_SIZE } from "@worldspring/shared/constants";
import {
  FOG_CELL_M,
  FOG_REVEAL_RADIUS_M,
  hasExploredIndex,
  type ExploredGrid,
} from "@worldspring/shared/fog";
import { makeProjection, type MapProjection } from "@worldspring/shared/map/projection";
import { mapPOIs, rasterizeBase, type MapShape } from "@worldspring/shared/map/raster";
import { yawToDir } from "@worldspring/shared/math";
import type { World } from "@worldspring/shared/world";
import { clientWorld } from "@/client/runtime";

/** Baked base resolution (square). One ~16 MB RGBA canvas, disposed on reset. */
const BAKE_PX = 1024;

// A detached HTMLCanvasElement (never in the DOM) — works on every target with
// no OffscreenCanvas/Safari caveat; a one-time 1024² bake doesn't need the
// worker-offload OffscreenCanvas would buy.
type Canvas2D = HTMLCanvasElement;
type Ctx2D = CanvasRenderingContext2D;

export interface BakedMap {
  /** world meters (WORLD_SIZE today; world.size once doc 07 lands it). */
  size: number;
  /** baked pixel dimension. */
  px: number;
  proj: MapProjection;
  /** biome raster + POIs + labels, painted once. */
  base: Canvas2D;
}

function createCanvas(px: number): { canvas: Canvas2D; ctx: Ctx2D } {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D };
}

/** Paint the projected POI vector layer onto the baked base. */
function drawPOIs(ctx: Ctx2D, shapes: MapShape[], proj: MapProjection, px: number): void {
  const order = { disc: 0, rect: 1, ring: 2, label: 3 } as const;
  for (const s of [...shapes].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (s.kind === "disc") {
      const c = proj.worldToImage(s.x, s.z);
      ctx.beginPath();
      ctx.arc(c.ix, c.iy, Math.max(0.5, s.r / proj.mpp), 0, Math.PI * 2);
      ctx.fillStyle = s.fill;
      ctx.fill();
      if (s.stroke) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = s.stroke;
        ctx.stroke();
      }
    } else if (s.kind === "rect") {
      const tl = proj.worldToImage(s.cx - s.halfW, s.cz + s.halfD); // +Z up: top = max z
      const w = (2 * s.halfW) / proj.mpp;
      const h = (2 * s.halfD) / proj.mpp;
      ctx.fillStyle = s.fill;
      ctx.fillRect(tl.ix, tl.iy, w, h);
      if (s.stroke) {
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = s.stroke;
        ctx.strokeRect(tl.ix, tl.iy, w, h);
      }
    } else if (s.kind === "ring") {
      const c = proj.worldToImage(s.x, s.z);
      ctx.beginPath();
      ctx.arc(c.ix, c.iy, s.r / proj.mpp, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = s.stroke;
      ctx.stroke();
    } else {
      const c = proj.worldToImage(s.x, s.z);
      ctx.font = `600 ${px / 55}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = px / 380;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.fillStyle = "#f5efe0";
      const t = s.text.toUpperCase();
      ctx.strokeText(t, c.ix, c.iy);
      ctx.fillText(t, c.ix, c.iy);
    }
  }
}

function bakeMap(world: World, size: number): BakedMap {
  const px = BAKE_PX;
  const proj = makeProjection(size, px);
  const { pixels } = rasterizeBase(world.heightAt, size, px, WATER_LEVEL);
  const { canvas, ctx } = createCanvas(px);
  const img = ctx.createImageData(px, px);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  drawPOIs(ctx, mapPOIs(world), proj, px);
  return { size, px, proj, base: canvas };
}

let cached: { world: World; baked: BakedMap } | null = null;

/** Get the baked map for the current world, baking (once) on first call. Returns
 * null before the world exists. Memoized by world identity, so a new join
 * (createWorld returns a fresh object) rebuilds it. */
export function getBakedMap(): BakedMap | null {
  const world = clientWorld.world;
  if (!world) return null;
  if (cached && cached.world === world) return cached.baked;
  const baked = bakeMap(world, WORLD_SIZE); // world.size once doc 07 lands it
  cached = { world, baked };
  return baked;
}

/** Drop the baked canvas (called from resetClientWorld on disconnect). */
export function disposeBakedMap(): void {
  cached = null;
}

/**
 * Blit a source window of the baked base to fill `destPx`×`destPx`, clamping the
 * source rect to the baked bounds so a window that runs off the island edge
 * shows the (pre-filled) background there instead of a stretched smear.
 */
export function blitWindow(
  ctx: Ctx2D,
  base: Canvas2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  destPx: number,
  basePx: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const kx = destPx / sw;
  const ky = destPx / sh;
  let dx = 0;
  let dy = 0;
  let dw = destPx;
  let dh = destPx;
  if (sx < 0) {
    dx = -sx * kx;
    dw += sx * kx;
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    dy = -sy * ky;
    dh += sy * ky;
    sh += sy;
    sy = 0;
  }
  if (sx + sw > basePx) {
    dw -= (sx + sw - basePx) * kx;
    sw = basePx - sx;
  }
  if (sy + sh > basePx) {
    dh -= (sy + sh - basePx) * ky;
    sh = basePx - sy;
  }
  if (sw > 0 && sh > 0) ctx.drawImage(base, sx, sy, sw, sh, dx, dy, dw, dh);
}

/** A world (x,z) -> destination canvas pixel mapping. */
export type ToPx = (x: number, z: number) => { x: number; y: number };

/**
 * doc 12 M6 — darken every unexplored cell (the fog) over the already-drawn
 * base. Call BETWEEN the base blit and drawDynamicLayer, so terrain + POI labels
 * you haven't found are hidden but live entities + the you-marker stay visible.
 * The disk around the player is always kept clear (the server marks it each tick,
 * but this also smooths interpolation lag). Cheap: dim^2 fillRects (625 standard).
 */
export function drawFog(ctx: Ctx2D, g: ExploredGrid, toPx: ToPx): void {
  const half = g.size / 2;
  const me = clientWorld.me;
  const r2 = FOG_REVEAL_RADIUS_M * FOG_REVEAL_RADIUS_M;
  ctx.fillStyle = "rgba(8,11,15,0.86)";
  for (let cz = 0; cz < g.dim; cz++) {
    for (let cx = 0; cx < g.dim; cx++) {
      if (hasExploredIndex(g, cz * g.dim + cx)) continue;
      const wcx = (cx + 0.5) * FOG_CELL_M - half;
      const wcz = (cz + 0.5) * FOG_CELL_M - half;
      const dx = wcx - me.x;
      const dz = wcz - me.z;
      if (dx * dx + dz * dz <= r2) continue; // keep the player's surroundings lit
      // +Z is image-up: the cell's top-left in image space is (minX, maxZ).
      const tl = toPx(cx * FOG_CELL_M - half, (cz + 1) * FOG_CELL_M - half);
      const br = toPx((cx + 1) * FOG_CELL_M - half, cz * FOG_CELL_M - half);
      ctx.fillRect(tl.x, tl.y, br.x - tl.x + 1, br.y - tl.y + 1); // +1 px: no seams
    }
  }
}

/**
 * Draw the live overlay (airdrops island-wide, other players, zombies, and the
 * local you-marker with heading) onto `ctx` using `toPx`. `s` scales marker
 * sizes (the minimap passes a smaller value). Reads clientWorld directly — no
 * React, called from an interval/raf in the panel + minimap.
 */
export function drawDynamicLayer(ctx: Ctx2D, toPx: ToPx, s: number): void {
  // Airdrops — island-wide (never interest-filtered), so always meaningful.
  for (const d of clientWorld.drops) {
    const p = toPx(d.x, d.z);
    ctx.fillStyle = "#e8c04a";
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = s;
    ctx.fillRect(p.x - 3 * s, p.y - 3 * s, 6 * s, 6 * s);
    ctx.strokeRect(p.x - 3 * s, p.y - 3 * s, 6 * s, 6 * s);
  }
  // Zombies within the interest bubble.
  ctx.fillStyle = "rgba(120,170,90,0.9)";
  for (const z of clientWorld.zombies.values()) {
    const p = toPx(z.x, z.z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Other players within the interest bubble.
  for (const pl of clientWorld.players.values()) {
    const p = toPx(pl.x, pl.z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 * s, 0, Math.PI * 2);
    ctx.fillStyle = "#e6e6e6";
    ctx.fill();
    ctx.lineWidth = s;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.stroke();
  }
  // You — an arrow pointing along the heading. yawToDir = [-sin,-cos] = (fx,fz);
  // +Z is image-up, so the canvas rotation that aligns the up-triangle is
  // atan2(fx, fz).
  const me = clientWorld.me;
  const p = toPx(me.x, me.z);
  const [fx, fz] = yawToDir(me.yaw);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(fx, fz));
  ctx.beginPath();
  ctx.moveTo(0, -6 * s);
  ctx.lineTo(4 * s, 5 * s);
  ctx.lineTo(0, 2.5 * s);
  ctx.lineTo(-4 * s, 5 * s);
  ctx.closePath();
  ctx.fillStyle = "#ffd23f";
  ctx.fill();
  ctx.lineWidth = s;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.stroke();
  ctx.restore();
}
