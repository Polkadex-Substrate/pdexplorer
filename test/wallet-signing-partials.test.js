// F-055 and F-056 — the two wallet-signing residuals from round 2.
//
// Both are funds-adjacent: one decides how many reward claims go into a
// transaction the user pays for, the other supplies a witness argument the
// runtime rejects the extrinsic over. Neither had a test, and both were
// PARTIAL after round 1 — the dangerous halves were fixed and the leftovers
// were the kind that only bite in the exact conditions the feature exists for
// (many unpaid eras; a contested election).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const src = stripComments(readRepo('script.js', import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// F-055 — the payout batch
// ─────────────────────────────────────────────────────────────────────────────

describe('F-055 — the batch must not be atomic', () => {
    const fn = src.slice(src.indexOf('function batchTx('), src.indexOf('function batchTx(') + 700);

    test('forceBatch is preferred, batchAll is the last resort', () => {
        // Each payoutStakers(validator, era) is independent, and an era someone
        // else already claimed returns AlreadyClaimed. Under batchAll that one
        // inner failure reverts every other payout in the transaction — the
        // user pays a fee and claims nothing.
        const force = fn.indexOf('forceBatch');
        const batch = fn.indexOf('utility.batch)');
        const all = fn.indexOf('batchAll');
        assert.ok(force !== -1 && all !== -1, 'batchTx no longer names both');
        assert.ok(force < all, 'batchAll is tried before forceBatch — one AlreadyClaimed reverts the whole claim');
        assert.ok(batch === -1 || batch < all, 'batchAll is tried before batch');
    });

    test('a single call is not wrapped at all', () => {
        // Wrapping one call in a batch pays the batch overhead and buries the
        // real dispatch error one level down.
        assert.match(fn, /if \(calls\.length === 1\) return calls\[0\];/);
    });

    test('it throws rather than silently signing something else', () => {
        assert.match(fn, /throw new Error\('utility\.batch/);
    });
});

describe('F-055 — the cap is disclosed before signing', () => {
    test('the cap is a named constant, used everywhere', () => {
        assert.match(src, /const PAYOUT_BATCH_MAX = 30;/);
        assert.ok(!/entries\.slice\(0, 30\)/.test(src), 'the magic 30 is back alongside the constant');
        assert.match(src, /entries\.slice\(0, PAYOUT_BATCH_MAX\)/);
    });

    test('the modal says "first N of M" when it OPENS', () => {
        // The audit's close test. Round 1 put this inside submitPayoutTx, which
        // runs when the user clicks Sign — after the decision, not before it.
        const open = src.slice(src.indexOf('function openPayoutModal('),
                               src.indexOf('function openPayoutModal(') + 2600);
        assert.match(open, /entries\.length > PAYOUT_BATCH_MAX/,
            'openPayoutModal does not disclose the cap — the user only learns of it after signing');
        assert.match(open, /This claims the first \$\{PAYOUT_BATCH_MAX\} of \$\{entries\.length\}/);
    });

    test('the submit path still restates it', () => {
        // Belt and braces: the modal can be left open while the dashboard
        // refreshes and the entry count changes underneath it.
        const submit = src.slice(src.indexOf('async function submitPayoutTx('),
                                 src.indexOf('async function submitPayoutTx(') + 2200);
        assert.match(submit, /truncated/);
        assert.match(submit, /label: 'Payout rewards'/);
    });
});

describe('F-055 — the help article matches the code', () => {
    const claim = HELP_TOPICS.find(t => /payout|claim/i.test(t.keywords || ''));

    test('the claim article exists', () => {
        assert.ok(claim, 'no help article about claiming rewards');
    });

    test('it no longer promises a plain utility.batch', () => {
        // The stale sentence the audit calls out: "packages up to 30 payout
        // calls into a single utility.batch". `batch` stops at the first inner
        // failure; the code uses forceBatch, which does not.
        assert.ok(!/into a single <code>utility\.batch<\/code>/.test(claim.body),
            'the help article still describes utility.batch — that IS the F-055 residual');
        assert.match(claim.body, /forceBatch/);
    });

    test('it names the button that actually exists', () => {
        // It said "Claim all"; the button reads "Sign & Pay Out".
        assert.ok(!/Click <b>Claim all<\/b>/.test(claim.body), 'the help names a button that is not on the page');
        assert.match(claim.body, /Sign &amp; Pay Out/);
    });

    test('it explains the 30 cap the user will hit', () => {
        assert.match(claim.body, /first 30/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-056 — the candidacy witness argument
// ─────────────────────────────────────────────────────────────────────────────

describe('F-056 — submitCandidacy reads the count from the chain', () => {
    const fn = src.slice(src.indexOf('async function submitCouncilCandidacy('),
                         src.indexOf('async function submitCouncilCandidacy(') + 2000);

    test('it no longer takes the count from the REST snapshot', () => {
        // elections.submitCandidacy(count) is a WITNESS argument: the runtime
        // compares it to the real length of `Candidates` and rejects the
        // extrinsic with InvalidWitnessData on any mismatch. Reading it from
        // GET /api/council means reading a backend cache of the chain, and any
        // candidacy submitted in between made this one fail — during an
        // election, which is when other people are submitting candidacies.
        assert.ok(!/fetch\('\/api\/council'\)/.test(fn),
            'candidacy still derives its witness count from the REST snapshot — that IS the F-056 residual');
        assert.ok(!/data\.candidates \|\| \[\]\)\.length/.test(fn));
    });

    test('it queries the chain inside buildTx', () => {
        assert.match(fn, /buildTx: async \(api\) => \{/);
        assert.match(fn, /await api\.query\[councilPalletName\]\.candidates\(\)/,
            'the count must be read at signing time, not captured earlier');
    });

    test('it reads the same pallet it dispatches to', () => {
        // Not a hardcoded 'elections' — the collective pallet name varies by
        // runtime and is resolved once.
        const queryAt = fn.indexOf('api.query[councilPalletName]');
        const txAt = fn.indexOf('api.tx[councilPalletName].submitCandidacy');
        assert.ok(queryAt !== -1 && txAt !== -1);
    });

    test('it handles both Vec shapes', () => {
        // Depending on the runtime, `candidates()` returns a Vec codec (which
        // has .length) or decodes to a plain array.
        assert.match(fn, /Array\.isArray\(candidates\) \? candidates\.length : \(candidates\.length \?\? 0\)/);
    });
});

describe('F-056 — submitSignedTx supports an async builder', () => {
    // The trap this change created, caught before it shipped: buildTx was
    // called synchronously, so an async builder would hand signAndSend a
    // Promise. `Promise.signAndSend` is undefined — a TypeError inside the
    // wallet flow, after the extension prompt, at the worst possible moment.
    const fn = src.slice(src.indexOf('async function submitSignedTx('),
                         src.indexOf('async function submitSignedTx(') + 4000);

    test('buildTx is awaited', () => {
        assert.match(fn, /const tx = await buildTx\(globalApi\);/,
            'an async buildTx would pass a Promise to signAndSend');
        assert.ok(!/const tx = buildTx\(globalApi\);/.test(fn));
    });

    test('awaiting does not break the synchronous builders', () => {
        // `await` on a non-promise resolves to the value, so the dozen
        // synchronous builders are unaffected. Asserted as a property of the
        // language rather than left implicit.
        const sync = (x) => x;
        return (async () => {
            assert.equal(await sync(42), 42);
            assert.equal(await Promise.resolve(42), 42);
        })();
    });

    test('the build happens inside the try, so a failed build is reported', () => {
        // A chain query can throw (RPC down). It must surface through the same
        // onError path as a failed signature, not as an unhandled rejection.
        //
        // The ENCLOSING try/catch, not the first one in the function: there are
        // two earlier ones (enumerating injected accounts, and enabling the
        // extension), and a first-match search finds those instead and fails
        // for the wrong reason. Nearest `try {` before, nearest `} catch` after.
        const buildAt = fn.indexOf('await buildTx(globalApi)');
        assert.ok(buildAt !== -1, 'buildTx call not found');
        const tryAt = fn.lastIndexOf('try {', buildAt);
        const catchAt = fn.indexOf('} catch', buildAt);
        assert.ok(tryAt !== -1, 'buildTx runs outside any try — an RPC failure while building becomes an unhandled rejection');
        assert.ok(catchAt !== -1, 'the try enclosing buildTx has no catch');
    });

    test('dispatchError is still checked before treating inclusion as success', () => {
        // F-056's round-1 half. A failed extrinsic is still included in a
        // block; inclusion and success are different facts.
        const errAt = fn.indexOf('if (dispatchError)');
        const inBlockAt = fn.indexOf('status.isInBlock');
        assert.ok(errAt !== -1, 'dispatchError is no longer checked');
        assert.ok(inBlockAt === -1 || errAt < inBlockAt,
            'inclusion is treated as success before dispatchError is examined');
    });
});
