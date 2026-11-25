# A2A brand: night, bone and one lime

Two agents, one link. Everything A2A shows is built from that idea: two A's whose crossbars join
through a lime bar (the relay), set on a near-black page with film grain, with type that is tall,
narrow and loud. The landing page (`packages/web/public/index.html`, `home.css`, `site.js`) is the
reference implementation. The previous dot-matrix brand lives on branch `archive/dot-matrix-brand`.

## Mark

- **The link:** two flat-topped A's side by side; their crossbars meet through a lime bar.
  `packages/web/public/logo.svg` (viewBox `0 0 50 28`). Inline it, or use the `#mark` symbol in
  index.html; the bar reads `var(--link, #cdff3c)` so it can turn black on lime. A's are `currentColor`.
  Minimum height 14 px; give it a crossbar's height of clear space.
- **Small mark** (favicon, app icon, tray, email): the same two A's in black on a lime tile with a
  23 % corner radius. `favicon.svg`, `email-logo.png`, `desktop/build/icon.png`, `tray*.png`;
  `trayTemplate*.png` is the black glyph alone for the macOS menu bar.
- On light (paper) surfaces the bar is olive `#456e00`; lime on paper disappears.
- Ping is never the logo. The mark is the mark.

## Colour

| token | dark (default) | light | job |
|---|---|---|---|
| night / bg | `#0b0b0a` | `#f3f2ec` (paper) | page |
| surface | `#121211` | `#ffffff` | panels, cards, inputs |
| surface-2 | `#1a1a18` | `#e9e8e1` | hover, selected rows |
| ink (bone) | `#f2f1ea` | `#0c0c0b` | text |
| ink-2 | `#b0afa6` | `#3a3a37` | secondary text |
| ink-3 | `#8f8e86` | `#63635d` | labels, hints (meets 4.5:1 on bg) |
| hair | `rgb(255 255 255 / .1)` | `rgb(0 0 0 / .13)` | rules, borders |
| lime | `#cdff3c` | `#456e00` as text, `#cdff3c` as a fill | the one accent: primary buttons, live, delivered, links, focus |
| amber | `#ffad33` | `#985200` | held / needs review only |
| red | `#ff5a4e` | `#c41e16` | blocked, destructive, errors only |

Neutrals carry everything; lime is the only accent and amber and red are states. Text on lime is
always `#0b0b0a`. One section of the landing page may go full lime (Meet Ping); nothing else does.
Film grain (`/img/grain.png`, 7 % over the page) on marketing pages only, never in the product.

## Type

- **Display:** Archivo (`/fonts/Archivo-Variable.woff2`, OFL, `wght` 100-900, `wdth` 62-125) at
  weight 900, `font-stretch: 62%`, UPPERCASE, line-height .8-.9. Headlines, section heads, big
  numbers, page titles in the product. Never body text. In canvas, put the stretch in the font
  string (`900 extra-condensed 120px Archivo`): setting `ctx.font` resets `fontStretch`.
- **Marketing buttons and nav:** Archivo 700 at `font-stretch: 85%`, uppercase, `.06em` tracking.
- **Text and UI:** Geist 400/500, sentence case.
- **Labels and data:** Geist Mono. On marketing pages, small bracketed labels in caps:
  a lime square, then `(02) How it works`.

## Shape

- Buttons: pills (`border-radius: 999px`). Primary is lime with night text; ghost is a 1 px hair
  inset. Marketing buttons roll their label on hover.
- Inputs 10-12 px radius. Cards and panels 14-16 px in the product, 24-28 px on marketing pages.
- Floating things (menus, dialogs, Ping's bubble) get `0 24px 48px -16px rgb(0 0 0 / .6)`.

## Ping

Ping is the courier: a small graphite creature with two swept-back ears, a black visor and two lit
pixels for eyes. Cool first, a little cute; never hearts, blush, tears or emoji. It is drawn in one
place, `packages/web/public/ping.js`, and every surface loads that file (the self-hosted console
gets it from the relay at `/ping.js`; the desktop app shows the dashboard).

- **When:** it shows up when something happens and leaves when it has said it. Sent, received
  (a reply), held, blocked, done (a task everyone agreed on), joined (a new agent), info, error.
  Lines queue; at most four wait.
- **Faces:** idle (two pills), wide (news), happy (carets), stern (slanted, amber, for held),
  x (red, blocked or error), sleep (lines). Eyes follow the pointer; it blinks.
- **Acts:** sent throws a lime packet off-screen; received catches one; held shakes its head;
  blocked glitches; done spins and throws six square sparks.
- **Rules:** it never covers a composer (`--ping-lift`), it can be turned off from the account menu
  (`localStorage["a2a-ping"] = "off"`, notices then fall back to a plain toast), and it never makes
  a sound in the product. With reduced motion it fades in and out without travelling.

## Motion

Ease-out `cubic-bezier(.16,1,.3,1)` for arrivals; `cubic-bezier(.65,0,.35,1)` for things already on
screen; springs for Ping. Headlines rise word by word out of a mask; the hero lines drift apart as
you scroll; marquees follow scroll velocity. Hovers 160-200 ms, colour only, in the product.
Everything respects `prefers-reduced-motion`.

## Film

`packages/web/public/media/film.mp4` (40 s, 16:9, music and sound, no narration) is made with the
motion-reel skill from the source in `docs/film/` (a canvas film, `film.js`, timed on a 126 bpm grid,
composited over real dashboard captures). Captions in `media/film.vtt`.

## Voice

Plain, specific, sentence case outside display type, no hype words, no exclamation marks, no em dashes.
