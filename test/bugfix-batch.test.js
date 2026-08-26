// Regression tests for the MEDIUM/LOW bug sweep.
//
// Most of that batch is behavioural (a button that now disables, a header that
// is now no-store) and lives in code that needs a browser or a chain. What IS
// unit-testable is the arithmetic and the string/config contracts — and those
// are exactly the places where a future edit could silently undo the fix
// without anyone noticing. Each test below names the finding and states the
// user-visible consequence of the bug, so a failure explains itself.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

describe('F-043 / F-067 — planck→PDEX must be BigInt-safe', () => {
    // Both files carry their own converter (server-side formatPDEX and the
    // SPA's formatLivePDEX). The bug was `Number(planck) / 1e12`: a u128 above
    // 2^53 planck (~9007 PDEX) truncates BEFORE the division, so large
    // transfers and whale balances were stored and displayed subtly wrong.
    // Reproduce the arithmetic both ways to show the difference is real.
    const PLANCK = 9007199254740993n;   // 2^53 + 1

    test('the naive conversion genuinely loses the low digit', () => {
        const naive = Number(PLANCK) / 1e12;
        const exact = Number(PLANCK / 1000000000000n) + Number(PLANCK % 1000000000000n) / 1e12;
        assert.notEqual(naive, exact, 'if these agree the test proves nothing');
        assert.equal(exact, 9007.199254740993);
    });

    test('server.js formatPDEX uses BigInt', () => {
        const src = read('server.js');
        const fn = src.slice(src.indexOf('function formatPDEX'), src.indexOf('function formatPDEX') + 700);
        assert.match(fn, /BigInt/, 'formatPDEX regressed to float division');
        assert.match(fn, /1000000000000n/, 'expected BigInt whole/fraction split');
    });

    test('script.js formatLivePDEX uses BigInt', () => {
        const src = read('script.js');
        const fn = src.slice(src.indexOf('function formatLivePDEX'), src.indexOf('function formatLivePDEX') + 700);
        assert.match(fn, /BigInt/, 'formatLivePDEX regressed to float division');
    });
});

describe('F-055 — reward payouts must not be atomic', () => {
    test('batchTx prefers forceBatch over batchAll', () => {
        // payoutStakers(validator, era) pairs are independent, and anyone can
        // trigger a payout. Under batchAll a single AlreadyClaimed reverts the
        // whole batch — the user pays a fee and claims nothing.
        const src = read('script.js');
        const fn = src.slice(src.indexOf('function batchTx'), src.indexOf('function batchTx') + 900);
        const iForce = fn.indexOf('forceBatch');
        const iAll = fn.indexOf('batchAll');
        assert.ok(iForce > -1, 'forceBatch is not considered at all');
        assert.ok(iForce < iAll, 'batchAll is preferred again — one failure reverts every claim');
    });
});

describe('F-056 — inclusion is not success', () => {
    test('no signAndSend watches only status.isInBlock', () => {
        // A failed extrinsic is still INCLUDED in a block. Any callback that
        // reports success from isInBlock without reading dispatchError tells
        // the user their governance action worked when the runtime rejected it.
        const src = read('script.js');
        // A review caught the first version of this test matching ZERO
        // callbacks (its regex couldn't span submitSignedTx's 400+ char body),
        // so it asserted nothing and passed unconditionally. Check the
        // invariant directly instead: every isInBlock success report must have
        // a dispatchError check within reach, and the count must be non-zero.
        const occurrences = [...src.matchAll(/isInBlock/g)];
        assert.ok(occurrences.length > 0, 'no isInBlock at all — did the signing path move?');
        for (const m of occurrences) {
            const window = src.slice(Math.max(0, m.index - 1200), m.index + 600);
            assert.match(window, /dispatchError/,
                `an isInBlock at offset ${m.index} has no dispatchError check nearby — inclusion is not success (F-056)`);
        }
    });
});

describe('F-118 — referendum index must be digit-checked', () => {
    test('the vote modal validates before SCALE-encoding', () => {
        // Compact<u32> encodes 0 happily, so a non-digit index became a vote
        // on referendum #0 — a different question than the one clicked.
        const src = read('script.js');
        const fn = src.slice(src.indexOf('function openReferendumVoteModal'), src.indexOf('function openReferendumVoteModal') + 900);
        assert.match(fn, /\\d\+\$|\\d\+/, 'no digit guard on the referendum index');
    });
});

