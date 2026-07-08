// doc 13 M1 — the workerd Rapier loader. Workers DISALLOW WebAssembly
// compilation from bytes ("code generation disallowed by embedder", M0
// finding), so rapier3d-compat's inlined-base64 init() cannot run as-is.
// Instantiating a PRECOMPILED module IS allowed, and the vite/wrangler
// pipeline imports .wasm as exactly that (see the "rapier3d.wasm" alias in
// vite.config.ts — the package's exports map hides the file). The reroute of
// WebAssembly.instantiate below is SCOPED to the one init() call and restored
// in finally; compat still wastes one ~2 MB base64 decode per isolate cold
// start (accepted for M1; a custom glue build removes it later).
//
// Server-only: this module must never be imported from client code (it would
// drag 1.5 MB of wasm into the browser bundle for an engine clients don't run).

import wasmModule from "rapier3d.wasm";
import RAPIER from "@dimforge/rapier3d-compat";

type RapierNamespace = typeof RAPIER;

let ready: Promise<RapierNamespace> | null = null;

/** Resolves the initialized Rapier namespace; memoized per isolate. */
export function loadRapier(): Promise<RapierNamespace> {
  ready ??= (async () => {
    const orig = WebAssembly.instantiate.bind(WebAssembly) as typeof WebAssembly.instantiate;
    (WebAssembly as { instantiate: unknown }).instantiate = (
      src: BufferSource | WebAssembly.Module,
      imports?: WebAssembly.Imports,
    ) => (src instanceof WebAssembly.Module ? orig(src, imports) : orig(wasmModule, imports));
    try {
      await RAPIER.init();
    } finally {
      (WebAssembly as { instantiate: unknown }).instantiate = orig;
    }
    return RAPIER;
  })();
  return ready;
}
