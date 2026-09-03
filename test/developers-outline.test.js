// Audit F-060 (round 2): "/developers is two different documents."
//
// There are two renderers for one page — the server-rendered document in
// server.js (the only SSR route in the app) and renderDevelopersPage() in
// script.js. Round 1 moved the ROUTE TABLE into lib/api-reference.js so the two
// could not list different endpoints. The residual was everything around the
// routes, which had drifted in ways a reader would notice:
//
//   * only the SPA emitted section ids and a table of contents, so a shared
//     `/developers#caching` link scrolled correctly in the SPA and landed at the
//     top of the page for anything that fetched the server-rendered HTML
//   * the sections were in different orders
//   * "Errors & addresses" was one heading server-side and two in the SPA
//   * each maintained its own cache-tier prose, and BOTH had drifted from the
//     handlers the same dangerous way (F-083)
//
// The fix is structural: DOC_OUTLINE owns order, ids and headings; each renderer
// supplies only bodies. These tests assert the structure holds, because the
// failure mode is silent — the page still renders, it just quietly stops being
// the same document as the other one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    DOC_OUTLINE, renderToc, renderOutline, renderCacheTiers, tocLabel, CACHE_TIERS
} from '../lib/api-reference.js';
import { readRepo, stripComments } from './helpers/source.js';
import { developersBodies } from '../lib/developers-bodies.js';

const sharedBodiesSrc = readRepo('lib/developers-bodies.js', import.meta.url);

const serverSrc = readRepo('server.js', import.meta.url);
const scriptSrc = readRepo('script.js', import.meta.url);
const ids = DOC_OUTLINE.map(e => e.id);

describe('the outline is well formed', () => {
    test('ids are unique', () => {
        assert.equal(new Set(ids).size, ids.length, 'a duplicate id makes one anchor unreachable');
    });

    test('every id is anchor-safe', () => {
        for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `not usable as a URL fragment: ${id}`);
    });

    test('every entry has a heading and a TOC label', () => {
        for (const e of DOC_OUTLINE) {
            assert.ok(e.title && e.title.trim(), `no title: ${e.id}`);
            assert.ok(tocLabel(e).trim(), `no TOC label: ${e.id}`);
        }
    });

    test('the previously-public anchors all survive', () => {
        // These shipped in the SPA before the consolidation. Renaming one
        // silently breaks every link anyone has shared, which is why the
        // outline adopted the SPA's ids and order rather than inventing new
        // ones — including `contact`, whose heading now reads "Found a bug…".
        for (const id of ['overview', 'cors', 'caching', 'chain', 'inspect', 'schema',
                          'accounts', 'labels', 'analytics', 'price', 'governance',
                          'email', 'discussions', 'auth', 'meta', 'errors',
                          'addresses', 'examples', 'contact']) {
            assert.ok(ids.includes(id), `anchor removed — every shared /developers#${id} link now 404s to the top of the page`);
        }
    });
});

