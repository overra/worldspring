// Ambient declaration-merge for OPTIONAL operator-set vars consumed in code
// with built-in defaults (doc 03 §2 name/motd). These are intentionally NOT in
// wrangler.jsonc: `wrangler types` only emits vars declared there, and baking a
// value (e.g. "Worldspring") into wrangler.jsonc would OVERRIDE the runtime code
// default. Declaring them here keeps the generated worker-configuration.d.ts and
// wrangler.jsonc untouched, so `pnpm --filter @worldspring/game cf-typegen` can
// regenerate cleanly once doc 01's deploy flow actually adds the vars.
//
// No imports/exports → this file is a SCRIPT, so `interface Env` merges with the
// global ambient `Env` that worker-configuration.d.ts declares. Picked up by
// tsconfig.server.json's `src/server` include glob.

interface Env {
  /** Operator-set display name; falls back to "Worldspring" in code. */
  SERVER_NAME?: string;
  /** Operator-set message of the day; falls back to "" in code. */
  SERVER_MOTD?: string;
  /** Deploy-time gameplay config (doc 04). A preset name, a JSON string, or an
   * object { preset, overrides } — `unknown` because it is untrusted env input;
   * resolveServerConfig validates it. NOT in wrangler.jsonc (the official deploy
   * is var-less and resolves to DEFAULT_CONFIG); typegen would emit a literal
   * type if a value were present, so it is declared here. */
  GAME_CONFIG?: unknown;
  /** doc 10: preview-only testbed gate. Set to "1" ONLY by preview.yml's
   * `--var TESTBED:1` on worldspring-pr-<N> deploys; declared here (NOT in
   * wrangler.jsonc) so the var-less official deploy leaves it undefined and the
   * prod join path is byte-identical. isTestbedEnabled() checks it === "1". */
  TESTBED?: string;
  /** doc 10 M3: deploy-time DEFAULT testbed set name (preview only; resolved by
   * systems/scenarios.ts and consulted only when TESTBED is on). Like TESTBED it
   * stays OUT of wrangler.jsonc — set per-preview via `--var SCENARIO:<name>` if
   * a PR wants a non-default set; the per-join `scenario` field overrides it. */
  SCENARIO?: string;
}
