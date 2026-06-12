// Deploy guard: refuse to deploy a Worker whose D1 binding still has the
// placeholder database_id. Run `wrangler d1 create worldspring-directory` and
// paste the real id into apps/web + apps/prober wrangler.jsonc first.
//   usage: node ../../scripts/assert-d1-configured.mjs wrangler.jsonc
import { readFileSync } from "node:fs";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const path = process.argv[2];
if (!path) {
  console.error("assert-d1-configured: pass a wrangler config path");
  process.exit(2);
}
if (readFileSync(path, "utf8").includes(PLACEHOLDER)) {
  console.error(
    `\nRefusing to deploy: ${path} still has the placeholder D1 database_id.\n` +
      `Run:  wrangler d1 create worldspring-directory\n` +
      `then paste the id into apps/web/wrangler.jsonc and apps/prober/wrangler.jsonc.\n`,
  );
  process.exit(1);
}
