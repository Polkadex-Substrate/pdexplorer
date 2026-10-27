// Per-section Open Graph cards: images, crawler shells, nginx selection, SPA sync.
//
// Link-preview crawlers never run JavaScript, so the card a shared link shows
// is decided by three static things that must agree: the committed PNGs and
// their generated map (lib/og-images.js), the shells the build writes
// (tools/og/shells.mjs), and the file nginx picks for a URL (nginx.conf). The
// SPA then has to keep the tags in step on in-app navigation (script.js via
// lib/og-route.js). Each describe block below pins one of those links.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, cpSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './helpers/source.js';
import { OG_CARDS, OG_ROUTES, OG_RENDERER } from '../lib/og-images.js';
import { ogRouteFor, ogCardFor, ogImageUrl, OG_ORIGIN, OG_DEEP_SHELL, normalizeOgPath } from '../lib/og-route.js';
import { writeShells, buildShell, extractRouteSeo, escapeAttr } from '../tools/og/shells.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const SECTIONS = JSON.parse(read('tools/og/sections.json')).cards;
const ROUTE_SEO = extractRouteSeo(read('script.js'));

// The sidebar sections the CEO asked for (index.html nav), by path.
const REQUIRED_PATHS = ['/', '/holders', '/transactions', '/blocks', '/events', '/validators',
    '/staking-rewards', '/analytics', '/watchlist', '/wallet', '/stake', '/democracy', '/council',
    '/treasury', '/discussions', '/developers'];

function meta(html, attr, key) {
    const m = html.match(new RegExp(`<meta\\s+${attr}="${key.replace(/[.:]/g, '\\$&')}"\\s+content="([^"]*)"`, 'g')) || [];
    if (m.length > 1) throw new Error(`duplicate meta ${key}`);
    return m.length ? m[0].match(/content="([^"]*)"/)[1] : null;
}
const canonicalOf = (html) => (html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/) || [])[1] || null;

