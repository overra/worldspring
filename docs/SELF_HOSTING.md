# Self-hosting Worldspring

Run your own server on your own Cloudflare account. You own the world, the data, the
uptime, and the bill — which is pennies a month for a small server, because a Worldspring
world is one Durable Object and a bucket of static assets, not a rented box.

There are two on-ramps. Both end in the same place: **a Worker in your account, on your
`workers.dev` subdomain, running your fork of this repo.**

> **Status, honestly:** the Deploy-button path below has **not** been click-tested
> end-to-end against a fresh Cloudflare account yet. The repo is wired for it (root
> `wrangler.jsonc`, `.dev.vars.example`) and the config is verified locally with
> `wrangler deploy --dry-run`, but the monorepo build under Workers Builds is unproven —
> see [Known risks](#known-risks-button-path). The CLI path is the one we run every day.

## Path A — the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/overra/worldspring)

One click. Cloudflare will:

1. **Clone this repo into your own GitHub account.** It is yours — hack it, mod it, rename
   it. There is no upstream link, so nothing we push can overwrite your game.
2. **Provision the resources** it reads from the root `wrangler.jsonc` — the `GameRoom`
   Durable Object and its SQLite migration, plus the client assets.
3. **Prompt for the secrets** listed in `.dev.vars.example`. You can leave every one blank:
   a default server needs none.
4. **Build and deploy** it, and connect **Workers Builds** so that every push you make to
   your fork redeploys your server automatically.

You land on `https://<worker-name>.<your-subdomain>.workers.dev` — that is the link you
give your friends.

### Known risks (button path)

- **The monorepo build.** This is a pnpm workspace, so the button must be pointed at the
  **repo root** (not `apps/game`, which is not self-contained — it consumes
  `packages/shared` via `workspace:*`). The pre-filled build command will be the root
  `pnpm build`, which builds the site and the prober as well as the game. That works, it
  is just slow. Narrow it in the setup page's **Build command** field to:

  ```bash
  pnpm --filter @worldspring/game build
  ```

- **pnpm version.** `package.json` pins `packageManager: pnpm@10.33.4`; the Workers Builds
  image ships an older pnpm 10.x. Same major and the same lockfile format, so it should
  install cleanly — but if the build fails on a Corepack version mismatch, add a build
  variable `PNPM_VERSION=10.33.4` in the build settings.

## Path B — the CLI

```sh
git clone https://github.com/overra/worldspring    # or your fork
cd worldspring
corepack enable && pnpm install
pnpm --filter @worldspring/game build
npx wrangler deploy -c apps/game/dist/worldspring/wrangler.json
```

That is exactly what our CI runs. Your world lands on your `workers.dev` subdomain. To
deploy from the repo root instead (the same config the button uses):

```sh
pnpm build && npx wrangler deploy
```

## Configure your world

Gameplay is one deploy-time **var**, `GAME_CONFIG` — a preset name, or JSON. It is a plain
var, not a secret: set it in the Cloudflare dashboard under **Settings → Variables**, or in
your fork's `wrangler.jsonc`:

```jsonc
"vars": { "GAME_CONFIG": "warpath" }
```

Shipped presets: `deadcoast` (the default — balanced survival), `ironcoast` (harsh),
`driftwood` (soft, no PvP), `homestead` (peaceful building), `warpath` (PvP-forward), and
`arena` (round-based deathmatch — a different `GameMode` entirely). Pass an object to tune
a preset: `{"preset":"ironcoast","overrides":{"time":{"dayLengthMin":30}}}`. Anything
unset falls back to the code default, and an invalid value logs a warning and falls back
rather than failing the deploy.

Two more optional vars: `SERVER_NAME` and `SERVER_MOTD` (what the directory and the join
screen show).

⚠️ Changing a **world-class** config field (seed, island size) wipes the world — the server
detects the mismatch on boot and regenerates. Gameplay-class fields (loot rates, PvP,
day length) are live and safe.

## List it in the public directory

The directory is a catalog, not a client — it links to *your* server, which serves its own
build. Listing is a **post-deploy claim**, because the token is minted only after your
server answers `/api/server-info`:

1. Deploy (Path A or B).
2. Go to [worldspring.games/servers/register](https://worldspring.games/servers/register)
   and paste your server URL. You get a `DIRECTORY_TOKEN`, shown exactly once.
3. Set it, plus the directory origin, on your Worker:

   ```sh
   npx wrangler secret put DIRECTORY_TOKEN     # paste the token
   ```

   …and add the var `DIRECTORY_URL=https://worldspring.games` (dashboard, or `vars` in your
   wrangler config). The heartbeat sender needs **both** — with either missing it is
   completely inert and makes zero outbound requests.
4. Redeploy, then hit **Verify**. Your server heartbeats its name, player count, version,
   and rules; the directory links players to you.

Listing is entirely optional. A private server for six friends never needs it.

## Now point a coding agent at your fork

This is the part the button is really for. You have the whole source — the authoritative
Durable Object, the deterministic shared sim, the R3F client — in one repo that an agent
can hold in its head.

- **[ARCHITECTURE.md](../ARCHITECTURE.md)** is the contract: what is engine (load-bearing:
  netcode, worldgen, physics, the wire protocol) and what is game (freely editable: items,
  vitals, zombies, the HUD).
- **`apps/game/src/server/mode/`** is the `GameMode` seam — win/lose conditions, scoring,
  round lifecycle, spawn/respawn. `survival` and `arena` both implement it. "Make this a
  heist game" starts by copying `arena` and its `arena-probe.mjs`.
- **Run `pnpm mod:check` before you deploy a mod.** One command: types → worldgen
  determinism → protocol round-trip + sim/GameMode probes → build. It exists because the
  failure an agent is most likely to introduce is *silent* — a stray `Math.random()` or
  `Date.now()` in the sim doesn't crash anything, it just desyncs every client's prediction
  a few minutes in. `mod:check` catches that class of break in one shot, and its failure
  output is written to be read by the agent that caused it.

```sh
pnpm mod:check     # green? push. Workers Builds redeploys your server.
```

## Costs

A Worldspring world is one always-on Durable Object at 15 Hz plus static assets. Small
servers sit inside or near the Workers free tier; the paid Workers plan is $5/mo and covers
a busy one. Durable Object **duration** (wall-clock with players connected), not bandwidth,
is the line item that grows — an empty server costs approximately nothing.

## Updating

Your fork is a copy, not a subscription: nothing we push lands on your server unless you
ask for it. To take upstream changes:

```sh
git remote add upstream https://github.com/overra/worldspring
git fetch upstream && git merge upstream/main
pnpm mod:check
```

If you have modded heavily, merge conflicts are yours — and that is the deal we chose. Your
server never *needs* our updates: the client and the Durable Object ship from the same fork,
so they are protocol-compatible by construction.
