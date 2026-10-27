// Post-build step: per-section copies of the SPA shell for link-preview crawlers.
//
// X, Slack, Telegram, Discord, LinkedIn and Facebook read Open Graph tags from
// the HTML the server returns and never run JavaScript, so updateSeoMeta() in
// script.js is invisible to them: every link used to unfurl as the home page.
// This writes, into the Vite output directory:
//
//   dist/index.html                 home card image; title and text untouched
//   dist/<section>/index.html       exact route (/democracy): the section's
//                                   title, description, canonical, og:url, card
//   dist/<section>/_deep.html       deep links (/democracy/referendum/5): the
//                                   section's title and card, but NO canonical
//                                   and NO og:url, so the page is not declared
//                                   a duplicate of /democracy (the SPA sets the
//                                   real canonical once it runs)
//
// nginx picks the file (nginx.conf: `try_files $uri $uri/index.html
// $og_section_shell /index.html`); lib/og-route.js states the same rule for the
// SPA. Titles and descriptions come from ROUTE_SEO in script.js, so a crawler
// sees what a browser tab shows. Every tag edited must already exist in
// index.html exactly once: a missing or duplicated tag fails the build rather
// than shipping a shell with the wrong preview.
//
// Run by the `og-section-shells` plugin in vite.config.js on every
// `vite build`. Idempotent: the output depends only on dist/index.html's
// non-image tags, script.js and lib/og-images.js.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { OG_CARDS, OG_ROUTES } from '../../lib/og-images.js';
import { OG_DEEP_SHELL, ogImageUrl, OG_ORIGIN } from '../../lib/og-route.js';

// ROUTE_SEO is a plain object literal of strings in script.js, which is a
// browser bundle with no export surface. Lift the literal out and evaluate it
// in an empty context.
export function extractRouteSeo(scriptSrc) {
    const start = scriptSrc.indexOf('const ROUTE_SEO = {');
    if (start === -1) throw new Error('og shells: `const ROUTE_SEO = {` not found in script.js');
    const open = scriptSrc.indexOf('{', start);
    const close = scriptSrc.indexOf('\n};', open);
    if (close === -1) throw new Error('og shells: end of ROUTE_SEO (a line starting with `};`) not found');
    const seo = vm.runInNewContext('(' + scriptSrc.slice(open, close + 2) + ')', Object.create(null));
    if (!seo || typeof seo.home?.title !== 'string') throw new Error('og shells: ROUTE_SEO did not evaluate to a route map');
    return seo;
}

export function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOnce(html, re, replacement, what) {
    const hits = html.match(new RegExp(re.source, 'g')) || [];
    if (hits.length !== 1) throw new Error(`og shells: expected exactly one ${what} in index.html, found ${hits.length}`);
    return html.replace(re, replacement);
}

function metaRe(attr, key) {
    return new RegExp(`<meta\\s+${attr}="${escapeRe(key)}"\\s+content="[^"]*"\\s*/?>`);
}

export function setMeta(html, attr, key, value) {
    return replaceOnce(html, metaRe(attr, key), `<meta ${attr}="${key}" content="${escapeAttr(value)}">`, `<meta ${attr}="${key}">`);
}

function removeMeta(html, attr, key) {
    return replaceOnce(html, new RegExp(`[ \\t]*${metaRe(attr, key).source}[ \\t]*\\n?`), '', `<meta ${attr}="${key}">`);
}

const CANONICAL_RE = /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/;
const TITLE_RE = /<title>[^<]*<\/title>/;
const HOME_LD_RE = /<script\s+type="application\/ld\+json"\s+id="home-jsonld">/;

