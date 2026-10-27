# Open Graph cards

One 1200x630 link-preview card per sidebar section. The cards are committed
PNGs in `public/og/`, so building the site never runs this generator.

## Regenerate (on your Mac)

```bash
pip3 install Pillow
python3 tools/og/generate.py
npm test
```

Then commit `tools/og/sections.json`, `public/og/` and `lib/og-images.js`
together. `python3 tools/og/generate.py --check` exits 1 if the committed files
are out of date.

## What to edit

`sections.json` holds, per card:

| Field     | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `id`      | File name stem (`public/og/<id>.<hash>.png`).                        |
| `icon`    | Boxicons name used in the sidebar (`index.html` nav), e.g. `cube`.   |
| `title`   | Big text. One line if it fits, otherwise two at a smaller size.      |
| `tagline` | One sentence under the title. Keep it under about 60 characters.     |
| `routes`  | Top-level paths that show this card. `seo` is the `ROUTE_SEO` key in `script.js` whose title and description the crawler sees; `canonical` is only for aliases (`/stake` is `/wallet`). |

The generator stops with a message if a title or tagline does not fit or a
card goes over 150 KB.

A new top-level SPA route that should have its own card needs an entry here and
a `ROUTE_SEO` entry in `script.js`. Without one it previews with the home card.

## How it is served

`vite build` writes per-section copies of `index.html` (`tools/og/shells.mjs`)
and nginx picks one per URL. See "Link previews" in the main README.

## Design

Colours, type and logo follow `BRAND.md`: `#08080C` background, `#12121A` tile,
`#E6007A` accent, white title, `#9CA3AF` tagline, Inter 800/600/400, and
`logo.png` from the repo root.

## Fonts and licences

`fonts/` holds only fonts whose licences allow redistribution, copied from the
pinned npm packages the site already ships:

- Inter (latin subset, from `@fontsource/inter` 5.2.8): SIL Open Font
  License 1.1, `fonts/Inter-OFL.txt`.
- Boxicons 2.1.4 (`boxicons-og-subset.ttf`, only the sidebar glyphs): MIT,
  `fonts/Boxicons-MIT.txt`.

To add an icon, find its code point in
`node_modules/boxicons/css/boxicons.min.css` (`.bx-<name>:before{content:"\ea8d"}`),
add it to `ICONS` in `generate.py`, and re-subset with every code point in
`ICONS` (fontTools: `pip3 install fonttools`):

```bash
python3 -m fontTools.subset node_modules/boxicons/fonts/boxicons.ttf --no-hinting --output-file=tools/og/fonts/boxicons-og-subset.ttf --unicodes=U+eafb,U+ec67,U+ec4e,U+ea8d,U+ea19,U+ea48,U+ea70,U+eb3a,U+ec27,U+ec65,U+ea6f,U+e9e5,U+eaff,U+ec78,U+ea15,U+ea40,U+ea69,U+ea5a,U+ea95,U+ec8c,U+ead7,U+eb0d,U+eb12,U+NEW
```

Different Pillow or FreeType versions can shift pixels slightly, which changes
the hashes in the file names. That is harmless: commit the new files.
`lib/og-images.js` records the renderer (`OG_RENDERER`), and the exact
`--check` test in `npm test` runs only on a machine with that same renderer.