function pngSize(buf) {
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
    assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('OG images: committed PNGs and the generated map', () => {
    test('every section the sidebar lists has a route with a card', () => {
        for (const p of REQUIRED_PATHS) {
            const r = OG_ROUTES.find(x => x.path === p);
            assert.ok(r, `no OG route for ${p}`);
            assert.ok(OG_CARDS[r.card], `${p} names missing card ${r.card}`);
        }
        const nav = [...read('index.html').matchAll(/<a href="(\/[a-z-]*)" class="nav-item[ "]/g)].map(m => m[1]);
        for (const p of REQUIRED_PATHS) assert.ok(nav.includes(p), `${p} is not a sidebar link any more; update REQUIRED_PATHS`);
    });

    test('each card is a 1200x630 PNG under 150 KB whose name carries its own hash', () => {
        for (const [id, card] of Object.entries(OG_CARDS)) {
            const file = path.join(ROOT, 'public', card.file);
            assert.ok(existsSync(file), `${id}: ${card.file} missing from public/`);
            const buf = readFileSync(file);
            assert.deepEqual(pngSize(buf), { width: 1200, height: 630 }, `${id} dimensions`);
            assert.deepEqual([card.width, card.height], [1200, 630]);
            assert.ok(buf.length <= 150 * 1024, `${id} is ${buf.length} bytes, over the 150 KB budget`);
            const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
            assert.equal(card.file, `/og/${id}.${hash}.png`,
                `${id}: file name hash does not match its bytes; re-run python3 tools/og/generate.py`);
            assert.ok(card.alt && !/[\u2013\u2014]/.test(card.alt), `${id}: alt text missing or has a dash character`);
        }
    });

    test('public/og holds exactly the cards in the map, nothing stale', () => {
        const onDisk = readdirSync(path.join(ROOT, 'public/og')).sort();
        const mapped = Object.values(OG_CARDS).map(c => path.basename(c.file)).sort();
        assert.deepEqual(onDisk, mapped);
    });

    test('lib/og-images.js matches tools/og/sections.json', () => {
        assert.deepEqual(Object.keys(OG_CARDS).sort(), SECTIONS.map(c => c.id).sort());
        const fromJson = SECTIONS.flatMap(c => c.routes.map(r => ({ path: r.path, card: c.id, seo: r.seo, ...(r.canonical ? { canonical: r.canonical } : {}) })));
        assert.deepEqual(OG_ROUTES, fromJson, 'sections.json changed without re-running the generator');
        assert.equal(new Set(OG_ROUTES.map(r => r.path)).size, OG_ROUTES.length, 'duplicate route path');
    });

    test('every route names a ROUTE_SEO entry in script.js', () => {
        for (const r of OG_ROUTES) {
            assert.ok(ROUTE_SEO[r.seo] && ROUTE_SEO[r.seo].title && ROUTE_SEO[r.seo].description,
                `ROUTE_SEO['${r.seo}'] missing (route ${r.path})`);
        }
    });

    test('the generator reproduces the committed files (skipped without python3 + Pillow)', (t) => {
        const probe = spawnSync('python3', ['tools/og/generate.py', '--renderer'], { cwd: ROOT, encoding: 'utf8' });
        if (probe.status !== 0) { t.skip('python3 with Pillow not available'); return; }
        // Another Pillow/FreeType can move pixels and so change every hash;
        // that is not a defect, so only the renderer that made the committed
        // files is held to an exact match.
        if (probe.stdout.trim() !== OG_RENDERER) { t.skip(`renderer is ${probe.stdout.trim()}, files were made with ${OG_RENDERER}`); return; }
        const run = spawnSync('python3', ['tools/og/generate.py', '--check'], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(run.status, 0, `generate.py --check: ${run.stdout}${run.stderr}`);
    });
});

describe('OG route rule (lib/og-route.js)', () => {
    test('exact, trailing slash, deep and unknown paths', () => {
        assert.equal(ogRouteFor('/democracy').route.card, 'democracy');
        assert.equal(ogRouteFor('/democracy').deep, false);
        assert.equal(ogRouteFor('/democracy/').deep, false);
        assert.equal(ogRouteFor('/democracy/referendum/5').route.card, 'democracy');
        assert.equal(ogRouteFor('/democracy/referendum/5').deep, true);
        assert.equal(ogRouteFor('/stake').route.card, 'stake');
        assert.equal(ogRouteFor('/wallet/esabc').route.card, 'wallet');
        assert.equal(ogRouteFor('/block/123'), null);
        assert.equal(ogRouteFor('/help/brand-kit'), null);
        assert.deepEqual(ogRouteFor(''), ogRouteFor('/'));
        assert.equal(ogCardFor('/block/123'), OG_CARDS.home);
        assert.equal(ogCardFor('/treasury?proposal=4#x'), OG_CARDS.treasury);
        assert.equal(normalizeOgPath('/blocks//'), '/blocks');
        assert.equal(ogImageUrl(OG_CARDS.home), OG_ORIGIN + OG_CARDS.home.file);
    });
});

describe('crawler shells (tools/og/shells.mjs)', () => {
    let dist;
    let written;
    before(() => {
        // A stand-in for Vite's output: the source index.html carries every
        // tag the built one does (Vite only rewrites asset references).
        dist = mkdtempSync(path.join(tmpdir(), 'og-shells-'));
        cpSync(path.join(ROOT, 'index.html'), path.join(dist, 'index.html'));
        cpSync(path.join(ROOT, 'public/og'), path.join(dist, 'og'), { recursive: true });
        written = writeShells({ distDir: dist, scriptPath: path.join(ROOT, 'script.js') });
    });
    after(() => rmSync(dist, { recursive: true, force: true }));
    const shell = (rel) => readFileSync(path.join(dist, rel), 'utf8');

    test('one exact and one deep shell per section route, plus the home shell', () => {
        const expected = ['index.html', ...OG_ROUTES.filter(r => r.path !== '/')
            .flatMap(r => [`${r.path.slice(1)}/index.html`, `${r.path.slice(1)}/${OG_DEEP_SHELL}`])];
        assert.deepEqual([...written].sort(), expected.sort());
    });

    test('every section shell carries its own absolute card, title, url and canonical', () => {
        for (const r of OG_ROUTES) {
            const html = shell(r.path === '/' ? 'index.html' : `${r.path.slice(1)}/index.html`);
            const img = OG_ORIGIN + OG_CARDS[r.card].file;
            assert.equal(meta(html, 'property', 'og:image'), img, `${r.path} og:image`);
            assert.equal(meta(html, 'property', 'og:image:secure_url'), img, `${r.path} og:image:secure_url`);
            assert.equal(meta(html, 'name', 'twitter:image'), img, `${r.path} twitter:image`);
            assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
            assert.equal(meta(html, 'property', 'og:site_name'), 'Polkadex Explorer');
            assert.equal(meta(html, 'property', 'og:image:width'), '1200');
            assert.equal(meta(html, 'property', 'og:image:height'), '630');
            assert.equal(meta(html, 'property', 'og:image:alt'), escapeAttr(OG_CARDS[r.card].alt));
            for (const v of [meta(html, 'property', 'og:url'), canonicalOf(html), img]) {
                assert.ok(v && v.startsWith('https://explorer.polkadex.ee/'), `${r.path}: ${v} is not absolute https`);
            }
            if (r.path === '/') continue;
            const seo = ROUTE_SEO[r.seo];
            assert.ok(html.includes(`<title>${escapeAttr(seo.title)}</title>`), `${r.path} <title>`);
            assert.equal(meta(html, 'property', 'og:title'), escapeAttr(seo.title));
            assert.equal(meta(html, 'name', 'description'), escapeAttr(seo.description));
            assert.equal(meta(html, 'property', 'og:description'), escapeAttr(seo.description));
            assert.equal(meta(html, 'name', 'twitter:title'), escapeAttr(seo.title));
            assert.equal(meta(html, 'property', 'og:type'), 'article');
            assert.equal(meta(html, 'property', 'og:url'), OG_ORIGIN + r.path);
            assert.equal(canonicalOf(html), OG_ORIGIN + (r.canonical || r.path));
            assert.match(html, /type="application\/ld\+json-disabled" id="home-jsonld"/, `${r.path}: home JSON-LD still live`);
            const robots = seo.noindex ? 'noindex, nofollow' : null;
            if (robots) assert.equal(meta(html, 'name', 'robots'), robots, `${r.path} should be noindex`);
        }
    });

    test('/stake canonicalises to /wallet but keeps its own og:url and card', () => {
        const html = shell('stake/index.html');
        assert.equal(canonicalOf(html), OG_ORIGIN + '/wallet');
        assert.equal(meta(html, 'property', 'og:url'), OG_ORIGIN + '/stake');
        assert.equal(meta(html, 'property', 'og:image'), OG_ORIGIN + OG_CARDS.stake.file);
    });

    test('home keeps index.html copy and only changes the picture', () => {
        const src = read('index.html');
        const html = shell('index.html');
        for (const [a, k] of [['property', 'og:title'], ['property', 'og:description'], ['name', 'description'],
            ['property', 'og:url'], ['property', 'og:type'], ['name', 'twitter:title']]) {
            assert.equal(meta(html, a, k), meta(src, a, k), `home ${k} changed`);
        }
        assert.equal(canonicalOf(html), 'https://explorer.polkadex.ee/');
        assert.equal(meta(html, 'property', 'og:image'), OG_ORIGIN + OG_CARDS.home.file);
        assert.match(html, /type="application\/ld\+json" id="home-jsonld"/);
    });

    test('deep shells drop canonical and og:url but keep the section card', () => {
        for (const r of OG_ROUTES.filter(x => x.path !== '/')) {
            const html = shell(`${r.path.slice(1)}/${OG_DEEP_SHELL}`);
            assert.equal(canonicalOf(html), null, `${r.path} deep shell has a canonical`);
            assert.equal(meta(html, 'property', 'og:url'), null, `${r.path} deep shell has og:url`);
            assert.equal(meta(html, 'property', 'og:image'), OG_ORIGIN + OG_CARDS[r.card].file);
            assert.equal(meta(html, 'property', 'og:title'), escapeAttr(ROUTE_SEO[r.seo].title));
        }
    });

    test('the build step is idempotent', () => {
        const before = Object.fromEntries(written.map(f => [f, shell(f)]));
        const again = writeShells({ distDir: dist, scriptPath: path.join(ROOT, 'script.js') });
        assert.deepEqual(again, written);
        for (const f of again) assert.equal(shell(f), before[f], `${f} changed on a second run`);
    });

    test('a tag missing from index.html fails loudly instead of shipping a wrong preview', () => {
        const broken = read('index.html').replace(/<meta property="og:image" [^>]*>/, '');
        assert.throws(() => buildShell(broken, { route: OG_ROUTES.find(r => r.path === '/blocks'), seo: ROUTE_SEO }),
            /exactly one <meta property="og:image">/);
    });

    test('a card PNG missing from the build output fails the build', () => {
        const d = mkdtempSync(path.join(tmpdir(), 'og-missing-'));
        try {
            cpSync(path.join(ROOT, 'index.html'), path.join(d, 'index.html'));
            assert.throws(() => writeShells({ distDir: d, scriptPath: path.join(ROOT, 'script.js') }), /not in the build output/);
        } finally { rmSync(d, { recursive: true, force: true }); }
    });

    // nginx is not available to the test suite, so resolve URLs with the same
    // try_files order and map regex read out of nginx.conf, against these
    // shells, and check the result against lib/og-route.js.
    test('nginx try_files + map pick the shell lib/og-route.js predicts', () => {
        const conf = stripComments(read('nginx.conf'), { line: '#', block: false });
        const tries = [...conf.matchAll(/try_files\s+([^;]*\/index\.html[^;]*);/g)].map(m => m[1].trim().split(/\s+/));
        assert.equal(tries.length, 2, 'expected the SPA try_files in both server blocks');
        for (const t of tries) assert.deepEqual(t, ['$uri', '$uri/index.html', '$og_section_shell', '/index.html']);
        const map = conf.match(/map\s+\$uri\s+\$og_section_shell\s*\{([^}]*)\}/);
        assert.ok(map, 'map $uri $og_section_shell missing');
        const def = map[1].match(/default\s+(\S+);/)[1];
        const [, rx, val] = map[1].match(/"~([^"]+)"\s+(\S+);/);
        assert.equal(def, '/index.html');
        assert.ok(rx.includes('[a-z0-9-]+') && !/\[[^\]]*[./][^\]]*\]/.test(rx), 'section segment must stay [a-z0-9-]');
        const re = new RegExp(rx);
        const isFile = (u) => { const f = path.join(dist, u); return existsSync(f) && statSync(f).isFile(); };
        const isDir = (u) => { const f = path.join(dist, u); return existsSync(f) && statSync(f).isDirectory(); };
        const resolve = (uri) => {
            if (uri.endsWith('/') && isDir(uri)) return path.join(uri, 'index.html');   // `$uri` dir test + index
            if (!uri.endsWith('/') && isFile(uri)) return uri;
            if (isFile(uri + '/index.html')) return uri + '/index.html';
            const m = uri.match(re);
            const shellUri = m ? val.replace('$og_section', m.groups.og_section) : def;
            if (isFile(shellUri)) return shellUri;
            return '/index.html';
        };
        const cases = ['/', '/blocks', '/blocks/', '/democracy/referendum/5', '/council/motion/0xabc',
            '/treasury/proposal/3', '/stake', '/staking', '/wallet/esabc', '/staking-rewards/esabc',
            '/discussions/12', '/chain-state', '/block/123', '/help/brand-kit', '/nope', '/og'];
        for (const uri of cases) {
            const served = shell(resolve(uri).replace(/^\/+/, ''));
            assert.equal(meta(served, 'property', 'og:image'), ogImageUrl(ogCardFor(uri)), `${uri}: nginx and the SPA disagree on the card`);
            const r = ogRouteFor(uri);
            if (r && r.deep) assert.equal(canonicalOf(served), null, `${uri}: deep link served a section canonical`);
        }
    });
});

