#!/usr/bin/env python3
"""Render the per-section Open Graph cards for the explorer.

Usage (from the repo root):

    python3 tools/og/generate.py          # write PNGs + lib/og-images.js
    python3 tools/og/generate.py --check  # exit 1 if anything would change

Input:   tools/og/sections.json  (titles, taglines, icons, routes)
Fonts:   tools/og/fonts/          (Inter, SIL OFL 1.1; Boxicons subset, MIT)
Logo:    logo.png                 (repo root, the same mark the sidebar uses)
Output:  public/og/<id>.<hash>.png   1200x630, content-hashed file names
         lib/og-images.js            generated map read by the build step,
                                     the SPA and the /developers page

Needs Python 3.9+ and Pillow (pip3 install Pillow). Nothing else: no network,
no browser, no SVG rasterizer. The PNGs are committed, so `npm run build`
never runs this script and the build gains no dependency.

The file name carries a hash of the image bytes. Crawlers (X, Slack,
Telegram, Facebook) cache a card by URL for days, so a redesigned card has to
live at a new URL to be picked up. Old files are deleted on each run.
"""

import hashlib
import json
import os
import re
import sys
from io import BytesIO

import PIL
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
HERE = os.path.join(ROOT, 'tools', 'og')
FONTS = os.path.join(HERE, 'fonts')
OUT_DIR = os.path.join(ROOT, 'public', 'og')
MANIFEST = os.path.join(ROOT, 'lib', 'og-images.js')

W, H = 1200, 630
SIZE_BUDGET = 150 * 1024

# BRAND.md tokens (the :root block in styles.css is the source of truth).
BG = (8, 8, 12)             # --bg-dark   #08080C
SURFACE = (18, 18, 26)      # --bg-surface #12121A
PRIMARY = (230, 0, 122)     # --brand-primary #E6007A
TEXT = (255, 255, 255)      # --text-primary
TEXT_2 = (156, 163, 175)    # --text-secondary #9CA3AF
BORDER = (36, 36, 44)       # --border-color, white at 8% over the surface

# Boxicons 2.1.4 code points for the icons the sidebar uses (see index.html
# nav). The committed font is a subset holding only these glyphs; to add one,
# look its code point up in node_modules/boxicons/css/boxicons.min.css and
# re-subset (command in tools/og/README.md).
ICONS = {
    'grid-alt': 0xEAFB, 'user-pin': 0xEC67, 'transfer': 0xEC4E, 'cube': 0xEA8D,
    'calendar-event': 0xEA19, 'check-shield': 0xEA48, 'coin-stack': 0xEA70,
    'line-chart': 0xEB3A, 'star': 0xEC27, 'user-circle': 0xEC65, 'coin': 0xEA6F,
    'book-content': 0xE9E5, 'group': 0xEAFF, 'wallet': 0xEC78, 'calendar': 0xEA15,
    'chat': 0xEA40, 'code-alt': 0xEA69, 'chip': 0xEA5A, 'data': 0xEA95,
    'wrench': 0xEC8C, 'file-find': 0xEAD7, 'help-circle': 0xEB0D, 'home': 0xEB12,
}

LAYOUT = ImageFont.Layout.BASIC  # same output whether or not libraqm is installed


def renderer():
    # Pixels (so hashes) can differ between Pillow/FreeType versions; the test
    # suite only demands an exact --check on the renderer that made the files.
    return 'Pillow %s / FreeType %s' % (PIL.__version__, features.version('freetype2'))


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size, layout_engine=LAYOUT)


def inter(weight, size):
    return font('inter-latin-%d-normal.woff' % weight, size)


def text_w(draw, s, f):
    return draw.textlength(s, font=f)


def wrap(draw, s, f, max_w, max_lines):
    """Greedy word wrap; returns lines or None if it needs more than max_lines."""
    lines = []
    for para in s.split('\n'):
        cur = ''
        for word in para.split(' '):
            trial = (cur + ' ' + word).strip()
            if cur and text_w(draw, trial, f) > max_w:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        lines.append(cur)
    if len(lines) > max_lines or any(text_w(draw, l, f) > max_w for l in lines):
        return None
    return lines


