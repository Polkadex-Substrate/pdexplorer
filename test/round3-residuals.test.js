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

// ─────────────────────────────────────────────────────────────────────────────
// F-138 — a warn-and-continue must at least leave a readback
// ─────────────────────────────────────────────────────────────────────────────

describe('F-138 — missing analytics indexes are recorded, not just logged', () => {
    const dbSrc = js('db.js');
    const srv = js('server.js');

    test('boot still continues when an index is missing', () => {
        // Deliberate and kept: a missing index is SLOW, not WRONG. Refusing to
        // boot takes the whole site down to fix one page. That is the opposite
        // trade from ensureColumn, where a missing column makes queries throw.
        assert.match(dbSrc, /migrate-add-indexes\.mjs/);
        assert.ok(!/throw new Error\(`analytics index/.test(dbSrc),
            'a missing analytics index now kills boot — that trade was rejected');
    });

    test('the state is written to KV so it can be read back', () => {
        assert.match(dbSrc, /setKv\('schema:index_state', indexState\)/);
    });

    test('recording cannot itself kill boot', () => {
        // A readback that can crash the thing it reports on is worse than none.
        const at = dbSrc.indexOf("setKv('schema:index_state'");
        assert.ok(at > 0);
        assert.match(dbSrc.slice(at - 120, at + 200), /try \{[\s\S]*catch/);
    });

    test('the try is PER-INDEX, not around the whole loop', () => {
        // It used to wrap the loop, so an exception checking `transactions`
        // skipped the `blocks` index entirely — one failure silently halved
        // the work and reported nothing about the half never attempted.
        const start = dbSrc.indexOf('const indexState = {');
        const body = dbSrc.slice(start, start + 2200);
        const loopAt = body.indexOf('for (const [table, idx, col]');
        const tryAt = body.indexOf('try {', loopAt);
        assert.ok(loopAt > 0 && tryAt > loopAt,
            'the try opens before the loop again — one failure skips the rest');
    });

    test('an unexpected error is a DIFFERENT state from the size skip', () => {
        // "table too big, run the script" and "sqlite_master is unreadable"
        // need different responses from a human; reporting both as a skipped
        // check is what made the original warning useless.
        for (const state of ['missing_too_large', 'error', 'present', 'created']) {
            assert.ok(dbSrc.includes(`'${state}'`), `the ${state} state is gone`);
        }
    });

    test('a degraded flag summarises it for a monitor', () => {
        assert.match(dbSrc, /degraded = Object\.values\(indexState\.indexes\)/);
    });

    // Bound the route by the NEXT registration, not by a fixed 1200 chars.
    // The first version used a fixed slice and a mutation that DELETED the
    // diagGate line survived: the slice simply ran on into /api/diag/rpc-cache,
    // which has its own diagGate, and matched that one instead. The test was
    // asserting that SOME route nearby was gated. Caught by mutation testing,
    // not by review — and it is the same overrunning-slice bug fixed in
    // round2-medium.test.js in this very session, which is why the delimiter
    // here is structural rather than a bigger number.
    const schemaRoute = (() => {
        const at = srv.indexOf("app.get('/api/diag/schema'");
        if (at < 0) return '';
        const rest = srv.slice(at + 1).search(/\napp\.(get|post|put|delete|use)\(/);
        return rest === -1 ? srv.slice(at) : srv.slice(at, at + 1 + rest);
    })();

    test('the diag route exposes it and is GATED', () => {
        assert.ok(schemaRoute, 'no /api/diag/schema route');
        assert.match(schemaRoute, /if \(!diagGate\(req, res\)\) return;/,
            'row counts and schema shape are operational internals — this must stay gated');
        assert.match(schemaRoute, /db\.getKv\('schema:index_state'\)/);
    });

    test('"no record" is distinguished from "no indexes"', () => {
        // A non-indexer worker has simply never run the check. Reporting that
        // as absent indexes would send an operator chasing a phantom.
        assert.match(schemaRoute, /recorded: false/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-082 — junk must not reach the chain
// ─────────────────────────────────────────────────────────────────────────────

describe('F-082 — search rejects unsearchable input before the RPC', () => {
    const srv = js('server.js');
    const start = srv.indexOf("app.get('/api/search/:query'");
    const next = srv.slice(start + 1).search(/\napp\.(get|post|put|delete|use)\(/);
    const route = srv.slice(start, start + 1 + next);

    test('the gate runs BEFORE requireRpc', () => {
        // This is the whole point. Junk used to fall through to
        // system.account(q), which threw into an empty catch and became a 404 —
        // after a live RPC round-trip. Any string at all bought the caller a
        // node query, which is free amplification against the RPC the whole
        // explorer depends on.
        const gateAt = route.indexOf('if (!isNumber && !isHash && !isAddress)');
        const rpcAt = route.indexOf('requireRpc(res)');
        assert.ok(gateAt > 0, 'the shape gate is gone');
        assert.ok(rpcAt > 0 && gateAt < rpcAt,
            'junk still reaches the RPC before being rejected');
    });

    test('it answers 400, not 404', () => {
        // 404 means "looked, found nothing" — untrue of input that was never
        // searchable.
        assert.match(route, /return res\.status\(400\)/);
    });

    test('the gate accepts exactly the three shapes the handler searches', () => {
        // If the gate and the handler disagree, the gate rejects something the
        // handler could have found. Tie them together.
        assert.match(route, /const isNumber\s+= \/\^\\d\+\$\/\.test\(q\)/);
        assert.match(route, /const isHash\s+= \/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(q\)/);
        assert.match(route, /const isAddress = q\.length > 0 && isValidAddress\(q\)/);
    });

    test('an over-long query is capped before isValidAddress runs', () => {
        // Base58-decoding a megabyte of text is wasted work; the longest legal
        // query here is 66 chars.
        const capAt = route.indexOf('q.length > 128');
        const validAt = route.indexOf('if (!isNumber');
        assert.ok(capAt > 0 && capAt < validAt, 'the length cap is missing or too late');
    });

    test('the account branch returns the NORMALISED address', () => {
        // It echoed `q`, so a prefix-42 search produced a card linking to the
        // un-normalised spelling, which /api/account then normalises
        // differently — two spellings of one account, and a tx list that
        // looked empty.
        assert.match(route, /address = normalizeAddress\(q\)/);
        assert.ok(!/data: \{ address: q,/.test(route),
            'the raw query is echoed back as the account address again');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-081 — the no-store trade, rejected on purpose
// ─────────────────────────────────────────────────────────────────────────────

describe('F-081 — an empty timeseries stays cacheable', () => {
    const srv = js('server.js');

    test('the response still distinguishes empty from unanswerable', () => {
        // This is what actually closed the finding: a bare empty array could
        // not tell "nothing happened" from "not indexed yet". The flag can, and
        // it travels INSIDE the cached body, so a cached copy is not a lie.
        assert.match(srv, /indexIncomplete = \(db\.getSyncState\('chain_index'\) \|\| \{\}\)\.status !== 'Synced'/);
    });

    test('the reason for not using no-store is recorded', () => {
        // Someone will propose no-store here again — it sounds obviously right.
        // The counter-argument is that it reopens a path that already took this
        // endpoint down, to buy 10 seconds on a correctly-labelled response.
        //
        // RAW source, not the comment-stripped `js()`: the thing being asserted
        // IS a comment. Anchoring a comment assertion on stripped source is a
        // mistake this suite has made more than once — indexOf returns -1 and
        // the test passes or fails for the wrong reason.
        assert.match(raw('server.js'), /Reopening a known-fatal path to shave 10 seconds/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-047 — the synchronous gap sweep, measured rather than argued about
// ─────────────────────────────────────────────────────────────────────────────

describe('F-047 — the gap sweep stays bounded and instrumented', () => {
    const srv = js('server.js');

    test('the full sweep is still a bounded slice, not an unbounded LEAD', () => {
        // This is the fix that mattered: 2,272ms -> 85ms at the production row
        // count. Removing the window puts the 2.3-second stall back.
        assert.match(srv, /const CHAIN_FULL_SCAN_WINDOW = readPositiveInteger\(process\.env\.CHAIN_FULL_SCAN_WINDOW, 500_000\)/);
        assert.match(srv, /sinceBlock = Math\.max\(BLOCKS_MIN_BLOCK, cursorTop - CHAIN_FULL_SCAN_WINDOW \+ 1\)/);
    });

    test('the sweep is timed and the duration is checked', () => {
        // Without this, the sweep silently regressing to seconds looks
        // identical to it running in 85ms.
        //
        // Round 4: the timer moved INSIDE scanGapsYielding and now measures the
        // longest single SLICE, which is the actual stall. Total wall time
        // would be the wrong thing to watch — it includes the yields, so it
        // would fire on a sweep that never blocked and stay quiet on one that
        // did.
        assert.match(srv, /const t0 = process\.hrtime\.bigint\(\);/);
        assert.match(srv, /if \(ms > longestMs\) longestMs = ms;/);
        assert.match(srv, /scan\.longestMs > GAP_SCAN_SLOW_MS/);
    });

    test('the timer brackets ONLY the query', () => {
        // A timer that also spans the repair work — or the yields — would
        // report a duration that is not the stall being bounded, and the
        // tripwire would fire for the wrong reason.
        const fnAt = srv.indexOf('async function scanGapsYielding');
        assert.ok(fnAt > 0, 'the sliced sweep is gone');
        const t0 = srv.indexOf('const t0 = process.hrtime.bigint();', fnAt);
        const call = srv.indexOf('const part = db.getBlockGaps(limit, lo, hi);', t0);
        const t1 = srv.indexOf('const ms = Number(process.hrtime.bigint() - t0)', call);
        assert.ok(t0 > 0 && call > t0 && t1 > call,
            'the timing no longer brackets exactly one getBlockGaps slice');
        // And the yield must be OUTSIDE the bracket.
        const yieldAt = srv.indexOf('await new Promise(r => setImmediate(r));', fnAt);
        assert.ok(yieldAt > t1, 'the yield is inside the timed region, so the stall reads too long');
    });

    test('the threshold is configurable and documented', () => {
        assert.match(srv, /GAP_SCAN_SLOW_MS = readPositiveInteger\(process\.env\.GAP_SCAN_SLOW_MS, 500\)/);
        // F-191: every env var the product reads must be in .env.example.
        assert.match(raw('.env.example'), /# GAP_SCAN_SLOW_MS=500/);
    });

    test('the measurement is recorded, not just the conclusion', () => {
        // Three rounds have now re-litigated this from theory. The numbers, the
        // row count they were taken at, and the method belong next to the code
        // so round 4 can check them instead of re-deriving them.
        const src = raw('server.js');
        assert.match(src, /12,941,836/, 'the row count the benchmark used is not recorded');
        assert.match(src, /2,272 ms/, 'the unbounded baseline is not recorded');
        assert.match(src, /serveHttp = !indexer \|\| WORKERS <= 1/,
            'the reason the stall hits no user request is not stated');
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Web Analytics — the one real CSP violation on the live site
// ─────────────────────────────────────────────────────────────────────────────

describe('F-201 — no third-party script origin on the wallet CSP', () => {
    // Reversal of a change made hours earlier in the same session. The beacon
    // host-source was added to silence a console error and make Cloudflare Web
    // Analytics work; audit round 4 rated it HIGH and it was reverted. Both
    // directions are asserted here so neither is re-made by accident.
    const conf = raw('nginx.conf');
    const policies = conf.split('\n').filter(l => l.includes('add_header Content-Security-Policy'));

    test('script-src is exactly self plus wasm-unsafe-eval', () => {
        // index.html is the SPA shell for EVERY route including /wallet, so a
        // script origin allowed anywhere is allowed on the signing page. There
        // is no per-route CSP available here.
        for (const p of policies) {
            const m = p.match(/script-src ([^;]+);/);
            assert.ok(m, 'no script-src');
            assert.deepEqual(m[1].trim().split(/\s+/).sort(), ["'self'", "'wasm-unsafe-eval'"],
                'a script origin was added to the CSP that also serves the wallet');
        }
    });

    test('the Insights host-source is not in any policy line', () => {
        for (const p of policies) {
            assert.ok(!p.includes('cloudflareinsights'),
                'the Cloudflare Insights host-source is back on the wallet origin (F-201)');
        }
    });

    test('connect-src was never widened for it either', () => {
        for (const p of policies) {
            assert.ok(!/connect-src [^;]*cloudflareinsights/.test(p));
            assert.match(p, /connect-src 'self' wss:\/\/rpc\.polkadex\.ee/);
        }
    });

    test('the two policies stay byte-identical', () => {
        assert.equal(policies.length, 2);
        assert.equal(policies[0].trim(), policies[1].trim());
    });

    test('the reversal reasoning is recorded, not just the reversal', () => {
        // Specifically the two arguments that decided it, because the case FOR
        // allowing the beacon is reasonable and will be made again.
        assert.match(conf, /'wasm-unsafe-eval' is not scoped to our own bundle/);
        assert.match(conf, /being in the path is exactly why the constraint\n\s*#\s*mattered/);
    });

    test('F-104 — the privacy page and the CSP agree', () => {
        // The privacy copy claims no third-party analytics and says the CSP
        // enforces it. With the host-source present that sentence was false.
        // This ties the two together so they cannot drift apart again: if the
        // policy ever admits a third-party script origin, this fails.
        const html = raw('index.html');
        assert.match(html, /We do not load Google Analytics, Mixpanel, Segment, advertising pixels, or any other analytics\/tracking script/);
        assert.match(html, /the browser itself refuses to load scripts from anywhere else/);
        for (const p of policies) {
            const m = p.match(/script-src ([^;]+);/);
            const thirdParty = m[1].trim().split(/\s+/).filter(s => s.startsWith('http'));
            assert.deepEqual(thirdParty, [],
                `privacy §4 promises no third-party scripts, but the CSP admits ${thirdParty.join(' ')}`);
        }
    });
});
