// doc 13 M0 — browser leg entry. Bundled by esbuild (see README.md) into
// worker/web/browser.js and served by the spike worker's assets; the page
// runs the shared scenario in the browser's V8 and renders the JSON result
// into #out (read by the preview harness).
import RAPIER from "@dimforge/rapier3d-compat";
import { runScenario } from "./scenario.mjs";

const out = document.getElementById("out");
out.textContent = "running…";
RAPIER.init()
  .then(() => {
    const result = runScenario(RAPIER, { bodies: 100, steps: 1000 });
    out.textContent = JSON.stringify({ runtime: "browser", ...result });
    document.title = "spike:" + result.hash;
  })
  .catch((e) => {
    out.textContent = JSON.stringify({ runtime: "browser", error: String(e) });
  });
