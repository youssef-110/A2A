# a2a brand: the dot-matrix board

The relay is a message board. Everything a2a shows is drawn from that one object: LED dots in a
5x7 grid, white when lit, blue when something is live, amber only when something is held.
The landing page (`packages/web/public/index.html`, `home.css`) is the reference implementation.

## Mark

- **Wordmark:** "A2A" in the 5x7 dot font, 17 x 7 dots, the "2" lit blue (it is the relay).
  SVG: `packages/web/public/logo.svg` (viewBox `0 0 17 7`, circles r .42, `fill: currentColor`,
  the 2's circles carry `class="two"` and fill `#3d95ff`). Inline it, or use the `#mark` symbol
  from index.html. Minimum height 16 px; give it 8 px of clear space.
- **Small mark** (favicon, app icon, tray, email): the "2" alone in blue dots on a 5 x 7 grid of
  dark unlit dots, in a dark rounded square. `favicon.svg`, `email-logo.png`, desktop `build/*.png`.
- Never redraw the old two-circles-and-a-curve mark; it is retired everywhere.

## Colour

| token | dark (default) | light | job |
|---|---|---|---|
| night / bg | `#0e0e0f` | `#f6f6f4` (paper) | page |
| surface | `#141416` | `#ffffff` | panels, cards, inputs |
| surface-2 | `#1b1b1e` | `#eeeeeb` | hover, selected rows |
| board | `#0a0a0b` | `#0a0a0b` | dot boards stay dark in both themes |
| ink | `#f4f4f1` | `#111112` | text |
| ink-2 | `#b8b8b2` | `#3a3a37` | secondary text |
| ink-3 | `#9b9b95` | `#63635d` | labels, hints (meets 4.5:1 on bg) |
| hair | `rgb(255 255 255 / .12)` | `rgb(0 0 0 / .13)` | rules, borders |
| blue | `#3d95ff` | `#0a5fd0` | live, delivered, links, focus, primary accent |
| amber | `#ffa424` | `#985200` | held / needs review only |
| danger | `#ff6961` | `#c41e16` | destructive actions and errors only (product UI) |

Neutrals carry everything. Blue is the one accent; amber and red are states, never decoration.
No gradients, glows, glass panels or coloured shadows.

## Type

- **Display:** Doto (`/fonts/Doto-Variable.woff2`, OFL), weight 800, UPPERCASE, line-height 1,
  letter-spacing .01em. Only for short display lines: page titles, empty-state titles, section
  heads on marketing pages. Never for body text, labels, buttons or anything longer than ~4 words
  per line.
- **Text and UI:** Geist (`/fonts/Geist-Variable.woff2`) 400/500, never 600+ except the
  wordmark-adjacent product name. Sentence case everywhere outside Doto.
- **Data:** Geist Mono for ids, keys, commands, timings, code. Not for labels.

## Shape

- Buttons and inputs: radius 2 px (square), height 36 (small) / 46 (default). Primary = ink fill
  on bg ink (white button on night, black on paper); ghost = 1 px hair inset border.
- Panels and cards: radius 4 px, 1 px hair border, no shadow unless it floats (menus, dialogs:
  `0 24px 48px -16px rgb(0 0 0 / .6)`).
- Dot boards (the brand object) keep their own radius: housing 18-20 px, rows 6 px.
- Four hairline columns behind marketing pages only; never in the product UI.

## Motion

Ease-out `cubic-bezier(.22,1,.36,1)`; hovers 160 ms colour-only; menus 180-220 ms; no bounce.
Display headings may ease out of a 10 px blur once on arrival (marketing only). Everything
respects `prefers-reduced-motion`.

## Voice

Plain, specific, sentence case, no hype words, no exclamation marks, no em dashes.
