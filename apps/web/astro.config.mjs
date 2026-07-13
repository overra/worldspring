// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

// Auth/utility routes (doc 01 M4) — crawlers have no business indexing the
// sign-in flow or the signed-in-only account page (which is a bare 302 to
// /login for anonymous visitors, i.e. every crawler). The pages also carry
// `noindex` meta; this keeps them out of the sitemap too.
const SITEMAP_EXCLUDE = new Set(["https://worldspring.games/login/", "https://worldspring.games/account/"]);

// Astro 6 defaults to `static` (prerender-by-default). Pages opt into SSR with
// `export const prerender = false`: the marketing landing + Starlight docs
// prerender; the server-directory pages and /api/v1/* run on the Worker.
export default defineConfig({
  // Canonical origin (doc 01 open Q1, resolved 2026-07-07): the apex custom
  // domain on the worldspring-web Worker (wrangler.jsonc `routes`). Drives
  // sitemap/canonical-URL generation; also the future OAuth client URL origin.
  site: "https://worldspring.games",
  // Load-bearing for /admin and the SSR form pages: same-origin form POSTs
  // are the CSRF posture (admin.astro's header comment relies on it). It IS
  // the Astro default, but the default is not a contract — pin it so a
  // future config edit or major-version change can't silently drop it.
  security: { checkOrigin: true },
  adapter: cloudflare({
    // v13 wires local bindings (D1, etc.) for `astro dev` automatically via
    // @cloudflare/vite-plugin — there's no `platformProxy` option (that was v12).
    imageService: "compile", // build-time transforms; avoids an Images binding
  }),
  integrations: [
    // Explicit sitemap (Starlight skips injecting its own when one is
    // configured) so auth/utility routes can be filtered out.
    sitemap({ filter: (page) => !SITEMAP_EXCLUDE.has(page) }),
    starlight({
      title: "Worldspring Docs",
      // Field-manual skin (matches apps/web design system): near-black ground,
      // olive accent, bone ink, Barlow / Barlow Semi Condensed / JetBrains Mono,
      // hairline borders, sharp corners. All CSS-variable overrides — no
      // component overrides. See src/styles/docs.css.
      customCss: ["./src/styles/docs.css"],
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
