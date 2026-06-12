// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import starlight from "@astrojs/starlight";

// Astro 6 defaults to `static` (prerender-by-default). Pages opt into SSR with
// `export const prerender = false`: the marketing landing + Starlight docs
// prerender; the server-directory pages and /api/v1/* run on the Worker.
export default defineConfig({
  adapter: cloudflare({
    // v13 wires local bindings (D1, etc.) for `astro dev` automatically via
    // @cloudflare/vite-plugin — there's no `platformProxy` option (that was v12).
    imageService: "compile", // build-time transforms; avoids an Images binding
  }),
  integrations: [
    starlight({
      title: "Worldspring Docs",
      // Scaffold sidebar — grows as hosting/reference docs land (doc 02/03).
      sidebar: [{ label: "Start", items: [{ slug: "getting-started" }] }],
    }),
  ],
  vite: {
    // Bundle the raw-.ts workspace package into the SSR output instead of
    // externalizing it — the documented monorepo safeguard.
    ssr: { noExternal: ["@worldspring/shared"] },
  },
});
