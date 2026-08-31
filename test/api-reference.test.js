// Audit F-154 + F-155 — /developers is generated from one route table, and the
// documented RPC-outage envelope is the one the server sends.
//
// These are cross-FILE invariants, which is why they are here rather than in a
// unit test: nothing inside server.js can notice that script.js disagrees with
// it, and nothing inside either can notice that README.md has grown a route
// neither renders. The finding is precisely that class of gap — four copies of
// a list, each individually consistent, collectively wrong.
//
// The trap this suite avoids (it has caught out three earlier suites in this
// repo): a "must not contain" grep that matches the source file's OWN comment
// explaining why the string is banned. Every negative assertion below runs
// against comment-stripped source.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    API_SECTIONS, allRoutes, basePath, findSection, renderSection,
    RPC_NOT_READY, rpcNotReadyExample
} from '../lib/api-reference.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// Strip comments so that a "must not appear" assertion cannot be satisfied by
// the source file's OWN explanation of why the string is banned. (Third time
// this trap has bitten these suites — see the note at the top of
// test/cert-perms.test.js.)
//
// Order and conservatism both matter here. Line comments go first, because
// prose like "the /api/diag/* endpoints" contains a `/*` that a naive block
// stripper pairs with the next real `*/` and swallows two hundred lines of
// code — which silently turns every assertion below into a tautology. Block
// comments are then only stripped when `/*` opens a line, which no string
// literal in this codebase does.
function stripJsComments(src) {
    const noLine = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    return noLine.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
}

const serverJs = read('server.js');
const scriptJs = read('script.js');
const serverCode = stripJsComments(serverJs);
const scriptCode = stripJsComments(scriptJs);
const readme = read('README.md');
const llms = read('public/llms.txt');

// The routes the round-2 audit named as missing from BOTH /developers copies.
// Listed literally rather than derived, so that deleting them from the table
// fails here instead of quietly shrinking the expectation.
const F154_MISSING_ROUTES = [
    '/api/labels/:address',
    '/api/identity/:address',
    '/api/proxies/:address',
    '/api/proxy-types',
    '/api/multisigs/:address',
    '/api/analytics/timeseries',
    '/api/analytics/snapshot',
    '/api/extrinsic-by-hash/:txHash',
    '/api/version',
    '/api/health'
];

