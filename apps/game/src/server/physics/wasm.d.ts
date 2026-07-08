// Wrangler/workerd import .wasm files as precompiled WebAssembly.Module
// (CompiledWasm) — typed here for the server-only physics loader.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
