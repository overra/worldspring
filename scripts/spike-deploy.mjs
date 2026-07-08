#!/usr/bin/env node
// scripts/spike-deploy.mjs — Worldspring doc 01 M1 spike harness.
// Burns down the six UNCONFIRMED platform behaviors + keep_bindings + the
// Workers-Logs WS measurement against a THROWAWAY scratch Cloudflare account.
// Zero-dep Node ESM (Node 22+), same house style as apps/game/scripts/loadtest.mjs:
// built-in fetch + WebSocket globals, no npm installs.
//
// Phases (run one at a time, fill CONFIG between them):
//   node scripts/spike-deploy.mjs scopes        # U1  GET /oauth/scopes
//   node scripts/spike-deploy.mjs create-client  # §2  POST /oauth_clients (private)
//   node scripts/spike-deploy.mjs login          # U3,U4 auth URL + token exchange
//   node scripts/spike-deploy.mjs deploy         # U2,U5,U6,U7,U8(part) full §5 seq
//   node scripts/spike-deploy.mjs update-tests   # U8,U10 migrations-omit + keep_bindings
//   node scripts/spike-deploy.mjs cleanup        # U9  force-delete + delete client
//
// SAFETY: every Workers write targets the SCRATCH account only. force-delete in
// cleanup DESTROYS the DO world — that is the point, on a throwaway worker.
// Re-verify endpoint shapes at docs/plans/research/cf-{oauth,deploy}.md before trusting output.

import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, extname, relative } from "node:path";

// ─── CONFIG — fill these in across the phases ────────────────────────────────
const CONFIG = {
  // Bootstrap API token on the SCRATCH account (Edit Workers + OAuth Clients Write):
  BOOTSTRAP_TOKEN: process.env.CF_BOOTSTRAP_TOKEN ?? "TODO",
  // Account that OWNS the OAuth client (private visibility => consenting user must
  // be a member). Simplest = the scratch account id:
  CLIENT_OWNER_ACCOUNT_ID: process.env.CF_CLIENT_OWNER_ACCOUNT_ID ?? "TODO",
  // From phase `scopes` (U1): the Workers-write id (guess workers-platform.write)
  // and account-read id (account.read). openid is added automatically/explicitly.
  SCOPE_IDS: ["openid", "account.read", "TODO-workers-write-scope-id"],
  // From phase `create-client`:
  CLIENT_ID: process.env.CF_CLIENT_ID ?? "TODO",
  CLIENT_SECRET: process.env.CF_CLIENT_SECRET ?? "TODO",
  REDIRECT_URI: "http://localhost:8788/oauth/callback", // localhost-accepted? = U6/cf-oauth §6
  // Throwaway script name: generated + persisted by resolveScriptName() in the
  // `deploy` phase (env override CF_SPIKE_SCRIPT_NAME) so every phase targets the
  // SAME worker. NOT a static field — a per-`node`-run random broke update/clean.
  WORKER_BUNDLE: "apps/game/dist/worldspring/index.js", // built by `pnpm --filter @worldspring/game build`
  ASSET_DIR: "apps/game/dist/client",                    // ~90 files / 7.5 MB (honors .assetsignore)
  COMPAT_DATE: "2026-06-01",
  // Persisted between phases via this file (deploy writes account_id/access_token here):
};
const API = "https://api.cloudflare.com/client/v4";
const DASH = "https://dash.cloudflare.com";
const STATE_FILE = ".spike-state.json"; // gitignored: {accountId, accessToken, subdomain, scriptName}

// ─── tiny helpers (style mirrors loadtest.mjs) ───────────────────────────────
const log = (...a) => console.log(...a);
const die = (m) => { console.error("spike:", m); process.exit(1); };
const loadState = async () => { try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { return {}; } };
const saveState = async (s) => { const { writeFile } = await import("node:fs/promises"); await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); };