def fit(draw, s, weight, sizes, max_w, max_lines):
    for size in sizes:
        f = inter(weight, size)
        lines = wrap(draw, s, f, max_w, max_lines)
        if lines:
            return f, size, lines
    return None


def glow(center, radius, color, alpha):
    """A soft radial glow, drawn small and blurred so it stays cheap and smooth."""
    layer = Image.new('RGBA', (W, H), color + (0,))
    mask = Image.new('L', (W // 4, H // 4), 0)
    d = ImageDraw.Draw(mask)
    cx, cy, r = center[0] // 4, center[1] // 4, radius // 4
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=alpha)
    mask = mask.filter(ImageFilter.GaussianBlur(r * 0.6)).resize((W, H), Image.BILINEAR)
    layer.putalpha(mask)
    return layer


def render(card, logo):
    img = Image.new('RGB', (W, H), BG)
    halo = glow((1060, 90), 420, PRIMARY, 60)
    img.paste(halo, (0, 0), halo)
    draw = ImageDraw.Draw(img)

    # Brand accent bar, left edge.
    draw.rectangle((0, 0, 9, H), fill=PRIMARY)

    x0 = 88
    # Header: logo + wordmark.
    mark = logo.resize((60, 59), Image.LANCZOS)
    img.paste(mark, (x0, 62), mark)
    draw.text((x0 + 78, 92), 'Polkadex Explorer', font=inter(600, 32), fill=TEXT, anchor='lm')

    # Right-hand tile with the section's sidebar icon (the logo for Home).
    tile = (812, 175, 812 + 300, 175 + 300)
    draw.rounded_rectangle(tile, radius=40, fill=SURFACE, outline=BORDER, width=3)
    tcx, tcy = (tile[0] + tile[2]) // 2, (tile[1] + tile[3]) // 2
    if card['icon'] == 'logo':
        big = logo.resize((180, 178), Image.LANCZOS)
        img.paste(big, (tcx - 90, tcy - 89), big)
    else:
        cp = ICONS.get(card['icon'])
        if cp is None:
            raise SystemExit('unknown icon %r for card %r: add it to ICONS' % (card['icon'], card['id']))
        icon_font = font('boxicons-og-subset.ttf', 190)
        if icon_font.getmask(chr(cp)).getbbox() is None:
            raise SystemExit('icon %r is not in the committed subset font; re-subset (tools/og/README.md)' % card['icon'])
        draw.text((tcx, tcy), chr(cp), font=icon_font, fill=PRIMARY, anchor='mm')

    # Title and tagline, vertically centred between header and footer.
    max_w = 660
    # One line at up to 104px; a title that needs two lines is set smaller so
    # the block still clears the footer.
    title = (fit(draw, card['title'], 800, [104, 96, 88, 80], max_w, 1)
             or fit(draw, card['title'], 800, [84, 78, 72], max_w, 2))
    tagline = fit(draw, card['tagline'], 400, [38, 36, 34, 32], max_w, 3)
    if not title or not tagline:
        raise SystemExit('%s: title or tagline does not fit the card; shorten it' % card['id'])
    tf, tsize, tlines = title
    sf, ssize, slines = tagline
    t_lh, s_lh, gap = round(tsize * 1.08), round(ssize * 1.32), 26
    block = len(tlines) * t_lh + gap + len(slines) * s_lh
    top, bottom = 140, 515
    y = top + (bottom - top - block) // 2
    for line in tlines:
        draw.text((x0, y), line, font=tf, fill=TEXT, anchor='la')
        y += t_lh
    y += gap
    for line in slines:
        draw.text((x0, y), line, font=sf, fill=TEXT_2, anchor='la')
        y += s_lh

    # Footer: the URL the card stands for.
    path = card['routes'][0]['path']
    host = 'explorer.polkadex.ee'
    ff = inter(600, 30)
    draw.text((x0, 566), host, font=ff, fill=TEXT, anchor='ls')
    if path != '/':
        draw.text((x0 + text_w(draw, host, ff), 566), path, font=ff, fill=PRIMARY, anchor='ls')

    buf = BytesIO()
    # Quantizing to a 256-colour palette keeps every card well under the size
    # budget; the glow is the only gradient and survives it without banding
    # visible at card size. No metadata chunks, so bytes depend only on pixels.
    img.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE).save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def js_manifest(cards, files):
    out = [
        '// GENERATED by tools/og/generate.py from tools/og/sections.json.',
        '// Do not edit by hand: change sections.json and re-run the generator.',
        '// Read by vite.config.js (crawler shells), script.js (in-app meta) and',
        '// server.js (the server-rendered /developers page). Import-free.',
        '',
        'export const OG_RENDERER = %s;' % json.dumps(renderer()),
        '',
        'export const OG_CARDS = {',
    ]
    for c in cards:
        alt = 'Polkadex Explorer: %s. %s' % (c['title'].replace('\n', ' '), c['tagline'])
        out.append('    %s: { file: %s, width: %d, height: %d, alt: %s },' % (
            json.dumps(c['id']), json.dumps(files[c['id']]), W, H, json.dumps(alt)))
    out.append('};')
    out.append('')
    out.append('export const OG_ROUTES = [')
    for c in cards:
        for r in c['routes']:
            entry = {'path': r['path'], 'card': c['id'], 'seo': r['seo']}
            if r.get('canonical'):
                entry['canonical'] = r['canonical']
            out.append('    %s,' % json.dumps(entry, separators=(', ', ': ')))
    out.append('];')
    out.append('')
    return '\n'.join(out)


