#!/usr/bin/env node
// scripts/build-artifact.mjs — doc 01 M2: build a versioned release artifact
// from the game build output, ready for R2 (`releases/v<version>/…`) and the
// GitHub Release mirror. Zero-dep Node ESM (Node 22+), house style of
// scripts/spike-deploy.mjs.
//
//   node scripts/build-artifact.mjs --version 0.4.0 [--out artifact]
//        [--prev-meta prev-meta.json]        # previous release's meta.json → wipesWorld
//        [--game-dist apps/game/dist]        # test override
//        [--shared-src packages/shared/src]  # test override
//        [--persistence apps/game/src/server/persistence.ts]
//
// What it emits under --out (default `artifact/`):
//   meta.json          — see docs/plans/01-create-server-deploy.md §3
//   index.js           — the worker bundle, byte-identical to the build
//   assets/<hash>      — one object per UNIQUE asset (Cloudflare asset hash)
//
// RELEASE GATE (doc 01 §3): hard-fails unless
//   (a) the built worker bundle contains the /api/server-info route,
//   (b) PROTOCOL_VERSION resolves to a number in packages/shared/src/protocol.ts,
//   (c) GAME_VERSION in version.ts equals --version (CI injects it from the tag
//       BEFORE building; a mismatch means the injection step was skipped).
// An artifact that fails the gate must never reach R2 — the deployer's verify
// step (§5 step 8) asserts on /api/server-info unconditionally because of this.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";

// ─── args ────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith("--")) die(`unexpected arg ${k}`);
  args[k.slice(2)] = process.argv[i + 1];
}
const VERSION = args.version ?? die("--version is required (strip the leading v)");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) die(`--version "${VERSION}" is not semver`);
const OUT = resolve(args.out ?? "artifact");
const GAME_DIST = resolve(args["game-dist"] ?? "apps/game/dist");
const SHARED_SRC = resolve(args["shared-src"] ?? "packages/shared/src");
const PERSISTENCE = resolve(args.persistence ?? "apps/game/src/server/persistence.ts");
const WORKER_BUNDLE = join(GAME_DIST, "worldspring/index.js");
const GEN_CONFIG = join(GAME_DIST, "worldspring/wrangler.json");
const ASSET_DIR = join(GAME_DIST, "client");

function die(msg) {
  console.error("build-artifact: FAIL —", msg);
  process.exit(1);
}
const log = (...a) => console.log("build-artifact:", ...a);

// Cloudflare asset hash: first 32 hex of sha256(base64(contents) + extWithoutDot)
// (research/cf-deploy.md §2.2; empirically validated by the M1 spike's asset
// round-trip — the upload API rejects wrong hashes).
const assetHash = (buf, ext) =>
  createHash("sha256").update(buf.toString("base64") + ext).digest("hex").slice(0, 32);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Read + parse JSON, routing BOTH failure modes through die() so error output
// stays consistent (a raw SyntaxError would bypass the FAIL prefix).
async function readJson(path, what) {
  const text = await readFile(path, "utf8").catch(() => die(`cannot read ${what} at ${path}`));
  try {
    return JSON.parse(text);
  } catch {
    return die(`${what} at ${path} is not valid JSON`);
  }
}

const CONTENT_TYPES = {
  html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", txt: "text/plain", md: "text/markdown", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", gif: "image/gif",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  woff: "font/woff", woff2: "font/woff2", wasm: "application/wasm",
};
const contentType = (ext) => CONTENT_TYPES[ext] ?? "application/octet-stream";

// Mirror wrangler's .assetsignore handling (exact names, dir/ prefixes, *.ext
// globs — the game's file only uses exact names; the file itself never ships).
function ignoreMatcher(lines) {
  const rules = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return (relPath) => {
    if (relPath === ".assetsignore") return true;
    return rules.some((r) => {
      if (r.endsWith("/")) return relPath.startsWith(r) || relPath.includes("/" + r);
      if (r.startsWith("*.")) return relPath.endsWith(r.slice(1));
      return relPath === r || relPath.endsWith("/" + r);
    });
  };
}

// ─── gates ───────────────────────────────────────────────────────────────────
async function runGates() {
  const bundle = await readFile(WORKER_BUNDLE).catch(() => die(`worker bundle missing at ${WORKER_BUNDLE} — run the game build first`));
  if (!bundle.includes("/api/server-info"))
    die("release gate (a): built worker bundle does not contain the /api/server-info route (doc 03 M2 missing from this tree?)");

  const protoSrc = await readFile(join(SHARED_SRC, "protocol.ts"), "utf8").catch(() => die(`cannot read ${SHARED_SRC}/protocol.ts`));
  const protoMatch = protoSrc.match(/export const PROTOCOL_VERSION\s*(?::\s*number)?\s*=\s*(\d+)\s*;/);
  if (!protoMatch) die("release gate (b): PROTOCOL_VERSION does not resolve to a number literal in protocol.ts");
  const protocolVersion = Number(protoMatch[1]);

  const versionSrc = await readFile(join(SHARED_SRC, "version.ts"), "utf8").catch(() => die(`cannot read ${SHARED_SRC}/version.ts`));
  const gvMatch = versionSrc.match(/export const GAME_VERSION\s*=\s*"([^"]+)"\s*;/);
  if (!gvMatch) die("release gate: GAME_VERSION not found in version.ts");
  if (gvMatch[1] !== VERSION)
    die(`release gate (c): GAME_VERSION "${gvMatch[1]}" != --version "${VERSION}" — CI must inject the tag version into version.ts BEFORE building`);

  const persistSrc = await readFile(PERSISTENCE, "utf8").catch(() => die(`cannot read ${PERSISTENCE}`));
  const schemaMatch = persistSrc.match(/const SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
  if (!schemaMatch) die("SCHEMA_VERSION not found in persistence.ts");

  return { bundle, protocolVersion, schemaVersion: Number(schemaMatch[1]) };
}