describe('serving and in-app sync', () => {
    test('HTML is never cached: both server blocks send the Cache-Control map, text/html is no-cache', () => {
        const conf = stripComments(read('nginx.conf'), { line: '#', block: false });
        const servers = conf.split(/\nserver\s*\{/).slice(1);
        assert.equal(servers.length, 2);
        for (const s of servers) {
            const top = s.split(/\n\s*location\s/)[0];
            assert.match(top, /add_header\s+Cache-Control\s+\$cache_control_for_type\s+always;/);
        }
        assert.match(conf, /~\^text\/html\s+"no-cache, no-store, must-revalidate";/);
    });

    test('the build registers the shell writer', () => {
        const cfg = stripComments(read('vite.config.js'));
        assert.match(cfg, /import \{ writeShells \} from '\.\/tools\/og\/shells\.mjs'/);
        assert.match(cfg, /plugins:\s*\[ogSectionShells\(\)\]/);
        assert.match(cfg, /closeBundle\(\)\s*\{[^}]*writeShells\(/);
    });

    test('updateSeoMeta keeps og:image and twitter:image in step with the route', () => {
        const src = stripComments(read('script.js'));
        assert.match(src, /import \{ ogCardFor, ogImageUrl \} from '\.\/lib\/og-route\.js';/);
        const fn = src.slice(src.indexOf('function updateSeoMeta('), src.indexOf('function setMetaContent('));
        assert.match(fn, /ogCardFor\(window\.location\.pathname\)/);
        for (const k of ["'property', 'og:image'", "'property', 'og:image:secure_url'", "'name', 'twitter:image'", "'property', 'og:image:alt'"]) {
            assert.ok(fn.includes(`setMetaContent(${k}`), `updateSeoMeta does not set ${k}`);
        }
    });

    test('the server-rendered /developers page carries the developers card', () => {
        const src = read('server.js');
        assert.match(src, /import \{ OG_CARDS \} from '\.\/lib\/og-images\.js';/);
        const page = src.slice(src.indexOf('const DEVELOPERS_HTML = `'), src.indexOf('</head>', src.indexOf('const DEVELOPERS_HTML = `')));
        assert.match(page, /<meta property="og:image" content="\$\{SITE_URL\}\$\{OG_CARDS\.developers\.file\}">/);
        assert.match(page, /<meta name="twitter:card" content="summary_large_image">/);
    });
});