describe('F-127 — timeAgo must cope with years', () => {
    // Pure function, transcribed from script.js so the buckets can be asserted
    // directly. With the transactions table now reaching 2021 (F-008), the
    // old hours-only version rendered "35,000 hrs ago".
    // Mirrors script.js including the F-114 null guard a review flagged: with
    // day/month/year buckets, `Date.now() - null` rendered a confident
    // "56.6 years ago" for a block whose timestamp could not be read.
    const timeAgo = (secondsAgo) => {
        if (!Number.isFinite(secondsAgo)) return '—';
        const seconds = secondsAgo;
        if (seconds < 0) return 'just now';
        if (seconds < 60) return `${seconds} secs ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
        if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)} days ago`;
        if (seconds < 365 * 86400) return `${Math.floor(seconds / (30 * 86400))} months ago`;
        return `${(seconds / (365.25 * 86400)).toFixed(1)} years ago`;
    };

    test('buckets escalate past hours', () => {
        assert.equal(timeAgo(30), '30 secs ago');
        assert.equal(timeAgo(600), '10 mins ago');
        assert.equal(timeAgo(7200), '2 hrs ago');
        assert.equal(timeAgo(3 * 86400), '3 days ago');
        assert.equal(timeAgo(60 * 86400), '2 months ago');
        assert.match(timeAgo(4 * 365 * 86400), /^3\.9 years ago$|^4\.0 years ago$/);
    });

    test('an unknown timestamp renders as unknown, not as a plausible lie', () => {
        assert.equal(timeAgo(NaN), '—');
        assert.equal(timeAgo(undefined), '—');
    });

    test('script.js has the day/month/year branches AND the null guard', () => {
        const src = read('script.js');
        const fn = src.slice(src.indexOf('function timeAgo'), src.indexOf('function timeAgo') + 1400);
        assert.match(fn, /days ago/);
        assert.match(fn, /years ago/);
        // F-114 interaction: getBlockTimestamp can legitimately return null.
        assert.match(fn, /Number\.isFinite/, 'timeAgo lost its unknown-timestamp guard');
    });
});

describe('F-059 — real static files must escape the SPA router', () => {
    test('the click interceptor exempts file-extension paths', () => {
        const src = read('script.js');
        assert.match(src, /isRealFile/, 'the static-file exemption is gone — /llms.txt routes to a blank pane');
    });

    test('the exemption regex does not swallow real SPA routes', () => {
        // The routes carry hashes, SS58 addresses and numbers — none contain a
        // dot, so the extension test must not match them.
        const isRealFile = (p) => /\.[a-z0-9]{2,12}$/i.test(p)
            || p === '/robots.txt' || p.startsWith('/api/') || p.startsWith('/vendor/');
        for (const spa of ['/blocks', '/tx/12861464/0xabc', '/account/esp2fvYLRhEFb2FTcx18kKmFqAFshpCDJAfsNTAthrPRbcRCS',
                           '/staking-rewards', '/email/preferences', '/validator/5CqWfd']) {
            assert.equal(isRealFile(spa), false, `${spa} would stop being an SPA route`);
        }
        for (const file of ['/llms.txt', '/sitemap.xml', '/manifest.webmanifest', '/vendor/chart.umd.js', '/favicon.png']) {
            assert.equal(isRealFile(file), true, `${file} would be hijacked by the router`);
        }
    });
});

