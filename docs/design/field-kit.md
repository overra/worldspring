# Field Kit — the game UI design language

**Status:** the in-game UI's design contract. Source: design direction "2a — FIELD KIT"
("your picks, synthesized"). This doc is the written form of it, so an agent (or a
modder) can extend the HUD without re-deriving the language from a screenshot.

> **The game UI and the web storefront are different surfaces and do not share a
> visual language.** The storefront (`apps/web`) is a flat, sharp-cornered "field
> manual": hairline borders, no blur, no shadow. The game HUD is **Field Kit**:
> soft-cornered glass floating over a live 3D world. Do not unify them. The first
> pass at this reskin did, and the result read as "the old HUD with new colors" —
> because the three traits below are precisely what make Field Kit legible.

## The three traits

A HUD panel is a **slab of glass held over moving terrain**. That single idea
decides everything:

1. **Soft corners.** The world behind is organic and noisy; a hard 90° corner
   reads as a rendering artifact against it. Radius scales with the surface:
   a 74px cell gets 8px, the full workspace gets 16px. Same material, different
   scale. Tokens: `--ui-r-sm|--ui-r|--ui-r-md|--ui-r-lg|--ui-r-xl|--ui-pill`.
2. **Real depth.** The ground behind a panel is bright, high-contrast and *moving*.
   A hairline border alone will not separate them — the panel needs a shadow to sit
   above the world. Three steps: `--ui-lift-1|2|3` (chip → floating card → workspace).
   Glow (`--ui-glow`) is **state** (held / selected / active), never elevation.
3. **Glass.** Panels are translucent (`rgba(14,17,11,.6)`-class fills) over
   `backdrop-filter: var(--ui-blur)`. Translucency is what keeps the HUD feeling
   *in* the world; blur is what keeps text legible on top of it. Coarse pointers opt
   out of blur — full-screen backdrop blur on a 3D canvas is a real mobile GPU cost.

## Type — the load-bearing choice

Three faces, self-hosted (`ui/fonts.css`, `public/fonts/*.woff2`, SIL OFL 1.1):

| Role | Face | Token | Used for |
|---|---|---|---|
| Display / label | **Barlow Semi Condensed** | `--ui-font-cond` | eyebrows, panel titles, tracked labels, buttons |
| Body | **Barlow** | `--ui-font` | prose, item descriptions, hints |
| Data | **JetBrains Mono** | `--ui-mono` | **every number** — vitals, ammo, clock, weight, coords |

The condensed width is what lets a `0.22em`-tracked uppercase label stay compact.
Mono on numerals is not decoration: a proportional face makes a counting readout
jitter as digits change width.

**Never let these fall back.** They are self-hosted precisely so they can't. A font
CDN would be an extra RTT on the join path, a CSP surface and an offline failure.

## Color

Olive (`--ui-accent`, `#7da06b`) is the **only** accent hue. Everything else is
neutral ground + the semantic vitals hues (`--ui-hp` / `--ui-food` / `--ui-water` /
`--ui-cold`) and the `--ui-kind-*` item stripes. A second accent hue is a bug.

## Layout

- **HUD:** vitals card bottom-left · hotbar bottom-center · minimap top-right ·
  compass strip top-center · objectives top-left · toasts + cast bar center ·
  key hints bottom-right.
- **Menu:** ONE tabbed workspace (`INVENTORY · CRAFTING · MAP · JOURNAL`) — one
  section at a time, gamepad- and touch-ready. No duplicated data: carry weight is
  read in exactly one place (the top bar).
- **Esc:** window-*contained*, not a full-bleed takeover. The world stays visible.

## Responsive

The HUD must work from a 390px phone to an ultrawide. Rules:

- Panels are sized in `clamp()`/`%`, never fixed px at the layout level.
- Under `(pointer: coarse)`: blur off, hit targets ≥ 44px, the tabbed workspace
  collapses to a **left icon rail** + one pane (see design frames 04/06).
- Nothing in the HUD may overlap the hotbar or the joystick at any viewport.

## Extending it (for modders)

A new mode's HUD implements `ModeHud` (`ui/hud/modes/types.ts`) and gets the shared
chrome for free. Build with the primitives in `ui.css` (`.ui-panel`, `.ui-chip`,
`.ui-key`, `.ui-btn`, `.ui-bar`, `.ui-cell`) and the tokens above — do not invent a
second set of surfaces, radii, or shadows.