describe('the route table itself (F-154)', () => {
    test('every section has a unique id and at least one route', () => {
        const ids = API_SECTIONS.map(s => s.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate section id in API_SECTIONS: ${ids.join(', ')}`);
        for (const s of API_SECTIONS) {
            assert.ok(s.routes.length > 0, `section '${s.id}' has no routes`);
            assert.ok(s.title, `section '${s.id}' has no title`);
        }
    });

    test('every route has a method, an /api-style path and a summary', () => {
        for (const r of allRoutes()) {
            assert.match(r.method, /^(GET|POST|PUT|DELETE)$/, `bad method on ${r.path}`);
            assert.match(r.path, /^\//, `path must be absolute: ${r.path}`);
            assert.ok(r.summary && r.summary.length > 3, `no summary for ${r.method} ${r.path}`);
        }
    });

    test('no duplicate method+path pairs', () => {
        const keys = allRoutes().map(r => `${r.method} ${r.path}`);
        assert.equal(new Set(keys).size, keys.length,
            'the same endpoint is listed twice — the whole point of one table is that it is one entry');
    });

    test('the routes the audit found missing are in the table', () => {
        const paths = allRoutes().map(r => basePath(r.path));
        for (const p of F154_MISSING_ROUTES) {
            assert.ok(paths.includes(p),
                `${p} is not in API_SECTIONS. F-154 was exactly this: routes that exist, are public, ` +
                'and are documented in README/llms.txt but invisible on the page integrators are pointed at.');
        }
    });
});

describe('both /developers renderers build from the table (F-154)', () => {
    // The real proof: render each section and assert the markup appears in the
    // two documents. Instead of running the SPA (no DOM here), assert both
    // files CALL the renderer for every section — and that neither has gone
    // back to hand-writing <li><code>GET /api/…</code> items.
    test('server.js renders every section of the table', () => {
        for (const s of API_SECTIONS) {
            assert.ok(serverCode.includes(`renderSection('${s.id}')`),
                `DEVELOPERS_HTML does not render section '${s.id}'. A section in the table that no ` +
                'renderer calls is the same invisible-route bug wearing a different hat.');
        }
    });

    test('script.js renders every section of the table', () => {
        for (const s of API_SECTIONS) {
            assert.ok(scriptCode.includes(`renderSection('${s.id}'`),
                `renderDevelopersPage() does not render section '${s.id}'.`);
        }
    });

    test('neither renderer hand-writes endpoint list items any more', () => {
        // The old shape: <li><code>GET /api/blocks</code> — …</li>. If this
        // reappears, someone has added a route to one copy again, and the two
        // documents have started to diverge for the fourth time.
        const handWritten = /<li>\s*<code>\s*(GET|POST|PUT|DELETE)\s+\/api\//;
        assert.ok(!handWritten.test(serverCode),
            'server.js hand-writes an endpoint <li> again — add it to lib/api-reference.js instead');
        assert.ok(!handWritten.test(scriptCode),
            'script.js hand-writes an endpoint <li> again — add it to lib/api-reference.js instead');
    });

    test('every renderSection() call names a section that exists', () => {
        // The reverse direction of the two tests above, and the one that is a
        // crash rather than an omission: DEVELOPERS_HTML is a module-scope
        // template literal, so a typo'd id makes findSection throw at IMPORT
        // time and the backend never starts. Cheaper to catch here.
        const ids = new Set(API_SECTIONS.map(s => s.id));
        for (const [name, src] of [['server.js', serverCode], ['script.js', scriptCode]]) {
            for (const m of src.matchAll(/renderSection\(\s*'([^']+)'/g)) {
                assert.ok(ids.has(m[1]),
                    `${name} calls renderSection('${m[1]}'), which is not a section in API_SECTIONS. ` +
                    'In server.js that throws while the module is being imported — the backend does not boot.');
            }
        }
    });

    test('rendered markup escapes and contains the path', () => {
        const html = renderSection('chain', { listClass: 'x' });
        assert.match(html, /<ul class="x">/);
        assert.match(html, /<code>GET \/api\/blocks<\/code>/);
        // `?before=<n>` must not become a tag.
        assert.ok(!/<n>/.test(html), 'the renderer emitted an unescaped angle bracket from a route path');
        assert.match(html, /&lt;n&gt;/);
    });

    test('a section note is rendered when present', () => {
        assert.ok(findSection('accounts').note, 'the accounts section lost its 501 note');
        assert.match(renderSection('accounts'), /<p>Each returns HTTP 501/);
    });

    test('findSection fails loudly on an unknown id', () => {
        // A typo in a renderer must break the build, not silently drop a
        // section from the page — silent omission is the failure mode.
        assert.throws(() => renderSection('chian'), /no section 'chian'/);
    });
});

describe('README and llms.txt still list every route (F-154)', () => {
    // These two are prose and stay hand-written; this is what keeps them from
    // drifting the other way now that the page is generated.
    for (const doc of [['README.md', readme], ['public/llms.txt', llms]]) {
        const [name, text] = doc;
        test(`${name} mentions every path in the table`, () => {
            const missing = allRoutes()
                .map(r => basePath(r.path))
                .filter(p => !text.includes(p));
            assert.deepEqual([...new Set(missing)], [],
                `${name} does not mention these documented routes`);
        });
    }
});

describe('the RPC-outage envelope is one string (F-155)', () => {
    test('requireRpc sends the shared constant, not a literal', () => {
        assert.match(serverCode, /RPC_NOT_READY\.error/,
            'requireRpc no longer sends lib/api-reference.js\'s RPC_NOT_READY.error — if the 503 body ' +
            'is written out again as a literal, the docs and the response can drift apart, which is F-155.');
        assert.match(serverCode, /RPC_NOT_READY\.code/);
    });

    test('the code is the stable discriminator clients are told to match', () => {
        assert.equal(RPC_NOT_READY.code, 'RPC_NOT_READY');
        const parsed = JSON.parse(rpcNotReadyExample());
        assert.equal(parsed.code, RPC_NOT_READY.code);
        assert.equal(parsed.error, RPC_NOT_READY.error);
    });

    test('the string the docs used to promise appears nowhere in the product code', () => {
        // `rpc not connected` is the literal requireRpc has never sent. Every
        // page that taught it sent integrators chasing a response that does
        // not exist. Comment-stripped, because this repo's own comments
        // (including the one above) quote the banned string.
        const banned = /["'`]rpc not connected["'`]/;
        assert.ok(!banned.test(serverCode), 'server.js documents or sends "rpc not connected" again');
        assert.ok(!banned.test(scriptCode), 'script.js documents "rpc not connected" again');
        // The rendered /developers documents are strings inside those files,
        // so also check the raw HTML shape the finding quoted.
        const inDocs = /\{\s*"error"\s*:\s*"rpc not connected"\s*\}/;
        assert.ok(!inDocs.test(serverJs.replace(/^\s*\/\/.*$/gm, '')),
            'DEVELOPERS_HTML still documents the { "error": "rpc not connected" } envelope');
        assert.ok(!inDocs.test(scriptJs.replace(/^\s*\/\/.*$/gm, '')),
            'renderDevelopersPage() still documents the { "error": "rpc not connected" } envelope');
    });

    test('README documents the same envelope the code sends', () => {
        assert.ok(readme.includes(RPC_NOT_READY.code), 'README stopped naming the RPC_NOT_READY code');
        assert.ok(readme.includes(RPC_NOT_READY.error),
            'README\'s 503 example no longer matches lib/api-reference.js — one of them has been reworded alone');
    });
});
