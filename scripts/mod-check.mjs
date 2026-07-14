#!/usr/bin/env node
// mod:check — the modder's guardrail suite (docs/plans/00 decision 5).
//
// One command a fork runs after any change, before deploying their server. It
// catches the invariants a coding agent editing this repo is most likely to
// break SILENTLY — the ones that don't show up as a crash or a red test until a
// player is already desynced or the wire is incompatible:
//
//   Types           — the mod still compiles against the shared contracts.
//   Determinism     — worldgen is reproducible. This is THE trap: a stray
//                     Math.random()/Date.now() or Map/Set iteration order makes
//                     the world non-deterministic, silently breaking the
//                     client/server prediction contract. We catch it by
//                     generating the world fingerprint TWICE and asserting the
//                     two runs match — platform-independent, unlike the
//                     byte-exact cross-machine reference (that stays CI's job,
//                     since V8 transcendental results drift across OS/Node).
//   Protocol + sim  — the binary wire protocol round-trips and every
//                     deterministic sim + GameMode probe passes (pnpm test).
//   Build           — the client + server actually bundle for deploy.
//
//   pnpm mod:check
//
// Exits non-zero if any guardrail trips, with a modder-facing explanation.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = join(root, "packages/shared/scripts/world.fingerprint.txt");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const results = [];
const record = (label, protects, ok) => {
  results.push({ label, protects, ok });
  console.log(ok ? green(`  ✓ ${label}`) : red(`  ✗ ${label}`));
  return ok;
};

const inherit = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status === 0;
const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
};
const seedLines = (s) => (s.match(/^seed .*$/gm) || []).join("\n");

// 1. Types --------------------------------------------------------------------
console.log(bold("\n▶ Types") + dim(" — compiles against the shared contracts"));
record("Types", "compiles against the shared contracts", inherit("pnpm", ["-w", "typecheck"]));

// 2. Determinism (self-consistency) -------------------------------------------
console.log(bold("\n▶ Determinism") + dim(" — worldgen must be reproducible (client/server prediction contract)"));
let detOk = true;
const a = capture("pnpm", ["--filter", "@worldspring/shared", "fingerprint"]);
const b = capture("pnpm", ["--filter", "@worldspring/shared", "fingerprint"]);
if (!a.ok || !b.ok) {
  console.error(red("  the fingerprint script failed to run:"));
  console.error(a.ok ? b.out : a.out);
  detOk = false;
} else if (seedLines(a.out) !== seedLines(b.out)) {
  console.error(red("  NON-DETERMINISTIC — two worldgen runs on this machine produced different worlds."));
  console.error("  Something leaked non-seeded entropy into worldgen: a Math.random(), a Date.now(),");
  console.error("  or Map/Set iteration order. The world MUST be a pure function of its seed, or the");
  console.error("  client's prediction diverges from the server. Find it before anything else.");
  detOk = false;
} else {
  console.log(dim("  two runs identical → worldgen is deterministic on this machine"));
  try {
    if (seedLines(a.out) === seedLines(readFileSync(REF, "utf8"))) {
      console.log(dim("  and byte-identical to the committed CI reference"));
    } else {
      console.log(dim("  (differs from the committed reference — expected off-Linux: V8 transcendental"));
      console.log(dim("   drift; CI on Linux is the byte-exact gate. Local run only checks reproducibility.)"));
    }
  } catch {
    console.log(dim("  (no committed reference to compare against)"));
  }
}
record("Determinism", "worldgen stays a pure function of its seed", detOk);

// 3. Protocol + sim -----------------------------------------------------------
console.log(bold("\n▶ Protocol + sim") + dim(" — wire protocol round-trips; every sim/GameMode probe passes"));
record("Protocol + sim", "protocol round-trip + deterministic sim smoke", inherit("pnpm", ["-w", "test"]));

// 4. Build --------------------------------------------------------------------
console.log(bold("\n▶ Build") + dim(" — client + server bundle for deploy"));
record("Build", "bundles for deploy", inherit("pnpm", ["-w", "build"]));

// Summary ---------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log("\n" + "─".repeat(66));
for (const r of results) console.log(`${r.ok ? green("✓") : red("✗")} ${bold(r.label)} ${dim("— " + r.protects)}`);
console.log("─".repeat(66));

if (failed.length === 0) {
  console.log(green(bold("mod:check PASSED")) + " — the trust invariants hold.");
  console.log(
    dim("Final pre-launch smoke (needs a live server): `pnpm dev:game`, then in another shell"),
  );
  console.log(dim("`pnpm loadtest ws://localhost:5173/ws 8 30` — watch for RESULT: PASS."));
  process.exit(0);
}

console.log(red(bold("mod:check FAILED")) + ` — ${failed.length} guardrail(s) tripped:`);
for (const r of failed) console.log(red(`  ✗ ${r.label}`) + dim(` — ${r.protects}`));
if (failed.some((r) => r.label === "Determinism")) {
  console.log(
    dim(
      "\nIf the worldgen change was INTENTIONAL it is wipe-class: bump WORLDGEN_VERSION +\n" +
        "PROTOCOL_VERSION and regenerate packages/shared/scripts/world.fingerprint.txt on Linux (CI).",
    ),
  );
}
process.exit(1);
