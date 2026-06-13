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
}
