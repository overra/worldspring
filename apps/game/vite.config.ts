import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // rapier's package `exports` map hides its .wasm file, so the server
      // physics loader imports it through this alias (aliases bypass export
      // enforcement). Workerd receives it as a precompiled WebAssembly.Module
      // (CompiledWasm) — the only WASM form Workers allow (doc 13 M0 finding).
      "rapier3d.wasm": fileURLToPath(
        new URL("./node_modules/@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm", import.meta.url),
      ),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Rolldown groups capture a matching module's dependency subtree,
            // and @react-three/fiber depends on react AND zustand — without
            // this higher-priority group those would be hoisted into
            // vendor-three, making the eager menu chunk statically import the
            // whole 3D stack and defeating the GameCanvas lazy boundary.
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/,
              priority: 20,
            },
            // Cache-stable vendor chunk for the 3D stack — reachable only via
            // the lazy GameCanvas import, so it is still fetched on demand.
            // Scoped tests only: a bare /node_modules/ test would merge eager
            // (react) and lazy (three) vendors into one menu-blocking chunk.
            {
              name: "vendor-three",
              test: /node_modules[\\/](three|@react-three|postprocessing|n8ao|@monogrid)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