// Resolve the throwaway script name, persisting it so every phase (separate
// `node` runs) targets the SAME worker. `deploy` creates it; later phases die if
// it is missing rather than inventing a fresh (nonexistent) name.
async function resolveScriptName(state, { create }) {
  if (state.scriptName) return state.scriptName;
  state.scriptName =
    process.env.CF_SPIKE_SCRIPT_NAME ??
    (create ? "spike-worldspring-" + randomBytes(3).toString("hex") : null);
  if (!state.scriptName) die("no script name in state — run `deploy` first (or set CF_SPIKE_SCRIPT_NAME)");
  await saveState(state);
  return state.scriptName;
}

async function cf(path, { method = "GET", token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  log(`  ${method} ${path} -> ${res.status}`);
  if (raw) return { status: res.status, json, headers: res.headers };
  if (!res.ok) log("  !! body:", JSON.stringify(json).slice(0, 800));
  return { status: res.status, json };
}

// Cloudflare asset hash: first 32 hex of sha256(base64(contents)+extWithoutDot). cf-deploy §2.2
function assetHash(buf, ext) {
  return createHash("sha256").update(buf.toString("base64") + ext).digest("hex").slice(0, 32);
}
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ─── PHASE: scopes (U1) ──────────────────────────────────────────────────────
async function phaseScopes() {
  // GET /oauth/scopes confirmed live: needs auth, no role; paginate (total ~2000).
  let page = 1, all = [];
  for (;;) {
    const { json } = await cf(`/oauth/scopes?page=${page}&per_page=200`, { token: CONFIG.BOOTSTRAP_TOKEN });
    const r = json?.result ?? [];
    all = all.concat(r);
    if (r.length < 200) break;
    page++;
  }
  const hits = all.filter((s) => /worker|account/i.test(s.id + " " + (s.name ?? "")));
  log(`\n${all.length} scopes total. Worker/account candidates:`);
  for (const s of hits) log(`  ${s.id}\t${s.name}\t[${s.category ?? ""}]`);
  log("\n>> Pin the Workers-WRITE id + account.read into CONFIG.SCOPE_IDS, record in cf-oauth.md §3.");
}

// ─── PHASE: create-client (§2) ───────────────────────────────────────────────
async function phaseCreateClient() {
  const body = {
    client_name: "Worldspring M1 Spike",
    grant_types: ["authorization_code"],            // NO refresh_token (doc §6)
    redirect_uris: [CONFIG.REDIRECT_URI],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
    scopes: CONFIG.SCOPE_IDS,
    // visibility defaults to "private" — do NOT promote (permanent; needs DNS TXT).
  };
  const { json } = await cf(`/accounts/${CONFIG.CLIENT_OWNER_ACCOUNT_ID}/oauth_clients`, {
    method: "POST", token: CONFIG.BOOTSTRAP_TOKEN,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  log("\nclient_id:", json?.result?.client_id);
  log("client_secret (SHOWN ONCE — capture now):", json?.result?.client_secret);
  log("redirect accepted? localhost rule = U6/cf-oauth §6. If rejected, adjust REDIRECT_URI and record.");
  log(">> Put CLIENT_ID/CLIENT_SECRET into CONFIG (or CF_CLIENT_ID/CF_CLIENT_SECRET env).");
}

// ─── PHASE: login (U3 auth params, U4 token shape) ───────────────────────────
async function phaseLogin() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");
  const authUrl = `${DASH}/oauth2/auth?response_type=code&client_id=${encodeURIComponent(CONFIG.CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}`
    + `&scope=${encodeURIComponent(CONFIG.SCOPE_IDS.join(" "))}`
    + `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  log("\n>> OPEN THIS URL as the SCRATCH user, click Authorize:\n", authUrl, "\n");
  const code = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, "http://localhost:8788");
      if (u.pathname === "/oauth/callback") {
        res.end("Spike: code received. Return to terminal.");
        srv.close();
        if (u.searchParams.get("state") !== state) die("state mismatch");
        resolve(u.searchParams.get("code"));
      } else res.end("ok");
    }).listen(8788, () => log("listening on http://localhost:8788 for the callback..."));
  });
  // Token exchange — client_secret_basic confirmed accepted at /oauth2/token.
  const basic = Buffer.from(`${CONFIG.CLIENT_ID}:${CONFIG.CLIENT_SECRET}`).toString("base64");
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CONFIG.REDIRECT_URI, code_verifier: verifier });
  const { json } = await cf(`${DASH}/oauth2/token`, {
    method: "POST", token: undefined,
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(), raw: true,
  }).then((r) => r);
  log("\nTOKEN RESPONSE (record verbatim in cf-oauth.md §4):");
  log("  expires_in:", json?.expires_in, " token_type:", json?.token_type, " refresh_token present?", "refresh_token" in (json ?? {}));
  log("  id_token present?", "id_token" in (json ?? {}), " scope echoed:", json?.scope);
  if (json?.id_token) { const [, p] = json.id_token.split("."); log("  id_token claims:", Buffer.from(p, "base64").toString()); }
  const st = await loadState(); st.accessToken = json?.access_token; await saveState(st);
  log(">> Re-run `login` once more to observe whether consent is re-prompted (U4 / doc §6).");
}

// ─── PHASE: deploy (U2,U5,U6,U7) — full §5 sequence ──────────────────────────
async function phaseDeploy() {
  const st = await loadState();
  const token = st.accessToken ?? die("no access token — run `login` first");
  const scriptName = await resolveScriptName(st, { create: true });
  // U2: account discovery — fail closed instead of silently using accounts[0].
  const acc = await cf(`/accounts`, { token });
  const accounts = acc.json?.result ?? [];
  if (accounts.length === 0) die("no accounts from GET /accounts (U2)");
  if (accounts.length > 1 && !process.env.CF_ACCOUNT_ID)
    die(`multiple accounts granted (${accounts.map((a) => a.id).join(", ")}) — set CF_ACCOUNT_ID to pick the scratch one`);
  const accountId = process.env.CF_ACCOUNT_ID ?? accounts[0].id;
  log("  using account_id:", accountId, " (U2 — confirm this is the granted scratch acct)");
  st.accountId = accountId; await saveState(st);
  // U5: subdomain GET-on-empty + PUT (+ optionally force a conflict by hand first)
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`, { token, raw: true });
  log("  subdomain GET-on-(maybe-empty) status/body (U5):", sub.status, JSON.stringify(sub.json).slice(0, 300));
  let subdomain = sub.json?.result?.subdomain;
  if (!subdomain) {
    const want = "ws-spike-" + randomBytes(3).toString("hex");
    const put = await cf(`/accounts/${accountId}/workers/subdomain`, {
      method: "PUT", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ subdomain: want }),
    });
    subdomain = put.json?.result?.subdomain ?? want;
    log("  >> To capture the CONFLICT shape (U5), PUT a common name by hand and record the error code.");
  }
  st.subdomain = subdomain; await saveState(st);
  // (optional but recommended) asset round-trip to validate the hash algorithm (U-none, but proves §2.2)
  const manifest = await buildManifest(CONFIG.ASSET_DIR);
  let completionJwt = null;
  const sess = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
    method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: manifest.map }),
  });
  const buckets = sess.json?.result?.buckets ?? [];
  completionJwt = sess.json?.result?.jwt;
  if (buckets.length) completionJwt = await uploadBuckets(accountId, buckets, completionJwt, manifest);
  // U7 + U6: the script PUT (observability ON, NO head_sampling_rate => 100% for the U11 log test)
  const metadata = {
    main_module: "index.js",
    compatibility_date: CONFIG.COMPAT_DATE,
    bindings: [
      { type: "durable_object_namespace", name: "GAME", class_name: "GameRoom" },
      { type: "plain_text", name: "SERVER_NAME", text: "spike" },
      { type: "secret_text", name: "DIRECTORY_TOKEN", text: "old-token-" + randomBytes(4).toString("hex") },
    ],
    migrations: { new_tag: "v1", new_sqlite_classes: ["GameRoom"] },
    assets: completionJwt ? { jwt: completionJwt, config: { not_found_handling: "single-page-application" } } : undefined,
    observability: { enabled: true }, // NB: NO head_sampling_rate => 100% (U11 measurement)
    tags: ["worldspring", "spike-vTEST"],
    annotations: { "workers/message": "Worldspring M1 spike" },
  };
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  const bundle = await readFile(CONFIG.WORKER_BUNDLE);
  fd.append("index.js", new Blob([bundle], { type: "application/javascript+module" }), "index.js");
  const put = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "PUT", token, body: fd });
  log("  PUT assertions: named_handlers=", JSON.stringify(put.json?.result?.named_handlers),
      " migration_tag=", put.json?.result?.migration_tag, " has_assets=", put.json?.result?.has_assets);
  // U6: per-script subdomain default + enable
  const sd = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, { token, raw: true });
  log("  per-script subdomain DEFAULT enabled (U6):", JSON.stringify(sd.json).slice(0, 200));
  await cf(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
    method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  // U7: do tags round-trip?
  const re = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}`, { token });
  log("  tags round-trip (U7)? ", JSON.stringify(re.json?.result?.tags ?? re.json?.result?.default_environment ?? "n/a"));
  const url = `https://${scriptName}.${subdomain}.workers.dev`;
  log("\n  LIVE URL:", url);
  // Verify like the real deployer will (§5 step 8): /api/server-info exists
  // since doc 03 M2 — assert it serves and report the version fields.
  const si = await fetch(url + "/api/server-info").then((r) => r.json()).catch((e) => ({ error: String(e) }));
  log("  GET /api/server-info ->", si.error ?? `gameVersion=${si.gameVersion} protocolVersion=${si.protocolVersion}`);
  log("\n>> For U11: hold ONE ws session ~10 min then read 'Log Events Written' in the dashboard.");
  log("   e.g. node apps/game/scripts/loadtest.mjs " + url.replace("https", "wss") + "/ws 1 600");
}