describe('renderToc and renderOutline agree by construction', () => {
    test('the TOC links exactly the sections that exist, in order', () => {
        const tocIds = [...renderToc().matchAll(/href="#([a-z0-9-]+)"/g)].map(m => m[1]);
        const secIds = [...renderOutline(() => 'x').matchAll(/<section[^>]* id="([a-z0-9-]+)">/g)].map(m => m[1]);
        assert.deepEqual(tocIds, ids);
        assert.deepEqual(secIds, ids);
    });

    test('a section always gets its anchor, even with an empty body', () => {
        // The reason the heading is emitted by the outline rather than the
        // caller: a renderer that has no prose for a section still cannot ship
        // it without an id.
        const html = renderOutline(() => '');
        for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing anchor: ${id}`);
    });

    test('class names are parameters, not forks', () => {
        // The two pages have separate stylesheets. That is the ONLY thing they
        // are allowed to differ on.
        assert.match(renderOutline(() => '', { sectionClass: 'developers-section' }), /<section class="developers-section" id="overview">/);
        assert.match(renderToc({ navClass: 'developers-toc' }), /<nav class="developers-toc"/);
    });

    test('bodies are inserted verbatim (they are trusted HTML, not user input)', () => {
        assert.ok(renderOutline(e => e.id === 'chain' ? '<ul><li>x</li></ul>' : '').includes('<ul><li>x</li></ul>'));
    });

    test('titles are escaped', () => {
        // API_SECTIONS summaries and titles are escaped elsewhere; the outline
        // must not be the one place that isn't.
        assert.match(renderOutline(() => ''), /Build provenance &amp; liveness/);
    });
});

describe('both renderers walk the outline', () => {
    const server = stripComments(serverSrc);
    const script = stripComments(scriptSrc);

    test('neither hand-writes its own table of contents', () => {
        // The SPA used to carry 18 literal <a href="#…"> links. That list is
        // what fell out of step with the server page.
        assert.ok(!/<a href="#overview">/.test(script),
            'script.js hand-writes TOC links again — that IS F-060');
        assert.ok(!/<a href="#overview">/.test(server));
        assert.match(script, /renderToc\(\{ navClass: 'developers-toc' \}\)/);
        assert.match(server, /\$\{renderToc\(\)\}/);
    });

    test('neither hand-writes section headings', () => {
        assert.ok(!/<section class="developers-section" id=/.test(script),
            'script.js emits its own <section id> again — order and ids can drift');
        assert.ok(!/<h2>Chain data \(read-only, public\)<\/h2>/.test(server),
            'server.js hand-writes a section heading again');
        assert.match(script, /renderOutline\(\(entry\) => DEVELOPERS_SECTION_BODIES\[entry\.id\]/);
        assert.match(server, /renderOutline\(\(entry\) => DEVELOPERS_BODIES\[entry\.id\]/);
    });

    test('there is a body for every section in the outline', () => {
        // A missing key renders as an empty section: the heading and anchor are
        // there, but the content silently vanishes.
        //
        // F-060 round 3: this used to check TWO hand-maintained maps. They had
        // drifted in all eight sections they shared, and the server's was
        // missing ten sections outright — which this test could not see,
        // because it only asked whether each id had *a* key, never whether the
        // two agreed. Now there is one map, so the question is simply whether
        // it covers the outline, asserted against the BUILT object rather than
        // the source text.
        const bodies = developersBodies();
        for (const id of ids) {
            assert.ok(typeof bodies[id] === 'string' && bodies[id].trim() !== '',
                `no body for the '${id}' section — it will render as a bare heading`);
        }
    });

    test('both renderers build from that one map', () => {
        // The property the old two-map version could not express.
        assert.match(server, /developersBodies\(\{ siteUrl: SITE_URL \}\)/,
            'server.js no longer builds from the shared bodies');
        assert.match(script, /developersBodies\(\)/,
            'script.js no longer builds from the shared bodies');
        for (const [label, src] of [['server.js', server], ['script.js', script]]) {
            assert.ok(!/const DEVELOPERS_(SECTION_)?BODIES = \{/.test(src),
                `${label} has grown its own body map again — the two will drift`);
        }
    });

    test('the cache tiers are rendered from the shared table, not retyped', () => {
        // F-083. Both pages described the tiers in their own prose and both had
        // drifted from the handlers.
        // Now asserted on the shared module (F-060) rather than on each file.
        const bodies = developersBodies();
        assert.ok(bodies.caching && bodies.caching.includes('developers-table'),
            'the caching section is no longer rendered from CACHE_TIERS');
        assert.match(sharedBodiesSrc, /renderCacheTiers\(/);
        assert.ok(!/max-age=30<\/code>.*wallet/i.test(bodies.caching || ''),
            'the caching section hand-lists the medium tier again');
    });
});

describe('F-083 — the documented tiers match the handlers', () => {
    const server = stripComments(serverSrc);

    test('nothing per-caller is advertised as shareable', () => {
        // The specific error both pages had made. /api/wallet/:address is one
        // account's balances; describing it as cacheable for 30 seconds invites
        // an intermediary to serve one visitor's balances to another.
        const shareable = CACHE_TIERS.filter(t => t.header.startsWith('public'));
        for (const t of shareable) {
            for (const r of t.routes) {
                assert.ok(!/:address|\/api\/auth|\/api\/email|\/api\/search/.test(r),
                    `${r} is per-caller but sits in the '${t.name}' (public) tier`);
            }
        }
    });

    test('the wallet dashboard is in the no-shared-cache tier', () => {
        const tier = CACHE_TIERS.find(t => t.routes.includes('/api/wallet/:address'));
        assert.ok(tier, '/api/wallet/:address is not described at all');
        assert.equal(tier.name, 'No shared cache');
    });

    test('and the handler really does send no-store for it', () => {
        // Reads the source rather than trusting the table: the point of F-083
        // is that the docs and the handlers disagreed.
        const i = server.indexOf("app.get('/api/wallet/:address'");
        assert.ok(i !== -1, 'the wallet handler moved — re-point this test');
        const handler = server.slice(i, i + 1500);
        assert.ok(/no-store|noStore\(res\)/.test(handler),
            'the wallet handler no longer sends no-store, so the tier table is now the lie F-083 described');
    });

    test('every tier has a header, a description and at least one route', () => {
        for (const t of CACHE_TIERS) {
            assert.ok(t.name && t.header && t.what, `incomplete tier: ${JSON.stringify(t)}`);
            assert.ok(t.routes.length > 0, `tier '${t.name}' lists no routes`);
        }
    });

    test('the rendered table names every tier', () => {
        const html = renderCacheTiers();
        for (const t of CACHE_TIERS) assert.ok(html.includes(t.name), `tier missing from output: ${t.name}`);
    });
});
