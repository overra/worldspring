// doc 13 M0 — workerd leg of the physics spike. /run executes the shared
// scenario inside workerd (wrangler dev local + a scratch deploy) and returns
// the pose hash; timing is measured CALLER-side (workerd freezes clocks during
// execution). The root serves the browser leg's page from ./web assets.
import wasmModule from "@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm";
import RAPIER from "@dimforge/rapier3d-compat";
import { runScenario } from "../scenario.mjs";

// FINDING (M0): workerd disallows WebAssembly compilation from BYTES ("Wasm
// code generation disallowed by embedder"), so rapier3d-compat's inlined
// base64 init cannot run as-is. Instantiating a PRECOMPILED module is allowed,
// and wrangler imports .wasm files as CompiledWasm modules — so this shim
// reroutes compat's bytes-instantiate to the package's own .wasm imported as a
// module (same binary; the decoded bytes are ignored). M1 does this properly
// with a custom loader instead of a global patch.
const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = (bytesOrModule, imports) =>
  bytesOrModule instanceof WebAssembly.Module
    ? origInstantiate(bytesOrModule, imports)
    : origInstantiate(wasmModule, imports);

let ready = null;

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("physics-spike: GET /run?bodies=100&steps=1000");
    try {
      ready ??= RAPIER.init();
      await ready;
      // `||` not `??`: an empty param (`?bodies=`) yields "", which `??` would
      // pass through as Number("") === 0 instead of the default.
      const bodies = Number(url.searchParams.get("bodies") || 100);
      const steps = Number(url.searchParams.get("steps") || 1000);
      return Response.json({ runtime: "workerd", ...runScenario(RAPIER, { bodies, steps }) });
    } catch (e) {
      // The likely failure: workerd disallowing WebAssembly compilation from
      // bytes (compat inlines base64 wasm). That result IS an M0 finding.
      return Response.json({ runtime: "workerd", error: String(e?.stack ?? e) }, { status: 500 });
    }
  },
};
