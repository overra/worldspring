#!/usr/bin/env node
// Wrangler config parity — the repo-root wrangler.jsonc (what the "Deploy to
// Cloudflare" button reads for a self-host) MUST describe the same Worker as
// apps/game/wrangler.jsonc (what `vite build` consumes and CI deploys).
//
// They are deliberately two files: the button treats a subdirectory URL as the
// whole repo, so pointing it at apps/game would hand a forker a tree with no
// packages/shared and no lockfile. The cost of that split is a DRIFT HAZARD —
// add a DO binding or bump a migration tag in one and forget the other, and a
// self-hosted server boots with different storage semantics than ours, silently.
//
// Nothing else can catch that: both files are individually valid, both typecheck
// (they aren't typed), and both deploy. Only a comparison catches it. Same shape
// as the worldgen + asset fingerprints — pin the invariant, not the bytes.
//
//   node scripts/wrangler-parity.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const GAME = join(import.meta.dirname, "..");

/** JSONC -> JSON. Strips // and /* *\/ comments outside string literals. */
function readJsonc(file) {
  const src = readFileSync(file, "utf8");
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  // tolerate trailing commas
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const root = readJsonc(join(ROOT, "wrangler.jsonc"));
const game = readJsonc(join(GAME, "wrangler.jsonc"));

const problems = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fields that define the WORKER's identity + storage contract. Everything
// else (main/assets paths, no_bundle, $schema) legitimately differs: the root
// config points at BUILD OUTPUT, apps/game's points at source.
const check = (label, a, b) => {
  if (!eq(a, b)) {
    problems.push(
      `  ${label}\n      root/wrangler.jsonc : ${JSON.stringify(a)}\n      apps/game/         : ${JSON.stringify(b)}`,
    );
  }
};

check("name", root.name, game.name);
check("compatibility_date", root.compatibility_date, game.compatibility_date);
check("durable_objects.bindings", root.durable_objects?.bindings, game.durable_objects?.bindings);
check("migrations", root.migrations, game.migrations);
check("assets.not_found_handling", root.assets?.not_found_handling, game.assets?.not_found_handling);

// A stranger's deploy must never contend for our production hostname. Wrangler
// accepts BOTH keys — `route` (a single string/object) and `routes` (an array) —
// so guarding only one leaves the other as an open door onto our domain.
for (const key of ["route", "routes"]) {
  if (root[key] !== undefined) {
    problems.push(
      `  root/wrangler.jsonc declares \`${key}\` — a self-hosted fork would fight for OUR domain.\n` +
        "      The button deploy must land on <worker>.<their-subdomain>.workers.dev.",
    );
  }
}
if (root.account_id !== undefined) {
  problems.push("  root/wrangler.jsonc declares `account_id` — that pins a stranger's deploy to OUR account.");
}

if (problems.length === 0) {
  console.log("wrangler-parity: root and apps/game describe the same Worker (name, DO bindings, migrations) ✓");
  process.exit(0);
}

console.error("wrangler-parity: THE TWO WRANGLER CONFIGS HAVE DRIFTED\n");
for (const p of problems) console.error(p);
console.error(`
The repo-root wrangler.jsonc is what the "Deploy to Cloudflare" button provisions into a
stranger's account; apps/game/wrangler.jsonc is what we build and deploy. If their Durable
Object bindings or migrations disagree, a self-hosted server gets different storage
semantics than ours — and nothing else in CI would notice.

Fix: mirror the change into BOTH files.
`);
process.exit(1);