describe('F-084 — internal error text must not reach clients', () => {
    test('a generic 500 helper exists and is used', () => {
        const src = read('server.js');
        assert.match(src, /function serverError\(/, 'the generic 500 helper is gone');
        // Client-facing handlers should not echo err.message. The remaining
        // occurrences are setSyncState writes (internal kv, operator-facing).
        const leaks = [...src.matchAll(/res\.status\(500\)\.json\(\{ error: err\.message \}\)/g)];
        assert.deepEqual(leaks.map(m => m[0]), [],
            'a handler echoes err.message to the client again (F-084)');
    });
});

describe('F-072 / F-077 / F-074 — public endpoint ceilings', () => {
    const src = read('server.js');

    test('/api/decode is bounded', () => {
        assert.match(src, /DECODE_MAX_EXTRINSICS/, 'the decode response ceiling is gone');
    });

    test('the RPC console allowlist excludes multi-key storage reads', () => {
        // Read the QUOTED entries only. Slicing raw text also catches the
        // comment that explains the removal — a false positive that would
        // make this test fail on the fixed tree (it did, first run).
        const block = src.slice(src.indexOf('const RPC_ALLOWLIST'), src.indexOf(']);', src.indexOf('const RPC_ALLOWLIST')));
        const entries = [...block.matchAll(/'([a-z]+_[A-Za-z]+)'/g)].map(m => m[1]);
        assert.ok(entries.length > 5, 'allowlist parse found almost nothing — regex probably broke');
        assert.ok(!entries.includes('state_queryStorageAt'),
            'state_queryStorageAt is back in the allowlist — an unbounded multi-key read from a public endpoint');
        assert.ok(entries.includes('state_getKeysPaged'), 'the paged reader should stay available');
    });

    test('diag endpoints share the per-IP limiter', () => {
        const fn = src.slice(src.indexOf('function diagGate'), src.indexOf('function diagGate') + 900);
        assert.match(fn, /devApiRateOk/, 'diag routes are unlimited again — subquery-lag is an amplifier');
    });
});

describe('F-137 / F-088 — SQLite write and index contracts', () => {
    test('writers take the lock immediately', () => {
        for (const f of ['db.js', 'lib/id-migration.js', 'backfill-transactions-from-events.mjs']) {
            const src = read(f);
            assert.ok(!/exec\('BEGIN'\)/.test(src), `${f} uses a deferred BEGIN — a reader can force SQLITE_BUSY mid-write`);
        }
    });

    test('the analytics index is in the schema, not only the migration script', () => {
        assert.match(read('db.js'), /idx_tx_timestamp/,
            'a fresh install would full-scan transactions for every timestamp range query');
    });

    test('a failed column migration is fatal, EXCEPT for the benign worker race', () => {
        const src = read('db.js');
        // Window widened: the benign-race branch pushed the throw past 900
        // chars and this test failed on correct code (caught on the run that
        // added it). Slice to the function's real end instead of guessing.
        const start = src.indexOf('function ensureColumn');
        const fn = src.slice(start, src.indexOf('\n}', start) + 2);
        assert.match(fn, /throw new Error/,
            'ensureColumn swallows failures again — queries then 500 at request time');
        // ...but N workers racing the same ALTER must not fail the boot: the
        // loser sees "duplicate column name", which means the column exists.
        assert.match(fn, /duplicate column name/i,
            'the concurrent-ALTER race is fatal again — this is the production upgrade path');
    });
});

describe('F-105 — the published storage inventory must match the code', () => {
    test('every pdex_ key in the SPA is documented, and vice versa', () => {
        const inCode = new Set([...read('script.js').matchAll(/pdex_[a-z_0-9]+/g)].map(m => m[0]));
        const inDocs = new Set([...read('index.html').matchAll(/pdex_[a-z_0-9]+/g)].map(m => m[0]));
        // The bearer token is the one that MUST be disclosed — it is a credential.
        assert.ok(inCode.has('pdex_discuss_session'), 'session key renamed? update this test');
        assert.ok(inDocs.has('pdex_discuss_session'),
            'the /cookies page omits the discussion bearer token (F-105)');
        const undocumented = [...inCode].filter(k => !inDocs.has(k));
        assert.deepEqual(undocumented, [], `keys used but not documented: ${undocumented.join(', ')}`);
        const phantom = [...inDocs].filter(k => !inCode.has(k));
        assert.deepEqual(phantom, [], `keys documented but never written: ${phantom.join(', ')}`);
    });
});

describe('F-112 — bare /api must not serve the SPA shell', () => {
    test('both server blocks redirect it', () => {
        const conf = read('nginx.conf');
        const redirects = [...conf.matchAll(/location = \/api \{\s*return 301/g)];
        assert.equal(redirects.length, 2, 'expected the /api redirect in both server blocks');
    });
});

describe('F-100 — debug probes must not default to production', () => {
    test('no debug script hardcodes the public RPC', () => {
        for (const f of ['debug-accounts.js', 'debug-holder-identities.js', 'debug-identity.js', 'debug-transactions.js']) {
            let src;
            try { src = read(f); } catch { continue; }
            assert.ok(!/['"]wss:\/\/rpc\.polkadex\.ee['"]/.test(src),
                `${f} points at the production RPC by default — running it loads the endpoint wallets sign against`);
        }
    });
});
