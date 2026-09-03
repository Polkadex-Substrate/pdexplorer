// Round-3 residuals of the ORIGINAL 165: F-044, F-083, F-041.
//
// Each of these was marked PARTIAL across three rounds, which is its own
// signal: a partial fix is one that addressed the symptom the auditor named
// and left the mechanism that produced it. F-044 renamed a COLUMN twice while
// the API field kept saying "real". F-083 added no-store to the branch that
// was already safe. Both residuals are the half that actually bites.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';
import { MAX_APY_BASE, estimatedApy, apyFields, APY_FIELD, APY_DEPRECATED_ALIASES } from '../lib/apy.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const js = (p) => stripComments(readRepo(p, import.meta.url), { line: '//', block: true });
const raw = (p) => readRepo(p, import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// F-044 — one definition of the base, and an honest name for the projection
// ─────────────────────────────────────────────────────────────────────────────

describe('F-044 — the APY base has exactly one definition', () => {
    test('no source file writes the literal 23.09 in CODE', () => {
        // Five copies existed: three bare literals in server.js, plus two
        // separate `const MAX_APY_BASE = 23.09` declarations. Comments may
        // still mention the number when explaining the history — hence the
        // comment-stripped source. Anchoring on raw source here would
        // self-match on the very comments that document the fix, which is a
        // trap this suite has fallen into repeatedly.
        for (const f of ['server.js', 'script.js', 'lib/help-topics.js']) {
            assert.ok(!js(f).includes('23.09'),
                `${f} still hardcodes the APY base instead of importing MAX_APY_BASE`);
        }
    });

    test('lib/apy.js is the only place the number appears', () => {
        assert.equal(MAX_APY_BASE, 23.09);
        assert.ok(js('lib/apy.js').includes('23.09'));
    });

    test('server.js and script.js both import it', () => {
        assert.match(js('server.js'), /from '\.\/lib\/apy\.js'/);
        assert.match(js('script.js'), /from '\.\/lib\/apy\.js'/);
    });

    test('MAX_APY_BASE is no longer declared inside a function', () => {
        // The old server-side declaration sat at brace depth 3, inside
        // getNetworkInfo — which is precisely WHY the other three call sites
        // wrote the literal by hand: they could not see it. Same shape as
        // F-199, where a function-local const threw a ReferenceError at
        // runtime on a page nobody had loaded.
        for (const f of ['server.js', 'script.js']) {
            assert.ok(!/^\s+const MAX_APY_BASE\s*=/m.test(raw(f)),
                `${f} re-declares MAX_APY_BASE in an inner scope`);
        }
    });
});

describe('F-044 — the API stops calling a projection "real"', () => {
    test('the honest key is primary', () => {
        assert.equal(APY_FIELD, 'estimatedApyAtCurrentCommission');
        const fields = apyFields(10);
        assert.ok(APY_FIELD in fields);
        assert.equal(fields[APY_FIELD], 23.09 * 0.9);
    });

    test('every deprecated alias mirrors the honest key exactly', () => {
        // They must not drift while they exist — an alias holding a STALE
        // value is worse than an alias that is gone, because it looks like a
        // second, corroborating measurement.
        const fields = apyFields(25);
        for (const alias of APY_DEPRECATED_ALIASES) {
            assert.equal(fields[alias], fields[APY_FIELD], `${alias} drifted from ${APY_FIELD}`);
        }
    });

    test('the aliases are exactly the three names that shipped', () => {
        // Dropping one silently would break integrators; adding a new
        // dishonest one would re-open the finding.
        assert.deepEqual([...APY_DEPRECATED_ALIASES].sort(),
            ['avg30DayApy', 'currentApy', 'realApy']);
    });

    test('no server payload builds the APY fields by hand any more', () => {
        // The point of apyFields() is that removing an alias is ONE edit. A
        // hand-written `realApy:` somewhere would survive that edit.
        assert.ok(!/realApy:/.test(js('server.js')),
            'server.js still spells out a realApy key instead of using apyFields()');
    });
});

describe('F-044 — estimatedApy refuses to invent a number', () => {
    test('a valid commission projects correctly', () => {
        assert.equal(estimatedApy(0), 23.09);
        assert.equal(estimatedApy(100), 0);
        assert.ok(Math.abs(estimatedApy(50) - 11.545) < 1e-9);
    });

    test('unusable input returns null, not NaN and not a negative APY', () => {
        // The old inline expression `23.09 * (1 - (c / 100))` returned NaN for
        // undefined — which `.toFixed(2)` renders as the string "NaN" — and a
        // NEGATIVE number for a commission above 100, which renders as a real,
        // alarming figure rather than as missing data.
        for (const bad of [undefined, null, '', 'abc', NaN, Infinity, -1, 101]) {
            assert.equal(estimatedApy(bad), null, `estimatedApy(${String(bad)}) should be null`);
        }
    });

    test('a commission over 100 cannot produce a negative APY', () => {
        assert.ok(!(estimatedApy(150) < 0));
    });
});

describe('F-044 — the prose agrees with the code', () => {
    test('the help article interpolates the constant rather than restating it', () => {
        // A template literal is required for this: in a plain quoted string
        // `${MAX_APY_BASE}` renders LITERALLY on the help page. Assert the
        // rendered output, not the source text, so that mistake cannot pass.
        const all = JSON.stringify(HELP_TOPICS);
        assert.ok(all.includes(`(${MAX_APY_BASE}%)`),
            'the help article does not show the APY base');
        assert.ok(!all.includes('${'),
            'an un-interpolated ${...} placeholder is being rendered to users');
    });

    test('the help article still says it is a projection', () => {
        const all = JSON.stringify(HELP_TOPICS);
        assert.match(all, /not a measured return/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-083 — a per-viewer response must not be served from a shared cache
// ─────────────────────────────────────────────────────────────────────────────

describe('F-083 — the labels GET varies on Authorization', () => {
    const src = js('server.js');
    const at = src.indexOf("app.get('/api/labels/:address'");
    const route = src.slice(at, src.indexOf("app.post('/api/labels/:address'", at));

    test('the route sets Vary: Authorization', () => {
        assert.ok(at > 0, 'route not found');
        assert.match(route, /res\.set\('Vary', 'Authorization'\)/,
            'the anonymous response is still cacheable under a bare URL, so Cloudflare can serve it to a signed-in user');
    });

    test('Vary is set OUTSIDE the viewer branch', () => {
        // This is the whole residual. no-store already protected the
        // signed-in RESPONSE; nothing protected the signed-in REQUEST from
        // being answered out of the cached ANONYMOUS entry. Setting Vary only
        // when `viewer` is truthy would leave that entry unqualified and fix
        // nothing.
        const varyAt = route.indexOf("res.set('Vary'");
        const branchAt = route.indexOf('if (viewer)');
        assert.ok(varyAt > 0 && branchAt > 0);
        assert.ok(varyAt < branchAt,
            'Vary is set inside the viewer branch, so the anonymous entry stays unqualified');
    });

    test('the signed-in response is still no-store', () => {
        assert.match(route, /if \(viewer\) res\.set\('Cache-Control', 'no-store'\); else cacheMedium\(res\)/);
    });

    test('Authorization is in fact the header that changes the body', () => {
        // If auth ever moves to a cookie, `Vary: Authorization` becomes a
        // no-op that still LOOKS correct. Tie the assertion to the reader.
        const getAuth = src.slice(src.indexOf('function getAuthAddress'), src.indexOf('function getAuthAddress') + 400);
        assert.match(getAuth, /req\.headers\['authorization'\]/,
            'getAuthAddress no longer reads the Authorization header — Vary now names the wrong header');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-041 — the CSP omission is a recorded decision, not an oversight
// ─────────────────────────────────────────────────────────────────────────────

describe('F-041 — nested locations omit CSP deliberately', () => {
    const conf = raw('nginx.conf');

    test('the reasoning is recorded where the next reader will look', () => {
        assert.match(conf, /CSP governs the document that\n\s*# loads subresources, not the subresources themselves/);
    });

    test('every nested location that resets headers still sends X-Frame-Options', () => {
        // This is what makes the omission safe rather than merely defensible:
        // the one case where a CSP on a subresource is NOT inert is direct
        // navigation, where frame-ancestors would apply — and X-Frame-Options
        // covers exactly that case. If a location ever drops it, the CSP
        // argument above stops holding and this test should fail.
        // Split on `location`, then TRUNCATE each chunk at its own closing
        // brace. Without the truncation a chunk swallows the comment block
        // that follows it, and `location /.well-known/acme-challenge/` — which
        // has no add_header at all — matched on the word appearing in the
        // prose underneath it. A test bug, not a config bug, but the same
        // "fixed-size slice overran into the next thing" shape that has bitten
        // this suite repeatedly.
        const blocks = conf.split(/\n(?=\s*location )/)
            .map(b => { const end = b.indexOf('\n    }'); return end > 0 ? b.slice(0, end) : b; })
            .filter(b => /^\s*add_header/m.test(b));
        assert.ok(blocks.length >= 5, `expected the 5 header-resetting locations, found ${blocks.length}`);
        for (const b of blocks) {
            const name = b.split('\n')[0].trim();
            assert.match(b, /add_header X-Frame-Options "SAMEORIGIN" always;/,
                `${name} resets headers but no longer sends X-Frame-Options — the F-041 reasoning no longer holds`);
        }
    });

    test('there are still exactly two CSP definitions', () => {
        // The drift check in dockerfile-copy.test.js compares the two policies
        // to each other, and that comparison is only meaningful at two.
        const n = (conf.match(/add_header Content-Security-Policy/g) || []).length;
        assert.equal(n, 2, `expected 2 CSP definitions, found ${n}`);
    });
});