async function buildManifest(dir) {
  const files = [];
  async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } }
  await walk(dir);
  // Honor .assetsignore like wrangler does; the file itself never ships. Same
  // matcher semantics as build-artifact.mjs ignoreMatcher (kept in sync by
  // hand — build-artifact runs its pipeline at import, so it can't be imported):
  // skip comments/blanks, `dir/` prefixes, `*.ext` globs, exact names.
  const lines = await readFile(join(dir, ".assetsignore"), "utf8").then((s) => s.split("\n")).catch(() => []);
  const rules = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const ignored = (relPath) => relPath === ".assetsignore" || rules.some((r) => {
    if (r.endsWith("/")) return relPath.startsWith(r) || relPath.includes("/" + r);
    if (r.startsWith("*.")) return relPath.endsWith(r.slice(1));
    return relPath === r || relPath.endsWith("/" + r);
  });
  const map = {}; const byHash = {};
  for (const f of files) {
    const rel = relative(dir, f).split("\\").join("/");
    if (ignored(rel)) continue;
    const buf = await readFile(f);
    const ext = extname(f).slice(1);
    const hash = assetHash(buf, ext);
    map["/" + rel] = { hash, size: buf.length };
    byHash[hash] = { buf, ct: guessCt(ext) };
  }
  return { map, byHash };
}
const guessCt = (ext) => ({ html: "text/html", js: "text/javascript", css: "text/css", json: "application/json",
  png: "image/png", glb: "model/gltf-binary", wav: "audio/wav", mp3: "audio/mpeg" })[ext] ?? "application/octet-stream";