// ─── main ────────────────────────────────────────────────────────────────────
const { bundle, protocolVersion, schemaVersion } = await runGates();
log(`gates passed — PROTOCOL_VERSION=${protocolVersion} SCHEMA_VERSION=${schemaVersion} GAME_VERSION=${VERSION}`);

// wipesWorld: schemaVersion CHANGED vs the previous release (doc 01 §3/§7) —
// inequality on purpose, so a downgrade/rollback release warns exactly like a
// bump (either direction trips the server's wipe-on-mismatch). No previous
// meta (first release / R2 unreachable) → false, loudly.
let wipesWorld = false;
if (args["prev-meta"]) {
  const prev = await readJson(args["prev-meta"], "--prev-meta");
  if (typeof prev.schemaVersion !== "number") die("--prev-meta has no numeric schemaVersion");
  wipesWorld = schemaVersion !== prev.schemaVersion;
  log(`prev release v${prev.version} schemaVersion=${prev.schemaVersion} → wipesWorld=${wipesWorld}`);
} else {
  log("no --prev-meta given — assuming first release, wipesWorld=false");
}

// Asset manifest (honoring .assetsignore, like wrangler does).
const ignoreLines = await readFile(join(ASSET_DIR, ".assetsignore"), "utf8").then((s) => s.split("\n")).catch(() => []);
const ignored = ignoreMatcher(ignoreLines);
const assetManifest = {};
const byHash = new Map();
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { await walk(p); continue; }
    const rel = relative(ASSET_DIR, p).split("\\").join("/");
    if (ignored(rel)) { log(`  (ignored: ${rel})`); continue; }
    const buf = await readFile(p);
    const ext = extname(p).slice(1);
    const hash = assetHash(buf, ext);
    assetManifest["/" + rel] = { hash, size: buf.length, contentType: contentType(ext) };
    byHash.set(hash, buf);
  }
}
await walk(ASSET_DIR);
if (Object.keys(assetManifest).length === 0) die(`no assets found under ${ASSET_DIR}`);

// metadataTemplate: derived from the build's generated wrangler.json so config
// drift is impossible (doc 01 §3) — with ONE deliberate override: community
// deploys ship observability at 1% head sampling (the §4.3 cost-bomb guard; the
// official instance keeps its own 100% default because IT deploys via wrangler,
// not via this artifact). Per-deploy fields (vars, secrets, tags, annotations,
// migrations, assets.jwt) are merged in by the deployer at §5 step 6.
const gen = await readJson(GEN_CONFIG, "generated wrangler config");
if (gen.main !== "index.js") die(`generated config main is "${gen.main}" — expected index.js (vite plugin output changed?)`);
const metadataTemplate = {
  main_module: "index.js",
  compatibility_date: gen.compatibility_date ?? die("generated config has no compatibility_date"),
  ...(gen.compatibility_flags?.length ? { compatibility_flags: gen.compatibility_flags } : {}),
  ...(gen.keep_vars ? { keep_vars: true } : {}),
  bindings: (gen.durable_objects?.bindings ?? []).map((b) => ({
    type: "durable_object_namespace", name: b.name, class_name: b.class_name,
  })),
  assets: { config: { not_found_handling: gen.assets?.not_found_handling ?? "single-page-application" } },
  observability: { enabled: true, head_sampling_rate: 0.01 },
};
if (metadataTemplate.bindings.length === 0) die("generated config has no DO bindings — GAME/GameRoom missing?");

const migrations = gen.migrations ?? [];
if (migrations.length === 0) die("generated config has no migrations history");

const meta = {
  artifactSchema: 1,
  version: VERSION,
  commit: process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
  builtAt: new Date().toISOString(),
  schemaVersion,
  wipesWorld,
  protocolVersion,
  worker: { path: "index.js", sha256: sha256(bundle), bytes: bundle.length },
  assetManifest,
  metadataTemplate,
  migrations,
};

// ─── write + self-verify ─────────────────────────────────────────────────────
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "assets"), { recursive: true });
await writeFile(join(OUT, "index.js"), bundle);
await writeFile(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
for (const [hash, buf] of byHash) await writeFile(join(OUT, "assets", hash), buf);

// Self-verify: re-read what we wrote and check every hash in meta.json.
const reWorker = await readFile(join(OUT, "index.js"));
if (sha256(reWorker) !== meta.worker.sha256) die("self-verify: worker sha256 mismatch after write");
for (const [path, a] of Object.entries(meta.assetManifest)) {
  const buf = await readFile(join(OUT, "assets", a.hash)).catch(() => die(`self-verify: asset object missing for ${path}`));
  if (assetHash(buf, extname(path).slice(1)) !== a.hash) die(`self-verify: hash mismatch for ${path}`);
}

const totalBytes = [...byHash.values()].reduce((n, b) => n + b.length, 0);
log(`OK → ${OUT}`);
log(`  version=${VERSION} commit=${meta.commit.slice(0, 8)} wipesWorld=${wipesWorld}`);
log(`  worker: ${(bundle.length / 1024).toFixed(0)} KB  assets: ${Object.keys(assetManifest).length} files, ${byHash.size} unique, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