// One shell. `route` is an OG_ROUTES entry; `seo` the ROUTE_SEO map.
export function buildShell(template, { route, seo, deep = false }) {
    const card = OG_CARDS[route.card];
    if (!card) throw new Error(`og shells: route ${route.path} names unknown card ${route.card}`);
    const image = ogImageUrl(card);
    let html = template;
    html = setMeta(html, 'property', 'og:image', image);
    html = setMeta(html, 'property', 'og:image:secure_url', image);
    html = setMeta(html, 'property', 'og:image:width', String(card.width));
    html = setMeta(html, 'property', 'og:image:height', String(card.height));
    html = setMeta(html, 'property', 'og:image:alt', card.alt);
    html = setMeta(html, 'name', 'twitter:image', image);
    html = setMeta(html, 'name', 'twitter:image:alt', card.alt);
    // The home page keeps index.html's hand-written title and copy: only its
    // picture changes.
    if (route.path === '/') return html;

    const meta = seo[route.seo];
    if (!meta) throw new Error(`og shells: ROUTE_SEO has no '${route.seo}' entry (route ${route.path})`);
    html = replaceOnce(html, TITLE_RE, `<title>${escapeAttr(meta.title)}</title>`, '<title>');
    html = setMeta(html, 'name', 'description', meta.description);
    html = setMeta(html, 'property', 'og:title', meta.title);
    html = setMeta(html, 'property', 'og:description', meta.description);
    html = setMeta(html, 'property', 'og:type', 'article');   // as updateSeoMeta does off home
    html = setMeta(html, 'name', 'twitter:title', meta.title);
    html = setMeta(html, 'name', 'twitter:description', meta.description);
    if (meta.noindex) {
        html = setMeta(html, 'name', 'robots', 'noindex, nofollow');
        html = setMeta(html, 'name', 'googlebot', 'noindex, nofollow');
    }
    if (deep) {
        html = replaceOnce(html, new RegExp(`[ \\t]*${CANONICAL_RE.source}[ \\t]*\\n?`), '', 'canonical link');
        html = removeMeta(html, 'property', 'og:url');
    } else {
        const canonical = OG_ORIGIN + (route.canonical || route.path);
        html = replaceOnce(html, CANONICAL_RE, `<link rel="canonical" href="${escapeAttr(canonical)}">`, 'canonical link');
        // og:url is the address that was shared, not the canonical: /stake
        // canonicalises to /wallet, but a /stake link must keep the stake card.
        html = setMeta(html, 'property', 'og:url', OG_ORIGIN + route.path);
    }
    // F-062: the site-wide @graph describes the home page. The SPA disables it
    // off home; do the same in the static copy.
    html = replaceOnce(html, HOME_LD_RE, '<script type="application/ld+json-disabled" id="home-jsonld">', 'home-jsonld script');
    return html;
}

// Write every shell into distDir. Returns the list of files written, relative
// to distDir. Throws (failing the build) on any inconsistency.
export function writeShells({ distDir, scriptPath }) {
    const indexPath = join(distDir, 'index.html');
    const template = readFileSync(indexPath, 'utf8');
    const seo = extractRouteSeo(readFileSync(scriptPath, 'utf8'));

    for (const [id, card] of Object.entries(OG_CARDS)) {
        if (!existsSync(join(distDir, card.file))) {
            throw new Error(`og shells: card '${id}' points at ${card.file}, which is not in the build output. ` +
                'Run python3 tools/og/generate.py and commit public/og/ and lib/og-images.js together.');
        }
    }

    const outputs = [];
    for (const route of OG_ROUTES) {
        if (route.path === '/') {
            outputs.push(['index.html', buildShell(template, { route, seo })]);
            continue;
        }
        const dir = join(distDir, route.path.slice(1));
        if (existsSync(dir) && !statSync(dir).isDirectory()) {
            throw new Error(`og shells: ${route.path} collides with a file in the build output`);
        }
        outputs.push([route.path.slice(1) + '/index.html', buildShell(template, { route, seo })]);
        outputs.push([route.path.slice(1) + '/' + OG_DEEP_SHELL, buildShell(template, { route, seo, deep: true })]);
    }
    for (const [rel, html] of outputs) {
        mkdirSync(join(distDir, rel, '..'), { recursive: true });
        writeFileSync(join(distDir, rel), html);
    }
    return outputs.map(([rel]) => rel);
}