async function uploadBuckets(accountId, buckets, jwt, manifest) {
  let completion = jwt;
  for (const bucket of buckets) {
    const fd = new FormData();
    for (const hash of bucket) {
      const a = manifest.byHash[hash]; if (!a) die("missing asset for hash " + hash);
      fd.append(hash, new Blob([a.buf.toString("base64")], { type: a.ct }), hash); // base64=true => base64 bodies
    }
    const { json } = await cf(`/accounts/${accountId}/workers/assets/upload?base64=true`, { method: "POST", token: jwt, body: fd });
    if (json?.result?.jwt) completion = json.result.jwt; // last bucket returns the completion token
  }
  return completion;
}

// ─── PHASE: update-tests (U8 omit/identical migrations, U10 keep_bindings) ────
async function phaseUpdateTests() {
  const st = await loadState(); const { accountId, accessToken: token } = st;
  if (!accountId || !token) die("run deploy first");
  const scriptName = await resolveScriptName(st, { create: false });
  const bundle = await readFile(CONFIG.WORKER_BUNDLE);
  const putMeta = async (meta, label) => {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    fd.append("index.js", new Blob([bundle], { type: "application/javascript+module" }), "index.js");
    const r = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "PUT", token, body: fd });
    log(`  [${label}] status=${r.status} migration_tag=${r.json?.result?.migration_tag} err=${JSON.stringify(r.json?.errors ?? "").slice(0,200)}`);
  };
  const base = { main_module: "index.js", compatibility_date: CONFIG.COMPAT_DATE,
    bindings: [{ type: "durable_object_namespace", name: "GAME", class_name: "GameRoom" }],
    observability: { enabled: true } };
  // U8a: migrations OMITTED on an already-v1 worker
  await putMeta({ ...base }, "U8a omit-migrations");
  // U8b: identical migrations re-sent (blind-retry hazard)
  await putMeta({ ...base, migrations: { new_tag: "v1", new_sqlite_classes: ["GameRoom"] } }, "U8b identical-migrations");
  // U10: keep_bindings test. FIRST set an operator secret out-of-band:
  log("  >> Before the keep_bindings PUT, set ADMIN_TOKEN as an operator would:");
  log("     wrangler secret put ADMIN_TOKEN -c apps/game/wrangler.jsonc   (against the SCRATCH account)");
  log("     (or POST /accounts/" + accountId + "/workers/scripts/" + scriptName + "/secrets)");
  await putMeta({
    ...base,
    bindings: [
      { type: "durable_object_namespace", name: "GAME", class_name: "GameRoom" },
      { type: "secret_text", name: "DIRECTORY_TOKEN", text: "new-rotated-" + randomBytes(4).toString("hex") }, // explicit re-send
    ],
    keep_bindings: ["secret_text"], // <-- UNCONFIRMED this field even exists on the raw PUT (U10)
  }, "U10 keep_bindings+explicit-rotate");
  const set = await cf(`/accounts/${accountId}/workers/scripts/${scriptName}/settings`, { token, raw: true });
  log("  final bindings (U10 — did ADMIN_TOKEN survive? did explicit DIRECTORY_TOKEN win?):",
      JSON.stringify(set.json?.result?.bindings ?? set.json).slice(0, 600));
  log(">> If keep_bindings was rejected/ignored: record that, and switch rotation to delete-then-set (doc §7).");
}