def main():
    check = '--check' in sys.argv[1:]
    with open(os.path.join(HERE, 'sections.json'), encoding='utf-8') as fh:
        cards = json.load(fh)['cards']
    ids = [c['id'] for c in cards]
    if len(set(ids)) != len(ids) or 'home' not in ids:
        raise SystemExit('sections.json: card ids must be unique and include "home"')
    for c in cards:
        if not re.fullmatch(r'[a-z0-9-]+', c['id']):
            raise SystemExit('bad card id %r' % c['id'])
        for r in c['routes']:
            if not re.fullmatch(r'/([a-z0-9-]+)?', r['path']):
                raise SystemExit('route paths are single segments like /blocks: %r' % r['path'])

    logo = Image.open(os.path.join(ROOT, 'logo.png')).convert('RGBA')
    os.makedirs(OUT_DIR, exist_ok=True)
    files, wanted, changed = {}, set(), []
    for c in cards:
        if c['id'] == 'home':
            c = dict(c, icon='logo')
        png = render(c, logo)
        if len(png) > SIZE_BUDGET:
            raise SystemExit('%s is %d bytes, over the %d budget' % (c['id'], len(png), SIZE_BUDGET))
        name = '%s.%s.png' % (c['id'], hashlib.sha256(png).hexdigest()[:10])
        files[c['id']] = '/og/' + name
        wanted.add(name)
        dest = os.path.join(OUT_DIR, name)
        if not os.path.exists(dest):
            changed.append(name)
            if not check:
                with open(dest, 'wb') as fh:
                    fh.write(png)
        print('%-16s %6d bytes  /og/%s' % (c['id'], len(png), name))

    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.png') and name not in wanted:
            changed.append('delete ' + name)
            if not check:
                os.remove(os.path.join(OUT_DIR, name))

    manifest = js_manifest(cards, files)
    old = open(MANIFEST, encoding='utf-8').read() if os.path.exists(MANIFEST) else ''
    if old != manifest:
        changed.append('lib/og-images.js')
        if not check:
            with open(MANIFEST, 'w', encoding='utf-8') as fh:
                fh.write(manifest)

    if check and changed:
        print('out of date: ' + ', '.join(changed))
        sys.exit(1)
    print('ok' if not changed else 'wrote: ' + ', '.join(changed))


if __name__ == '__main__':
    if '--renderer' in sys.argv[1:]:
        print(renderer())
    else:
        main()
