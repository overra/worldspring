# navcat M0 — workerd execution probe (doc 14)

Throwaway scratch **Durable Object** that proves navcat's per-tile build pipeline +
`findPath` execute inside a real workerd runtime — the one condition the 2026-07-10
`spike/navcat` spike left open (it ran under Node). See
[`docs/plans/14-navmesh-pathfinding.md`](../../../../docs/plans/14-navmesh-pathfinding.md)
§ "M0 findings".

## Run

`wrangler` resolves a redirected deploy config from `apps/game/.wrangler`, which conflicts
with a standalone config under `apps/game/`. So run this from an isolated dir **outside**
`apps/game` (its own `node_modules` with `navcat@0.4.1`):

```sh
mkdir -p /tmp/navcat-m0 && cd /tmp/navcat-m0
cp <repo>/apps/game/scripts/navcat-m0/{worker.ts,wrangler.jsonc} .
printf '{"name":"navcat-m0-run","private":true,"type":"module","dependencies":{"navcat":"0.4.1"}}' > package.json
pnpm install
<repo>/apps/game/node_modules/.bin/wrangler dev --port 8799 --ip 127.0.0.1 &
curl -sS http://127.0.0.1:8799/    # → JSON result
```

## Result (2026-07-15) — GO

`{ ok: true, runtime: "workerd (Durable Object)" }` — build + `findPath` ran with no throw;
valid navmesh (35 polys); `findPath` success + `COMPLETE_PATH`; the path detours around the
block obstacle; build warm-p50 ~8 ms (matches the spike's 5–9 ms); bundle ~285 KiB / ~54 KiB
gzip. Query time reads 0 ms because workerd rounds pure-CPU `performance.now` — the spike's
Node p50 0.10 ms is the real figure.