// ─── PHASE: cleanup (U9 force-delete + delete client) ────────────────────────
async function phaseCleanup() {
  const st = await loadState(); const { accountId, accessToken: token } = st;
  if (!accountId || !token) die("nothing to clean");
  const scriptName = await resolveScriptName(st, { create: false });
  // U9: try WITHOUT force first (record refusal due to DO namespace), then with force
  await cf(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "DELETE", token, raw: true });
  log("  ^ DELETE without force (U9 — expect refusal because of the DO namespace)");
  await cf(`/accounts/${accountId}/workers/scripts/${scriptName}?force=true`, { method: "DELETE", token });
  log("  ^ DELETE ?force=true (U9 — destroys the DO world; confirm gone in dashboard)");
  // delete the throwaway OAuth client (bootstrap token, owner account)
  await cf(`/accounts/${CONFIG.CLIENT_OWNER_ACCOUNT_ID}/oauth_clients/${CONFIG.CLIENT_ID}`, { method: "DELETE", token: CONFIG.BOOTSTRAP_TOKEN });
  log("  ^ deleted spike OAuth client. (Optionally POST " + DASH + "/oauth2/revoke for the token — RFC7009 shape UNCONFIRMED.)");
  log(">> Then delete the scratch Cloudflare account so no throwaway creds linger.");
}

// ─── dispatch ────────────────────────────────────────────────────────────────
const phase = process.argv[2];
const phases = { scopes: phaseScopes, "create-client": phaseCreateClient, login: phaseLogin,
  deploy: phaseDeploy, "update-tests": phaseUpdateTests, cleanup: phaseCleanup };
if (!phases[phase]) die(`usage: node scripts/spike-deploy.mjs <${Object.keys(phases).join("|")}>`);
phases[phase]().catch((e) => die(e?.stack ?? String(e)));