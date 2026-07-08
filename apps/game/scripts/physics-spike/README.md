# doc 13 M0 — physics determinism + cost spike

RESULT: **GO** — findings recorded in `docs/plans/13-shared-dynamic-physics.md` §M0 findings.

```sh
pnpm --filter @worldspring/game build   # not needed; spike is standalone
node apps/game/scripts/physics-spike/run-node.mjs                  # Node (any OS)
docker run --rm -v "$PWD:/w" -w /w/apps/game node:22 \
  node scripts/physics-spike/run-node.mjs                          # Linux (arm64/amd64 via --platform)
# browser + workerd (bundle the browser leg first):
node_modules/.bin/esbuild apps/game/scripts/physics-spike/entry-browser.mjs \
  --bundle --format=esm --outfile=apps/game/scripts/physics-spike/worker/web/browser.js
npx wrangler dev -c apps/game/scripts/physics-spike/worker/wrangler.jsonc   # visit / for browser, curl /run for workerd
```

Every runtime must print the same `hash` for the same scenario version/seed.
