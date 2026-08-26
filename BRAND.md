# Polkadex Mainnet Explorer — Brand Kit

Quick-reference cheatsheet. The single source of truth for tokens is the
`:root` block in `styles.css`. The live, interactive version of this document
is at [`explorer.polkadex.ee/brand`](https://explorer.polkadex.ee/brand).

When the brand evolves, edit `styles.css` and this document together.

## Colour palette

### Brand

| Role          | Token                  | Hex       | Use                                              |
| ------------- | ---------------------- | --------- | ------------------------------------------------ |
| Primary       | `--brand-primary`      | `#E6007A` | Primary CTAs, brand emphasis, active nav state.  |
| Primary glow  | `--brand-primary-glow` | `rgba(230, 0, 122, 0.2)` | Hover halos, focus rings.            |
| Secondary     | `--brand-secondary`    | `#00E676` | Successful actions, positive metrics, growth.    |

### Surfaces

| Role        | Token         | Hex                            |
| ----------- | ------------- | ------------------------------ |
| Background  | `--bg-dark`   | `#08080C`                      |
| Surface     | `--bg-surface`| `#12121A`                      |
| Glass       | `--bg-glass`  | `rgba(20, 20, 30, 0.6)`        |

### Borders

| Role         | Token             | Value                          |
| ------------ | ----------------- | ------------------------------ |
| Default      | `--border-color`  | `rgba(255, 255, 255, 0.08)`    |
| Hover        | `--border-hover`  | `rgba(230, 0, 122, 0.4)`       |

### Text

| Role         | Token              | Hex       |
| ------------ | ------------------ | --------- |
| Primary      | `--text-primary`   | `#FFFFFF` |
| Secondary    | `--text-secondary` | `#9CA3AF` |
| Muted        | `--text-muted`     | `#6B7280` |

### Semantic

| Role     | Token       | Hex       |
| -------- | ----------- | --------- |
| Success  | `--success` | `#14F195` |
| Error    | `--error`   | `#FF4D4D` |

**Usage rule.** Use Primary for the most-important call to action on a screen — only one per view. Secondary is for positive states (success badges, growth indicators), never for primary actions. Keep semantic colours for their semantic role; don't repaint a positive action red.

## Typography

Primary face is **Inter** (Google Fonts, weights `300/400/500/600/700`), loaded once in `index.html`:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

Monospace stack is `Courier New, monospace` — used for addresses, hashes, URLs, and storage keys.

### Type scale

| Use         | Weight       | Size              | Letter-spacing |
| ----------- | ------------ | ----------------- | -------------- |
| Display     | 800          | `2.4rem` (~38 px) | `-0.01em`      |
| H1          | 700          | `1.7rem` (~27 px) | normal         |
| H2          | 700          | `1.2rem` (~19 px) | normal         |
| Body        | 400          | `0.95rem` (~15 px)| normal         |
| Caption     | 400          | `0.82rem` (~13 px)| normal         |
| Mono        | 400          | `0.9rem`          | normal         |

Line-height conventions: 1.1 for display, 1.2 for headings, 1.6 for body, 1.65 for long-form prose.

## Logo

The mark lives at the repo root.

| File           | Where it's used                                     |
| -------------- | --------------------------------------------------- |
| `logo.png`     | Primary mark. Sidebar header, social cards, brand-kit page. |
| `favicon.png`  | Browser tab, PWA app icon, taskbar.                 |

**Clear space**: maintain padding equal to the height of the mark on all four sides.
**Minimum size**: 32 px on screen, 12 mm in print.
**Background**: prefers dark backgrounds; works on the brand colour itself; avoid busy photography.

**Don't**: recolour the logo, skew it, stretch it, add a drop shadow, animate it gratuitously, or place it over imagery without sufficient contrast.

## Iconography

Icons come from **Boxicons 2.1.4**, loaded via the `bx-*` class system:

```html
<link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
```

Inline usage:

```html
<i class='bx bx-wallet'></i>
```

Standard sizes: `16px` inline with body, `20px` for buttons, `24px` for headings, `42px` for hero affordances. Tint with `currentColor` by default; switch to `var(--brand-primary)` for emphasis or actionable affordances.

## Spacing, radii, motion

| Token                 | Value         | Where to use                                   |
| --------------------- | ------------- | ---------------------------------------------- |
| `--radius-sm`         | `8px`         | Inputs, pills, small chips.                    |
| `--radius-md`         | `12px`        | Cards, sub-panels.                             |
| `--radius-lg`         | `16px`        | Full panels, modals.                           |
| `--sidebar-width`     | `260px`       | Persistent left nav.                           |
| `--transition-fast`   | `0.2s ease`   | Hover/focus state changes.                     |
| `--transition-normal` | `0.3s ease`   | Layout shifts, modal open/close.               |

Spacing follows a 4 px grid. Common gap values: `4`, `8`, `12`, `16`, `20`, `24`, `32`, `48`.

## Voice in three lines

1. **Direct.** Lead with the verb. *"Connect your wallet"* beats *"Authentication is available via wallet connection."*
2. **Honest.** Name limitations. *"We cannot delete on-chain data"* is more useful than a paragraph of legalese.
3. **Concrete.** Show the number, not the adjective. *"Backfilled to block 8,402,991"* beats *"extensive history."*

## Don't

- Don't add new colours outside this palette. Extend by adjusting alpha on existing tokens.
- Don't use the brand primary as a body-text colour — it's reserved for actions and emphasis.
- Don't introduce third-party JavaScript or analytics. The privacy page promises none, and the brand follows.
- Don't recolour the logo for a one-off use. If you need a single-tone version for a constrained surface, ship a proper monochrome variant alongside it.

## Assets & further reference

- **Logo:** `logo.png` (at the repo root).
- **Favicon:** `favicon.png`.
- **PWA icon set:** see `public/manifest.webmanifest` (the only manifest in the
  repo — Vite copies `public/` verbatim into `dist/`, so this is the file served
  at `/manifest.webmanifest`. A second, disagreeing copy used to sit at the repo
  root; audit F-061 deleted it because nothing shipped it).
- **Live token source:** the `:root` block in `styles.css`.
- **Interactive cheatsheet:** [`explorer.polkadex.ee/brand`](https://explorer.polkadex.ee/brand).
- **User-facing brand article in the explorer's help center:** [`/help/brand-kit`](https://explorer.polkadex.ee/help/brand-kit).
