// Offline top-down map renderer (doc 12 M1).
//
//   pnpm --filter @worldspring/shared map:render -- --seed 1337 --px 1024 --out island.svg
//
// Renders the deterministic world for a seed to a top-down image using the SAME
// shared raster core (packages/shared/src/map/) the in-game map uses, so the
// design/admin artifact and the in-game map are the same island. Output is SVG
// by default (a zlib-compressed PNG biome base embedded as <image>, plus crisp
// vector POIs + town labels on top); `--out *.png` writes the flat raster only.
//
// ZERO new dependencies: esbuild (already a devDep) bundles the TS exactly like
// fingerprint.mjs; the PNG is written by the ~50-line encoder below using Node's
// built-in zlib. The image is COSMETIC — heightAt is ULP-divergent macOS<->Linux
// (see fingerprint.mjs), so never hash it or gate CI on its bytes.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const seed = Number(arg("seed", "1337"));
const px = Number(arg("px", "1024"));
const out = arg("out", `island-${seed}.svg`);
const asPng = out.toLowerCase().endsWith(".png");

// ---- bundle the shared TS (mirrors fingerprint.mjs) ----
const dir = resolve(join(import.meta.dirname, "..", "src"));
const bundled = await build({
  stdin: {
    contents:
      'export { createWorld } from "./world.ts";\n' +
      'export { WORLD_SIZE, WATER_LEVEL } from "./constants.ts";\n' +
      'export { rasterizeBase, mapPOIs } from "./map/raster.ts";\n' +
      'export { makeProjection } from "./map/projection.ts";\n',
    resolveDir: dir,
    loader: "ts",
    sourcefile: "map-render-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { createWorld, WORLD_SIZE, WATER_LEVEL, rasterizeBase, mapPOIs, makeProjection } =
  await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

// ---- render (invoked at the bottom, after every const/helper is initialized) ----
function render() {
  const size = WORLD_SIZE; // doc 07 will make this world.size; the core already takes it as a param
  const world = createWorld(seed);
  const t0 = performance.now();
  const { pixels } = rasterizeBase(world.heightAt, size, px, WATER_LEVEL);
  const proj = makeProjection(size, px);
  const ms = Math.round(performance.now() - t0);

  const png = encodePng(px, px, pixels);

  if (asPng) {
    writeFileSync(out, png);
  } else {
    writeFileSync(out, buildSvg(world, proj, px, png));
  }
  process.stdout.write(
    `map:render seed ${seed} -> ${out} (${px}x${px}, ${world.towns.length} towns, ` +
      `${world.buildings.length} buildings, rasterized in ${ms}ms)\n`,
  );
}

// ---------- SVG assembly ----------
function buildSvg(world, proj, px, png) {
  const b64 = png.toString("base64");
  const shapes = mapPOIs(world);
  const els = [];
  // discs/rects first, then rings, then labels on top
  const order = { disc: 0, rect: 1, ring: 2, label: 3 };
  for (const s of [...shapes].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (s.kind === "disc") {
      const c = proj.worldToImage(s.x, s.z);
      els.push(
        `<circle cx="${f(c.ix)}" cy="${f(c.iy)}" r="${f(s.r / proj.mpp)}" fill="${s.fill}"` +
          (s.stroke ? ` stroke="${s.stroke}"` : "") +
          ` />`,
      );
    } else if (s.kind === "rect") {
      const tl = proj.worldToImage(s.cx - s.halfW, s.cz + s.halfD); // -x,+z = top-left
      const w = (2 * s.halfW) / proj.mpp;
      const h = (2 * s.halfD) / proj.mpp;
      els.push(
        `<rect x="${f(tl.ix)}" y="${f(tl.iy)}" width="${f(w)}" height="${f(h)}" fill="${s.fill}"` +
          (s.stroke ? ` stroke="${s.stroke}" stroke-width="0.6"` : "") +
          ` />`,
      );
    } else if (s.kind === "ring") {
      const c = proj.worldToImage(s.x, s.z);
      els.push(`<circle cx="${f(c.ix)}" cy="${f(c.iy)}" r="${f(s.r / proj.mpp)}" fill="none" stroke="${s.stroke}" />`);
    } else {
      const c = proj.worldToImage(s.x, s.z);
      els.push(
        `<text x="${f(c.ix)}" y="${f(c.iy)}" text-anchor="middle" dominant-baseline="middle" ` +
          `font-family="ui-sans-serif,system-ui,sans-serif" font-size="${f(px / 55)}" font-weight="600" ` +
          `fill="#f5efe0" stroke="rgba(0,0,0,0.65)" stroke-width="${f(px / 380)}" paint-order="stroke" ` +
          `style="letter-spacing:0.06em">${esc(s.text.toUpperCase())}</text>`,
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">\n` +
    `<image href="data:image/png;base64,${b64}" x="0" y="0" width="${px}" height="${px}" />\n` +
    els.join("\n") +
    `\n<rect x="0.5" y="0.5" width="${px - 1}" height="${px - 1}" fill="none" stroke="rgba(0,0,0,0.5)" />\n` +
    `<text x="${f(px / 2)}" y="${f(px / 36)}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" ` +
    `font-size="${f(px / 48)}" font-weight="700" fill="#f5efe0" stroke="rgba(0,0,0,0.6)" stroke-width="${f(px / 500)}" ` +
    `paint-order="stroke">N</text>\n</svg>\n`
  );
}

const f = (n) => Math.round(n * 100) / 100;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ---------- minimal zero-dep PNG (RGBA, 8-bit) ----------
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // filtered scanlines: a 0 (None) filter byte prefixes each row of RGBA bytes
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // None filter
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

render();
